/**
 * Unit tests for revectorizeCollection() in core/collection-export.js:
 * the chunk → insert-item mapping (keyword suffix, hash, payload fields) and
 * the restore-on-failure path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    saveSettingsDebounced: vi.fn(),
}));
vi.mock('../../../../utils.js', () => ({ getStringHash: (s) => s.length }));
vi.mock('../core/core-vector-api.js', () => ({
    insertVectorItems: vi.fn(),
    purgeVectorIndex: vi.fn(),
    clearSavedHashesMetaCache: vi.fn(),
}));
vi.mock('../core/collection-metadata.js', () => ({
    getCollectionMeta: vi.fn(() => ({})),
    setCollectionMeta: vi.fn(),
    getChunkMetadata: vi.fn(),
    saveChunkMetadata: vi.fn(),
    clearCollectionLock: vi.fn(),
    getEffectiveScope: vi.fn(() => 'character'),
}));
vi.mock('../core/collection-loader.js', () => ({ registerCollection: vi.fn() }));
vi.mock('../core/providers.js', () => ({ getModelFromSettings: () => 'model-x' }));
vi.mock('../core/corpus-stats.js', () => ({ clearCorpusStatsCache: vi.fn() }));
vi.mock('../ui/progress-tracker.js', () => ({
    progressTracker: new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} } }));

import { revectorizeCollection, revectorizeItemFromListed, stripKeywordSuffix } from '../core/collection-export.js';
import { insertVectorItems, purgeVectorIndex } from '../core/core-vector-api.js';
import { setCollectionMeta } from '../core/collection-metadata.js';

const LISTED = [
    {
        hash: 111,
        vector: { '': [0.1, 0.2], text_sparse: { indices: [1], values: [1] } },
        metadata: {
            hash: 111, text: 'Gray is a slur. [KEYWORDS: gray slur]', keywords: [{ text: 'gray' }, { text: 'slur' }],
            importance: 80, chunkIndex: 3, messageIndex: 3, contentType: 'document', sourceName: 'Doc.md',
            type: 'chat', sourceId: 'unknown', embeddingSource: 'openrouter', embeddingModel: 'old-model',
        },
    },
    {
        hash: 222,
        vector: [0.3, 0.4],
        metadata: { hash: 222, text: 'No keywords here.', keywords: [], chunkIndex: 4, messageIndex: 4 },
    },
];

function stubList(items = LISTED) {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, items }) }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const SETTINGS = { vector_backend: 'qdrant', source: 'openrouter' };

beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe('stripKeywordSuffix', () => {
    it('removes the exact " [KEYWORDS: …]" suffix ingestion appended', () => {
        expect(stripKeywordSuffix('Body. [KEYWORDS: a b]', ['a', { text: 'b' }])).toBe('Body.');
    });
    it('leaves text alone when the suffix does not match the keywords', () => {
        expect(stripKeywordSuffix('Body. [KEYWORDS: a b]', ['c'])).toBe('Body. [KEYWORDS: a b]');
        expect(stripKeywordSuffix('Body.', [])).toBe('Body.');
    });
});

describe('revectorizeItemFromListed', () => {
    it('keeps hash and payload fields, lifts item-level fields, drops backend-written ones', () => {
        const item = revectorizeItemFromListed(LISTED[0], 0);
        expect(item).toEqual({
            hash: 111,
            index: 3,
            text: 'Gray is a slur.',
            keywords: [{ text: 'gray' }, { text: 'slur' }],
            importance: 80,
            metadata: { chunkIndex: 3, contentType: 'document', sourceName: 'Doc.md' },
        });
    });
});

describe('revectorizeCollection', () => {
    it('reads, purges, then re-embeds the same chunks into the same collection', async () => {
        stubList();
        purgeVectorIndex.mockResolvedValue(true);
        insertVectorItems.mockResolvedValue(undefined);

        const result = await revectorizeCollection('vf_document_qdrant_x', SETTINGS, { backend: 'qdrant' });

        expect(result).toEqual({ chunkCount: 2, restored: false });
        expect(purgeVectorIndex).toHaveBeenCalledTimes(1);
        const [collectionId, items, settings] = insertVectorItems.mock.calls[0];
        expect(collectionId).toBe('vf_document_qdrant_x');
        expect(items.map(i => [i.hash, i.text])).toEqual([[111, 'Gray is a slur.'], [222, 'No keywords here.']]);
        expect(items.every(i => i.vector === undefined)).toBe(true); // embedded fresh
        expect(settings.vector_backend).toBe('qdrant');
        expect(setCollectionMeta).toHaveBeenCalledWith('qdrant:vf_document_qdrant_x', expect.objectContaining({ revectorizedAt: expect.any(String) }));
    });

    it('puts the old vectors back when embedding fails', async () => {
        const fetchMock = stubList();
        purgeVectorIndex.mockResolvedValue(true);
        insertVectorItems.mockRejectedValue(new Error('embedding provider down'));

        await expect(revectorizeCollection('vf_document_qdrant_x', SETTINGS, { backend: 'qdrant' }))
            .rejects.toMatchObject({ restored: true, message: expect.stringContaining('restored with its old vectors') });

        expect(purgeVectorIndex).toHaveBeenCalledTimes(2); // clear, then clear the partial write
        const insertCall = fetchMock.mock.calls.find(([url]) => url.includes('/chunks/insert'));
        const body = JSON.parse(insertCall[1].body);
        expect(body.collectionId).toBe('vf_document_qdrant_x');
        expect(body.items.map(i => [i.hash, i.vector])).toEqual([[111, [0.1, 0.2]], [222, [0.3, 0.4]]]);
        expect(body.items[0].metadata).toMatchObject({ keywords: [{ text: 'gray' }, { text: 'slur' }], importance: 80, contentType: 'document' });
    });

    it('changes nothing when the collection cannot be cleared', async () => {
        stubList();
        purgeVectorIndex.mockResolvedValue(false);

        await expect(revectorizeCollection('vf_document_qdrant_x', SETTINGS, { backend: 'qdrant' }))
            .rejects.toThrow('nothing was changed');
        expect(insertVectorItems).not.toHaveBeenCalled();
    });

    it('refuses non-Qdrant collections and multitenancy mode', async () => {
        await expect(revectorizeCollection('id', { ...SETTINGS, vector_backend: 'standard' }, { backend: 'standard' })).rejects.toThrow('Qdrant collections only');
        await expect(revectorizeCollection('id', { ...SETTINGS, qdrant_multitenancy: true }, { backend: 'qdrant' })).rejects.toThrow('multitenancy');
    });
});
