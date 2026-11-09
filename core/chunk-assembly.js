/**
 * ============================================================================
 * CHUNK ASSEMBLY
 * ============================================================================
 * Pure helpers that shape the list of retrieved ChunkBase chunks before it is
 * injected: joining the stored parts of one Auto-Reformat entry back into the
 * whole entry, dropping chunks whose text is already in the list, and capping
 * the total. No ST dependencies, so they are unit-tested directly;
 * core/chat-vectorization.js does the backend lookups around them.
 * ============================================================================
 */

import { buildStoredText } from './reformat-schema.js';

/**
 * Removes the " [KEYWORDS: …]" tail that Qdrant ingestion appends to the
 * stored text (backends/qdrant.js) so the keywords are embedded and indexed.
 * It is index data, not content, and must not reach the chat prompt.
 * @param {string} text
 * @returns {string}
 */
export function stripKeywordTail(text) {
    return typeof text === 'string' ? text.replace(/\s*\[KEYWORDS: [^\]]*\]\s*$/, '') : text;
}

/**
 * Identifies the Auto-Reformat entry a stored chunk is a part of, or null
 * when the chunk is not one part of a split entry. Entries longer than
 * "Max Entry Size" are stored as several chunks ("part 2 of 3") so every part
 * is embedded and searchable; all parts share these fields.
 * @param {object} metadata - Chunk metadata as stored
 * @param {string} [collectionId]
 * @returns {string|null}
 */
export function splitEntryKey(metadata, collectionId = '') {
    const meta = metadata || {};
    if (meta.strategy !== 'llm_reformat' || !(Number(meta.subChunkTotal) > 1) || !meta.name) return null;
    return [collectionId, meta.reformatRunId || '', meta.name, meta.hidden ? 1 : 0, meta.subChunkTotal].join('|');
}

const BODY_MARK = '\u0000BODY\u0000';

/**
 * Rebuilds a whole entry from its stored parts.
 *
 * Each part's text is "<header>\n[hidden tag]\n<body piece>[\n<relationship
 * sentences>]" (buildStoredText). The body pieces are cut out and joined in
 * order, and the entry is rendered once, so the name appears once and the
 * relationship sentences come last. A part whose text no longer has that
 * shape (edited by hand, or stored by an older version) is used as it is.
 *
 * @param {Array<{text: string, metadata: object}>} parts - Any order; parts
 *        with the same subChunkIndex are used once
 * @returns {string}
 */
export function joinStoredParts(parts) {
    const byIndex = new Map();
    for (const part of Array.isArray(parts) ? parts : []) {
        const index = Number(part?.metadata?.subChunkIndex) || 0;
        if (!byIndex.has(index) && typeof part?.text === 'string') byIndex.set(index, part);
    }
    const ordered = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part);
    if (ordered.length === 0) return '';

    const bodies = ordered.map(part => {
        const text = stripKeywordTail(part.text).trim();
        const meta = part.metadata || {};
        const template = buildStoredText({ ...meta, body: BODY_MARK }, {
            part: Number(meta.subChunkIndex) || 0,
            total: Number(meta.subChunkTotal) || 1,
        });
        const [prefix, suffix] = template.split(BODY_MARK);
        const fits = text.length > prefix.length + suffix.length && text.startsWith(prefix) && text.endsWith(suffix);
        return fits ? text.slice(prefix.length, text.length - suffix.length).trim() : text;
    }).filter(Boolean);

    return buildStoredText({ ...ordered[0].metadata, body: bodies.join('\n\n') });
}

/**
 * Collapses the retrieved parts of each split entry into one chunk carrying
 * the whole entry's text. The best-scoring retrieved part stands for the
 * entry (its hash, score and position in the list are kept).
 *
 * @param {object[]} chunks - Retrieved chunks, best first
 * @param {(key: string, chunk: object) => Array<{text: string, metadata: object}>|null} lookupParts -
 *        Returns every stored part of the entry, or null/[] when they can't
 *        be read; the retrieved parts are then joined on their own
 * @returns {{chunks: object[], joined: Array<{hash: any, parts: number, absorbed: any[]}>}}
 */
export function joinSplitEntries(chunks, lookupParts = () => null) {
    const list = Array.isArray(chunks) ? chunks : [];
    const groups = new Map();
    for (const chunk of list) {
        const key = splitEntryKey(chunk?.metadata, chunk?.collectionId);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(chunk);
    }
    if (groups.size === 0) return { chunks: list, joined: [] };

    const absorbed = new Set();
    const joined = [];
    const replacement = new Map();
    for (const [key, retrieved] of groups) {
        const lead = retrieved[0];
        const stored = lookupParts(key, lead);
        const parts = Array.isArray(stored) && stored.length > 0
            ? stored
            : retrieved.map(c => ({ text: c.text, metadata: c.metadata }));
        // One part only (its siblings could not be read): nothing to join.
        if (new Set(parts.map(p => Number(p?.metadata?.subChunkIndex) || 0)).size < 2) continue;

        const text = joinStoredParts(parts);
        if (!text) continue;
        for (const other of retrieved.slice(1)) absorbed.add(other);
        const partCount = new Set(parts.map(p => Number(p?.metadata?.subChunkIndex) || 0)).size;
        replacement.set(lead, { ...lead, text, joinedParts: partCount });
        joined.push({ hash: lead.hash, parts: partCount, absorbed: retrieved.slice(1).map(c => c.hash) });
    }

    return {
        chunks: list.filter(c => !absorbed.has(c)).map(c => replacement.get(c) || c),
        joined,
    };
}

/**
 * Drops chunks whose text is already in the list (the same file vectorized
 * into two collections injects the same passage twice). The first one in the
 * list, which is the best-scoring, is kept. Only identical text counts, after
 * collapsing whitespace and case.
 * @param {object[]} chunks
 * @returns {{kept: object[], dropped: object[]}}
 */
export function dropRepeatedChunks(chunks) {
    const seen = new Set();
    const kept = [];
    const dropped = [];
    for (const chunk of Array.isArray(chunks) ? chunks : []) {
        const key = String(chunk?.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (key && seen.has(key)) {
            dropped.push(chunk);
            continue;
        }
        if (key) seen.add(key);
        kept.push(chunk);
    }
    return { kept, dropped };
}

/**
 * Keeps the `max` best-scoring chunks, in their existing order. Each enabled
 * collection contributes up to Top K chunks, so without this the total grows
 * with the number of collections. 0 or less means no limit.
 * @param {object[]} chunks
 * @param {number} max
 * @returns {{kept: object[], dropped: object[]}}
 */
export function capChunks(chunks, max) {
    const list = Array.isArray(chunks) ? chunks : [];
    const limit = Math.floor(Number(max));
    if (!(limit > 0) || list.length <= limit) return { kept: list, dropped: [] };
    const ranked = list.map((chunk, i) => ({ chunk, i }))
        .sort((a, b) => ((b.chunk.score ?? 0) - (a.chunk.score ?? 0)) || (a.i - b.i));
    const keep = new Set(ranked.slice(0, limit).map(r => r.chunk));
    return { kept: list.filter(c => keep.has(c)), dropped: list.filter(c => !keep.has(c)) };
}
