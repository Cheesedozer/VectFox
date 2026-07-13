/**
 * Unit tests for core/core-vector-api.js's getSavedHashes(..., includeMetadata=true)
 * cache — see the module-level `_savedHashesMetaCache` docstring.
 *
 * Uncached, this call fetches the ENTIRE collection twice (backend.getSavedHashes
 * for hashes + a direct /chunks/list POST for metadata) on every retrieval that
 * surfaces a summary/force-linked chunk. These tests cover: cache hit avoids both
 * fetches, concurrent calls dedupe to one in-flight fetch, the plain-hashes path
 * stays uncached (insert dedup needs freshness), and every write path
 * (insert/delete/purge/purgeAll/updateChunkText/updateChunkMetadata) invalidates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    modules: [],
}));

vi.mock('../../../../secrets.js', () => ({ secret_state: {} }));

vi.mock('../../../../textgen-settings.js', () => ({
    textgen_types: { OLLAMA: 'ollama', LLAMACPP: 'llamacpp', VLLM: 'vllm' },
    textgenerationwebui_settings: { server_urls: {} },
}));

vi.mock('../../../../openai.js', () => ({ oai_settings: {} }));

vi.mock('../core/providers.js', () => ({
    getProviderConfig: () => ({}),
    getModelField: () => null,
    getModelFromSettings: () => 'test-model',
    getSecretKey: () => '',
    requiresApiKey: () => false,
    requiresUrl: () => false,
    getUrlProviders: () => [],
}));

vi.mock('../../../shared.js', () => ({ isWebLlmSupported: () => false }));

vi.mock('../providers/webllm.js', () => ({
    getWebLlmProvider: () => ({}),
}));

const savedHashesSpy = vi.fn(async () => [1, 2, 3]);

vi.mock('../backends/backend-manager.js', () => ({
    getBackend: vi.fn(async () => ({
        getSavedHashes: savedHashesSpy,
        insertVectorItems: vi.fn(async () => {}),
        deleteVectorItems: vi.fn(async () => {}),
        purgeVectorIndex: vi.fn(async () => {}),
        purgeAllVectorIndexes: vi.fn(async () => {}),
        updateChunkText: vi.fn(async () => ({ ok: true })),
        updateChunkMetadata: vi.fn(async () => ({ ok: true })),
    })),
    getBackendForCollection: vi.fn(async () => ({})),
    invalidateBackendHealth: vi.fn(),
    recordQuery: vi.fn(),
    recordInsert: vi.fn(),
    recordDelete: vi.fn(),
    recordError: vi.fn(),
}));

vi.mock('../core/reformat-store.js', () => ({
    invalidateAllVectorizedReformatCaches: vi.fn(),
}));

import {
    getSavedHashes,
    insertVectorItems,
    deleteVectorItems,
    purgeVectorIndex,
    purgeAllVectorIndexes,
    updateChunkText,
    updateChunkMetadata,
    clearSavedHashesMetaCache,
} from '../core/core-vector-api.js';

function mockChunksListResponse(metadataItems) {
    return {
        ok: true,
        json: async () => ({ success: true, items: metadataItems.map(m => ({ metadata: m })) }),
    };
}

const settings = { vector_backend: 'standard', source: 'transformers' };

beforeEach(() => {
    vi.clearAllMocks();
    clearSavedHashesMetaCache();
    savedHashesSpy.mockClear();
    savedHashesSpy.mockImplementation(async () => [1, 2, 3]);
    globalThis.toastr = { success: vi.fn(), error: vi.fn() };
});

/** Flushes pending microtasks (getBackend/backend.getSavedHashes awaits) without racing real timers. */
function flushMicrotasks() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

describe('getSavedHashes(..., includeMetadata=true) — caching', () => {
    it('fetches once, then serves subsequent calls from cache without hitting the network again', async () => {
        const fetchMock = vi.fn(async () => mockChunksListResponse([{ name: 'A' }, { name: 'B' }, { name: 'C' }]));
        vi.stubGlobal('fetch', fetchMock);

        const first = await getSavedHashes('col1', settings, true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(savedHashesSpy).toHaveBeenCalledTimes(1);
        expect(first).toEqual({ hashes: [1, 2, 3], metadata: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] });

        const second = await getSavedHashes('col1', settings, true);
        expect(fetchMock).toHaveBeenCalledTimes(1); // no new network call
        expect(savedHashesSpy).toHaveBeenCalledTimes(1); // no new backend call either
        expect(second).toBe(first); // same cached object

        vi.unstubAllGlobals();
    });

    it('dedupes concurrent calls into a single in-flight fetch', async () => {
        let resolveFetch;
        const fetchMock = vi.fn(() => new Promise(resolve => { resolveFetch = resolve; }));
        vi.stubGlobal('fetch', fetchMock);

        const p1 = getSavedHashes('col1', settings, true);
        const p2 = getSavedHashes('col1', settings, true);

        // getSavedHashes has no `await` of its own before registering the
        // in-flight promise, so p2 already joined it synchronously — but the
        // underlying fetch is still a few microtask hops away (getBackend,
        // then backend.getSavedHashes both await first). Flush those before
        // asserting call counts.
        await flushMicrotasks();
        expect(fetchMock).toHaveBeenCalledTimes(1); // second call joined the in-flight promise
        expect(savedHashesSpy).toHaveBeenCalledTimes(1);

        resolveFetch(mockChunksListResponse([{ name: 'X' }]));
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1).toBe(r2);

        vi.unstubAllGlobals();
    });

    it('keeps separate cache entries per collection', async () => {
        const fetchMock = vi.fn(async () => mockChunksListResponse([{ name: 'only-entry' }]));
        vi.stubGlobal('fetch', fetchMock);

        await getSavedHashes('col1', settings, true);
        await getSavedHashes('col2', settings, true);
        expect(fetchMock).toHaveBeenCalledTimes(2); // distinct collections, both fetched

        await getSavedHashes('col1', settings, true);
        await getSavedHashes('col2', settings, true);
        expect(fetchMock).toHaveBeenCalledTimes(2); // both now warm

        vi.unstubAllGlobals();
    });

    it('does not cache the hashes-only fallback when the metadata plugin call fails', async () => {
        const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
        vi.stubGlobal('fetch', fetchMock);

        const first = await getSavedHashes('col1', settings, true);
        expect(first).toEqual([1, 2, 3]); // fallback: plain hashes array

        // A later successful call must NOT be poisoned by the failed one —
        // it should attempt the fetch again, not return the stale fallback.
        fetchMock.mockImplementationOnce(async () => mockChunksListResponse([{ name: 'A' }]));
        const second = await getSavedHashes('col1', settings, true);
        expect(second).toEqual({ hashes: [1, 2, 3], metadata: [{ name: 'A' }] });

        vi.unstubAllGlobals();
    });

    it('the includeMetadata=false path is never cached — always calls the backend fresh', async () => {
        savedHashesSpy.mockImplementationOnce(async () => [1]).mockImplementationOnce(async () => [1, 2]);

        const first = await getSavedHashes('col1', settings, false);
        const second = await getSavedHashes('col1', settings, false);
        expect(first).toEqual([1]);
        expect(second).toEqual([1, 2]); // reflects the second (fresh) backend call, not a cached value
        expect(savedHashesSpy).toHaveBeenCalledTimes(2);
    });
});

describe('getSavedHashes(..., true) cache — invalidation on writes', () => {
    async function warmCache(collectionId = 'col1') {
        const fetchMock = vi.fn(async () => mockChunksListResponse([{ name: 'A' }]));
        vi.stubGlobal('fetch', fetchMock);
        await getSavedHashes(collectionId, settings, true);
        vi.unstubAllGlobals();
        return fetchMock;
    }

    it('insertVectorItems invalidates the collection\'s cache', async () => {
        await warmCache('col1');
        savedHashesSpy.mockClear();

        await insertVectorItems('col1', [{ hash: 1, text: 'x' }], settings);

        const fetchMock = vi.fn(async () => mockChunksListResponse([{ name: 'A' }, { name: 'B' }]));
        vi.stubGlobal('fetch', fetchMock);
        const result = await getSavedHashes('col1', settings, true);
        expect(fetchMock).toHaveBeenCalledTimes(1); // refetched, not served stale
        expect(savedHashesSpy).toHaveBeenCalledTimes(1);
        expect(result.metadata).toHaveLength(2);
        vi.unstubAllGlobals();
    });

    it('deleteVectorItems invalidates the collection\'s cache', async () => {
        await warmCache('col1');

        await deleteVectorItems('col1', [1], settings);

        const fetchMock = vi.fn(async () => mockChunksListResponse([]));
        vi.stubGlobal('fetch', fetchMock);
        await getSavedHashes('col1', settings, true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });

    it('purgeVectorIndex invalidates the collection\'s cache', async () => {
        await warmCache('col1');

        await purgeVectorIndex('col1', settings);

        const fetchMock = vi.fn(async () => mockChunksListResponse([]));
        vi.stubGlobal('fetch', fetchMock);
        await getSavedHashes('col1', settings, true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });

    it('purgeAllVectorIndexes invalidates every collection\'s cache', async () => {
        await warmCache('col1');
        await warmCache('col2');

        await purgeAllVectorIndexes(settings);

        const fetchMock = vi.fn(async () => mockChunksListResponse([]));
        vi.stubGlobal('fetch', fetchMock);
        await getSavedHashes('col1', settings, true);
        await getSavedHashes('col2', settings, true);
        expect(fetchMock).toHaveBeenCalledTimes(2); // both refetched
        vi.unstubAllGlobals();
    });

    it('updateChunkText invalidates the collection\'s cache', async () => {
        await warmCache('col1');

        await updateChunkText('col1', 1, 'new text', settings);

        const fetchMock = vi.fn(async () => mockChunksListResponse([{ name: 'edited' }]));
        vi.stubGlobal('fetch', fetchMock);
        const result = await getSavedHashes('col1', settings, true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.metadata).toEqual([{ name: 'edited' }]);
        vi.unstubAllGlobals();
    });

    it('updateChunkMetadata invalidates the collection\'s cache', async () => {
        await warmCache('col1');

        await updateChunkMetadata('col1', 1, { enabled: false }, settings);

        const fetchMock = vi.fn(async () => mockChunksListResponse([{ name: 'edited-meta' }]));
        vi.stubGlobal('fetch', fetchMock);
        const result = await getSavedHashes('col1', settings, true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.metadata).toEqual([{ name: 'edited-meta' }]);
        vi.unstubAllGlobals();
    });

    it('a write to one collection does not invalidate another collection\'s cache', async () => {
        await warmCache('col1');
        await warmCache('col2');
        savedHashesSpy.mockClear();

        await insertVectorItems('col1', [{ hash: 1, text: 'x' }], settings);

        // col2 must still be served from cache — no new fetch/backend call
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await getSavedHashes('col2', settings, true);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(savedHashesSpy).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
});
