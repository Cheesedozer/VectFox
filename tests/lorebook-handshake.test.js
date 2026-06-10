/**
 * Tests for the Fatbody 2.5.1+ lorebook handshake:
 *  - resolveLiveEntries (world-info-integration.js): live content swap,
 *    deleted/disabled filtering, Fatbody semantic-mode dormancy exemption
 *  - invalidateLorebook / vectfox_invalidateLorebook (lorebook-invalidation.js):
 *    create-or-refresh scheduling, debounce, settings gate
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Shared mutable state driving the mocks ────────────────────────────────────
const _state = vi.hoisted(() => ({
    books: {},          // bookName → { entries } | null (null = load throws)
    registry: [],       // collection registry keys
    meta: {},           // registryKey → meta
}));

// ── SillyTavern host modules ──────────────────────────────────────────────────
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ chat: [], characterId: 'char1' })),
}));
vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(),
    getCurrentChatId: vi.fn(() => 'chat1'),
    eventSource: { on: vi.fn(), removeListener: vi.fn() },
    event_types: {},
    substituteParams: vi.fn((s) => s),
}));
vi.mock('../../../../world-info.js', () => ({
    loadWorldInfo: vi.fn(async (name) => {
        const book = _state.books[name];
        if (book === null) throw new Error(`cannot load ${name}`);
        return book;
    }),
    world_names: [],
}));

// ── VectFox internals not under test ──────────────────────────────────────────
vi.mock('../core/core-vector-api.js', () => ({ queryCollection: vi.fn() }));
vi.mock('../core/collection-metadata.js', () => ({
    getCollectionMeta: vi.fn((key) => _state.meta[key] || {}),
    setCollectionMeta: vi.fn((key, data) => { _state.meta[key] = { ..._state.meta[key], ...data }; }),
    isCollectionEnabled: vi.fn(() => true),
    shouldCollectionActivate: vi.fn(async () => true),
}));
vi.mock('../core/collection-loader.js', () => ({
    getCollectionListing: vi.fn(() => []),
    getCollectionRegistry: vi.fn(() => _state.registry),
    deleteCollection: vi.fn(async () => {}),
}));
vi.mock('../core/collection-ids.js', () => ({
    parseRegistryKey: vi.fn((key) => ({ collectionId: key })),
    buildLorebookCollectionId: vi.fn((name) => `vf_lorebook_${name}`),
    resolveBackendForCollection: vi.fn((key) => ({ backend: 'standard', collectionId: String(key).replace(/^standard:/, '') })),
}));
vi.mock('../core/constants.js', () => ({
    EXTENSION_PROMPT_TAG: 'vectfox_world_info',
    LOREBOOK_PROMPT_TAG: 'vectfox_lorebook',
}));
vi.mock('../core/lorebook-rename-detector.js', () => ({
    detectLorebookRenames: vi.fn(async () => []),
    showLorebookRenameModal: vi.fn(),
    openDatabaseBrowserForRename: vi.fn(),
}));
vi.mock('../core/content-vectorization.js', () => ({
    vectorizeContent: vi.fn(async () => ({ success: true, chunkCount: 3 })),
    resolveEffectiveSettings: vi.fn((s) => ({ vector_backend: 'standard', ...(s || {}) })),
}));

import { extension_settings } from '../../../../extensions.js';
import { loadWorldInfo } from '../../../../world-info.js';
import { deleteCollection } from '../core/collection-loader.js';
import { vectorizeContent } from '../core/content-vectorization.js';
import { resolveLiveEntries } from '../core/world-info-integration.js';
import {
    invalidateLorebook,
    reindexLorebookNow,
    findLorebookRegistryKey,
    installLorebookInvalidationHook,
    _clearPendingInvalidations,
} from '../core/lorebook-invalidation.js';

function hit(sourceName, entryUid, content, extra = {}) {
    return {
        uid: `${sourceName}-${entryUid}`,
        content,
        score: 0.9,
        metadata: { sourceName, entryUid },
        ...extra,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    _state.books = {};
    _state.registry = [];
    _state.meta = {};
    extension_settings.vectfox = {};
});

afterEach(() => {
    _clearPendingInvalidations();
    delete globalThis._rpgGetCurrentPrefix;
    delete globalThis._rpgGetActivationMode;
    delete globalThis.vectfox_invalidateLorebook;
});

// ============================================================================
// resolveLiveEntries
// ============================================================================

describe('resolveLiveEntries', () => {
    it('replaces vector-snapshot text with live lorebook content', async () => {
        _state.books['Eldoria_NPCs'] = {
            entries: { 3: { uid: 3, content: 'LIVE: Thorne now leads the Syndicate.', disable: true } },
        };
        // Fatbody semantic mode so the disabled (dormant) entry passes
        globalThis._rpgGetCurrentPrefix = () => 'Eldoria';
        globalThis._rpgGetActivationMode = () => 'semantic';

        const out = await resolveLiveEntries([hit('Eldoria_NPCs', 3, 'STALE: Thorne is a dockworker.')], {});
        expect(out).toHaveLength(1);
        expect(out[0].content).toBe('LIVE: Thorne now leads the Syndicate.');
    });

    it('drops hits whose live entry was deleted', async () => {
        _state.books['MyWorld'] = { entries: { 1: { uid: 1, content: 'kept' } } };
        const out = await resolveLiveEntries(
            [hit('MyWorld', 1, 'kept-stale'), hit('MyWorld', 99, 'deleted-stale')], {});
        expect(out).toHaveLength(1);
        expect(out[0].metadata.entryUid).toBe(1);
    });

    it('drops disabled entries on ordinary lorebooks (respect_entry_disable default on)', async () => {
        _state.books['MyWorld'] = {
            entries: {
                1: { uid: 1, content: 'enabled entry' },
                2: { uid: 2, content: 'disabled entry', disable: true },
            },
        };
        const out = await resolveLiveEntries([hit('MyWorld', 1, 'a'), hit('MyWorld', 2, 'b')], {});
        expect(out).toHaveLength(1);
        expect(out[0].content).toBe('enabled entry');
    });

    it('keeps disabled entries when world_info_respect_entry_disable is false', async () => {
        _state.books['MyWorld'] = { entries: { 2: { uid: 2, content: 'disabled entry', disable: true } } };
        const out = await resolveLiveEntries([hit('MyWorld', 2, 'b')], { world_info_respect_entry_disable: false });
        expect(out).toHaveLength(1);
        expect(out[0].content).toBe('disabled entry');
    });

    it('waives the disable check ONLY for Fatbody books in semantic mode', async () => {
        _state.books['Eldoria_NPCs'] = { entries: { 1: { uid: 1, content: 'dormant lore', disable: true } } };
        _state.books['Other_Book'] = { entries: { 1: { uid: 1, content: 'user-disabled', disable: true } } };
        globalThis._rpgGetCurrentPrefix = () => 'Eldoria';
        globalThis._rpgGetActivationMode = () => 'semantic';

        const out = await resolveLiveEntries(
            [hit('Eldoria_NPCs', 1, 'x'), hit('Other_Book', 1, 'y')], {});
        expect(out).toHaveLength(1);
        expect(out[0].content).toBe('dormant lore');

        // In managed mode the same Fatbody entry is filtered like any other
        globalThis._rpgGetActivationMode = () => 'managed';
        const out2 = await resolveLiveEntries([hit('Eldoria_NPCs', 1, 'x')], {});
        expect(out2).toHaveLength(0);
    });

    it('falls back to vector text when the book fails to load', async () => {
        _state.books['BrokenBook'] = null; // loadWorldInfo throws
        const out = await resolveLiveEntries([hit('BrokenBook', 1, 'vector fallback')], {});
        expect(out).toHaveLength(1);
        expect(out[0].content).toBe('vector fallback');
    });

    it('passes through hits without sourceName/entryUid metadata', async () => {
        const legacy = { uid: 'h1', content: 'legacy chunk', score: 0.8, metadata: {} };
        const out = await resolveLiveEntries([legacy], {});
        expect(out).toEqual([legacy]);
    });

    it('loads each book once per call (per-generation cache)', async () => {
        _state.books['MyWorld'] = {
            entries: { 1: { uid: 1, content: 'a' }, 2: { uid: 2, content: 'b' } },
        };
        await resolveLiveEntries([hit('MyWorld', 1, 'x'), hit('MyWorld', 2, 'y')], {});
        expect(loadWorldInfo).toHaveBeenCalledTimes(1);
    });
});

// ============================================================================
// invalidateLorebook / reindexLorebookNow
// ============================================================================

describe('lorebook invalidation hook', () => {
    it('findLorebookRegistryKey matches sanitized lorebook names', () => {
        _state.registry = ['standard:vf_lorebook_eldoria_npcs_1700000000000'];
        expect(findLorebookRegistryKey('Eldoria NPCs')).toBe('standard:vf_lorebook_eldoria_npcs_1700000000000');
        expect(findLorebookRegistryKey('Unrelated')).toBeNull();
    });

    it('schedules a debounced re-index for an already-vectorized book and marks it dirty', async () => {
        vi.useFakeTimers();
        try {
            _state.registry = ['standard:vf_lorebook_eldoria_npcs_1700000000000'];
            const scheduled = invalidateLorebook('Eldoria NPCs', { debounceMs: 1000 });
            expect(scheduled).toBe(true);
            expect(_state.meta['standard:vf_lorebook_eldoria_npcs_1700000000000'].dirty).toBe(true);
            expect(vectorizeContent).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1100);
            expect(deleteCollection).toHaveBeenCalledTimes(1);
            expect(vectorizeContent).toHaveBeenCalledTimes(1);
            expect(vectorizeContent.mock.calls[0][0]).toMatchObject({
                contentType: 'lorebook',
                source: { type: 'select', id: 'Eldoria NPCs', name: 'Eldoria NPCs' },
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('debounce coalesces a burst of writes into one re-index', async () => {
        vi.useFakeTimers();
        try {
            _state.registry = ['standard:vf_lorebook_eldoria_npcs_1700000000000'];
            invalidateLorebook('Eldoria NPCs', { debounceMs: 1000 });
            await vi.advanceTimersByTimeAsync(500);
            invalidateLorebook('Eldoria NPCs', { debounceMs: 1000 });
            await vi.advanceTimersByTimeAsync(500);
            expect(vectorizeContent).not.toHaveBeenCalled(); // timer was reset
            await vi.advanceTimersByTimeAsync(600);
            expect(vectorizeContent).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('creates a fresh collection for an unindexed Fatbody book only in semantic mode', () => {
        globalThis._rpgGetCurrentPrefix = () => 'Eldoria';

        globalThis._rpgGetActivationMode = () => 'managed';
        expect(invalidateLorebook('Eldoria_NPCs', { debounceMs: 50 })).toBe(false);

        globalThis._rpgGetActivationMode = () => 'semantic';
        expect(invalidateLorebook('Eldoria_NPCs', { debounceMs: 50 })).toBe(true);
    });

    it('respects the auto_reindex_invalidated_lorebooks=false gate but still marks dirty', () => {
        extension_settings.vectfox = { auto_reindex_invalidated_lorebooks: false };
        _state.registry = ['standard:vf_lorebook_eldoria_npcs_1700000000000'];
        expect(invalidateLorebook('Eldoria NPCs', { debounceMs: 50 })).toBe(false);
        expect(_state.meta['standard:vf_lorebook_eldoria_npcs_1700000000000'].dirty).toBe(true);
    });

    it('reindexLorebookNow carries forward scope/strategy/chunkSize from the old collection', async () => {
        _state.registry = ['standard:vf_lorebook_eldoria_npcs_1700000000000'];
        _state.meta['standard:vf_lorebook_eldoria_npcs_1700000000000'] = {
            scope: 'chat',
            settings: { strategy: 'per_entry', chunkSize: 512 },
        };
        await reindexLorebookNow('Eldoria NPCs');
        expect(vectorizeContent.mock.calls[0][0].settings).toMatchObject({
            scope: 'chat', strategy: 'per_entry', chunkSize: 512,
        });
    });

    it('installLorebookInvalidationHook publishes a never-throwing global', () => {
        installLorebookInvalidationHook();
        expect(typeof globalThis.vectfox_invalidateLorebook).toBe('function');
        // invalid input must not throw into the caller (Fatbody's lore write path)
        expect(() => globalThis.vectfox_invalidateLorebook(undefined)).not.toThrow();
        expect(globalThis.vectfox_invalidateLorebook(undefined)).toBe(false);
    });
});
