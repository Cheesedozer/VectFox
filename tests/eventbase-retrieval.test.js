/**
 * EventBase Retrieval Tests
 *
 * Primary purpose: REGRESSION GUARD for the "log is not defined" class of bug.
 * retrieveEvents() once referenced `log` (via log.enabled) without importing it,
 * throwing "ReferenceError: log is not defined" the moment the function ran —
 * but only at message-send time, never at import time, so npm test stayed green
 * and it shipped. This test CALLS retrieveEvents so any missing import / runtime
 * reference error inside the function body surfaces as a failure here.
 *
 * Isolation strategy (important — do NOT replace with a global vitest alias):
 * every DIRECT import of eventbase-retrieval.js is mocked below. Because all six
 * dependencies are stubbed, none of them load, so the SillyTavern host modules
 * they transitively pull in (script.js, secrets.js, extensions.js, ...) are
 * never resolved. This keeps the blast radius to this one file and needs no
 * vitest.config.js change. See [[project_vitest_host_stub]] for why the global
 * alias approach was abandoned (it collided with other tests' vi.mock calls).
 *
 * NOTE on mocking ./log.js: the `import { log }` line must still EXIST in the
 * source for the `log` binding to resolve to this mock. If someone deletes that
 * import again, `log` becomes an undefined reference and the call-time tests
 * below throw — exactly the regression we are guarding against.
 * 
 * npx vitest run --reporter=verbose 2>&1 | Tee-Object -FilePath C:\tmp\vitest-out.txt
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mock every DIRECT dependency of core/eventbase-retrieval.js ---
const queryCollectionMock = vi.fn();
vi.mock('../core/core-vector-api.js', () => ({
    queryCollection: (...a) => queryCollectionMock(...a),
}));

// Native-rerank path only (Qdrant + opt-in), not exercised here — stub to null.
vi.mock('../backends/backend-manager.js', () => ({
    getBackendForCollection: vi.fn(async () => null),
    getBackend: vi.fn(async () => null),
}));

vi.mock('../core/collection-ids.js', () => ({
    parseRegistryKey: vi.fn((id) => ({ backend: null, collectionId: id })),
}));

vi.mock('../core/eventbase-schema.js', () => ({
    parseEmbedText: vi.fn(() => ({})),
}));

const checkPluginAvailableMock = vi.fn(async () => true);
vi.mock('../core/collection-loader.js', () => ({
    checkPluginAvailable: (...a) => checkPluginAvailableMock(...a),
}));

// Permissive log stub: every level is a no-op, predicates return false so the
// debug branches stay quiet. Mocking this avoids loading log.js -> extensions.js
// while STILL requiring the `import { log }` line to exist in the source.
vi.mock('../core/log.js', () => ({
    log: {
        enabled: () => false,
        domainEnabled: () => false,
        error: () => {},
        warn: () => {},
        lifecycle: () => {},
        verbose: () => {},
        trace: () => {},
        domain: () => {},
    },
    LOG_DOMAINS: [],
}));

import { retrieveEvents } from '../core/eventbase-retrieval.js';

const baseSettings = {
    vector_backend: 'standard',
    eventbase_retrieval_top_k: 8,
    eventbase_retrieval_min_importance: 1,
};

function makeEvent(i, overrides = {}) {
    return {
        event_id: `evt_${i}`,
        event_type: `type_${i}`,
        text: `Event number ${i} happened in the story.`,
        importance: 5,
        should_persist: false,
        source_window_end: i,
        score: 0.9 - i * 0.01,
        keywords: [`kw${i}`],
        ...overrides,
    };
}

beforeEach(() => {
    queryCollectionMock.mockReset();
    checkPluginAvailableMock.mockReset();
    checkPluginAvailableMock.mockResolvedValue(true);
});

describe('retrieveEvents', () => {
    it('runs without throwing a ReferenceError (missing-import regression guard)', async () => {
        // THE guard: the original bug threw "ReferenceError: log is not defined"
        // on the first line of the function body. This call would have failed.
        queryCollectionMock.mockResolvedValue({ hashes: [], metadata: [] });

        await expect(retrieveEvents({
            searchText: 'what happened to the hero',
            keywordQuery: 'hero',
            chatLength: 50,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [],
            skipLiveQuery: false,
        })).resolves.not.toThrow();
    });

    it('returns the {events, debug} shape', async () => {
        queryCollectionMock.mockResolvedValue({ hashes: [], metadata: [] });

        const result = await retrieveEvents({
            searchText: 'recap',
            keywordQuery: 'recap',
            chatLength: 50,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [],
            skipLiveQuery: false,
        });

        expect(result).toBeTypeOf('object');
        expect(Array.isArray(result.events)).toBe(true);
        expect(result.debug).toBeTypeOf('object');
    });

    it('returns ranked events from the live query (non-empty path)', async () => {
        const metadata = [makeEvent(1), makeEvent(2), makeEvent(3)];
        queryCollectionMock.mockResolvedValue({
            hashes: metadata.map(m => m.event_id),
            metadata,
        });

        const { events, debug } = await retrieveEvents({
            searchText: 'story recap',
            keywordQuery: 'story',
            chatLength: 100,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [],
            skipLiveQuery: false,
        });

        expect(queryCollectionMock).toHaveBeenCalled();
        expect(events.length).toBeGreaterThan(0);
        expect(debug.rawCount).toBeGreaterThan(0);
    });

    it('skips the live query and folds in archive candidates without calling the backend', async () => {
        const archive = [makeEvent(10), makeEvent(11)];

        const { events, debug } = await retrieveEvents({
            searchText: 'recap',
            keywordQuery: 'recap',
            chatLength: 100,
            settings: baseSettings,
            liveCollectionIds: [],
            additionalCandidates: archive,
            skipLiveQuery: true,
        });

        expect(queryCollectionMock).not.toHaveBeenCalled();
        expect(debug.archiveCandidates).toBe(2);
        expect(Array.isArray(events)).toBe(true);
    });

    it('filters out events below minimum importance', async () => {
        const metadata = [
            makeEvent(1, { importance: 9 }),
            makeEvent(2, { importance: 1 }),
        ];
        queryCollectionMock.mockResolvedValue({
            hashes: metadata.map(m => m.event_id),
            metadata,
        });

        const { debug } = await retrieveEvents({
            searchText: 'q',
            keywordQuery: 'q',
            chatLength: 100,
            settings: { ...baseSettings, eventbase_retrieval_min_importance: 5 },
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [],
            skipLiveQuery: false,
        });

        // Only the importance-9 event survives the >=5 filter.
        expect(debug.afterImportanceFilter).toBe(1);
    });

    // -----------------------------------------------------------------------
    // Duplicate suppression (step 5)
    // -----------------------------------------------------------------------
    describe('duplicate suppression', () => {
        const scene = (i, text, overrides = {}) => makeEvent(i, {
            event_type: 'dialogue_significant',
            characters: ['Aria', 'Leon'],
            source_window_end: 40 + i,
            // below DUPLICATE_SCORE_OVERRIDE (0.75), which exempts a candidate from suppression
            score: 0.6 - i * 0.01,
            text,
            ...overrides,
        });
        const run = async (metadata) => {
            queryCollectionMock.mockResolvedValue({ hashes: metadata.map(m => m.event_id), metadata });
            const { events } = await retrieveEvents({
                searchText: 'q', keywordQuery: 'q', chatLength: 200, settings: baseSettings,
                liveCollectionIds: ['standard:vf_eventbase_x'], additionalCandidates: [], skipLiveQuery: false,
            });
            return events.map(e => e.event_id);
        };

        it('keeps different events with the same type and cast a few messages apart', async () => {
            // The shape of most neighbouring events in a one-on-one chat: before
            // the wording check the second and third were dropped as duplicates.
            const ids = await run([
                scene(1, 'Aria admits to Leon that she forged the commander\'s signature on the supply order.'),
                scene(2, 'Leon tells Aria about his brother who vanished in the northern mines years ago.'),
                scene(3, 'Aria and Leon argue over whether to warn the village before the patrol arrives.'),
            ]);
            expect(ids).toEqual(['evt_1', 'evt_2', 'evt_3']);
        });

        it('suppresses the same event told twice by overlapping windows', async () => {
            const ids = await run([
                scene(1, 'Aria admits to Leon that she forged the commander\'s signature on the supply order.'),
                scene(2, 'Aria admits to Leon that she forged the signature of the commander on the supply order.'),
            ]);
            expect(ids).toEqual(['evt_1']);
        });

        it('compares CJK text by character pairs', async () => {
            const same = await run([
                scene(1, '師傅承諾幫梅拉尋找失蹤的父親暗影之翼。'),
                scene(2, '師傅承諾幫助梅拉尋找她失蹤的父親暗影之翼。'),
            ]);
            expect(same).toEqual(['evt_1']);
            const different = await run([
                scene(1, '師傅承諾幫梅拉尋找失蹤的父親暗影之翼。'),
                scene(2, '梅拉在市場偷走了商人的地圖並逃進小巷。'),
            ]);
            expect(different).toEqual(['evt_1', 'evt_2']);
        });

        it('still suppresses on type, cast and timing alone when there is no text to compare', async () => {
            const ids = await run([scene(1, ''), scene(2, '')]);
            expect(ids).toEqual(['evt_1']);
        });

        it('never treats events far apart in the chat as duplicates', async () => {
            const text = 'Aria admits to Leon that she forged the commander\'s signature.';
            const ids = await run([scene(1, text), scene(2, text, { source_window_end: 120 })]);
            expect(ids.sort()).toEqual(['evt_1', 'evt_2']);
        });
    });
});
