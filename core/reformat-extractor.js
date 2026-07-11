/**
 * ============================================================================
 * AUTO-REFORMAT EXTRACTOR
 * ============================================================================
 * Calls an LLM (OpenRouter or vLLM) to restructure Document/URL/Wiki source
 * text into structured, entity-tagged reformatted chunks (see
 * core/reformat-schema.js for the record shape).
 *
 * Mirrors core/eventbase-extractor.js's shape (provider calling, JSON parse
 * + repair) but is a fully independent implementation — no imports from
 * EventBase's files. The one deliberate improvement over that precedent:
 * provider calls are wrapped in AsyncUtils.retry() (transient-failure retry),
 * since losing a large single-shot batch call here is costlier than losing
 * one small EventBase chat window.
 *
 * Returns { chunks, warnings, batchesProcessed, batchesFailed, totalBatches }.
 * Throws ReformatFatalError for config/auth failures (aborts the whole run).
 * Individual batch parse/validation failures are non-fatal — logged as
 * warnings, the rest of the document still gets processed.
 * ============================================================================
 */

import { getOpenRouterApiKey, getCustomApiKey } from './api-keys.js';
import { getRequestHeaders } from '../../../../../script.js';
import { getModelConfigErrorMessage } from './model-http-errors.js';
import { chunkText } from './chunking.js';
import AsyncUtils from '../utils/async-utils.js';
import {
    ReformatExtractionError,
    ReformatFatalError,
    validateReformattedChunk,
    buildReformatPrompt,
    computeNameVerification,
    computeKeywordVerification,
} from './reformat-schema.js';
import { log } from './log.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_BATCH_CHARS = 6000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_NAME_FUZZY_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// Config resolution (independent copy of agentic-retrieval.js's
// _resolveAgenticLLMConfig pattern — each VectFox LLM feature keeps its own
// copy rather than sharing one resolver; see reformat-schema.js docstring)
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

// ---------------------------------------------------------------------------
// HTTP callers
// ---------------------------------------------------------------------------

/**
 * @param {string} prompt
 * @param {object} settings
 * @param {number} batchIndex
 * @returns {Promise<{reply: string, finishReason: string|null}>}
 */
async function _callOpenRouter(prompt, settings, batchIndex) {
    const apiKey = getOpenRouterApiKey(settings);
    if (!apiKey) {
        throw new ReformatFatalError(
            'Auto-Reformat: OpenRouter API key not found. Add it in Core → LLM Summarization settings (Auto-Reformat inherits it unless overridden in ChunkBase settings).',
            'missing_api_key',
        );
    }

    const model = _resolveModel(settings);
    if (!model) {
        throw new ReformatFatalError(
            'Auto-Reformat: No model configured. Set a model in ChunkBase → Auto-Reformat, or leave it blank to inherit the Summarization Model.',
            'missing_model',
        );
    }

    const maxTokens = settings.reformat_max_output_tokens || DEFAULT_MAX_TOKENS;
    const temperature = settings.reformat_temperature ?? DEFAULT_TEMPERATURE;
    const timeoutMs = settings.reformat_timeout_ms || DEFAULT_TIMEOUT_MS;

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: 'openrouter',
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature,
        }),
        signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        if (response.status === 401 || response.status === 403) {
            throw new ReformatFatalError(
                `Auto-Reformat: OpenRouter authentication failed (${response.status}). Check your API key.`,
                'invalid_api_key',
            );
        }
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'Auto-Reformat', provider: 'OpenRouter', model, status: response.status, responseText: errText,
        });
        if (modelConfigError) throw new ReformatFatalError(modelConfigError, 'invalid_model_config');
        throw new ReformatExtractionError(`Auto-Reformat: OpenRouter HTTP ${response.status}: ${errText}`, batchIndex);
    }

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || null;
    const finishReason = data?.choices?.[0]?.finish_reason || null;
    if (!reply) {
        const bodyText = data?.error ? JSON.stringify(data.error) : JSON.stringify(data || {});
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'Auto-Reformat', provider: 'OpenRouter', model, status: response.status, responseText: bodyText, enforceStatusGate: false,
        });
        if (modelConfigError) throw new ReformatFatalError(modelConfigError, 'invalid_model_config');
        throw new ReformatExtractionError('Auto-Reformat: OpenRouter returned empty response', batchIndex);
    }
    return { reply, finishReason };
}

/**
 * @param {string} prompt
 * @param {object} settings
 * @param {number} batchIndex
 * @returns {Promise<{reply: string, finishReason: string|null}>}
 */
async function _callVLLM(prompt, settings, batchIndex) {
    const baseUrl = _resolveVllmUrl(settings);
    if (!baseUrl) {
        throw new ReformatFatalError(
            'Auto-Reformat: vLLM URL not configured. Set it in ChunkBase → Auto-Reformat, or leave it blank to inherit the Summarization vLLM URL.',
            'missing_url',
        );
    }

    const model = _resolveModel(settings);
    if (!model) {
        throw new ReformatFatalError(
            'Auto-Reformat: No model configured. Set a model in ChunkBase → Auto-Reformat, or leave it blank to inherit the Summarization Model.',
            'missing_model',
        );
    }

    const apiKey = getCustomApiKey(settings);
    if (!apiKey) {
        throw new ReformatFatalError(
            'Auto-Reformat: vLLM / Custom OpenAI-compatible API key not configured. Enter it in Core → LLM Summarization settings.',
            'missing_api_key',
        );
    }

    const maxTokens = settings.reformat_max_output_tokens || DEFAULT_MAX_TOKENS;
    const temperature = settings.reformat_temperature ?? DEFAULT_TEMPERATURE;
    const timeoutMs = settings.reformat_timeout_ms || DEFAULT_TIMEOUT_MS;

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: baseUrl,
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature,
        }),
        signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        if (response.status === 401 || response.status === 403) {
            throw new ReformatFatalError(
                `Auto-Reformat: vLLM authentication failed (${response.status}). Check your API key.`,
                'invalid_api_key',
            );
        }
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'Auto-Reformat', provider: 'vLLM', model, status: response.status, responseText: errText,
        });
        if (modelConfigError) throw new ReformatFatalError(modelConfigError, 'invalid_model_config');
        throw new ReformatExtractionError(`Auto-Reformat: vLLM HTTP ${response.status}: ${errText}`, batchIndex);
    }

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || null;
    const finishReason = data?.choices?.[0]?.finish_reason || null;
    if (!reply) {
        const bodyText = data?.error ? JSON.stringify(data.error) : JSON.stringify(data || {});
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'Auto-Reformat', provider: 'vLLM', model, status: response.status, responseText: bodyText, enforceStatusGate: false,
        });
        if (modelConfigError) throw new ReformatFatalError(modelConfigError, 'invalid_model_config');
        throw new ReformatExtractionError('Auto-Reformat: vLLM returned empty response', batchIndex);
    }
    return { reply, finishReason };
}

/**
 * Calls the configured provider, retrying transient failures (network hiccups,
 * 5xx, timeouts) but never retrying ReformatFatalError (auth/config problems
 * a retry can't fix).
 */
async function _callProviderWithRetry(prompt, settings, batchIndex) {
    const provider = _resolveProvider(settings);
    const callFn = provider === 'vllm' ? _callVLLM : _callOpenRouter;
    return AsyncUtils.retry(() => callFn(prompt, settings, batchIndex), {
        maxAttempts: 3,
        delay: 1500,
        maxDelay: 10000,
        backoffFactor: 2,
        shouldRetry: (err) => !(err instanceof ReformatFatalError),
        onRetry: (attempt, err) => log.warn(`[Auto-Reformat] Batch ${batchIndex}: attempt ${attempt} failed (${err?.message || err}), retrying...`),
    });
}

// ---------------------------------------------------------------------------
// JSON parse + repair — schema-adapted duplicate of eventbase-extractor.js's
// _parseJsonArray, keyed on entry_type/name/body instead of
// event_type/summary/importance. Not imported, per independence requirement.
// ---------------------------------------------------------------------------

/**
 * @param {string} raw
 * @param {number} [batchIndex]
 * @returns {unknown[]}
 */
function _parseReformatArray(raw, batchIndex = -1) {
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
        return Object.prototype.hasOwnProperty.call(first, 'entry_type')
            || Object.prototype.hasOwnProperty.call(first, 'name')
            || Object.prototype.hasOwnProperty.call(first, 'body');
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
// Batching packer
// ---------------------------------------------------------------------------

/** First non-empty line of a section, used as its title for continuation notes. */
function _firstLine(text) {
    return (text || '').split('\n').map(l => l.trim()).find(Boolean) || 'section';
}

/**
 * Splits source text into LLM-call-sized batches, respecting header
 * boundaries via the existing `section` chunking strategy wherever possible.
 * NOT a final chunk boundary — purely an internal batching mechanism so a
 * long document doesn't blow one call's output budget. If a single section
 * itself exceeds the budget (e.g. one header covering seven character
 * profiles — the exact reported bug), that section alone gets sub-split via
 * `paragraph` strategy into ordered continuation batches.
 *
 * @param {string} text
 * @param {number} targetChars
 * @returns {Promise<Array<{text: string, continuation: {sectionTitle: string}|null}>>}
 */
async function _buildBatches(text, targetChars) {
    const sectionChunks = await chunkText(text, { strategy: 'section' });
    const sections = sectionChunks.map(c => (typeof c === 'string' ? c : c.text)).filter(Boolean);

    const batches = [];
    let current = '';

    const flush = () => {
        if (current.trim()) batches.push({ text: current.trim(), continuation: null });
        current = '';
    };

    for (const section of sections) {
        if (section.length > targetChars) {
            flush();
            const title = _firstLine(section);
            const paraChunks = await chunkText(section, { strategy: 'paragraph' });
            const paragraphs = paraChunks.map(c => (typeof c === 'string' ? c : c.text)).filter(Boolean);

            let sub = '';
            let isFirstSubBatch = true;
            const flushSub = () => {
                if (!sub.trim()) return;
                batches.push({ text: sub.trim(), continuation: isFirstSubBatch ? null : { sectionTitle: title } });
                isFirstSubBatch = false;
                sub = '';
            };
            for (const p of paragraphs) {
                if (sub && (sub.length + p.length + 2) > targetChars) {
                    flushSub();
                    sub = p;
                } else {
                    sub += (sub ? '\n\n' : '') + p;
                }
            }
            flushSub();
        } else if (current && (current.length + section.length + 2) > targetChars) {
            flush();
            current = section;
        } else {
            current += (current ? '\n\n' : '') + section;
        }
    }
    flush();

    return batches;
}

/**
 * Groups packed batches into ordered "chains" — a continuation batch must be
 * processed after the batch it continues (so it can be told which names were
 * already extracted), but independent chains can run concurrently.
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
 * Processes one chain (a normal batch, or an ordered run of continuation
 * batches for one oversized section) sequentially, threading the running
 * "already extracted" name list into each continuation's prompt.
 */
async function _processChain(chain, settings, chainIndex, warnings) {
    const results = [];
    let failedCount = 0;
    const alreadyExtractedNames = [];
    const threshold = settings.reformat_name_fuzzy_threshold ?? DEFAULT_NAME_FUZZY_THRESHOLD;

    for (let i = 0; i < chain.length; i++) {
        const batch = chain[i];
        const batchLabel = chain.length > 1 ? `chain ${chainIndex} part ${i + 1}/${chain.length}` : `batch ${chainIndex}`;
        const batchContext = batch.continuation
            ? { sectionTitle: batch.continuation.sectionTitle, alreadyExtractedNames: [...alreadyExtractedNames] }
            : null;
        const prompt = buildReformatPrompt(batch.text, { customPrompt: settings.reformat_custom_prompt, batchContext });

        try {
            const { reply, finishReason } = await _callProviderWithRetry(prompt, settings, chainIndex);
            if (finishReason === 'length') {
                warnings.push(`${batchLabel}: response was truncated by the model's output limit — some entries from this section may be missing. Consider lowering "Batch size (chars)" in Auto-Reformat settings.`);
            }

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
        } catch (err) {
            if (err instanceof ReformatFatalError) throw err;
            failedCount++;
            warnings.push(`${batchLabel} failed: ${err?.message || err} — skipped, other batches continue.`);
            log.warn(`[Auto-Reformat] ${batchLabel} failed:`, err?.message || err);
        }
    }

    return { results, failedCount };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Restructures source text into structured reformatted chunks.
 *
 * @param {object} params
 * @param {string} params.text - Full prepared source text (document/url, or
 *        wiki text with per_page strategy overridden away — see caller)
 * @param {string} params.contentType - 'document' | 'url' | 'wiki'
 * @param {object} params.settings - VectFox settings
 * @param {(processed: number, total: number) => void} [params.onProgress]
 * @param {AbortSignal} [params.abortSignal]
 * @returns {Promise<{chunks: object[], warnings: string[], batchesProcessed: number, batchesFailed: number, totalBatches: number}>}
 */
export async function reformatDocument({ text, contentType, settings, onProgress = null, abortSignal = null } = {}) {
    if (!text || typeof text !== 'string' || !text.trim()) {
        return { chunks: [], warnings: ['No text to reformat.'], batchesProcessed: 0, batchesFailed: 0, totalBatches: 0 };
    }

    const targetChars = settings.reformat_batch_chars || DEFAULT_BATCH_CHARS;
    const batches = await _buildBatches(text, targetChars);
    if (batches.length === 0) {
        return { chunks: [], warnings: ['No content found to reformat.'], batchesProcessed: 0, batchesFailed: 0, totalBatches: 0 };
    }

    const chains = _groupIntoChains(batches);
    const totalBatches = batches.length;
    const warnings = [];
    let batchesProcessed = 0;
    let batchesFailed = 0;

    const concurrency = Math.max(1, Math.min(8, settings.reformat_concurrency || DEFAULT_CONCURRENCY));

    log.lifecycle(`[Auto-Reformat] Starting: ${contentType}, ${totalBatches} batch(es) in ${chains.length} chain(s), concurrency=${concurrency}`);

    const chainFns = chains.map((chain, chainIndex) => async () => {
        if (abortSignal?.aborted) {
            const err = new Error('Auto-Reformat stopped by user');
            err.name = 'AbortError';
            throw err;
        }
        const { results, failedCount } = await _processChain(chain, settings, chainIndex, warnings);
        batchesProcessed += chain.length;
        batchesFailed += failedCount;
        onProgress?.(batchesProcessed, totalBatches);
        return results;
    });

    const chainResultsArrays = await AsyncUtils.parallel(chainFns, concurrency);
    const chunks = chainResultsArrays.flat();

    log.lifecycle(`[Auto-Reformat] Complete: ${chunks.length} entries extracted from ${totalBatches} batch(es), ${batchesFailed} batch failure(s), ${warnings.length} warning(s)`);

    return { chunks, warnings, batchesProcessed, batchesFailed, totalBatches };
}

// ---------------------------------------------------------------------------
// Oversized-entity fallback (used at Accept time by ui/reformat-review.js)
// ---------------------------------------------------------------------------

/**
 * If an accepted record's body exceeds maxBodyChars, sub-chunks it with the
 * EXISTING adaptive splitter (no new splitting logic) into N physical chunks
 * that all carry the parent record's metadata plus subChunkIndex/subChunkTotal.
 * Returns [chunk] unchanged when no expansion is needed.
 *
 * @param {object} chunk - A validated reformatted chunk (post-review, accepted)
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
