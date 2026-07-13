/**
 * Tests: Auto-Reformat cache store — vectorizedInto tracking and delete-time
 * invalidation (the "instantly completes with saved content after the vectors
 * were deleted" bug).
 *
 * Invariants under test:
 *  - saveReformatCache creates entries with runId and an EMPTY vectorizedInto
 *    (a fresh accept is never delete-invalidated).
 *  - recordReformatVectorization appends/dedupes and lazily upgrades legacy
 *    entries that predate the field.
 *  - invalidateReformatCacheForCollections unlinks per-collection and deletes
 *    an entry only when its LAST linked collection is gone.
 *  - invalidateAllVectorizedReformatCaches is backend-scoped and treats
 *    unparseable IDs as belonging to the purged backend (conservative).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSettings = vi.hoisted(() => ({ vectfox: {} }));
vi.mock('../../../../extensions.js', () => ({
    extension_settings: mockSettings,
    getContext: vi.fn(() => ({})),
}));
vi.mock('../../../../../script.js', () => ({
    saveSettingsDebounced: vi.fn(),
    getCurrentChatId: vi.fn(() => null),
    chat_metadata: {},
}));

import {
    getReformatCache,
    saveReformatCache,
    deleteReformatCache,
    recordReformatVectorization,
    invalidateReformatCacheForCollections,
    invalidateAllVectorizedReformatCaches,
} from '../core/reformat-store.js';

const HASH_A = 'hashA';
const HASH_B = 'hashB';
const COLL_STD = 'vf_document_standard_alice_doc_123';
const COLL_STD2 = 'vf_document_standard_alice_doc_456';
const COLL_QDR = 'vf_document_qdrant_alice_doc_789';
const COLL_LEGACY = 'vectfox_document_alice_doc_000'; // no backend segment — unparseable

function seed(hash, { chunks = [{ text: 'x' }], ...rest } = {}) {
    return saveReformatCache(hash, {
        chunks,
        originalText: 'orig',
        contentType: 'document',
        sourceName: 'test.txt',
        providerModel: 'test:model',
        schemaVersion: 1,
        ...rest,
    });
}

beforeEach(() => {
    mockSettings.vectfox = {};
});

describe('saveReformatCache', () => {
    it('creates an entry with runId and empty vectorizedInto', () => {
        const entry = seed(HASH_A);
        expect(entry.runId).toBe(`${HASH_A}_${entry.acceptedAt}`);
        expect(entry.vectorizedInto).toEqual([]);
        expect(getReformatCache(HASH_A)).toBe(entry);
    });

    it('re-accept overwrites and resets vectorizedInto', () => {
        seed(HASH_A);
        recordReformatVectorization(HASH_A, COLL_STD);
        expect(getReformatCache(HASH_A).vectorizedInto).toEqual([COLL_STD]);
        seed(HASH_A);
        expect(getReformatCache(HASH_A).vectorizedInto).toEqual([]);
    });
});

describe('recordReformatVectorization', () => {
    it('appends collection IDs and dedupes', () => {
        seed(HASH_A);
        recordReformatVectorization(HASH_A, COLL_STD);
        recordReformatVectorization(HASH_A, COLL_STD);
        recordReformatVectorization(HASH_A, COLL_QDR);
        expect(getReformatCache(HASH_A).vectorizedInto).toEqual([COLL_STD, COLL_QDR]);
    });

    it('lazily upgrades legacy entries missing the field', () => {
        seed(HASH_A);
        delete getReformatCache(HASH_A).vectorizedInto; // simulate pre-upgrade entry
        recordReformatVectorization(HASH_A, COLL_STD);
        expect(getReformatCache(HASH_A).vectorizedInto).toEqual([COLL_STD]);
    });

    it('no-ops on a missing entry', () => {
        expect(() => recordReformatVectorization('nope', COLL_STD)).not.toThrow();
        expect(getReformatCache('nope')).toBeNull();
    });
});

describe('invalidateReformatCacheForCollections', () => {
    it('deletes an entry whose only collection was deleted (the bug fix)', () => {
        seed(HASH_A);
        recordReformatVectorization(HASH_A, COLL_STD);
        const result = invalidateReformatCacheForCollections([COLL_STD]);
        expect(result).toEqual({ invalidated: 1, unlinked: 0 });
        expect(getReformatCache(HASH_A)).toBeNull();
    });

    it('unlinks but keeps an entry that lives in another collection, deletes on the second', () => {
        seed(HASH_A);
        recordReformatVectorization(HASH_A, COLL_STD);
        recordReformatVectorization(HASH_A, COLL_STD2);

        expect(invalidateReformatCacheForCollections([COLL_STD]))
            .toEqual({ invalidated: 0, unlinked: 1 });
        expect(getReformatCache(HASH_A).vectorizedInto).toEqual([COLL_STD2]);

        expect(invalidateReformatCacheForCollections([COLL_STD2]))
            .toEqual({ invalidated: 1, unlinked: 0 });
        expect(getReformatCache(HASH_A)).toBeNull();
    });

    it('never touches a fresh accept (empty vectorizedInto)', () => {
        seed(HASH_A);
        const result = invalidateReformatCacheForCollections([COLL_STD, COLL_STD2, COLL_QDR]);
        expect(result).toEqual({ invalidated: 0, unlinked: 0 });
        expect(getReformatCache(HASH_A)).not.toBeNull();
    });

    it('never touches legacy entries without the field', () => {
        seed(HASH_A);
        delete getReformatCache(HASH_A).vectorizedInto;
        invalidateReformatCacheForCollections([COLL_STD]);
        expect(getReformatCache(HASH_A)).not.toBeNull();
    });

    it('ignores non-matching collection IDs', () => {
        seed(HASH_A);
        recordReformatVectorization(HASH_A, COLL_STD);
        const result = invalidateReformatCacheForCollections([COLL_QDR, 'unrelated']);
        expect(result).toEqual({ invalidated: 0, unlinked: 0 });
        expect(getReformatCache(HASH_A).vectorizedInto).toEqual([COLL_STD]);
    });

    it('handles empty/invalid input', () => {
        seed(HASH_A);
        expect(invalidateReformatCacheForCollections([])).toEqual({ invalidated: 0, unlinked: 0 });
        expect(invalidateReformatCacheForCollections(null)).toEqual({ invalidated: 0, unlinked: 0 });
        expect(invalidateReformatCacheForCollections([null, undefined, ''])).toEqual({ invalidated: 0, unlinked: 0 });
    });
});

describe('invalidateAllVectorizedReformatCaches', () => {
    it('deletes entries vectorized into the purged backend only', () => {
        seed(HASH_A);
        recordReformatVectorization(HASH_A, COLL_STD);
        seed(HASH_B);
        recordReformatVectorization(HASH_B, COLL_QDR);

        expect(invalidateAllVectorizedReformatCaches('standard')).toBe(1);
        expect(getReformatCache(HASH_A)).toBeNull();
        expect(getReformatCache(HASH_B)).not.toBeNull();
    });

    it("normalizes 'vectra' to 'standard'", () => {
        seed(HASH_A);
        recordReformatVectorization(HASH_A, COLL_STD);
        expect(invalidateAllVectorizedReformatCaches('vectra')).toBe(1);
        expect(getReformatCache(HASH_A)).toBeNull();
    });

    it('treats unparseable collection IDs as purged (conservative)', () => {
        seed(HASH_A);
        recordReformatVectorization(HASH_A, COLL_LEGACY);
        expect(invalidateAllVectorizedReformatCaches('qdrant')).toBe(1);
        expect(getReformatCache(HASH_A)).toBeNull();
    });

    it('unlinks purged-backend collections from mixed entries without deleting them', () => {
        seed(HASH_A);
        recordReformatVectorization(HASH_A, COLL_STD);
        recordReformatVectorization(HASH_A, COLL_QDR);
        expect(invalidateAllVectorizedReformatCaches('standard')).toBe(0);
        expect(getReformatCache(HASH_A).vectorizedInto).toEqual([COLL_QDR]);
    });

    it('keeps fresh accepts', () => {
        seed(HASH_A);
        expect(invalidateAllVectorizedReformatCaches('standard')).toBe(0);
        expect(getReformatCache(HASH_A)).not.toBeNull();
    });
});

describe('deleteReformatCache', () => {
    it('is idempotent', () => {
        seed(HASH_A);
        deleteReformatCache(HASH_A);
        expect(getReformatCache(HASH_A)).toBeNull();
        expect(() => deleteReformatCache(HASH_A)).not.toThrow();
    });
});
