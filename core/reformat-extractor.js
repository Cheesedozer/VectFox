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
 * Optional whole-document mode (settings.reformat_single_pass) sends the
 * document to the model in ONE call, so every entry is written with the full
 * document in view. That call is tried twice; if both fail (or the document
 * can't fit the model's context/output limits) the run falls back to the
 * batched path below. It is off by default because it depends on the model:
 * measured on a 31k-character world bible, Claude Haiku 5.5 (medium effort)
 * kept 99% of the source's facts in one reply with no duplicate entries,
 * while Gemini 3.5 Flash Lite and 3.8 Flash summarized (~88%, against ~98%
 * for Flash Lite in batches).
 *
 * Optional roster mode (settings.reformat_roster) reads the document part by
 * part first and builds a ROSTER: one item per thing, under one name, with
 * the batches that describe it. The batches then extract as usual, each told
 * the roster's names and the items it covers, and the pieces of an item are
 * joined under its roster name. Every call stays small, so it works for
 * documents of any length. Measured on a 300-page book with Claude Haiku
 * 5.5, it matched batched recall with 3 judged duplicate pairs instead of
 * 34 and 881 entries instead of 1380 (far fewer "<Hero>: <one episode>"
 * fragments), at ~1.7x the cost and ~3x the time (the roster is built
 * sequentially). See tools/reformat-bench/README.md.
 *
 * settings.reformat_reasoning_effort ('' = model default) sets the thinking
 * level. Thinking tokens count against the output limit, so with an effort
 * set every call gets more output room and a longer timeout.
 *
 * Returns { chunks, warnings, batchesProcessed, batchesFailed, totalBatches, mode }
 * (mode: 'whole' | 'roster' | 'batched').
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
    REFORMAT_ENTRY_TYPES,
    validateReformattedChunk,
    buildReformatPrompt,
    buildLinkingPrompt,
    buildRepairPrompt,
    buildRosterPrompt,
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
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_NAME_FUZZY_THRESHOLD = 0.8;
const DEFAULT_COVERAGE_THRESHOLD = 0.5;
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

// Roster mode: source chars per roster call (a reply lists ~0.5 tokens of
// roster per source token, plus thinking), the cap on the roster's name list
// in a prompt, and the call budget (measured roster replies reached ~25k
// tokens including thinking, and ~3 minutes).
const ROSTER_PART_CHARS = 60000;
const ROSTER_NAMES_MAX_CHARS = 60000;
const ROSTER_MIN_OUTPUT_TOKENS = 32000;
const ROSTER_MIN_TIMEOUT_MS = 300000;

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
 * @returns {unknown[]}
 */
function _parseReformatArray(raw, batchIndex = -1, keyFields = ['entry_type', 'name', 'body']) {
    let text = (raw || '').trim();

    if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    if (!text) {
        throw new ReformatExtractionError('Empty LLM response', batchIndex);
    }

    /** @type {unknown[][]} */
    const candidates = [];

    // 1) Direct parse first.
    try {
        const direct = JSON.parse(text);
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
    const chosen = candidates.find(isReformatArray) ?? candidates.find(arr => Array.isArray(arr) && arr.length === 0);

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

    return chosen;
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

/**
 * Groups batches into ordered "chains": a continuation batch runs after the
 * batch it continues (so it can be told which names were already
 * extracted); independent chains run concurrently.
 * @param {Array<{text: string, continuation: object|null}>} batches
 * @returns {Array<Array<object>>}
 */
function _groupIntoChains(batches) {
    const chains = [];
    let current = null;
    for (const b of batches) {
        if (b.continuation && current) {
            current.push(b);
        } else {
            current = [b];
            chains.push(current);
        }
    }
    return chains;
}

// ---------------------------------------------------------------------------
// Chain processing
// ---------------------------------------------------------------------------

/**
 * Parses, validates, and grounding-checks one LLM reply, appending the
 * surviving records to `results` and their names to `alreadyExtractedNames`.
 * @returns {number} How many records were appended
 */
function _ingestReply(reply, batch, { results, alreadyExtractedNames, settings, chainIndex, batchLabel }) {
    const threshold = settings.reformat_name_fuzzy_threshold ?? DEFAULT_NAME_FUZZY_THRESHOLD;

    const rawArray = _parseReformatArray(reply, chainIndex);
    const validatedForBatch = [];
    for (let j = 0; j < rawArray.length; j++) {
        const { ok, errors, chunk } = validateReformattedChunk(rawArray[j]);
        if (!ok) {
            log.warn(`[Auto-Reformat] ${batchLabel}, item ${j}: validation failed — ${errors.join('; ')} — skipped`);
            continue;
        }
        if (errors.length > 0) {
            log.warn(`[Auto-Reformat] ${batchLabel}, item ${j}: coercion warnings — ${errors.join('; ')}`);
        }
        validatedForBatch.push(chunk);
    }

    const verification = computeNameVerification(validatedForBatch, batch.text, threshold);
    const keywordVerification = computeKeywordVerification(validatedForBatch, batch.text);
    validatedForBatch.forEach((chunk, j) => {
        results.push({
            ...chunk,
            _nameGrounded: verification[j]?.nameGrounded ?? true,
            _ungroundedAliases: verification[j]?.ungroundedAliases ?? [],
            _ungroundedKeywords: keywordVerification[j]?.ungroundedKeywords ?? [],
        });
        alreadyExtractedNames.push(chunk.name);
    });
    return validatedForBatch.length;
}

/**
 * Processes one chain sequentially. After each batch, computeBatchCoverage
 * checks that the batch's distinctive facts landed in the records; flagged
 * sections get ONE repair call. Repair failures are non-fatal.
 *
 * With `strict` (the whole-document call), an extraction failure or a reply
 * cut off by the output limit is thrown instead of recorded, so the caller
 * can retry or fall back to batches.
 */
async function _processChain(chain, settings, chainIndex, warnings, contentType, { callOptions = {}, strict = false } = {}) {
    const results = [];
    let failedCount = 0;
    let repairCalls = 0;
    const alreadyExtractedNames = [];
    const repairEnabled = settings.reformat_enable_repair_pass !== false;
    const coverageThreshold = settings.reformat_coverage_threshold ?? DEFAULT_COVERAGE_THRESHOLD;

    for (let i = 0; i < chain.length; i++) {
        const batch = chain[i];
        const batchLabel = chain.length > 1 ? `chain ${chainIndex} part ${i + 1}/${chain.length}` : `batch ${chainIndex}`;
        const batchContext = batch.continuation
            ? { sectionTitle: batch.continuation.sectionTitle, alreadyExtractedNames: [...alreadyExtractedNames] }
            : null;
        const prompt = buildReformatPrompt(batch.text, {
            customPrompt: settings.reformat_custom_prompt,
            headingPath: batch.headingPath,
            contentType,
            batchContext,
            roster: batch.roster || null,
        });

        try {
            const { reply, finishReason } = await _callProviderWithRetry(prompt, settings, chainIndex, callOptions);
            if (strict && finishReason === 'length') {
                throw new ReformatTruncatedError('the response was cut off by the model\'s output limit');
            }
            if (finishReason === 'length') {
                warnings.push(`${batchLabel}: response was truncated by the model's output limit — some entries from this section may be missing. Consider lowering "Batch size (chars)" in Auto-Reformat settings.`);
            }

            _ingestReply(reply, batch, { results, alreadyExtractedNames, settings, chainIndex, batchLabel });
        } catch (err) {
            if (err instanceof ReformatFatalError || strict) throw err;
            failedCount++;
            warnings.push(`${batchLabel} failed: ${err?.message || err} — skipped, other batches continue.`);
            log.warn(`[Auto-Reformat] ${batchLabel} failed:`, err?.message || err);
            continue;
        }

        if (!repairEnabled) continue;
        const flagged = computeBatchCoverage(batch.text, results, coverageThreshold);
        if (flagged.length === 0) continue;

        const flaggedTitles = flagged.map(s => `"${s.title}"`).join(', ');
        log.lifecycle(`[Auto-Reformat] ${batchLabel}: ${flagged.length} under-captured section(s) (${flaggedTitles}) — issuing repair call`);
        try {
            const repairPrompt = buildRepairPrompt(flagged, {
                customPrompt: settings.reformat_custom_prompt,
                alreadyExtractedNames: [...alreadyExtractedNames],
                headingPath: batch.headingPath,
                contentType,
                roster: batch.roster || null,
            });
            const { reply: repairReply } = await _callProviderWithRetry(repairPrompt, settings, chainIndex, { ...callOptions, maxAttempts: undefined });
            repairCalls++;
            const added = _ingestReply(repairReply, batch, { results, alreadyExtractedNames, settings, chainIndex, batchLabel: `${batchLabel} (repair)` });
            log.lifecycle(`[Auto-Reformat] ${batchLabel}: repair call added ${added} record(s)`);

            const stillFlagged = computeBatchCoverage(batch.text, results, coverageThreshold);
            if (stillFlagged.length > 0) {
                warnings.push(`${batchLabel}: section(s) still under-captured after a repair pass: ${stillFlagged.map(s => `"${s.title}"`).join(', ')} — review these entries for missing detail.`);
            }
        } catch (err) {
            if (err instanceof ReformatFatalError) throw err;
            warnings.push(`${batchLabel}: repair call for under-captured section(s) ${flaggedTitles} failed: ${err?.message || err} — the original extraction is kept.`);
            log.warn(`[Auto-Reformat] ${batchLabel} repair call failed:`, err?.message || err);
        }
    }

    return { results, failedCount, repairCalls };
}

// ---------------------------------------------------------------------------
// Roster mode
// ---------------------------------------------------------------------------

/** All names of a roster item. */
function _rosterItemNames(item) {
    return [item.name, ...(item.aliases || [])].filter(Boolean);
}

/** The roster's name list for prompts, one item per line. */
function _rosterNameLines(items) {
    return items.map(x => _rosterItemNames(x).join(' | ')).join('\n');
}

/** Roster items any of whose names appear in `text` as whole words. */
function _rosterItemsNamedIn(items, text) {
    const haystack = ` ${normalizeForMatch(text)} `;
    return items.filter(x => _rosterItemNames(x).some(n => {
        const key = normalizeForMatch(n);
        return key.length >= 3 && haystack.includes(` ${key} `);
    }));
}

/**
 * The name list a prompt gets: every name while the roster is small, else
 * only the items named in `text` (a very long document's roster would
 * otherwise fill the prompt).
 */
function _rosterNamesFor(items, text) {
    const all = _rosterNameLines(items);
    return all.length <= ROSTER_NAMES_MAX_CHARS ? all : _rosterNameLines(_rosterItemsNamedIn(items, text));
}

/**
 * Applies one roster reply's operations. Sources outside this part are
 * dropped; an update to an unknown id is ignored.
 * @returns {{added: number, updated: number}}
 */
function _applyRosterOps(ops, items, partIds) {
    let added = 0;
    let updated = 0;
    const strings = v => (Array.isArray(v) ? v : []).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
    for (const op of ops) {
        const sources = strings(op?.op === 'update' ? op.add_sources : op?.sources).filter(id => partIds.has(id));
        if (op?.op === 'update') {
            const item = items[Number(op.id) - 1];
            if (!item) continue;
            for (const alias of strings(op.add_aliases)) {
                if (!_rosterItemNames(item).some(n => n.toLowerCase() === alias.toLowerCase())) item.aliases.push(alias);
            }
            for (const id of sources) if (!item.sources.includes(id)) item.sources.push(id);
            if (typeof op.scope === 'string' && op.scope.trim()) item.scope = op.scope.trim();
            updated++;
        } else if (op?.op === 'new' && typeof op.name === 'string' && op.name.trim()) {
            const name = op.name.trim();
            items.push({
                id: items.length + 1,
                name,
                aliases: strings(op.aliases).filter(a => a.toLowerCase() !== name.toLowerCase()),
                entry_type: REFORMAT_ENTRY_TYPES.includes(op.entry_type) ? op.entry_type : 'other',
                hidden: op.hidden === true,
                scope: typeof op.scope === 'string' ? op.scope.trim() : '',
                sources: [...new Set(sources)],
            });
            added++;
        }
    }
    return { added, updated };
}

/**
 * Builds the roster: batches are grouped into parts of ROSTER_PART_CHARS,
 * and each part is one call that sees its batches (numbered B1, B2, ...),
 * the roster's names so far and details for the items it names. Parts run
 * in order, since each extends the roster the previous ones built. A failed
 * part is a warning: its batches simply get no expected items.
 *
 * @returns {Promise<object[]>} Roster items {id, name, aliases, entry_type, hidden, scope, sources}
 */
async function _buildRoster({ batches, settings, warnings, contentType, onProgress, abortSignal }) {
    const sections = batches.map((b, i) => ({ id: `B${i + 1}`, headingPath: b.headingPath, text: b.text }));
    const parts = [];
    let current = [];
    let size = 0;
    for (const section of sections) {
        if (current.length && size + section.text.length > ROSTER_PART_CHARS) {
            parts.push(current);
            current = [];
            size = 0;
        }
        current.push(section);
        size += section.text.length;
    }
    if (current.length) parts.push(current);

    const limits = await _getModelLimits(settings);
    const callOptions = {
        maxTokens: limits?.maxOutputTokens || Math.max(settings.reformat_max_output_tokens || DEFAULT_MAX_TOKENS, ROSTER_MIN_OUTPUT_TOKENS),
        timeoutMs: Math.max(settings.reformat_timeout_ms || DEFAULT_TIMEOUT_MS, ROSTER_MIN_TIMEOUT_MS),
    };

    const items = [];
    for (let k = 0; k < parts.length; k++) {
        if (abortSignal?.aborted) {
            const err = new Error('Auto-Reformat stopped by user');
            err.name = 'AbortError';
            throw err;
        }
        onProgress?.(k, parts.length, 'roster');
        const part = parts[k];
        const partText = part.map(s => s.text).join('\n\n');
        const prompt = buildRosterPrompt(part, {
            part: k + 1,
            totalParts: parts.length,
            names: _rosterNamesFor(items, partText),
            mentioned: _rosterItemsNamedIn(items, partText),
            contentType,
        });
        try {
            const { reply, finishReason } = await _callProviderWithRetry(prompt, settings, k, callOptions);
            if (finishReason === 'length') {
                warnings.push(`Roster part ${k + 1}/${parts.length}: the response was cut off by the model's output limit; some items from this part may be missing from the roster.`);
            }
            const ops = _parseReformatArray(reply, k, ['op', 'name', 'id']);
            const { added, updated } = _applyRosterOps(ops, items, new Set(part.map(s => s.id)));
            log.lifecycle(`[Auto-Reformat] Roster part ${k + 1}/${parts.length}: +${added} new, ${updated} updated (${items.length} items)`);
        } catch (err) {
            if (err instanceof ReformatFatalError) throw err;
            warnings.push(`Roster part ${k + 1}/${parts.length} failed: ${err?.message || err} — its sections are extracted without roster guidance.`);
            log.warn(`[Auto-Reformat] Roster part ${k + 1} failed:`, err?.message || err);
        }
    }
    onProgress?.(parts.length, parts.length, 'roster');
    return items;
}

/**
 * Gives every batch its roster note: the items whose sources include it and
 * the roster's names.
 */
function _attachRoster(batches, items) {
    const coveredBy = new Map();
    for (const item of items) {
        for (const id of item.sources) {
            if (!coveredBy.has(id)) coveredBy.set(id, []);
            coveredBy.get(id).push(item);
        }
    }
    batches.forEach((batch, i) => {
        batch.roster = { covered: coveredBy.get(`B${i + 1}`) || [], names: _rosterNamesFor(items, batch.text) };
    });
}

/**
 * Renames extracted pieces to their roster item's name so the merge joins an
 * item's pieces:
 * - a piece written under one of the item's names (same match keys as the
 *   duplicate merge) keeps that name as an alias;
 * - an off-roster "<Name>: <Part>" piece whose <Name> is a roster item is
 *   folded into that item (batches still split episodes off on their own;
 *   "Tantalus: Punishment" is not another name for Tantalus, so it is not
 *   kept as an alias). A piece of the other visibility is left alone, so a
 *   "<Name>: Hidden truth" never folds into a public entry.
 * @returns {{renamed: number, folded: number}}
 */
function _canonicalizeToRoster(records, items) {
    const byKey = new Map();
    for (const item of items) {
        for (const key of _entityKeys(item)) if (!byKey.has(key)) byKey.set(key, item);
    }
    const itemFor = name => _nameKeys(name).map(k => byKey.get(k)).find(Boolean);
    let renamed = 0;
    let folded = 0;
    for (const record of records) {
        let item = itemFor(record.name);
        let fold = false;
        if (!item) {
            const idx = record.name.indexOf(': ');
            if (idx > 0) {
                item = itemFor(record.name.slice(0, idx));
                fold = Boolean(item);
            }
        }
        if (!item || item.name === record.name || Boolean(item.hidden) !== Boolean(record.hidden)) continue;
        if (!fold) record.aliases = _unionStrings(record.aliases || [], [record.name]);
        record.aliases = (record.aliases || []).filter(a => a.toLowerCase() !== item.name.toLowerCase());
        record.name = item.name;
        if (fold) folded++;
        else renamed++;
    }
    return { renamed, folded };
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
 * Merges duplicate records produced by independent chains (the per-chain
 * "already extracted" list can't see across chains).
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
            const triples = _parseReformatArray(reply, i, ['source', 'target']);

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
 * @returns {Promise<{results: object[], repairCalls: number}|null>}
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
            const { results, repairCalls } = await _processChain([batch], settings, 0, attemptWarnings, contentType, { callOptions, strict: true });
            warnings.push(...attemptWarnings);
            log.lifecycle(`[Auto-Reformat] Whole-document attempt ${attempt} succeeded: ${results.length} entries`);
            return { results, repairCalls };
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
 * Whole-document mode (settings.reformat_single_pass, off by default) sends
 * the document in one call and tries it twice; when both fail, or the
 * document can't fit the model, it falls back to header-aligned batches.
 * Roster mode (settings.reformat_roster, off by default) builds a roster
 * before the batches run and joins each item's pieces under its roster name.
 *
 * @param {object} params
 * @param {string} params.text - Full prepared source text
 * @param {string} params.contentType - 'document' | 'url' | 'wiki' | 'youtube'
 * @param {object} params.settings - VectFox settings
 * @param {string} [params.sourceName] - Shown to the model as the root of each batch's heading path
 * @param {(processed: number, total: number, phase?: 'whole'|'roster'|'extract'|'link') => void} [params.onProgress]
 * @param {AbortSignal} [params.abortSignal]
 * @returns {Promise<{chunks: object[], warnings: string[], batchesProcessed: number, batchesFailed: number, totalBatches: number, mode: 'whole'|'batched'|'roster'}>}
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
    let totalRepairCalls = 0;
    let batchCallOptions = {};
    let rosterItems = null;

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
            totalRepairCalls = outcome.repairCalls;
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

        if (settings.reformat_roster === true) {
            log.lifecycle(`[Auto-Reformat] Building the roster for ${batches.length} batch(es)`);
            rosterItems = await _buildRoster({ batches, settings, warnings, contentType, onProgress, abortSignal });
            if (rosterItems.length > 0) {
                _attachRoster(batches, rosterItems);
                mode = 'roster';
            } else {
                warnings.push('Roster mode produced no roster; the document was processed in batches as usual.');
            }
        }

        const chains = _groupIntoChains(batches);
        batchCallOptions = _batchCallOptions(settings, _resolveReasoningEffort(settings) ? await _getModelLimits(settings) : null);
        log.lifecycle(`[Auto-Reformat] Starting: ${contentType}, ${batches.length} batch(es) in ${chains.length} chain(s), concurrency=${concurrency}${linkingEnabled ? ', linking pass enabled' : ''}`);

        const chainFns = chains.map((chain, chainIndex) => async () => {
            if (abortSignal?.aborted) {
                const err = new Error('Auto-Reformat stopped by user');
                err.name = 'AbortError';
                throw err;
            }
            const { results, failedCount, repairCalls } = await _processChain(chain, settings, chainIndex, warnings, contentType, { callOptions: batchCallOptions });
            batchesProcessed += chain.length;
            batchesFailed += failedCount;
            totalRepairCalls += repairCalls;
            onProgress?.(batchesProcessed, batches.length, 'extract');
            return results;
        });

        rawChunks = (await AsyncUtils.parallel(chainFns, concurrency)).flat();
    }

    const totalBatches = batches.length;
    if (skippedSections.length > 0) {
        warnings.unshift(`Skipped author-note section(s): ${skippedSections.map(t => `"${t}"`).join(', ')}.`);
    }

    if (mode === 'roster') {
        const { renamed, folded } = _canonicalizeToRoster(rawChunks, rosterItems);
        log.lifecycle(`[Auto-Reformat] Roster: ${renamed} piece(s) renamed to their roster name, ${folded} off-roster part(s) folded into their roster entry`);
    }
    const chunks = mergeDuplicateEntities(rawChunks);
    if (chunks.length < rawChunks.length) {
        // In roster mode the batches write each item's pieces under one name
        // on purpose; joining them is the plan, not a duplicate cleanup.
        warnings.push(mode === 'roster'
            ? `Joined ${rawChunks.length} pieces into ${chunks.length} ${chunks.length === 1 ? 'entry' : 'entries'} under their roster names.`
            : `Merged ${rawChunks.length - chunks.length} duplicate entries (${rawChunks.length} → ${chunks.length} records) — the same entity was extracted from multiple document sections.`);
    }
    linkSubEntriesToParents(chunks);

    // The linking pass connects entries that separate batches couldn't see
    // together; a whole-document call already saw everything.
    if (linkingEnabled && mode !== 'whole' && chunks.length > 0) {
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

    log.lifecycle(`[Auto-Reformat] Complete (${mode}): ${chunks.length} entries extracted from ${totalBatches} batch(es), ${totalRepairCalls} coverage repair call(s), ${batchesFailed} batch failure(s), ${warnings.length} warning(s)`);

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
