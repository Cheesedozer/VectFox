/**
 * ============================================================================
 * AUTO-REFORMAT EXTRACTOR
 * ============================================================================
 * Calls an LLM (OpenRouter or vLLM) to restructure Document/URL/Wiki/YouTube
 * source text into self-contained entries (see core/reformat-schema.js for
 * the record shape).
 *
 * Independent of EventBase's extractor (no imports from it). Provider calls
 * are wrapped in AsyncUtils.retry(), since losing a large batch call costs
 * more than losing one small EventBase window.
 *
 * The document is split into header-aligned batches that are processed ONE
 * AFTER ANOTHER. Each call is shown the entries written from the earlier
 * batches (the "ledger", see buildLedgerText) and answers with new entries
 * plus {"op": "extend"} additions to existing ones, so a thing described in
 * several sections ends up with one entry instead of one per batch. Measured
 * on a 89k-character world bible with Claude Haiku 5.5: independent batches
 * produced 274 records of which 105 were duplicates to merge afterwards, and
 * a third of all sentences restated another entry; the ledger produced
 * 131–134 entries with none to merge, 12–18% restated sentences and the same
 * fact recall, for about the same cost. The
 * price is that batches can no longer run in parallel.
 * settings.reformat_ledger_detail ('full' | 'names') sets how much of each
 * earlier entry a batch is shown; see buildLedgerText for when 'names' is
 * the better choice.
 *
 * Optional whole-document mode (settings.reformat_single_pass) sends the
 * document to the model in ONE call. That call is tried twice; if both fail
 * (or the document can't fit the model's context/output limits) the run
 * falls back to the batched path. It is off by default because long replies
 * lose detail (95% recall on the same document) and it depends on the model.
 *
 * settings.reformat_reasoning_effort ('' = model default) sets the thinking
 * level. Thinking tokens count against the output limit, so with an effort
 * set every call gets more output room and a longer timeout.
 *
 * After extraction a coverage check (settings.reformat_enable_repair_pass)
 * compares the document's distinctive facts with the final entries and
 * reports under-covered paragraphs as warnings. It makes no LLM call.
 *
 * Returns { chunks, warnings, batchesProcessed, batchesFailed, totalBatches, mode }.
 * Throws ReformatFatalError for config/auth failures (aborts the whole run).
 * Individual batch failures are non-fatal warnings.
 * ============================================================================
 */

import { getOpenRouterApiKey, getCustomApiKey } from './api-keys.js';
import { callChatCompletion, extractReply, errorBodyText } from './llm-transport.js';
import { getModelConfigErrorMessage } from './model-http-errors.js';
import { chunkText } from './chunking.js';
import AsyncUtils from '../utils/async-utils.js';
import {
    ReformatExtractionError,
    ReformatFatalError,
    validateReformattedChunk,
    validateReformatExtension,
    buildReformatPrompt,
    buildLedgerText,
    buildLinkingPrompt,
    computeBatchCoverage,
    computeNameVerification,
    computeKeywordVerification,
    normalizeForMatch,
} from './reformat-schema.js';
import { log } from './log.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 16000;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_BATCH_CHARS = 6000;
// Parallel calls for the linking pass (extraction runs one batch at a time).
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_NAME_FUZZY_THRESHOLD = 0.8;
const DEFAULT_COVERAGE_THRESHOLD = 0.5;
// Under-covered paragraphs named in the coverage warning; the rest are counted.
const COVERAGE_MAX_REPORTED_SECTIONS = 10;
// Whole-document mode: one generation can run for minutes on a long document.
const DEFAULT_SINGLE_PASS_TIMEOUT_MS = 600000;
const SINGLE_PASS_ATTEMPTS = 2;
// The extracted entries restate every fact plus JSON fields, names, keywords
// and relationships: measured at ~2.5 output tokens per source token, so 3
// leaves a margin.
const SINGLE_PASS_OUTPUT_RATIO = 3;
// Output tokens to set aside for thinking, per reasoning effort. The measured
// whole-document peak was ~7k (Haiku 5.5, medium) and ~38k (Gemini 3.8 Flash,
// high); per batch, Gemini 3.8 Flash on high used more than 16k.
const THINKING_RESERVE_TOKENS = { low: 8000, medium: 24000, high: 40000 };
// A thinking model can take minutes on one batch.
const REASONING_MIN_TIMEOUT_MS = 300000;
// Room for the extraction prompt's instructions and example around the text.
const PROMPT_OVERHEAD_TOKENS = 2500;

/** The whole-document reply hit the output limit; retrying it can't help. */
class ReformatTruncatedError extends ReformatExtractionError {
    constructor(message) {
        super(message);
        this.name = 'ReformatTruncatedError';
    }
}

// ---------------------------------------------------------------------------
// Config resolution (each VectFox LLM feature keeps its own copy; see
// reformat-schema.js on independence)
// ---------------------------------------------------------------------------

function _resolveProvider(settings) {
    return (settings.reformat_provider || settings.summarize_provider || 'openrouter').toLowerCase();
}

function _resolveModel(settings) {
    return (settings.reformat_model || settings.summarize_model || '').trim();
}

function _resolveVllmUrl(settings) {
    return (settings.reformat_vllm_url || settings.summarize_vllm_url || '').trim();
}

/** 'low' | 'medium' | 'high', or '' for the model's default. */
function _resolveReasoningEffort(settings) {
    const effort = String(settings.reformat_reasoning_effort || '').toLowerCase();
    return Object.hasOwn(THINKING_RESERVE_TOKENS, effort) ? effort : '';
}

// ---------------------------------------------------------------------------
// HTTP caller
// ---------------------------------------------------------------------------

/**
 * One chat-completion call to the configured provider.
 * @param {string} prompt
 * @param {object} settings
 * @param {number} batchIndex
 * @param {{maxTokens?: number|null, timeoutMs?: number}} [callOptions] - Overrides
 *        for the whole-document call and for calls with a reasoning effort.
 *        maxTokens null sends no max_tokens, so the provider's own
 *        (model-maximum) limit applies.
 * @returns {Promise<{reply: string, finishReason: string|null}>}
 */
async function _callLLM(prompt, settings, batchIndex, callOptions = {}) {
    const isVllm = _resolveProvider(settings) === 'vllm';
    const providerLabel = isVllm ? 'vLLM' : 'OpenRouter';

    let vllmUrl;
    if (isVllm) {
        vllmUrl = _resolveVllmUrl(settings);
        if (!vllmUrl) {
            throw new ReformatFatalError(
                'Auto-Reformat: vLLM URL not configured. Set it in ChunkBase → Auto-Reformat, or leave it blank to inherit the Summarization vLLM URL.',
                'missing_url',
            );
        }
    }

    const model = _resolveModel(settings);
    if (!model) {
        throw new ReformatFatalError(
            'Auto-Reformat: No model configured. Set a model in ChunkBase → Auto-Reformat, or leave it blank to inherit the Summarization Model.',
            'missing_model',
        );
    }

    const apiKey = isVllm ? getCustomApiKey() : getOpenRouterApiKey();
    if (!apiKey) {
        throw new ReformatFatalError(
            isVllm
                ? 'Auto-Reformat: vLLM / Custom OpenAI-compatible API key not configured. Enter it in Core → LLM Summarization settings.'
                : 'Auto-Reformat: OpenRouter API key not found. Add it in Core → LLM Summarization settings (Auto-Reformat inherits it unless overridden in ChunkBase settings).',
            'missing_api_key',
        );
    }

    const result = await callChatCompletion({
        provider: isVllm ? 'vllm' : 'openrouter',
        model,
        vllmUrl,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: callOptions.maxTokens !== undefined
            ? (callOptions.maxTokens ?? undefined)
            : (settings.reformat_max_output_tokens || DEFAULT_MAX_TOKENS),
        temperature: settings.reformat_temperature ?? DEFAULT_TEMPERATURE,
        timeoutMs: callOptions.timeoutMs || settings.reformat_timeout_ms || DEFAULT_TIMEOUT_MS,
        reasoningEffort: _resolveReasoningEffort(settings) || undefined,
    });

    if (!result.ok) {
        const { status, errText } = result;
        if (status === 401 || status === 403) {
            throw new ReformatFatalError(
                `Auto-Reformat: ${providerLabel} authentication failed (${status}). Check your API key.`,
                'invalid_api_key',
            );
        }
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'Auto-Reformat', provider: providerLabel, model, status, responseText: errText,
        });
        if (modelConfigError) throw new ReformatFatalError(modelConfigError, 'invalid_model_config');
        throw new ReformatExtractionError(`Auto-Reformat: ${providerLabel} HTTP ${status}: ${errText}`, batchIndex);
    }

    const reply = extractReply(result.data);
    const finishReason = result.data?.choices?.[0]?.finish_reason || null;
    if (!reply) {
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'Auto-Reformat', provider: providerLabel, model, status: result.status, responseText: errorBodyText(result.data), enforceStatusGate: false,
        });
        if (modelConfigError) throw new ReformatFatalError(modelConfigError, 'invalid_model_config');
        throw new ReformatExtractionError(`Auto-Reformat: ${providerLabel} returned empty response`, batchIndex);
    }
    return { reply, finishReason };
}

/**
 * Calls the provider, retrying transient failures but never
 * ReformatFatalError (auth/config problems a retry can't fix).
 */
async function _callProviderWithRetry(prompt, settings, batchIndex, callOptions = {}) {
    return AsyncUtils.retry(() => _callLLM(prompt, settings, batchIndex, callOptions), {
        maxAttempts: callOptions.maxAttempts || 3,
        delay: 1500,
        maxDelay: 10000,
        backoffFactor: 2,
        shouldRetry: (err) => !(err instanceof ReformatFatalError),
        onRetry: (attempt, err) => log.warn(`[Auto-Reformat] Batch ${batchIndex}: attempt ${attempt} failed (${err?.message || err}), retrying...`),
    });
}

// ---------------------------------------------------------------------------
// JSON parse + repair (schema-adapted copy of eventbase-extractor.js's
// _parseJsonArray; not imported, per the independence requirement)
// ---------------------------------------------------------------------------

/**
 * @param {string} raw
 * @param {number} [batchIndex]
 * @param {string[]} [keyFields] - An array candidate is accepted when its first
 *        item has ANY of these keys. The linking pass passes ['source', 'target'].
 * @returns {{items: unknown[], clean: boolean}} `clean` is false when the reply
 *        was not valid JSON and the items were salvaged from it, in which case
 *        some may be missing.
 */
function _parseReformatArray(raw, batchIndex = -1, keyFields = ['entry_type', 'name', 'body', 'op']) {
    let text = (raw || '').trim();

    if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    if (!text) {
        throw new ReformatExtractionError('Empty LLM response', batchIndex);
    }

    /** @type {unknown[][]} */
    const candidates = [];

    // 1) Direct parse first. `clean` records that the reply was valid JSON.
    let clean = false;
    try {
        const direct = JSON.parse(text);
        clean = true;
        if (Array.isArray(direct)) candidates.push(direct);
        if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
            if (Object.keys(direct).length === 0) candidates.push([]);
            const wrappedArr = Object.values(direct).find(v => Array.isArray(v));
            if (Array.isArray(wrappedArr)) candidates.push(wrappedArr);
        }
    } catch {
        // Continue with extraction-based parsing.
    }

    // 2) NDJSON / object-stream: one JSON object per line.
    if (text.includes('\n')) {
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && l.startsWith('{') && l.endsWith('}'));
        if (lines.length > 0) {
            try {
                candidates.push(lines.map(line => JSON.parse(line)));
            } catch {
                // Ignore and continue.
            }
        }
    }

    // 3) Every balanced array slice.
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '[') continue;
        let depth = 0;
        let end = -1;
        for (let j = i; j < text.length; j++) {
            if (text[j] === '[') depth++;
            else if (text[j] === ']') {
                depth--;
                if (depth === 0) { end = j; break; }
            }
        }
        if (end === -1) continue;
        const slice = text.slice(i, end + 1);
        try {
            const parsed = JSON.parse(slice);
            if (Array.isArray(parsed)) candidates.push(parsed);
        } catch {
            // Keep scanning.
        }
    }

    // 4) Top-level object stream fallback.
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const objectRegion = text.slice(firstBrace, lastBrace + 1);
        const stream = [];
        let depth = 0;
        let start = -1;
        for (let i = 0; i < objectRegion.length; i++) {
            if (objectRegion[i] === '{') {
                if (depth === 0) start = i;
                depth++;
            } else if (objectRegion[i] === '}') {
                depth--;
                if (depth === 0 && start !== -1) {
                    const part = objectRegion.slice(start, i + 1);
                    try {
                        const obj = JSON.parse(part);
                        if (obj && typeof obj === 'object' && !Array.isArray(obj)) stream.push(obj);
                    } catch {
                        // Skip malformed object parts.
                    }
                    start = -1;
                }
            }
        }
        if (stream.length > 0) candidates.push(stream);
    }

    const isReformatArray = arr => {
        if (!Array.isArray(arr) || arr.length === 0) return false;
        const first = arr[0];
        if (!first || typeof first !== 'object' || Array.isArray(first)) return false;
        return keyFields.some(key => Object.prototype.hasOwnProperty.call(first, key));
    };
    // The candidate with the most entries wins. Taking the first match used
    // to return a small array nested inside a malformed reply (one entry out
    // of 26 in a real run) while the object-stream salvage held the rest.
    const matching = candidates.filter(isReformatArray);
    const chosen = matching.reduce((best, arr) => (!best || arr.length > best.length ? arr : best), null)
        ?? candidates.find(arr => Array.isArray(arr) && arr.length === 0);

    if (!chosen) {
        const sample = candidates[0];
        const sampleType = Array.isArray(sample) && sample.length > 0 ? typeof sample[0] : 'none';
        throw new ReformatExtractionError(
            `Unable to find entry-object array in LLM response. candidateCount=${candidates.length}, firstCandidateItemType=${sampleType}, rawPreview=${text.slice(0, 200)}`,
            batchIndex,
        );
    }

    if (chosen.length > 0 && (typeof chosen[0] !== 'object' || Array.isArray(chosen[0]))) {
        throw new ReformatExtractionError(
            `Parsed array contains non-object items (first type: ${typeof chosen[0]}). Raw: ${JSON.stringify(chosen).slice(0, 120)}`,
            batchIndex,
        );
    }

    return { items: chosen, clean };
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

const HEADER_LINE = /^(#{1,6})\s+(.+)$/;

/**
 * Section titles that are notes for the author rather than world content
 * (the layout world-bible generators use). The prompt also tells the model to
 * skip such sections, but small models often keep them, so they are removed
 * before extraction and listed in the run's warnings.
 */
const AUTHOR_NOTE_HEADINGS = /^(?:settings|canon log|open questions|change ?log|to-?do(?: list)?|author'?s? notes?)$/i;

/** First non-empty line of a section. */
function _firstLine(text) {
    return (text || '').split('\n').map(l => l.trim()).find(Boolean) || 'section';
}

/**
 * A short title for a section, for continuation notes: its first line, cut
 * at a word boundary. Header-less text (a transcript is one long line) would
 * otherwise put the whole section into every continuation prompt.
 */
function _sectionTitle(text, max = 80) {
    const line = _firstLine(text);
    if (line.length <= max) return line;
    const cut = line.slice(0, max);
    return `${cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : max)}…`;
}

/**
 * Splits text into pieces no longer than `target`, cutting at the coarsest
 * boundary available: blank lines, then line breaks, then sentence ends,
 * then spaces, and finally a hard cut (long CJK runs have no spaces). Small
 * neighbouring pieces are packed back together up to `target`.
 * @param {string} text
 * @param {number} target
 * @returns {string[]}
 */
export function splitToFit(text, target) {
    const trimmed = (text || '').trim();
    if (!trimmed) return [];
    if (trimmed.length <= target) return [trimmed];

    const levels = [
        ['\n\n', /\n\s*\n+/],
        ['\n', /\n/],
        [' ', /(?<=[.!?。！？])\s+/],
        [' ', /\s+/],
    ];
    for (const [joiner, splitter] of levels) {
        const parts = trimmed.split(splitter).map(s => s.trim()).filter(Boolean);
        if (parts.length < 2) continue;
        const out = [];
        let current = '';
        for (const piece of parts.flatMap(p => splitToFit(p, target))) {
            if (current && current.length + joiner.length + piece.length > target) {
                out.push(current);
                current = piece;
            } else {
                current = current ? current + joiner + piece : piece;
            }
        }
        if (current) out.push(current);
        return out;
    }

    const out = [];
    for (let i = 0; i < trimmed.length; i += target) out.push(trimmed.slice(i, i + target));
    return out;
}

/**
 * Splits source text into LLM-call-sized batches along header boundaries.
 * A section larger than the budget is split into ordered continuation
 * batches (see _splitToFit). Every batch records the heading path of its
 * first section ("Doc › Part › Section") so the model knows where a batch
 * that starts mid-document sits.
 *
 * Not a final chunk boundary — only keeps one call's output within budget.
 *
 * Sections whose heading matches AUTHOR_NOTE_HEADINGS are skipped together
 * with their subsections.
 *
 * @param {string} text
 * @param {number} targetChars
 * @param {string} [sourceName] - Used as the path root when the text has no top-level title
 * @returns {Promise<{batches: Array<{text: string, headingPath: string, continuation: {sectionTitle: string}|null}>, skippedSections: string[]}>}
 */
async function _buildBatches(text, targetChars, sourceName = '') {
    const sectionChunks = await chunkText(text, { strategy: 'section' });
    const sections = sectionChunks.map(c => (typeof c === 'string' ? c : c.text)).filter(Boolean);

    const hasTopTitle = /^#\s+\S/m.test(text);
    const root = !hasTopTitle && sourceName ? [sourceName] : [];
    /** @type {Array<{level: number, title: string}>} */
    let stack = [];
    const pathOf = () => [...root, ...stack.map(h => h.title)].join(' › ');

    const batches = [];
    let current = '';
    let currentPath = '';

    const flush = () => {
        if (current.trim()) batches.push({ text: current.trim(), headingPath: currentPath, continuation: null });
        current = '';
    };

    const skippedSections = [];
    let skipBelowLevel = 0; // > 0 while inside a skipped author-note section

    for (const section of sections) {
        const header = _firstLine(section).match(HEADER_LINE);
        if (header) {
            const level = header[1].length;
            const title = header[2].replace(/\*+/g, '').trim();
            if (skipBelowLevel && level <= skipBelowLevel) skipBelowLevel = 0;
            if (!skipBelowLevel && AUTHOR_NOTE_HEADINGS.test(title)) {
                skipBelowLevel = level;
                skippedSections.push(title);
            }
            stack = stack.filter(h => h.level < level);
            stack.push({ level, title });
        }
        if (skipBelowLevel) continue;
        const sectionPath = pathOf();

        if (section.length > targetChars) {
            flush();
            const title = _sectionTitle(section);
            splitToFit(section, targetChars).forEach((piece, i) => {
                batches.push({ text: piece, headingPath: sectionPath, continuation: i === 0 ? null : { sectionTitle: title } });
            });
        } else if (current && (current.length + section.length + 2) > targetChars) {
            flush();
            current = section;
            currentPath = sectionPath;
        } else {
            if (!current) currentPath = sectionPath;
            current += (current ? '\n\n' : '') + section;
        }
    }
    flush();

    return { batches, skippedSections };
}

// ---------------------------------------------------------------------------
// Batch processing (ledger)
// ---------------------------------------------------------------------------

/**
 * Finds the ledger entry an extension or a repeated name refers to: by name
 * first, then by alias. `hidden` (when known) restricts the match, since a
 * hidden truth and its public entry are separate entries.
 * @param {object[]} ledger
 * @param {string} name
 * @param {boolean|null} hidden
 * @returns {object|undefined}
 */
function _findLedgerEntry(ledger, name, hidden = null) {
    const keys = _nameKeys(name);
    if (keys.length === 0) return undefined;
    const visible = e => hidden === null || Boolean(e.hidden) === hidden;
    return ledger.find(e => visible(e) && _nameKeys(e.name).some(k => keys.includes(k)))
        || ledger.find(e => visible(e) && _entityKeys(e).some(k => keys.includes(k)));
}

/**
 * Parses, validates and grounding-checks one LLM reply and applies it to the
 * ledger: new entries are appended, {"op": "extend"} items (and new entries
 * that repeat an existing entry's name) are folded into the entry they name.
 * @returns {{added: number, extended: number, clean: boolean, itemCount: number}}
 */
function _applyReply(reply, batch, { ledger, settings, batchIndex, batchLabel }) {
    const threshold = settings.reformat_name_fuzzy_threshold ?? DEFAULT_NAME_FUZZY_THRESHOLD;
    const { items, clean } = _parseReformatArray(reply, batchIndex);
    let added = 0;
    let extended = 0;

    const grounding = record => {
        const [names] = computeNameVerification([record], batch.text, threshold);
        const [keywords] = computeKeywordVerification([record], batch.text);
        return {
            _nameGrounded: names?.nameGrounded ?? true,
            _ungroundedAliases: names?.ungroundedAliases ?? [],
            _ungroundedKeywords: keywords?.ungroundedKeywords ?? [],
        };
    };

    items.forEach((raw, j) => {
        const item = /** @type {any} */ (raw);
        const isExtend = typeof item?.op === 'string' && item.op.trim().toLowerCase() === 'extend';

        if (isExtend) {
            const { ok, errors, extension } = validateReformatExtension(item);
            if (!ok) {
                log.warn(`[Auto-Reformat] ${batchLabel}, item ${j}: extension skipped — ${errors.join('; ')}`);
                return;
            }
            const hidden = typeof item.hidden === 'boolean' ? item.hidden : null;
            const target = _findLedgerEntry(ledger, extension.name, hidden);
            if (target) {
                // The target's name was grounded when it was created.
                _absorbRecord(target, { ...extension, hidden: target.hidden, ...grounding(extension), _nameGrounded: true });
                extended++;
                return;
            }
            // The model extended something that has no entry: keep the content as a new entry.
            log.warn(`[Auto-Reformat] ${batchLabel}, item ${j}: extension names "${extension.name}", which has no entry — stored as a new entry`);
        }

        const { ok, errors, chunk } = validateReformattedChunk(item);
        if (!ok) {
            log.warn(`[Auto-Reformat] ${batchLabel}, item ${j}: validation failed — ${errors.join('; ')} — skipped`);
            return;
        }
        if (errors.length > 0) {
            log.warn(`[Auto-Reformat] ${batchLabel}, item ${j}: coercion warnings — ${errors.join('; ')}`);
        }
        const record = { ...chunk, ...grounding(chunk) };

        // A "new" entry under a name that already has one is an extension in disguise.
        const existing = ledger.find(e => Boolean(e.hidden) === Boolean(record.hidden)
            && _nameKeys(e.name).some(k => _nameKeys(record.name).includes(k)));
        if (existing) {
            _absorbRecord(existing, record);
            extended++;
        } else {
            ledger.push(record);
            added++;
        }
    });

    return { added, extended, clean, itemCount: items.length };
}

/**
 * Processes the batches in document order against one shared ledger.
 *
 * A reply that is not valid JSON is salvaged (see _parseReformatArray) and
 * the batch is asked for once more; the second reply is used when it parses
 * cleanly, otherwise the salvaged entries are kept and a warning says some
 * may be missing.
 *
 * With `strict` (the whole-document call), an extraction failure or a reply
 * cut off by the output limit is thrown instead of recorded, so the caller
 * can retry or fall back to batches.
 *
 * @returns {Promise<{results: object[], failedCount: number}>}
 */
async function _processBatches(batches, settings, warnings, contentType, { callOptions = {}, strict = false, abortSignal = null, onBatchDone = null } = {}) {
    const ledger = [];
    let failedCount = 0;
    const ledgerDetail = settings.reformat_ledger_detail === 'names' ? 'names' : 'full';
    /** Entries written from the earlier parts of the section being continued. */
    let sectionEntries = new Set();

    for (let i = 0; i < batches.length; i++) {
        if (abortSignal?.aborted) {
            const err = new Error('Auto-Reformat stopped by user');
            err.name = 'AbortError';
            throw err;
        }
        const batch = batches[i];
        const batchLabel = `batch ${i}`;
        if (!batch.continuation) sectionEntries = new Set();
        const before = new Set(ledger);

        const prompt = buildReformatPrompt(batch.text, {
            customPrompt: settings.reformat_custom_prompt,
            headingPath: batch.headingPath,
            contentType,
            batchContext: batch.continuation ? { sectionTitle: batch.continuation.sectionTitle } : null,
            ledgerText: buildLedgerText(ledger, batch.text, { alwaysFull: sectionEntries, detail: ledgerDetail }),
            ledgerDetail,
        });

        const callOnce = async () => {
            const { reply, finishReason } = await _callProviderWithRetry(prompt, settings, i, callOptions);
            if (strict && finishReason === 'length') {
                throw new ReformatTruncatedError('the response was cut off by the model\'s output limit');
            }
            return { reply, finishReason };
        };

        try {
            let { reply, finishReason } = await callOnce();
            // Apply to a copy first, so a malformed reply can be replaced by a retry.
            let trial = ledger.map(e => ({ ...e }));
            let outcome = _applyReply(reply, batch, { ledger: trial, settings, batchIndex: i, batchLabel });

            if (!outcome.clean && finishReason !== 'length') {
                log.warn(`[Auto-Reformat] ${batchLabel}: reply was not valid JSON (${outcome.itemCount} entries salvaged) — asking again`);
                try {
                    const second = await callOnce();
                    const retryTrial = ledger.map(e => ({ ...e }));
                    const retryOutcome = _applyReply(second.reply, batch, { ledger: retryTrial, settings, batchIndex: i, batchLabel });
                    if (retryOutcome.clean || retryOutcome.itemCount > outcome.itemCount) {
                        ({ reply, finishReason } = second);
                        trial = retryTrial;
                        outcome = retryOutcome;
                    }
                } catch (retryErr) {
                    if (retryErr instanceof ReformatFatalError) throw retryErr;
                    log.warn(`[Auto-Reformat] ${batchLabel}: second attempt failed (${retryErr?.message || retryErr}) — keeping the salvaged entries`);
                }
                if (!outcome.clean) {
                    if (strict) throw new ReformatExtractionError('the response was not valid JSON', i);
                    warnings.push(`${batchLabel}: the model's reply was malformed twice; ${outcome.itemCount} entries were recovered from it, but some from this section may be missing.`);
                }
            }
            if (finishReason === 'length') {
                warnings.push(`${batchLabel}: response was truncated by the model's output limit — some entries from this section may be missing. Consider lowering "Batch size (chars)" in Auto-Reformat settings.`);
            }

            ledger.length = 0;
            ledger.push(...trial);
        } catch (err) {
            if (err instanceof ReformatFatalError || strict) throw err;
            failedCount++;
            warnings.push(`${batchLabel} failed: ${err?.message || err} — skipped, other batches continue.`);
            log.warn(`[Auto-Reformat] ${batchLabel} failed:`, err?.message || err);
        }

        // Entries are copied on every batch, so track this section's by name.
        const sectionNames = new Set([...sectionEntries].map(e => e.name));
        const beforeNames = new Set([...before].map(e => e.name));
        sectionEntries = new Set(ledger.filter(e => sectionNames.has(e.name) || !beforeNames.has(e.name)));
        onBatchDone?.(i + 1);
    }

    return { results: ledger, failedCount };
}

// ---------------------------------------------------------------------------
// Duplicate-entity merge
// ---------------------------------------------------------------------------

/**
 * Match keys for a name: lowercased, a leading "the" dropped, and a trailing
 * parenthetical acronym split off as a key of its own, so "The Gender War" =
 * "Gender War" and "Gender Authentication Registry System (GARS)" matches
 * both its long form and "GARS".
 * @param {string} name
 * @returns {string[]}
 */
function _nameKeys(name) {
    let base = String(name || '').trim().replace(/\s+/g, ' ');
    if (!base) return [];
    const keys = [];
    const acronym = base.match(/\s*\(([A-Z][A-Z0-9.&-]{1,11})\)$/);
    if (acronym) {
        base = base.slice(0, acronym.index).trim();
        keys.push(acronym[1].toLowerCase());
    }
    base = base.toLowerCase().replace(/^the\s+/, '');
    if (base) keys.unshift(base);
    return keys;
}

/** All match keys for a record: its name plus every alias. */
function _entityKeys(record) {
    return [record?.name, ...(Array.isArray(record?.aliases) ? record.aliases : [])].flatMap(_nameKeys);
}

/** Dedup key for a relationship; tolerates legacy plain-string entries. */
function _relationshipKey(rel) {
    if (typeof rel === 'string') return rel.trim().toLowerCase();
    return `${(rel?.target || '').trim().toLowerCase()}|${(rel?.type || '').trim().toLowerCase()}`;
}

/** Relationship target, for "already linked" checks. */
function _relationshipTarget(rel) {
    return (typeof rel === 'string' ? rel : rel?.target || '').trim().toLowerCase();
}

// Abbreviations and initials that end with a period but don't end a sentence.
const NON_TERMINAL_ABBREVIATION = /(?:\b(?:Dr|Mr|Mrs|Ms|Mx|St|Jr|Sr|Prof|Gen|Col|Lt|Sgt|Capt|Rev|Hon|Mt|No|vs|etc|approx|e\.g|i\.e)|\b[A-Z])\.$/;

/**
 * Splits prose into sentences without breaking after abbreviations such as
 * "Dr." or initials.
 * @param {string} text
 * @returns {string[]}
 */
function _splitSentences(text) {
    const pieces = String(text || '').split(/(?<=[.!?。！？]["”’)]?)\s+/);
    const out = [];
    for (const piece of pieces) {
        if (out.length && NON_TERMINAL_ABBREVIATION.test(out[out.length - 1])) {
            out[out.length - 1] += ' ' + piece;
        } else {
            out.push(piece);
        }
    }
    return out.map(s => s.trim()).filter(Boolean);
}

/**
 * True when `sentence` adds nothing to the merged text: it is contained in
 * it, or at least 85% of its words already appear AND every number and
 * capitalized word in it already appears (so a restatement is dropped but a
 * sentence with one new name or figure is kept).
 * @param {string} sentence
 * @param {string} mergedNorm - normalizeForMatch of the merged text
 * @param {Set<string>} mergedWords
 * @returns {boolean}
 */
function _isRestatement(sentence, mergedNorm, mergedWords) {
    const norm = normalizeForMatch(sentence);
    if (!norm) return true;
    if (mergedNorm.includes(norm)) return true;

    const words = norm.split(' ').filter(w => w.length > 3);
    if (words.length === 0) return false;
    const shared = words.filter(w => mergedWords.has(w)).length / words.length;
    if (shared < 0.85) return false;

    const details = (sentence.match(/\d[\d,.]*|(?<!^)\b\p{Lu}[\p{L}'’-]*/gu) || [])
        .map(normalizeForMatch)
        .flatMap(d => d.split(' '))
        .filter(Boolean);
    return details.every(d => mergedWords.has(d));
}

/**
 * Lossless body merge: keeps the longer body, then appends each sentence of
 * the other body that isn't a restatement of what is already there
 * (grouped by the paragraph it came from).
 * @param {string} bodyA
 * @param {string} bodyB
 * @returns {string}
 */
function _mergeBodies(bodyA, bodyB) {
    const a = (bodyA || '').trim();
    const b = (bodyB || '').trim();
    if (!a) return b;
    if (!b) return a;

    const [primary, secondary] = b.length > a.length ? [b, a] : [a, b];

    let merged = primary;
    let mergedNorm = normalizeForMatch(merged);
    const mergedWords = new Set(mergedNorm.split(' '));

    for (const para of secondary.split(/\n\n+/).map(p => p.trim()).filter(Boolean)) {
        const novel = _splitSentences(para).filter(s => !_isRestatement(s, mergedNorm, mergedWords));
        if (novel.length === 0) continue;
        const addition = novel.join(' ');
        merged += '\n\n' + addition;
        const additionNorm = normalizeForMatch(addition);
        mergedNorm += ' ' + additionNorm;
        for (const w of additionNorm.split(' ')) mergedWords.add(w);
    }
    return merged;
}

/** Case-insensitive union of two string arrays, keeping first-seen casing. */
function _unionStrings(a, b) {
    const seen = new Set();
    const out = [];
    for (const s of [...a, ...b]) {
        const key = (typeof s === 'string' ? s : '').trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(s.trim());
    }
    return out;
}

/**
 * Merges duplicate records that got past the ledger (the model writing a
 * second entry under a different spelling, or whole-document replies).
 *
 * Two records merge when their names match after normalization (see
 * _nameKeys), whatever their entry_type, or when a name or alias matches
 * within the same entry_type. Aliases are model-generated and occasionally
 * wrong, so they alone never merge records of different types.
 *
 * A second pass folds "<Section>: <Thing>" records into the record named
 * <Thing> when one exists: that is the model prefixing a named thing, not a
 * real sub-entry. The plain name is kept.
 *
 * Policy: union aliases/keywords/relationships, first non-empty
 * affiliation, hidden if either is, and a lossless body merge.
 *
 * @param {object[]} chunks - Validated records, document order
 * @returns {object[]} Merged records, first-occurrence order
 */
export function mergeDuplicateEntities(chunks) {
    if (!Array.isArray(chunks) || chunks.length < 2) return Array.isArray(chunks) ? chunks : [];

    /** @type {Map<string, object>} normalized primary-name key → record */
    const byName = new Map();
    /** @type {Map<string, object>} `${entry_type}::${name-or-alias key}` → record */
    const byTypedKey = new Map();
    let merged = [];

    const register = (record, source) => {
        for (const k of _nameKeys(source.name)) if (!byName.has(k)) byName.set(k, record);
        for (const k of _entityKeys(source)) byTypedKey.set(`${source.entry_type || 'other'}::${k}`, record);
    };

    for (const record of chunks) {
        const type = record?.entry_type || 'other';
        // A hidden truth never merges into a public entry (or vice versa).
        const sameVisibility = r => Boolean(r) && Boolean(r.hidden) === Boolean(record?.hidden);
        const existing = _nameKeys(record?.name).map(k => byName.get(k)).find(sameVisibility)
            || _entityKeys(record).map(k => byTypedKey.get(`${type}::${k}`)).find(sameVisibility);

        if (!existing) {
            const copy = { ...record };
            merged.push(copy);
            register(copy, copy);
            continue;
        }
        _absorbRecord(existing, record);
        register(existing, record);
    }

    const prefixedNameKeys = name => {
        const idx = String(name || '').lastIndexOf(': ');
        return idx > 0 ? _nameKeys(name.slice(idx + 2)) : [];
    };
    const absorbed = new Set();
    for (const r of merged) {
        const target = prefixedNameKeys(r.name).map(k => byName.get(k)).find(t => t && t !== r && !absorbed.has(t) && Boolean(t.hidden) === Boolean(r.hidden));
        if (!target) continue;
        _absorbRecord(target, r);
        absorbed.add(r);
    }
    merged = merged.filter(r => !absorbed.has(r));

    // A relationship pointing at the record itself (e.g. after an alias merge) says nothing.
    for (const r of merged) {
        const own = new Set(_entityKeys(r));
        r.relationships = (r.relationships || []).filter(rel => !_nameKeys(_relationshipTarget(rel)).some(k => own.has(k)));
    }

    return merged;
}

/**
 * Absorbs `record` into `existing` in place; `existing` keeps its name, type
 * and position.
 * @param {object} existing
 * @param {object} record
 */
function _absorbRecord(existing, record) {
    const existingName = existing.name.trim().toLowerCase();
    const incomingNames = record.name && record.name.trim().toLowerCase() !== existingName ? [record.name] : [];
    existing.aliases = _unionStrings(existing.aliases || [], [...incomingNames, ...(record.aliases || [])])
        .filter(a => a.toLowerCase() !== existingName);
    existing.keywords = _unionStrings(
        (existing.keywords || []).map(k => (typeof k === 'string' ? k : k?.text || '')),
        (record.keywords || []).map(k => (typeof k === 'string' ? k : k?.text || '')),
    );

    if (!existing.affiliation && record.affiliation) existing.affiliation = record.affiliation;
    existing.hidden = Boolean(existing.hidden) || Boolean(record.hidden);
    existing.body = _mergeBodies(existing.body, record.body);

    const relSeen = new Set((existing.relationships || []).map(_relationshipKey));
    for (const rel of record.relationships || []) {
        const key = _relationshipKey(rel);
        if (!key || relSeen.has(key)) continue;
        relSeen.add(key);
        existing.relationships = [...(existing.relationships || []), rel];
    }

    existing._nameGrounded = Boolean(existing._nameGrounded) || Boolean(record._nameGrounded);
    existing._ungroundedAliases = _unionStrings(existing._ungroundedAliases || [], record._ungroundedAliases || []);
    existing._ungroundedKeywords = _unionStrings(existing._ungroundedKeywords || [], record._ungroundedKeywords || []);
}

/**
 * Adds a "is part of" relationship from every "<Parent>: <Part>" entry to
 * its parent entry when the parent exists and the two aren't linked yet.
 * Done in code because the prompt's naming rule already encodes it.
 * @param {object[]} records - Merged records (mutated)
 * @returns {number} Relationships added
 */
export function linkSubEntriesToParents(records) {
    const byKey = new Map();
    for (const r of records) for (const k of _entityKeys(r)) if (!byKey.has(k)) byKey.set(k, r);

    let added = 0;
    for (const r of records) {
        const idx = String(r.name || '').indexOf(':');
        if (idx <= 0) continue;
        const parent = _nameKeys(r.name.slice(0, idx)).map(k => byKey.get(k)).find(Boolean);
        if (!parent || parent === r) continue;
        const parentKeys = new Set(_entityKeys(parent));
        const alreadyLinked = (r.relationships || []).some(rel => _nameKeys(_relationshipTarget(rel)).some(k => parentKeys.has(k)));
        if (alreadyLinked) continue;
        // Target the parent as written in this entry's name: it still resolves
        // to the parent (by name or alias), and buildStoredText recognises it
        // as the name's own prefix and doesn't restate it.
        r.relationships = [...(r.relationships || []), { target: r.name.slice(0, idx).trim(), type: 'is part of' }];
        added++;
    }
    return added;
}

// ---------------------------------------------------------------------------
// Optional cross-batch linking pass
// ---------------------------------------------------------------------------

/**
 * Cleans a name the model returned in the linking pass: drops a trailing
 * "[type]" or "(…)" annotation and an "also called" tail some models copy
 * from the catalog line.
 * @param {unknown} raw
 * @returns {string}
 */
function _cleanLinkName(raw) {
    return String(raw || '')
        .replace(/\s+\(?also called:.*$/i, '')
        .replace(/\s*\[[^\]]*\]\s*$/, '')
        .trim();
}

/**
 * Second LLM pass (opt-in via settings.reformat_enable_linking_pass) that
 * backfills relationships the per-batch extraction cannot see: each batch
 * only knows its own text, so a connection between entries extracted in
 * different batches is invisible to both calls.
 *
 * A link is applied only when both ends resolve to a merged record, they are
 * different records, and neither already has a relationship to the other
 * (so the pass adds missing connections instead of rewording existing ones).
 * Per-batch failures are non-fatal warnings.
 *
 * @param {object} params
 * @param {Array<{text: string}>} params.batches
 * @param {object[]} params.records - Merged records (mutated)
 * @param {object} params.settings
 * @param {string[]} params.warnings
 * @param {number} params.concurrency
 * @param {AbortSignal|null} params.abortSignal
 * @param {(() => void)|null} params.onTick
 * @param {{maxTokens?: number, timeoutMs?: number}} [params.callOptions] - Reasoning-effort overrides (see _batchCallOptions)
 * @returns {Promise<{applied: number, dropped: number}>}
 */
async function _runLinkingPass({ batches, records, settings, warnings, concurrency, abortSignal = null, onTick = null, callOptions = {} }) {
    const catalog = records.map(r => ({ name: r.name, aliases: r.aliases || [] }));

    /** @type {Map<string, object>} name/alias key → record (first registration wins) */
    const resolver = new Map();
    for (const r of records) {
        for (const key of _entityKeys(r)) {
            if (!resolver.has(key)) resolver.set(key, r);
        }
    }
    const resolve = raw => {
        const cleaned = _cleanLinkName(raw);
        return [cleaned, cleaned.replace(/\s*\([^)]*\)\s*$/, '')]
            .flatMap(_nameKeys)
            .map(k => resolver.get(k))
            .find(Boolean);
    };
    const linked = (from, to) => {
        const toKeys = new Set(_entityKeys(to));
        return (from.relationships || []).some(rel => _nameKeys(_relationshipTarget(rel)).some(k => toKeys.has(k)));
    };

    let applied = 0;
    let dropped = 0;

    const linkFns = batches.map((batch, i) => async () => {
        if (abortSignal?.aborted) {
            const err = new Error('Auto-Reformat stopped by user');
            err.name = 'AbortError';
            throw err;
        }
        try {
            const prompt = buildLinkingPrompt(batch.text, catalog);
            const { reply } = await _callProviderWithRetry(prompt, settings, i, callOptions);
            const { items: triples } = _parseReformatArray(reply, i, ['source', 'target']);

            for (const t of triples) {
                const source = resolve((/** @type {any} */ (t))?.source);
                const target = resolve((/** @type {any} */ (t))?.target);
                if (!source || !target) {
                    dropped++;
                    continue;
                }
                if (source === target || linked(source, target) || linked(target, source)) continue;
                const type = String((/** @type {any} */ (t))?.type || '').trim();
                source.relationships = [...(source.relationships || []), { target: target.name, type }];
                applied++;
            }
        } catch (err) {
            if (err instanceof ReformatFatalError || err?.name === 'AbortError') throw err;
            warnings.push(`Linking pass, batch ${i}: ${err?.message || err} — skipped, extraction results are unaffected.`);
            log.warn(`[Auto-Reformat] Linking pass batch ${i} failed:`, err?.message || err);
        }
        onTick?.();
    });

    await AsyncUtils.parallel(linkFns, concurrency);
    log.lifecycle(`[Auto-Reformat] Linking pass: ${applied} relationship(s) added, ${dropped} unresolvable link(s) dropped`);
    if (dropped > 0 && dropped >= applied) {
        warnings.push(`Linking pass: ${dropped} suggested link(s) named entries that don't exist and were ignored.`);
    }
    return { applied, dropped };
}

// ---------------------------------------------------------------------------
// Whole-document mode
// ---------------------------------------------------------------------------

/** @type {Map<string, {contextLength: number|null, maxOutputTokens: number|null}|null>} */
const _modelLimitsCache = new Map();

/**
 * Context and output limits of an OpenRouter model, from OpenRouter's public
 * model list. Null when unknown (vLLM, an unlisted model, or no network);
 * the whole-document call is then attempted without a pre-check.
 * @param {object} settings
 * @returns {Promise<{contextLength: number|null, maxOutputTokens: number|null}|null>}
 */
async function _getModelLimits(settings) {
    if (_resolveProvider(settings) === 'vllm') return null;
    const model = _resolveModel(settings);
    if (!model) return null;
    if (_modelLimitsCache.has(model)) return _modelLimitsCache.get(model);

    let limits = null;
    try {
        const response = await fetch('https://openrouter.ai/api/v1/models', { method: 'GET', signal: AbortSignal.timeout(15000) });
        const data = response?.ok ? await response.json() : null;
        const entry = Array.isArray(data?.data) ? data.data.find(m => m?.id === model) : null;
        if (entry) {
            limits = {
                contextLength: Number(entry.context_length) || null,
                maxOutputTokens: Number(entry.top_provider?.max_completion_tokens) || null,
            };
        }
    } catch (err) {
        log.verbose(`[Auto-Reformat] Could not read model limits for ${model}: ${err?.message || err}`);
    }
    _modelLimitsCache.set(model, limits);
    return limits;
}

/**
 * Rough token count: CJK characters are about one token each, other text
 * about four characters per token.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
    const str = String(text || '');
    const cjk = (str.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/g) || []).length;
    return Math.ceil(cjk + (str.length - cjk) / 4);
}

/**
 * Why the whole document can't go out in one call, or null when it fits
 * (or the limits are unknown).
 * @param {string} text
 * @param {{contextLength: number|null, maxOutputTokens: number|null}|null} limits
 * @param {string} [reasoningEffort] - Reserves THINKING_RESERVE_TOKENS for it
 * @returns {string|null}
 */
function wholeDocumentMisfit(text, limits, reasoningEffort = '') {
    if (!limits) return null;
    const inputTokens = estimateTokens(text) + PROMPT_OVERHEAD_TOKENS;
    const thinkingTokens = THINKING_RESERVE_TOKENS[reasoningEffort] || 0;
    const outputTokens = Math.ceil(estimateTokens(text) * SINGLE_PASS_OUTPUT_RATIO) + thinkingTokens;
    const thinkingNote = thinkingTokens ? `, including ~${thinkingTokens.toLocaleString()} for thinking` : '';
    if (limits.contextLength && inputTokens + outputTokens > limits.contextLength) {
        return `the document (~${inputTokens.toLocaleString()} tokens) plus its entries (~${outputTokens.toLocaleString()} tokens${thinkingNote}) exceed the model's ${limits.contextLength.toLocaleString()}-token context`;
    }
    if (limits.maxOutputTokens && outputTokens > limits.maxOutputTokens) {
        return `its entries (~${outputTokens.toLocaleString()} tokens${thinkingNote}) would exceed the model's ${limits.maxOutputTokens.toLocaleString()}-token output limit`;
    }
    return null;
}

/**
 * Call overrides for batches when a reasoning effort is set: thinking tokens
 * come out of max_tokens, so the batch gets the model's own output limit (or
 * Max Output Tokens plus the thinking reserve when the limit is unknown), and
 * at least REASONING_MIN_TIMEOUT_MS. Without an effort, batches keep the
 * settings as they are.
 * @param {object} settings
 * @param {{maxOutputTokens: number|null}|null} limits
 * @returns {{maxTokens?: number, timeoutMs?: number}}
 */
function _batchCallOptions(settings, limits) {
    const effort = _resolveReasoningEffort(settings);
    if (!effort) return {};
    return {
        maxTokens: limits?.maxOutputTokens
            || (settings.reformat_max_output_tokens || DEFAULT_MAX_TOKENS) + THINKING_RESERVE_TOKENS[effort],
        timeoutMs: Math.max(settings.reformat_timeout_ms || DEFAULT_TIMEOUT_MS, REASONING_MIN_TIMEOUT_MS),
    };
}

/**
 * Sends the whole document in one call, twice at most. Batch size and the
 * Max Output Tokens setting don't apply: max_tokens is the model's own
 * output limit. Returns null when both attempts fail or the reply was cut
 * off, so the caller falls back to batches.
 * @returns {Promise<{results: object[]}|null>}
 */
async function _runWholeDocument({ batch, settings, warnings, contentType, onProgress, abortSignal }) {
    const limits = await _getModelLimits(settings);
    const misfit = wholeDocumentMisfit(batch.text, limits, _resolveReasoningEffort(settings));
    if (misfit) {
        warnings.push(`Whole-document mode skipped: ${misfit}. The document was processed in batches instead.`);
        log.lifecycle(`[Auto-Reformat] Whole-document mode skipped: ${misfit}`);
        return null;
    }

    const callOptions = {
        maxTokens: limits?.maxOutputTokens ?? null,
        timeoutMs: settings.reformat_single_pass_timeout_ms || DEFAULT_SINGLE_PASS_TIMEOUT_MS,
        maxAttempts: 1,
    };
    const failures = [];
    for (let attempt = 1; attempt <= SINGLE_PASS_ATTEMPTS; attempt++) {
        if (abortSignal?.aborted) {
            const err = new Error('Auto-Reformat stopped by user');
            err.name = 'AbortError';
            throw err;
        }
        onProgress?.(attempt, SINGLE_PASS_ATTEMPTS, 'whole');
        const attemptWarnings = [];
        try {
            const { results } = await _processBatches([batch], settings, attemptWarnings, contentType, { callOptions, strict: true, abortSignal });
            warnings.push(...attemptWarnings);
            log.lifecycle(`[Auto-Reformat] Whole-document attempt ${attempt} succeeded: ${results.length} entries`);
            return { results };
        } catch (err) {
            if (err instanceof ReformatFatalError || err?.name === 'AbortError') throw err;
            failures.push(`attempt ${attempt}: ${err?.message || err}`);
            log.warn(`[Auto-Reformat] Whole-document attempt ${attempt} failed:`, err?.message || err);
            // The same document hits the same output limit again.
            if (err instanceof ReformatTruncatedError) break;
        }
    }
    warnings.push(`Whole-document mode failed (${failures.join('; ')}). The document was processed in batches instead.`);
    return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Restructures source text into entries.
 *
 * Header-aligned batches are processed in order against a shared ledger of
 * the entries written so far. Whole-document mode
 * (settings.reformat_single_pass, off by default) sends the document in one
 * call and tries it twice; when both fail, or the document can't fit the
 * model, it falls back to the batches.
 *
 * @param {object} params
 * @param {string} params.text - Full prepared source text
 * @param {string} params.contentType - 'document' | 'url' | 'wiki' | 'youtube'
 * @param {object} params.settings - VectFox settings
 * @param {string} [params.sourceName] - Shown to the model as the root of each batch's heading path
 * @param {(processed: number, total: number, phase?: 'whole'|'extract'|'link') => void} [params.onProgress]
 * @param {AbortSignal} [params.abortSignal]
 * @returns {Promise<{chunks: object[], warnings: string[], batchesProcessed: number, batchesFailed: number, totalBatches: number, mode: 'whole'|'batched'}>}
 */
export async function reformatDocument({ text, contentType, settings, sourceName = '', onProgress = null, abortSignal = null } = {}) {
    if (!text || typeof text !== 'string' || !text.trim()) {
        return { chunks: [], warnings: ['No text to reformat.'], batchesProcessed: 0, batchesFailed: 0, totalBatches: 0, mode: 'batched' };
    }

    const warnings = [];
    const concurrency = Math.max(1, Math.min(8, settings.reformat_concurrency || DEFAULT_CONCURRENCY));
    const linkingEnabled = Boolean(settings.reformat_enable_linking_pass);

    let rawChunks = null;
    let mode = 'batched';
    let batches = [];
    let skippedSections = [];
    let batchesProcessed = 0;
    let batchesFailed = 0;
    let batchCallOptions = {};

    if (settings.reformat_single_pass === true) {
        const whole = await _buildBatches(text, Infinity, sourceName);
        skippedSections = whole.skippedSections;
        if (whole.batches.length === 0) {
            return { chunks: [], warnings: ['No content found to reformat.'], batchesProcessed: 0, batchesFailed: 0, totalBatches: 0, mode };
        }
        log.lifecycle(`[Auto-Reformat] Starting: ${contentType}, whole document in one call (${whole.batches[0].text.length} chars)`);
        // The heading path _buildBatches records is the FIRST section's; the
        // whole document sits under the document itself.
        const wholeBatch = { ...whole.batches[0], headingPath: sourceName };
        const outcome = await _runWholeDocument({ batch: wholeBatch, settings, warnings, contentType, onProgress, abortSignal });
        if (outcome) {
            rawChunks = outcome.results;
            batches = whole.batches;
            batchesProcessed = 1;
            mode = 'whole';
        }
    }

    if (!rawChunks) {
        const targetChars = settings.reformat_batch_chars || DEFAULT_BATCH_CHARS;
        ({ batches, skippedSections } = await _buildBatches(text, targetChars, sourceName));
        if (batches.length === 0) {
            return { chunks: [], warnings: ['No content found to reformat.'], batchesProcessed: 0, batchesFailed: 0, totalBatches: 0, mode };
        }

        batchCallOptions = _batchCallOptions(settings, _resolveReasoningEffort(settings) ? await _getModelLimits(settings) : null);
        log.lifecycle(`[Auto-Reformat] Starting: ${contentType}, ${batches.length} batch(es), one after another${linkingEnabled ? ', linking pass enabled' : ''}`);

        const outcome = await _processBatches(batches, settings, warnings, contentType, {
            callOptions: batchCallOptions,
            abortSignal,
            onBatchDone: done => {
                batchesProcessed = done;
                onProgress?.(done, batches.length, 'extract');
            },
        });
        rawChunks = outcome.results;
        batchesFailed = outcome.failedCount;
    }

    const totalBatches = batches.length;
    if (skippedSections.length > 0) {
        warnings.unshift(`Skipped author-note section(s): ${skippedSections.map(t => `"${t}"`).join(', ')}.`);
    }

    const chunks = mergeDuplicateEntities(rawChunks);
    if (chunks.length < rawChunks.length) {
        warnings.push(`Merged ${rawChunks.length - chunks.length} duplicate entries (${rawChunks.length} → ${chunks.length} records) — the same entity was written under more than one name or type.`);
    }
    linkSubEntriesToParents(chunks);

    // The linking pass connects entries that separate batches couldn't see
    // together; a whole-document call already saw everything.
    if (linkingEnabled && mode === 'batched' && chunks.length > 0) {
        let linkBatchesDone = 0;
        await _runLinkingPass({
            batches,
            records: chunks,
            settings,
            warnings,
            concurrency,
            abortSignal,
            callOptions: batchCallOptions,
            onTick: () => {
                linkBatchesDone++;
                onProgress?.(linkBatchesDone, totalBatches, 'link');
            },
        });
    }

    // Coverage check: which paragraphs' distinctive facts are in no entry?
    // Reported for the user to review; it makes no LLM call.
    if (settings.reformat_enable_repair_pass !== false && chunks.length > 0) {
        const threshold = settings.reformat_coverage_threshold ?? DEFAULT_COVERAGE_THRESHOLD;
        const flagged = computeBatchCoverage(batches.map(b => b.text).join('\n\n'), chunks, threshold);
        if (flagged.length > 0) {
            const shown = flagged.slice(0, COVERAGE_MAX_REPORTED_SECTIONS)
                .map(f => `"${f.title}"${f.missingFacts.length ? ` (not found: ${f.missingFacts.slice(0, 5).join('; ')})` : ''}`);
            const more = flagged.length > shown.length ? `, and ${flagged.length - shown.length} more` : '';
            warnings.push(`Coverage check: ${flagged.length} paragraph(s) may be missing detail — ${shown.join(', ')}${more}. Compare these sections with their entries before accepting.`);
        }
        log.lifecycle(`[Auto-Reformat] Coverage check: ${flagged.length} under-covered paragraph(s)`);
    }

    log.lifecycle(`[Auto-Reformat] Complete (${mode}): ${chunks.length} entries extracted from ${totalBatches} batch(es), ${batchesFailed} batch failure(s), ${warnings.length} warning(s)`);

    return { chunks, warnings, batchesProcessed, batchesFailed, totalBatches, mode };
}

// ---------------------------------------------------------------------------
// Oversized-entity fallback (used at Accept time by ui/content-vectorizer.js)
// ---------------------------------------------------------------------------

/**
 * If an accepted record's body exceeds maxBodyChars, splits it with the
 * adaptive splitter into pieces that all carry the parent record's fields
 * plus subChunkIndex/subChunkTotal. Returns [chunk] when no split is needed.
 *
 * @param {object} chunk - An accepted record
 * @param {number} maxBodyChars
 * @returns {Promise<object[]>}
 */
export async function expandOversizedChunk(chunk, maxBodyChars) {
    if (!chunk?.body || chunk.body.length <= maxBodyChars) {
        return [chunk];
    }
    const subChunks = await chunkText(chunk.body, { strategy: 'adaptive', chunkSize: maxBodyChars });
    const total = subChunks.length;
    return subChunks.map((sc, i) => ({
        ...chunk,
        body: typeof sc === 'string' ? sc : sc.text,
        subChunkIndex: i,
        subChunkTotal: total,
    }));
}
