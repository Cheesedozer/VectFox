/**
 * ============================================================================
 * AUTO-REFORMAT STORE
 * ============================================================================
 * The "freeze" mechanism for Auto-Reformat: once a user accepts a reformatted
 * document, the result is cached here keyed by source-content hash so a
 * later "Vectorize Content" run on the same source reuses it instead of
 * re-invoking the LLM (non-deterministic output would otherwise silently
 * re-cost money/time and could drift from what the user actually reviewed).
 *
 * Genuinely new — nothing like this exists for non-chat content today. Chat's
 * fingerprint/dedup cache (core/eventbase-store.js) is chat-UUID-keyed and
 * unrelated. Kept as its OWN top-level bucket
 * (extension_settings.vectfox.reformat_cache), separate from
 * collection-metadata.js's per-collection object — that store is framed as a
 * lean settings layer, and a full document's original text plus its
 * structured output is a materially different size class than anything else
 * that lives there (see the storage-growth note in the accept-time UI flow).
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { getBackendFromCollectionId, normalizeBackendForId } from './collection-ids.js';
import { log } from './log.js';

/**
 * @typedef {object} ReformatCacheEntry
 * @property {object[]} chunks - Accepted, validated reformatted chunks
 * @property {string} originalText - Raw pre-reformat source text (retained for audit/revert)
 * @property {string} contentType - 'document' | 'url' | 'wiki'
 * @property {string} sourceName
 * @property {number} acceptedAt - Date.now() at accept time
 * @property {string} providerModel - e.g. "openrouter:openai/gpt-4o-mini"
 * @property {number} schemaVersion
 * @property {string} runId - `${sourceHash}_${acceptedAt}` — stamped onto every
 *        chunk's metadata so a later "Re-run Auto-Reformat" can purge exactly
 *        this generation's chunks from a live collection without touching
 *        anything from a different generation.
 * @property {string} selectionDescriptor - For Wiki Library basket sources:
 *        the exact page selection (key:contentHash pairs) this result was
 *        accepted for, so a changed selection can be detected instead of
 *        silently orphaning the freeze. '' for non-basket sources.
 * @property {string[]} vectorizedInto - Bare collection IDs this result has
 *        been vectorized into. Empty for a fresh accept that hasn't been
 *        vectorized yet — such entries are never touched by delete-time
 *        invalidation. When the last listed collection is deleted the whole
 *        entry is dropped, so the next Auto-Reformat run is a real LLM run
 *        instead of silently reusing chunks whose vectors no longer exist.
 */

function _ensureReformatCacheObject() {
    if (!extension_settings) {
        log.error('VectFox: extension_settings is null/undefined - cannot access reformat_cache');
        return false;
    }
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = {};
    }
    if (!extension_settings.vectfox.reformat_cache) {
        extension_settings.vectfox.reformat_cache = {};
    }
    return true;
}

/**
 * @param {string} sourceHash
 * @returns {ReformatCacheEntry|null}
 */
export function getReformatCache(sourceHash) {
    if (!sourceHash || !_ensureReformatCacheObject()) return null;
    return extension_settings.vectfox.reformat_cache[sourceHash] || null;
}

/**
 * Stores an accepted Auto-Reformat result. Overwrites any prior generation
 * for the same sourceHash (callers wanting to purge the previous
 * generation's live chunk hashes should read the old entry via
 * getReformatCache() BEFORE calling this).
 *
 * @param {string} sourceHash
 * @param {Omit<ReformatCacheEntry, 'runId' | 'acceptedAt'> & {acceptedAt?: number}} data
 * @returns {ReformatCacheEntry}
 */
export function saveReformatCache(sourceHash, data) {
    if (!sourceHash) {
        log.warn('VectFox: saveReformatCache called with null/undefined sourceHash');
        return null;
    }
    _ensureReformatCacheObject();

    const acceptedAt = data.acceptedAt || Date.now();
    const entry = {
        chunks: data.chunks || [],
        originalText: data.originalText || '',
        contentType: data.contentType || '',
        sourceName: data.sourceName || '',
        acceptedAt,
        providerModel: data.providerModel || '',
        schemaVersion: data.schemaVersion || 1,
        runId: `${sourceHash}_${acceptedAt}`,
        selectionDescriptor: data.selectionDescriptor || '',
        // A re-accept starts a new generation that hasn't been vectorized yet,
        // so any previous collection links are intentionally not carried over.
        vectorizedInto: [],
    };

    extension_settings.vectfox.reformat_cache[sourceHash] = entry;
    saveSettingsDebounced();
    log.lifecycle(`VectFox: Saved Auto-Reformat cache for source ${sourceHash} (${entry.chunks.length} chunks, runId=${entry.runId})`);
    return entry;
}

/**
 * Records that a cached Auto-Reformat result was vectorized into a collection,
 * so delete-time invalidation can map that collection back to this entry.
 * Legacy entries (saved before vectorizedInto existed) get the array lazily.
 *
 * @param {string} sourceHash
 * @param {string} collectionId - Bare collection ID (no registry-key prefix)
 */
export function recordReformatVectorization(sourceHash, collectionId) {
    if (!sourceHash || !collectionId || !_ensureReformatCacheObject()) return;
    const entry = extension_settings.vectfox.reformat_cache[sourceHash];
    if (!entry) {
        log.warn(`VectFox: recordReformatVectorization: no cache entry for source ${sourceHash}`);
        return;
    }
    if (!Array.isArray(entry.vectorizedInto)) entry.vectorizedInto = [];
    if (!entry.vectorizedInto.includes(collectionId)) {
        entry.vectorizedInto.push(collectionId);
        saveSettingsDebounced();
        log.lifecycle(`VectFox: Linked Auto-Reformat cache ${sourceHash} → collection ${collectionId}`);
    }
}

/**
 * Delete-time invalidation: unlinks the given collections from every cache
 * entry, and deletes an entry once its last linked collection is gone (the
 * frozen chunks no longer exist anywhere in the DB, so reusing them would
 * "instantly complete" against nothing).
 *
 * Entries with an empty/absent vectorizedInto are never touched — those are
 * fresh accepts that haven't been vectorized yet.
 *
 * @param {string[]} collectionIds - Bare collection IDs that were deleted
 * @returns {{invalidated: number, unlinked: number}}
 */
export function invalidateReformatCacheForCollections(collectionIds) {
    const result = { invalidated: 0, unlinked: 0 };
    if (!Array.isArray(collectionIds) || collectionIds.length === 0 || !_ensureReformatCacheObject()) {
        return result;
    }
    const deleted = new Set(collectionIds.filter(Boolean));
    if (deleted.size === 0) return result;

    const cache = extension_settings.vectfox.reformat_cache;
    for (const [sourceHash, entry] of Object.entries(cache)) {
        if (!Array.isArray(entry.vectorizedInto) || entry.vectorizedInto.length === 0) continue;
        const remaining = entry.vectorizedInto.filter((id) => !deleted.has(id));
        if (remaining.length === entry.vectorizedInto.length) continue;
        if (remaining.length === 0) {
            delete cache[sourceHash];
            result.invalidated++;
            log.lifecycle(`VectFox: Invalidated Auto-Reformat cache ${sourceHash} — last vectorized collection deleted`);
        } else {
            entry.vectorizedInto = remaining;
            result.unlinked++;
            log.lifecycle(`VectFox: Unlinked deleted collection(s) from Auto-Reformat cache ${sourceHash} (${remaining.length} remaining)`);
        }
    }
    if (result.invalidated > 0 || result.unlinked > 0) saveSettingsDebounced();
    return result;
}

/**
 * Purge-all invalidation: deletes every cache entry that was vectorized into
 * the given backend. Collections whose backend tag can't be parsed from the
 * ID are treated as belonging to the purged backend (conservative — better a
 * re-run than a silent reuse of deleted vectors). Fresh accepts (empty
 * vectorizedInto) are kept.
 *
 * @param {string} backend - settings.vector_backend value ('standard'|'vectra'|'qdrant')
 * @returns {number} Number of entries invalidated
 */
export function invalidateAllVectorizedReformatCaches(backend) {
    if (!_ensureReformatCacheObject()) return 0;
    const purgedBackend = normalizeBackendForId(backend) || 'standard';
    const cache = extension_settings.vectfox.reformat_cache;
    let invalidated = 0;
    let changed = false;
    for (const [sourceHash, entry] of Object.entries(cache)) {
        if (!Array.isArray(entry.vectorizedInto) || entry.vectorizedInto.length === 0) continue;
        const remaining = entry.vectorizedInto.filter((id) => {
            const idBackend = getBackendFromCollectionId(id);
            return idBackend !== null && idBackend !== purgedBackend;
        });
        if (remaining.length === 0) {
            delete cache[sourceHash];
            invalidated++;
            changed = true;
            log.lifecycle(`VectFox: Invalidated Auto-Reformat cache ${sourceHash} — backend '${purgedBackend}' purged`);
        } else if (remaining.length !== entry.vectorizedInto.length) {
            entry.vectorizedInto = remaining;
            changed = true;
        }
    }
    if (changed) saveSettingsDebounced();
    return invalidated;
}

/**
 * @param {string} sourceHash
 */
export function deleteReformatCache(sourceHash) {
    if (!sourceHash || !_ensureReformatCacheObject()) return;
    if (extension_settings.vectfox.reformat_cache[sourceHash]) {
        delete extension_settings.vectfox.reformat_cache[sourceHash];
        saveSettingsDebounced();
        log.lifecycle(`VectFox: Deleted Auto-Reformat cache for source ${sourceHash}`);
    }
}

/**
 * Lists all cached entries with their storage footprint, for the Database
 * Browser's "Clear Auto-Reformat originals" maintenance action.
 * @returns {Array<{sourceHash: string, sourceName: string, contentType: string, acceptedAt: number, originalTextBytes: number, chunkCount: number}>}
 */
export function listReformatCacheEntries() {
    if (!_ensureReformatCacheObject()) return [];
    return Object.entries(extension_settings.vectfox.reformat_cache).map(([sourceHash, entry]) => ({
        sourceHash,
        sourceName: entry.sourceName,
        contentType: entry.contentType,
        acceptedAt: entry.acceptedAt,
        originalTextBytes: entry.originalText ? entry.originalText.length : 0,
        chunkCount: Array.isArray(entry.chunks) ? entry.chunks.length : 0,
    }));
}

/**
 * Clears the retained `originalText` for every cached entry (keeps the
 * accepted chunks/runId intact — only the audit copy of the raw source is
 * dropped). Used by the Database Browser maintenance action to reclaim
 * settings.json space without breaking the freeze/dedup mechanism, which
 * only depends on sourceHash + chunks, not originalText.
 * @returns {number} Number of entries cleared
 */
export function clearAllReformatOriginals() {
    if (!_ensureReformatCacheObject()) return 0;
    let cleared = 0;
    for (const entry of Object.values(extension_settings.vectfox.reformat_cache)) {
        if (entry.originalText) {
            entry.originalText = '';
            cleared++;
        }
    }
    if (cleared > 0) {
        saveSettingsDebounced();
        log.lifecycle(`VectFox: Cleared retained original text for ${cleared} Auto-Reformat cache entries`);
    }
    return cleared;
}
