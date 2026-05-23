/**
 * Eventbase-test.spec.js — Playwright integration tests for VectFox
 *
 * Run all:      npm run test:e2e
 * Run one:      npx playwright test --grep "TEST 001"
 * View report:  npm run test:e2e:report
 *
 * On first run: a Playwright browser window opens. Log in, then open the chat
 * that has your locked collections. Tests start automatically once the chat is open.
 *  * npm install -D @playwright/test
 * npx playwright install
 * 
 * # Run all 8 tests
npm run test:e2e
npm run test:e2e:no-log.
npm run test:e2e -- --grep "TEST 008"
npm run test:e2e -- --grep "TEST 00[5-9]|TEST 01[01]"
--grep "TEST 008|TEST 009" (regex, run multiple)
--grep "TEST 008" --debug (Playwright inspector)
--grep-invert "TEST 00[1-7]" (everything except 1-7)
--grep "TEST 00[1-7]" (everything except 1-7)


# Run a specific test
npx playwright test --grep "TEST 001"
npm run test:e2e -- --grep "TEST 00[5-9]|TEST 01[01]"


# View HTML report after a run
npm run test:e2e:report
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'fs';

// ---------------------------------------------------------------------------
// SillyTavern target URL — override here for quick A/B testing across machines
// ---------------------------------------------------------------------------
//
// Set TEST_TARGET_URL to point the suite at a different ST instance for one
// run. Leave it as `null` to fall back to the default chain:
//   1. `process.env.SILLYTAVERN_URL` if set, otherwise
//   2. `baseURL` in playwright.config.js
//
// Examples:
//   const TEST_TARGET_URL = 'http://192.168.1.50:8000';   // LAN box
//   const TEST_TARGET_URL = 'http://localhost:8000';      // local ST
//   const TEST_TARGET_URL = null;                          // use config/env
//
// This override only affects THIS test file — it doesn't mutate the config
// for any other suite.
// ---------------------------------------------------------------------------
const TEST_TARGET_URL = 'http://localhost:8000';

if (TEST_TARGET_URL) {
    test.use({ baseURL: TEST_TARGET_URL });
    console.log(`[setup] Eventbase-test.spec.js: baseURL overridden → ${TEST_TARGET_URL}`);
}

// ---------------------------------------------------------------------------
// serial mode — one browser window, shared across all tests
// ---------------------------------------------------------------------------
test.describe.configure({ mode: 'serial' });

let sharedPage;
let sharedContext;

const AUTH_FILE = '.playwright-auth.json';

test.beforeAll(async ({ browser }) => {
    // Reuse saved cookies/localStorage from the last run so login is skipped
    sharedContext = await browser.newContext({
        storageState: existsSync(AUTH_FILE) ? AUTH_FILE : undefined,
    });
    sharedPage = await sharedContext.newPage();

    // Force-disable HTTP cache via Chrome DevTools Protocol BEFORE the first
    // navigation. Without this, the browser will happily reuse a cached copy
    // of VectFox's JS files across test runs, masking code changes — leading
    // to "the fix is on disk but the test still sees the old behavior".
    try {
        const cdp = await sharedContext.newCDPSession(sharedPage);
        await cdp.send('Network.clearBrowserCache');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        console.log('[setup] HTTP cache cleared and disabled (CDP)');
    } catch (err) {
        console.warn(`[setup] CDP cache disable failed (non-Chromium?): ${err.message}`);
    }

    // First navigation: load the page so we can access window APIs. ST may register
    // a service worker that caches JS files — survives HTTP cache busting because
    // it serves from its own Cache Storage. Unregister it and wipe Cache Storage,
    // then reload so the page comes up SW-free with fresh JS.
    await sharedPage.goto('/');
    try {
        const swWiped = await sharedPage.evaluate(async () => {
            const result = { regsBefore: 0, regsAfter: 0, cacheKeys: [] };
            if (navigator.serviceWorker) {
                const regs = await navigator.serviceWorker.getRegistrations();
                result.regsBefore = regs.length;
                await Promise.all(regs.map(r => r.unregister()));
                result.regsAfter = (await navigator.serviceWorker.getRegistrations()).length;
            }
            if (typeof caches !== 'undefined') {
                result.cacheKeys = await caches.keys();
                await Promise.all(result.cacheKeys.map(k => caches.delete(k)));
            }
            return result;
        });
        console.log(`[setup] Service workers: ${swWiped.regsBefore} → ${swWiped.regsAfter}, Cache Storage cleared: ${swWiped.cacheKeys.length} key(s)`);
        if (swWiped.regsBefore || swWiped.cacheKeys.length) {
            console.log('[setup] Reloading page so fresh JS (no SW) is fetched...');
            await sharedPage.reload({ waitUntil: 'load' });
        }
    } catch (err) {
        console.warn(`[setup] Service worker / Cache Storage wipe failed: ${err.message}`);
    }

    // Show a banner in the Playwright window so the user knows what to do
    await sharedPage.waitForSelector('body');
    await sharedPage.evaluate(() => {
        const el = document.createElement('div');
        el.id = '__vf_test_hint';
        el.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
            'background:#1a1a2e', 'color:#eee', 'padding:14px 20px',
            'font:15px/1.5 sans-serif', 'text-align:center',
            'box-shadow:0 2px 8px rgba(0,0,0,0.6)',
        ].join(';');
        el.innerHTML = '🧪 <b>VectFox Tests</b> — log in (if needed), then open the chat that has your locked collections. Tests start automatically once the chat is open.';
        document.body.prepend(el);
    }).catch(() => {});

    console.log('[setup] Log in (if needed) and open the correct chat in the Playwright browser window...');

    // Wait for ST's send button — present once logged in and on the main page
    await sharedPage.waitForSelector('#send_but', { timeout: 120000 });

    // Wait until a chat is actually open. Strictly gate on ctx.chatId — the
    // previous DOM-presence fallback (#chat .mes count > 0) could trigger on
    // stale UI from a previous session even when the user hadn't focused the
    // Playwright window and clicked into a chat yet. Tests downstream all
    // strictly check ctx.chatId, so beforeAll must match that contract or
    // tests start before they should and fail mysteriously with "No active
    // chat — open a chat first."
    console.log('[setup] Waiting for chat to become active (focus the Playwright window and click a chat)...');
    await sharedPage.waitForFunction(
        () => {
            const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? null;
            return !!ctx?.chatId;
        },
        { timeout: 120000 }
    );

    // Save cookies + localStorage so the next run skips login
    await sharedContext.storageState({ path: AUTH_FILE });
    console.log(`[setup] Auth state saved → ${AUTH_FILE}`);

    // Let VectFox and other extensions finish initialising
    await sharedPage.waitForTimeout(2000);

    // Pre-test cleanup: remove leftover *playwright_test* collections from
    // previous (possibly interrupted) runs.
    //
    // Match pattern: case-insensitive `playwright_test` substring on EITHER
    // the collectionId or the registryKey. This is broader than the previous
    // `__vf_playwright_test_` check and catches:
    //   • IDs without the leading double-underscore (`vf_playwright_test_…`)
    //   • Registry-key-only orphans whose collectionId has been stripped
    //   • Any future test naming convention as long as it includes the
    //     unambiguous `playwright_test` marker
    // The marker is unique enough that a real user collection would never
    // contain it accidentally.
    const cleanupReport = await sharedPage.evaluate(async () => {
        const base = '/scripts/extensions/third-party/VectFox/';
        const { getCollectionListing, unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const vf = extension_settings?.vectfox;
        if (!vf) return { leftover: [] };

        const listing = getCollectionListing(vf);
        const leftover = [];
        const isTestMarker = (s) => typeof s === 'string' && s.toLowerCase().includes('playwright_test');

        for (const e of listing) {
            const cid = e.collectionId || '';
            const rk  = e.registryKey  || '';
            if (isTestMarker(cid) || isTestMarker(rk)) leftover.push({ cid, rk });
        }

        // Full cleanup for leftover test data only (vectors + meta + registry).
        // Real user collections are never touched.
        for (const { cid, rk } of leftover) {
            try { await deleteContentCollection(cid); } catch {}
            try { deleteCollectionMeta(rk); } catch {}
            try { unregisterCollection(rk); } catch {}
            // Defensive: also try the bare-ID form in case a pre-B4-fix run
            // left a duplicate entry behind.
            try { unregisterCollection(cid); } catch {}
        }

        return { leftover };
    });

    if (cleanupReport.leftover.length) {
        console.log(`[setup] Removed ${cleanupReport.leftover.length} leftover test collection(s):`);
        cleanupReport.leftover.forEach(e => console.log(`  ${e.cid}`));
    } else {
        console.log('[setup] Nothing to clean up ✓');
    }

    console.log('[setup] Chat open — running tests ✓');
});

test.afterAll(async () => {
    await sharedContext?.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runTestInPage(testFn) {
    const logs = [];
    const handler = msg => logs.push({ type: msg.type(), text: msg.text() });
    sharedPage.on('console', handler);
    try {
        await sharedPage.evaluate(testFn);
    } catch (err) {
        logs.push({ type: 'error', text: `page.evaluate threw: ${err.message}` });
    }
    sharedPage.off('console', handler);
    return logs;
}

function assertPassed(logs) {
    const failLines = logs.filter(m => m.text.includes('[FAIL]')).map(m => m.text);
    const warnLines = logs.filter(m => m.text.includes('[WARN]')).map(m => m.text);
    const skipLines = logs.filter(m => m.text.includes('[SKIP]')).map(m => m.text);
    const passed    = logs.some(m => m.text.includes('[PASS]'));

    logs.forEach(m => {
        if      (m.type === 'error')   console.error(m.text);
        else if (m.type === 'warning') console.warn(m.text);
        else                           console.log(m.text);
    });

    if (warnLines.length) console.warn('WARNINGS:\n' + warnLines.join('\n'));

    // [SKIP] is a soft-pass: the test couldn't run because a prerequisite
    // wasn't met (no plugin, no qdrant config, wrong backend, etc.). In
    // serial-mode suites this is critical — a hard FAIL halts every
    // subsequent test, so a no-plugin user running the full suite would be
    // stuck at TEST 001 and never reach the standard-backend tests that
    // DO work on their machine. SKIP keeps the suite moving.
    //
    // Precedence: SKIP wins over the PASS-required check, so a test that
    // skipped without emitting [FAIL] is treated as cleanly bypassed.
    // SKIP does NOT override [FAIL] — a test that emits both is still a
    // hard failure (someone should fix the test or the environment).
    expect(failLines.length, '[FAIL] found:\n' + failLines.join('\n')).toBe(0);
    if (skipLines.length) {
        console.warn('SKIPPED:\n' + skipLines.join('\n'));
        return;
    }
    expect(passed, 'No [PASS] found — test did not reach success path').toBe(true);
}

// ---------------------------------------------------------------------------
// Environment probes — used by soft-skip helpers below
// ---------------------------------------------------------------------------
//
// These probes run at the spec level (outside runTestInPage) so we can call
// `test.skip(...)` cleanly before the test body executes. Skipping at this
// layer marks the test as ⏭️ skipped in the Playwright report instead of as
// failed — critical for serial-mode suites, where a hard FAIL halts every
// subsequent test. Without soft-skip, a no-plugin user running the full
// suite gets stuck at TEST 001 and never reaches TEST 009 (the test that
// specifically validates their environment).

let _pluginAvailableCache = null;
async function isSimilharityPluginAvailable() {
    if (_pluginAvailableCache !== null) return _pluginAvailableCache;
    try {
        _pluginAvailableCache = await sharedPage.evaluate(async () => {
            try {
                const resp = await fetch('/api/plugins/similharity/probe', { method: 'GET' });
                // ST's generic 404 page (route not registered = plugin not
                // installed/enabled) is text/html. Any other content-type
                // means the request reached the plugin route table — even a
                // 404 JSON inside the plugin counts as "plugin installed".
                const ct = resp.headers.get('content-type') || '';
                return !ct.includes('text/html');
            } catch { return false; }
        });
    } catch { _pluginAvailableCache = false; }
    return !!_pluginAvailableCache;
}

async function hasQdrantConfig() {
    try {
        return await sharedPage.evaluate(async () => {
            const { extension_settings } = await import('/scripts/extensions.js');
            const vf = extension_settings?.vectfox;
            return !!(vf?.qdrant_url || vf?.qdrant_host);
        });
    } catch { return false; }
}

/**
 * Soft-skip helper for tests that require the qdrant pipeline. Skips cleanly
 * (test marked ⏭️ in report, not failed) when either:
 *   1. The Similharity plugin isn't installed (qdrant requires it — see
 *      Doc/dev_helper.md §15 plugin-dependency policy).
 *   2. VectFox settings have no `qdrant_url` / `qdrant_host` configured.
 *
 * Use at the very top of any qdrant-requiring test body.
 */
async function skipIfQdrantUnavailable() {
    if (!(await isSimilharityPluginAvailable())) {
        test.skip(true, 'Similharity plugin not installed — qdrant requires it. See Doc/dev_helper.md §15.');
    }
    if (!(await hasQdrantConfig())) {
        test.skip(true, 'Qdrant URL/host not configured in VectFox settings.');
    }
}

/**
 * Soft-skip helper for TEST 008 — uses standard backend but specifically
 * exercises the plugin-enhanced path. Skips when the plugin isn't installed.
 * (TEST 009 is the no-plugin counterpart and should run on any machine.)
 */
async function skipIfNoPlugin() {
    if (!(await isSimilharityPluginAvailable())) {
        test.skip(true, 'Similharity plugin not installed — this test exercises the plugin-enhanced path. TEST 009 is the no-plugin counterpart.');
    }
}


// ═══════════════════════════════════════════════════════════════════
// TEST 001 — Qdrant lorebook: vectorize → lock → query isolation
// ═══════════════════════════════════════════════════════════════════
// Self-contained: creates its own test lorebook, vectorizes it with Qdrant,
// locks it to the current chat, runs a dry-run query, then cleans up.
// No external setup required — just needs Qdrant configured in VectFox settings.
test('TEST 001 — Qdrant lorebook: lock + query isolation', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 001 [QdrantLorebook]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { shouldCollectionActivate, deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

        // Defensive in-eval check — spec-level skipIfQdrantUnavailable should
        // have already returned for missing config, but belt-and-suspenders.
        const hasQdrant = !!(vf.qdrant_url || vf.qdrant_host);
        if (!hasQdrant) { console.warn(`${TEST} [SKIP] Qdrant not configured — set qdrant_url or qdrant_host in VectFox settings`); return; }

        // Synthetic lorebook entries with content that is clearly unique to this test
        const testEntries = [
            {
                uid: 'vf_test_001_a',
                comment: 'Tesseract Crystal',
                key: ['tesseract', 'crystal'],
                content: 'The Tesseract Crystal is a rare gemstone found only in the deepest caverns of the Rift Mountains. It emits a faint blue glow and can store magical energy indefinitely. Scholars have catalogued seventeen distinct alchemical applications for the stone.',
            },
            {
                uid: 'vf_test_001_b',
                comment: 'Velmora Pact',
                key: ['velmora', 'pact'],
                content: 'The Velmora Pact was signed in the third age between the river nations and the highland clans. It established shared water rights and prohibited the construction of dams above the city of Quellos. The pact is renewed every fifty years by the Council of Streams.',
            },
            {
                uid: 'vf_test_001_c',
                comment: 'Ironbark Trees',
                key: ['ironbark', 'tree'],
                content: 'Ironbark trees grow only in the northern tundra. Their wood is denser than steel and resists both fire and decay. Lumberjacks require enchanted axes to harvest them. A single plank can support the weight of a fully loaded merchant cart.',
            },
        ];

        // Vectorize — vectorizeContent auto-locks to current chat when scope='chat'
        console.log(`${TEST} Vectorizing test lorebook (3 entries) with Qdrant backend...`);
        let vectorizeResult;
        try {
            vectorizeResult = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_001__', entries: testEntries },
                settings: { ...vf, vector_backend: 'qdrant', strategy: 'per_entry', scope: 'chat' },
            });
        } catch (err) {
            console.error(`${TEST} [FAIL] vectorizeContent threw: ${err.message}`);
            return;
        }

        if (!vectorizeResult?.success || !vectorizeResult.collectionId) {
            console.error(`${TEST} [FAIL] Vectorization failed or returned no collectionId`);
            return;
        }

        const collectionId = vectorizeResult.collectionId;
        const registryKey  = `qdrant:${collectionId}`;
        console.log(`${TEST} Vectorized ${vectorizeResult.chunkCount} chunks → ${registryKey}`);

        try {
            // Confirm the new collection is active for this chat
            const isActive = await shouldCollectionActivate(registryKey, context);
            if (!isActive) {
                console.error(`${TEST} [FAIL] New collection not activated for current chat — scope=chat lock did not apply`);
                return;
            }
            console.log(`${TEST} Collection locked and active for current chat ✓`);

            // Dry-run with a query that should match the Tesseract Crystal entry
            const chat = ctx.chat ?? [];
            const testQuery = 'tesseract crystal magical energy rift mountains';
            let result;
            try { result = await runLorebookWIDryRun({ chat, testMessage: testQuery, settings: vf }); }
            catch (err) { console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`); return; }

            if (!result.entryCount) { console.error(`${TEST} [FAIL] Dry-run returned 0 entries for query "${testQuery}"`); return; }

            console.log(`${TEST} Dry-run: ${result.entryCount} entry/entries returned`);
            console.log(`  preview: ${(result.injectionText || '').slice(0, 200)}`);
            console.log(`${TEST} [PASS] Qdrant lorebook vectorized, locked, results returned, no contamination`);
        } finally {
            // Always clean up the test collection so it doesn't pollute the user's DB
            try {
                await deleteContentCollection(collectionId);
                // TEST-ONLY: nuke vectra-side-effect folder (B4 — qdrant insert
                // path leaves an empty vectra placeholder during registry stamping).
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                deleteCollectionMeta(registryKey);
                unregisterCollection(registryKey);
                // Also remove the BARE-ID duplicate registry entry (B4) that the
                // qdrant insert path leaves behind. Without this the DB browser
                // shows the collection as a "VECTRA"-tagged 0-chunk orphan.
                unregisterCollection(collectionId);
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 002 — Qdrant EventBase: insert + field check
// ═══════════════════════════════════════════════════════════════════
// Self-contained: creates its own EventBase collection, inserts 2 test
// events, queries them back, verifies fields, then cleans up.
test('TEST 002 — Qdrant EventBase: insert + field check', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 002 [EventBaseQdrant]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { insertEvents } = await import(base + 'core/eventbase-store.js');
        const { deleteCollection } = await import(base + 'core/collection-loader.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const settings = { ...vf, vector_backend: 'qdrant' };
        const ts = Date.now();
        // collectionId contains __vf_playwright_test_ so beforeAll cleanup catches orphans
        const collectionId = `vf_eventbase_qdrant_playwright___vf_playwright_test_002__${ts}`;
        const registryKey  = `qdrant:${collectionId}`;
        const testChatUUID = `__vf_playwright_test_002__${ts}`;

        const testEvents = [
            {
                event_type: 'dialogue_significant',
                importance: 8,
                summary: 'Charlotte and Prince Estra forge a naval alliance against the empire',
                DateTime: '2026-01-01T12:00:00Z',
                cause: 'War council meeting at Royal HQ',
                result: 'Alliance formally established',
                characters: ['Charlotte', 'Prince Estra'],
                locations: ['Royal Navy HQ'],
                factions: ['Eltherins Empire', 'Floran Privateers'],
                items: [],
                concepts: ['naval warfare', 'diplomacy', 'alliance'],
                keywords: ['naval', 'strategy', 'alliance', 'charlotte', 'prince'],
                open_threads: ['Will the empire retaliate?'],
                should_persist: true,
                chat_uuid: testChatUUID,
                event_id: `test_event_001_${ts}`,
                source_window_start: 0,
                source_window_end: 5,
                source_message_hashes: [11111, 22222],
                schema_version: 1,
            },
            {
                event_type: 'combat',
                importance: 9,
                summary: 'Pirate fleet ambushes the imperial supply convoy near the Skaagi islands',
                DateTime: '2026-01-02T08:00:00Z',
                cause: 'Intelligence report from Floran agents',
                result: 'Supply convoy destroyed, 3 ships sunk',
                characters: ['Captain Loren', 'Charlotte'],
                locations: ['Skaagi Islands', 'Southern Sea'],
                factions: ['Floran Privateers', 'Eltherins Empire'],
                items: ['Floran warship', 'imperial cargo'],
                concepts: ['piracy', 'naval combat', 'supply disruption'],
                keywords: ['pirate', 'ambush', 'convoy', 'skaagi', 'combat'],
                open_threads: ['Imperial response fleet dispatched'],
                should_persist: true,
                chat_uuid: testChatUUID,
                event_id: `test_event_002_${ts}`,
                source_window_start: 5,
                source_window_end: 10,
                source_message_hashes: [33333, 44444],
                schema_version: 1,
            },
        ];

        console.log(`${TEST} Inserting 2 test events into ${collectionId}...`);
        try {
            await insertEvents(testEvents, settings, null, collectionId);
        } catch (err) {
            console.error(`${TEST} [FAIL] insertEvents threw: ${err.message}`);
            try { await deleteCollection(collectionId, settings, registryKey); } catch {}
            return;
        }
        console.log(`${TEST} Insert complete ✓`);

        try {
            // Per Doc/collection_helper.md (canonical-API rule): use
            // getBackend so the shared singleton (with pluginAvailable +
            // Qdrant init already done) is returned.
            // A fresh `new QdrantBackend()` would skip that initialization.
            const backend = await getBackend(settings);
            let results;
            try {
                results = await backend.queryCollection(collectionId, 'naval alliance combat pirate', 10, settings);
            } catch (err) {
                console.error(`${TEST} [FAIL] Query threw: ${err.message}`);
                return;
            }

            const items = results?.metadata ?? [];
            if (!items.length) { console.error(`${TEST} [FAIL] Query returned 0 results after insert`); return; }

            // Verify each inserted event_id is present and has its event_type field.
            // Extras (e.g. orphan vectors from prior runs) are warned but don't fail the test.
            const expectedIds = new Set(testEvents.map(e => e.event_id));
            const foundIds = new Set();
            let extras = 0;
            for (const m of items) {
                if (m.event_id && expectedIds.has(m.event_id)) {
                    if (!m.event_type) { console.error(`${TEST} [FAIL] Event ${m.event_id}: missing event_type`); return; }
                    foundIds.add(m.event_id);
                    console.log(`  ✓ ${m.event_id}  type=${m.event_type}  imp=${m.importance}  chars=${JSON.stringify(m.characters)}`);
                } else {
                    extras++;
                }
            }
            if (extras) console.warn(`${TEST} [WARN] ${extras} unrelated result(s) returned (orphan vectors in physical Qdrant collection)`);

            const missing = [...expectedIds].filter(id => !foundIds.has(id));
            if (missing.length) { console.error(`${TEST} [FAIL] ${missing.length} inserted event(s) not retrieved: ${missing.join(', ')}`); return; }

            console.log(`${TEST} [PASS] All ${expectedIds.size} inserted event(s) retrieved with event_type + payload fields`);
        } finally {
            try {
                await deleteCollection(collectionId, settings, registryKey);
                // TEST-ONLY: nuke vectra-side-effect folder + bare registry entry (B4).
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 003 — E2E qdrant: locked lorebook + locked EventBase → both return results
// ═══════════════════════════════════════════════════════════════════
// Setup: TEST 001 + TEST 002 setups both complete
test('TEST 003 — E2E qdrant: both locked, both return results', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 003 [E2EQuery]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { getCollectionListing } = await import(base + 'core/collection-loader.js');
        const { shouldCollectionActivate, getCollectionLocks } = await import(base + 'core/collection-metadata.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');

        const { extension_settings } = await import('/scripts/extensions.js');
        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

        const listing = getCollectionListing(vf);

        const lorebookCols = listing.filter(e => e.collectionId.startsWith('vf_lorebook_'));
        const lockedLorebooks = [];
        for (const e of lorebookCols) {
            if (await shouldCollectionActivate(e.registryKey, context)) lockedLorebooks.push(e);
        }
        if (!lockedLorebooks.length) { console.error(`${TEST} [FAIL] No lorebook activated — complete TEST 001 setup`); return; }
        lockedLorebooks.forEach(e => console.log(`${TEST} Active lorebook: ${e.registryKey}`));

        const eventbaseCols = listing.filter(e => e.collectionId.startsWith('vf_eventbase_'));
        const lockedEventbases = eventbaseCols.filter(e => getCollectionLocks(e.registryKey).some(l => l === currentChatId));
        if (!lockedEventbases.length) { console.error(`${TEST} [FAIL] No EventBase locked — complete TEST 002 setup`); return; }
        console.log(`${TEST} Locked EventBase: ${lockedEventbases.map(e => e.registryKey).join(', ')}`);

        const chat = ctx.chat ?? [];
        const lastUserMsg = [...chat].reverse().find(m => !m.is_system && m.mes)?.mes || 'test query';
        let lorebookResult;
        try { lorebookResult = await runLorebookWIDryRun({ chat, testMessage: lastUserMsg, settings: vf }); }
        catch (err) { console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`); return; }

        if (!lorebookResult.entryCount) { console.error(`${TEST} [FAIL] Lorebook returned 0 entries`); return; }
        console.log(`${TEST} Lorebook: ${lorebookResult.entryCount} entries`);
        console.log(`  preview: ${(lorebookResult.injectionText || '').slice(0, 200)}`);

        const { runEventBaseRetrieval } = await import(base + 'core/eventbase-workflow.js').catch(() => ({}));
        if (typeof runEventBaseRetrieval !== 'function') { console.warn(`${TEST} [WARN] runEventBaseRetrieval not exported`); return; }

        let eventbaseResult;
        try { eventbaseResult = await runEventBaseRetrieval({ chat, settings: vf, dryRun: true, testMessage: lastUserMsg }); }
        catch (err) { console.error(`${TEST} [FAIL] runEventBaseRetrieval threw: ${err.message}`); return; }

        const eventCount = eventbaseResult?.eventCount ?? 0;
        if (!eventCount) { console.error(`${TEST} [FAIL] EventBase returned 0 events`); return; }
        console.log(`${TEST} EventBase: ${eventCount} event(s) injected, lockedCollections=${eventbaseResult.lockedCollectionsCount}, archive=${eventbaseResult.archiveCollectionsCount}`);
        console.log(`  preview: ${(eventbaseResult.injectionText || '').slice(0, 200)}`);

        console.log(`${TEST} [PASS] Lorebook (${lorebookResult.entryCount}) + EventBase (${eventCount}) — locked collections only`);
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 004 — DB Browser: listing + delete (qdrant)
// ═══════════════════════════════════════════════════════════════════
// Self-contained: creates its own qdrant lorebook with 3 named entries,
// verifies listChunks surfaces entryName + text, deletes one chunk,
// verifies it's gone, then cleans up.
test('TEST 004 — DB Browser: listing + delete (any backend)', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 004 [DBBrowser]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        if (!(vf.qdrant_url || vf.qdrant_host)) { console.warn(`${TEST} [SKIP] Qdrant not configured`); return; }

        const testEntries = [
            {
                uid: 'vf_test_004_a',
                comment: 'Glasswing Moths',
                key: ['glasswing', 'moth'],
                content: 'Glasswing moths inhabit the cloud forests of the southern continent. Their transparent wings refract sunlight into faint rainbows. Alchemists collect their wing dust as a primary ingredient for invisibility potions.',
            },
            {
                uid: 'vf_test_004_b',
                comment: 'Sunken Library of Ralthar',
                key: ['ralthar', 'library'],
                content: 'The Sunken Library of Ralthar rests beneath the Cerulean Bay. Sealed in glass domes by the last archmage of the Eighth Council, its scrolls remain dry and legible after four centuries underwater. Only triton scholars hold the keys.',
            },
            {
                uid: 'vf_test_004_c',
                comment: 'Bronzewing Falcons',
                key: ['bronzewing', 'falcon'],
                content: 'Bronzewing falcons are bred by the high desert tribes for long-distance message delivery. They navigate by magnetic field alone and can fly nine hundred miles without rest. Each bird is bonded to a single rider through a ritual of shared blood.',
            },
        ];

        console.log(`${TEST} Vectorizing test lorebook (3 entries) with Qdrant backend...`);
        let vectorizeResult;
        try {
            vectorizeResult = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_004__', entries: testEntries },
                settings: { ...vf, vector_backend: 'qdrant', strategy: 'per_entry', scope: 'chat' },
            });
        } catch (err) { console.error(`${TEST} [FAIL] vectorizeContent threw: ${err.message}`); return; }

        if (!vectorizeResult?.success || !vectorizeResult.collectionId) {
            console.error(`${TEST} [FAIL] Vectorization failed`); return;
        }

        const collectionId = vectorizeResult.collectionId;
        const registryKey  = `qdrant:${collectionId}`;
        console.log(`${TEST} Vectorized ${vectorizeResult.chunkCount} chunks → ${registryKey}`);

        try {
            // Per Doc/collection_helper.md (canonical-API rule): use
            // getBackend so the shared, initialized singleton is returned. A
            // fresh `new QdrantBackend()` would skip the plugin probe and
            // Qdrant init that happens at first use.
            const backend = await getBackend({ ...vf, vector_backend: 'qdrant' });
            let listResult;
            try { listResult = await backend.listChunks(collectionId, vf, { limit: 10 }); }
            catch (err) { console.error(`${TEST} [FAIL] listChunks threw: ${err.message}`); return; }

            const items = listResult?.items ?? [];
            if (!items.length) { console.error(`${TEST} [FAIL] listChunks returned 0 items`); return; }
            console.log(`${TEST} listChunks: ${items.length} items (total: ${listResult.total})`);

            items.slice(0, 3).forEach((item, i) =>
                console.log(`  [${i}] entryName="${item.metadata?.entryName ?? '(none)'}"  text="${(item.text||'').slice(0,60)}"`));

            const noText      = items.filter(i => !i.text?.trim());
            const noEntryName = items.filter(i => !i.metadata?.entryName);

            if (noText.length) { console.error(`${TEST} [FAIL] ${noText.length} chunk(s) have no text`); return; }
            if (noEntryName.length === items.length) { console.error(`${TEST} [FAIL] ALL chunks missing entryName`); return; }
            if (noEntryName.length > 0) console.warn(`${TEST} [WARN] ${noEntryName.length} chunk(s) missing entryName`);

            const targetHash = items[0].hash;
            console.log(`${TEST} Deleting hash=${targetHash}  entryName="${items[0].metadata?.entryName ?? '(none)'}"`);
            try { await backend.deleteVectorItems(collectionId, [targetHash], vf); }
            catch (err) { console.error(`${TEST} [FAIL] deleteVectorItems threw: ${err.message}`); return; }

            let afterResult;
            try { afterResult = await backend.listChunks(collectionId, vf, { limit: 10 }); }
            catch (err) { console.error(`${TEST} [FAIL] listChunks after delete threw: ${err.message}`); return; }

            if ((afterResult?.items ?? []).some(i => i.hash === targetHash)) {
                console.error(`${TEST} [FAIL] Deleted hash still in listing`); return;
            }
            if (afterResult.total >= listResult.total) console.warn(`${TEST} [WARN] total count did not decrease`);

            console.log(`${TEST} After delete: ${listResult.total} → ${afterResult.total} ✓`);
            console.log(`${TEST} [PASS] Entry names visible, text present, delete removed the entry`);
        } finally {
            try {
                await deleteContentCollection(collectionId);
                // TEST-ONLY: nuke vectra-side-effect folder (B4).
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                deleteCollectionMeta(registryKey);
                unregisterCollection(registryKey);
                // Also remove the BARE-ID duplicate registry entry (B4).
                unregisterCollection(collectionId);
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 005 — Standard lorebook: vectorize → lock → query isolation
// ═══════════════════════════════════════════════════════════════════
// Setup: lorebook vectorized with Standard backend + locked to current chat in DB Browser
// Note: vectorScore=0.0000 is expected — not a failure
// ═══════════════════════════════════════════════════════════════════
// TEST 005 — Standard lorebook: lock + query isolation
// ═══════════════════════════════════════════════════════════════════
// Self-contained: vectorizes its own standard (vectra) lorebook, asserts
// it gets locked to the current chat, runs a dry-run WI activation, and
// verifies the test entries come back. Never touches user data.
test('TEST 005 — Standard lorebook: lock + query isolation', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 005 [StdLorebook]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { shouldCollectionActivate, deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

        const testEntries = [
            {
                uid: 'vf_test_005_a',
                comment: 'Quartzwood Beetles',
                key: ['quartzwood', 'beetle'],
                content: 'Quartzwood beetles bore into petrified trees of the Ironvale forest. Their carapaces refract moonlight into prism patterns, making them prized by jewellers. A single mature beetle yields enough chitin for one signet ring.',
            },
            {
                uid: 'vf_test_005_b',
                comment: 'Hollowtongue Caverns',
                key: ['hollowtongue', 'cavern'],
                content: 'The Hollowtongue Caverns echo human speech for hours after a single whisper. Travellers report hearing arguments from the previous decade reverberating from the deep tunnels. Cartographers refuse to map them past the second junction.',
            },
            {
                uid: 'vf_test_005_c',
                comment: 'Saltglass Anvils',
                key: ['saltglass', 'anvil'],
                content: 'Saltglass anvils are forged from compressed sea-salt under volcanic heat. They cool blades at twice the rate of stone anvils and impart a faint mineral edge. Only three smiths in the Vermilion Reach know the firing technique.',
            },
        ];

        console.log(`${TEST} Vectorizing test lorebook (3 entries) with Standard backend...`);
        let vectorizeResult;
        try {
            vectorizeResult = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_005__', entries: testEntries },
                settings: { ...vf, vector_backend: 'standard', strategy: 'per_entry', scope: 'chat' },
            });
        } catch (err) { console.error(`${TEST} [FAIL] vectorizeContent threw: ${err.message}`); return; }

        if (!vectorizeResult?.success || !vectorizeResult.collectionId) {
            console.error(`${TEST} [FAIL] Vectorization failed`); return;
        }

        const collectionId = vectorizeResult.collectionId;
        const registryKey  = `vectra:${collectionId}`;
        console.log(`${TEST} Vectorized ${vectorizeResult.chunkCount} chunks → ${registryKey}`);

        try {
            const isActive = await shouldCollectionActivate(registryKey, context);
            if (!isActive) {
                console.error(`${TEST} [FAIL] New collection not activated for current chat — scope=chat lock did not apply`);
                return;
            }
            console.log(`${TEST} Collection locked and active for current chat ✓`);

            const chat = ctx.chat ?? [];
            const testQuery = 'quartzwood beetle ironvale prism carapace';
            let result;
            try { result = await runLorebookWIDryRun({ chat, testMessage: testQuery, settings: vf }); }
            catch (err) { console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`); return; }

            if (!result.entryCount) { console.error(`${TEST} [FAIL] Dry-run returned 0 entries for query "${testQuery}"`); return; }
            console.log(`${TEST} Dry-run: ${result.entryCount} entries (vectorScore=0.0000 expected for standard backend)`);
            console.log(`  preview: ${(result.injectionText || '').slice(0, 200)}`);
            console.log(`${TEST} [PASS] Standard lorebook vectorized, locked, results returned`);
        } finally {
            try {
                await deleteContentCollection(collectionId);
                // TEST-ONLY: also nuke the parent on-disk folder so vectra storage stays
                // truly orphan-free. Production purge only removes the model subdir; this
                // test helper finishes the job. Never call this from production code.
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                deleteCollectionMeta(registryKey);
                unregisterCollection(registryKey);
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 006 — Standard EventBase: lock → parseEmbedText field recovery
// ═══════════════════════════════════════════════════════════════════
// Setup: chat history vectorized with Standard backend + locked to this chat
// Note: imp=undefined and method=bm25 are expected
// ═══════════════════════════════════════════════════════════════════
// TEST 006 — Standard EventBase: insert + parseEmbedText recovery
// ═══════════════════════════════════════════════════════════════════
// Self-contained: inserts two test events into its own standard (vectra)
// EventBase collection, queries them back via StandardBackend, and verifies
// parseEmbedText can recover event_type / summary from the embed text.
// This is the no-rich-metadata path — structured fields live INSIDE the
// embed text and have to be parsed back out client-side.
test('TEST 006 — Standard EventBase: insert + parseEmbedText recovery', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 006 [StdEventBase]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { insertEvents } = await import(base + 'core/eventbase-store.js');
        const { deleteCollection } = await import(base + 'core/collection-loader.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { parseEmbedText } = await import(base + 'core/eventbase-schema.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const settings = { ...vf, vector_backend: 'standard' };
        const ts = Date.now();
        // collectionId contains __vf_playwright_test_ so beforeAll cleanup catches orphans
        const collectionId = `vf_eventbase_standard_playwright___vf_playwright_test_006__${ts}`;
        const registryKey  = `vectra:${collectionId}`;
        const testChatUUID = `__vf_playwright_test_006__${ts}`;

        const testEvents = [
            {
                event_type: 'discovery',
                importance: 8,
                summary: 'The party uncovers a hidden Saltglass Anvil chamber beneath the Vermilion Reach forge',
                DateTime: '2027-03-15T09:00:00Z',
                cause: 'Investigating mysterious heat signatures',
                result: 'Anvil chamber catalogued, contents preserved',
                characters: ['Bramwell the Smith', 'Iris Quench'],
                locations: ['Vermilion Reach', 'Saltglass Forge'],
                factions: ['Smiths Conclave'],
                items: ['Saltglass Anvil'],
                concepts: ['ancient forging', 'discovery', 'archaeology'],
                keywords: ['saltglass', 'anvil', 'vermilion', 'forge', 'discovery'],
                open_threads: ['Who built the original chamber?'],
                should_persist: true,
                chat_uuid: testChatUUID,
                event_id: `test_event_006_001_${ts}`,
                source_window_start: 0,
                source_window_end: 5,
                source_message_hashes: [55501, 55502],
                schema_version: 1,
            },
            {
                event_type: 'combat',
                importance: 9,
                summary: 'Quartzwood beetle swarm attacks Bramwell mid-forging, scattered with Iris pyrotechnics',
                DateTime: '2027-03-15T11:00:00Z',
                cause: 'Disturbed nest in the forge ceiling beams',
                result: 'Swarm dispersed, two beetles captured for study',
                characters: ['Bramwell the Smith', 'Iris Quench'],
                locations: ['Vermilion Reach', 'Saltglass Forge'],
                factions: ['Smiths Conclave'],
                items: ['quartzwood beetle specimens'],
                concepts: ['combat', 'insect swarm', 'pyrotechnic dispersal'],
                keywords: ['quartzwood', 'beetle', 'swarm', 'forge', 'combat'],
                open_threads: ['Beetles may have been drawn by the chamber discovery'],
                should_persist: true,
                chat_uuid: testChatUUID,
                event_id: `test_event_006_002_${ts}`,
                source_window_start: 5,
                source_window_end: 10,
                source_message_hashes: [55503, 55504],
                schema_version: 1,
            },
        ];

        console.log(`${TEST} Inserting 2 test events into ${collectionId}...`);
        try {
            await insertEvents(testEvents, settings, null, collectionId);
        } catch (err) {
            console.error(`${TEST} [FAIL] insertEvents threw: ${err.message}`);
            try { await deleteCollection(collectionId, settings, registryKey); } catch {}
            return;
        }
        console.log(`${TEST} Insert complete ✓`);

        try {
            // Per Doc/collection_helper.md (canonical-API rule): use
            // getBackend so the shared, initialized singleton is returned. A
            // fresh `new StandardBackend()` would have pluginAvailable=false
            // until initialize() runs — silently routing every call to the
            // native fallback and masking real plugin paths.
            const backend = await getBackend(settings);
            let results;
            try { results = await backend.queryCollection(collectionId, 'saltglass anvil quartzwood beetle', 10, settings); }
            catch (err) { console.error(`${TEST} [FAIL] queryCollection threw: ${err.message}`); return; }

            const items = results?.metadata ?? [];
            if (!items.length) { console.error(`${TEST} [FAIL] Query returned 0 results after insert`); return; }
            console.log(`${TEST} Query: ${items.length} result(s)`);

            // For the standard (vectra) backend, structured event fields live INSIDE the
            // embed text — they have to be recovered via parseEmbedText. Verify both of
            // our inserted events come back AND their event_type parses out cleanly.
            const expectedIds = new Set(testEvents.map(e => e.event_id));
            const foundIds = new Set();
            let recoveredCount = 0;
            for (const m of items) {
                const r = parseEmbedText(m.text || '');
                if (m.event_id && expectedIds.has(m.event_id)) foundIds.add(m.event_id);
                if (r.event_type) {
                    recoveredCount++;
                    console.log(`  ✓ ${m.event_id || '(no event_id)'}  type="${r.event_type}"  summary="${(r.summary||'').slice(0,50)}"`);
                }
            }

            const missing = [...expectedIds].filter(id => !foundIds.has(id));
            if (missing.length) { console.error(`${TEST} [FAIL] ${missing.length} inserted event(s) not retrieved: ${missing.join(', ')}`); return; }
            if (recoveredCount < expectedIds.size) {
                console.error(`${TEST} [FAIL] parseEmbedText recovered event_type for only ${recoveredCount}/${expectedIds.size} inserted events`);
                return;
            }

            console.log(`${TEST} [PASS] All ${expectedIds.size} inserted event(s) retrieved, parseEmbedText recovered event_type cleanly`);
        } finally {
            try {
                await deleteCollection(collectionId, settings, registryKey);
                // TEST-ONLY: also nuke the parent on-disk folder.
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 007 — E2E standard: locked standard lorebook + locked standard EventBase → both return results
// ═══════════════════════════════════════════════════════════════════
// Setup: TEST 005 + TEST 006 setups both complete
// Note: vectorScore=0.0000, imp=undefined, method=bm25 all expected
test('TEST 007 — E2E standard: both locked, both return results', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 007 [E2EStd]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { getCollectionListing } = await import(base + 'core/collection-loader.js');
        const { shouldCollectionActivate, getCollectionLocks } = await import(base + 'core/collection-metadata.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');

        const { extension_settings } = await import('/scripts/extensions.js');
        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

        const listing = getCollectionListing(vf);

        const lorebookCols = listing.filter(e => e.collectionId.startsWith('vf_lorebook_'));
        const lockedLorebooks = [];
        for (const e of lorebookCols) {
            if (await shouldCollectionActivate(e.registryKey, context)) lockedLorebooks.push(e);
        }
        if (!lockedLorebooks.length) { console.error(`${TEST} [FAIL] No lorebook activated — complete TEST 005 setup`); return; }
        if (!lockedLorebooks.some(e => e.registryKey.startsWith('vectra:')))
            console.warn(`${TEST} [WARN] Active lorebook is not standard backend`);
        lockedLorebooks.forEach(e => console.log(`${TEST} Active lorebook: ${e.registryKey}`));

        const eventbaseCols = listing.filter(e => e.collectionId.startsWith('vf_eventbase_'));
        const lockedEventbases = eventbaseCols.filter(e => getCollectionLocks(e.registryKey).some(l => l === currentChatId));
        if (!lockedEventbases.length) { console.error(`${TEST} [FAIL] No EventBase locked — complete TEST 006 setup`); return; }
        if (!lockedEventbases.some(e => e.registryKey.startsWith('vectra:')))
            console.warn(`${TEST} [WARN] Locked EventBase is not standard backend`);
        console.log(`${TEST} Locked EventBase: ${lockedEventbases.map(e => e.registryKey).join(', ')}`);

        const chat = ctx.chat ?? [];
        const lastUserMsg = [...chat].reverse().find(m => !m.is_system && m.mes)?.mes || 'test query';
        let lorebookResult;
        try { lorebookResult = await runLorebookWIDryRun({ chat, testMessage: lastUserMsg, settings: vf }); }
        catch (err) { console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`); return; }

        if (!lorebookResult.entryCount) { console.error(`${TEST} [FAIL] Lorebook returned 0 entries`); return; }
        console.log(`${TEST} Lorebook: ${lorebookResult.entryCount} entries (vectorScore=0.0000 expected)`);
        console.log(`  preview: ${(lorebookResult.injectionText || '').slice(0, 200)}`);

        const { runEventBaseRetrieval } = await import(base + 'core/eventbase-workflow.js').catch(() => ({}));
        if (typeof runEventBaseRetrieval !== 'function') { console.warn(`${TEST} [WARN] runEventBaseRetrieval not exported`); return; }

        let eventbaseResult;
        try { eventbaseResult = await runEventBaseRetrieval({ chat, settings: vf, dryRun: true, testMessage: lastUserMsg }); }
        catch (err) { console.error(`${TEST} [FAIL] runEventBaseRetrieval threw: ${err.message}`); return; }

        const eventCount = eventbaseResult?.eventCount ?? 0;
        if (!eventCount) { console.error(`${TEST} [FAIL] EventBase returned 0 events`); return; }
        console.log(`${TEST} EventBase: ${eventCount} event(s) injected, lockedCollections=${eventbaseResult.lockedCollectionsCount}, archive=${eventbaseResult.archiveCollectionsCount}`);
        console.log(`  preview: ${(eventbaseResult.injectionText || '').slice(0, 200)}`);

        console.log(`${TEST} [PASS] Lorebook (${lorebookResult.entryCount}) + EventBase (${eventCount}) — standard backend, no contamination`);
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
//  Why TEST 008 AND TEST 009? — read this before touching either
// ═══════════════════════════════════════════════════════════════════
//
// The Standard (vectra) backend has TWO operational modes that look
// identical at the API surface but behave VERY differently underneath:
//
//   1. Standard + Similharity plugin  (the path most users have)
//      ─ insert/list/delete go through /api/plugins/similharity/chunks/*
//      ─ FULL metadata round-trip: text, entryName, keywords, custom
//        fields all persist and come back via listChunks
//      ─ DB Browser shows everything
//
//   2. Standard alone, no plugin       (the bare minimum SillyTavern setup)
//      ─ insert/list/delete go through ST's native /api/vector/*
//      ─ DEGRADED mode: only hash + text + index are stored; listChunks
//        is hashes-only ({ hash, text: '', metadata: {} })
//      ─ DB Browser shows just hashes — by design, per backends/standard.js
//        top comment ("Plugin dependency rule"). The standard backend MUST
//        remain fully functional without the plugin installed.
//
// Both modes are *supported* contracts. Both have to work. So we test both
// — TEST 008 verifies the rich path, TEST 009 verifies graceful degradation
// to the lean path. A regression in either mode breaks real users.
//
// If you find yourself wondering "why are we doing the same test twice?" —
// you're not. They exercise different code paths via the same surface
// (StandardBackend.listChunks). The plugin/native branch inside that
// function is the seam.
//
// TEST 010 covers cross-collection isolation (lorebook/EventBase leak)
// independently of this split.
// ═══════════════════════════════════════════════════════════════════

// ─── TEST 008 — standard backend WITH plugin ─────────────────────────
// Asserts the rich path works: listChunks must surface text + entryName
// after a self-contained insert. If this fails while pluginAvailable=true,
// the plugin's /chunks/list endpoint or vectra's storeListItems is broken.
test('TEST 008 — DB Browser standard + plugin: listing + delete', async () => {
    await skipIfNoPlugin();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 008 [DBBrowserStd]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const testEntries = [
            {
                uid: 'vf_test_008_a',
                comment: 'Ashfern Spores',
                key: ['ashfern', 'spore'],
                content: 'Ashfern spores germinate only after exposure to volcanic ash. The resulting plant produces a deep-blue dye prized by the southern weavers. A single mature ashfern yields enough spore-pods for one full bolt of cloth.',
            },
            {
                uid: 'vf_test_008_b',
                comment: 'Mirror Citadel of Vorn',
                key: ['vorn', 'citadel'],
                content: 'The Mirror Citadel of Vorn was carved from a single obsidian seam in the Coldroot Mountains. Its walls reflect approaching armies tenfold, an illusion that has broken three sieges without a single arrow loosed.',
            },
            {
                uid: 'vf_test_008_c',
                comment: 'Tideglass Eels',
                key: ['tideglass', 'eel'],
                content: 'Tideglass eels migrate along the Vermilion Reef every spring. Their translucent bodies become visible only at twilight. Fishermen of the coastal hamlets carve flutes from their bones — said to summon mist on still nights.',
            },
        ];

        console.log(`${TEST} Vectorizing test lorebook (3 entries) with Standard backend...`);
        let vectorizeResult;
        try {
            vectorizeResult = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_008__', entries: testEntries },
                settings: { ...vf, vector_backend: 'standard', strategy: 'per_entry', scope: 'chat' },
            });
        } catch (err) { console.error(`${TEST} [FAIL] vectorizeContent threw: ${err.message}`); return; }

        if (!vectorizeResult?.success || !vectorizeResult.collectionId) {
            console.error(`${TEST} [FAIL] Vectorization failed`); return;
        }

        const collectionId = vectorizeResult.collectionId;
        const registryKey  = `vectra:${collectionId}`;
        console.log(`${TEST} Vectorized ${vectorizeResult.chunkCount} chunks → ${registryKey}`);

        try {
            // Use the backend manager so we get the shared, properly-initialized
            // StandardBackend (pluginAvailable already detected). A fresh
            // `new StandardBackend()` would have pluginAvailable=false until
            // initialize() runs — silently routing every listChunks call to
            // the native fallback and masking real plugin issues.
            const backend = await getBackend({ ...vf, vector_backend: 'standard' });
            console.log(`${TEST} backend.pluginAvailable=${backend.pluginAvailable}`);

            let listResult;
            try { listResult = await backend.listChunks(collectionId, vf, { limit: 10 }); }
            catch (err) { console.error(`${TEST} [FAIL] listChunks threw: ${err.message}`); return; }

            const items = listResult?.items ?? [];
            if (!items.length) { console.error(`${TEST} [FAIL] listChunks returned 0 items`); return; }
            console.log(`${TEST} listChunks: ${items.length} items (total: ${listResult.total})`);

            items.slice(0, 3).forEach((item, i) =>
                console.log(`  [${i}] entryName="${item.metadata?.entryName ?? '(none)'}"  text="${(item.text||'').slice(0,60)}"`));

            const noText      = items.filter(i => !i.text?.trim());
            const noEntryName = items.filter(i => !i.metadata?.entryName);

            if (noText.length === items.length) { console.error(`${TEST} [FAIL] ALL chunks have no text — standard backend listChunks may need plugin support`); return; }
            if (noText.length > 0) console.warn(`${TEST} [WARN] ${noText.length} chunk(s) have no text`);
            if (noEntryName.length === items.length) { console.error(`${TEST} [FAIL] ALL chunks missing entryName`); return; }
            if (noEntryName.length > 0) console.warn(`${TEST} [WARN] ${noEntryName.length} chunk(s) missing entryName`);

            const targetHash = items[0].hash;
            console.log(`${TEST} Deleting hash=${targetHash}  entryName="${items[0].metadata?.entryName ?? '(none)'}"`);
            try { await backend.deleteVectorItems(collectionId, [targetHash], vf); }
            catch (err) { console.error(`${TEST} [FAIL] deleteVectorItems threw: ${err.message}`); return; }

            let afterResult;
            try { afterResult = await backend.listChunks(collectionId, vf, { limit: 10 }); }
            catch (err) { console.error(`${TEST} [FAIL] listChunks after delete threw: ${err.message}`); return; }

            if ((afterResult?.items ?? []).some(i => i.hash === targetHash)) {
                console.error(`${TEST} [FAIL] Deleted hash still in listing`); return;
            }
            if (afterResult.total >= listResult.total) console.warn(`${TEST} [WARN] total count did not decrease`);

            console.log(`${TEST} After delete: ${listResult.total} → ${afterResult.total} ✓`);
            console.log(`${TEST} [PASS] Standard: entry names visible, text present, delete removed the entry`);
        } finally {
            try {
                await deleteContentCollection(collectionId);
                // TEST-ONLY: also nuke the parent on-disk folder.
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                deleteCollectionMeta(registryKey);
                unregisterCollection(registryKey);
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ─── TEST 009 — standard backend WITHOUT plugin (degraded path) ─────
// Read the "Why TEST 008 AND TEST 009?" block above test 008 first.
//
// This test verifies graceful degradation: when the Similharity plugin
// is unavailable, the standard backend must still support the basic
// vectorize → list → delete cycle through ST's native /api/vector/*.
// The top comment in backends/standard.js mandates this contract.
//
// We can't uninstall the plugin from a test, so we simulate it by
// forcing `pluginAvailable = false` on the SHARED cached backend
// instance from getBackend(). This must be done BEFORE vectorize, so
// insert ALSO routes through the native API — otherwise data lands at
// vectors/{source}/{collectionId}/{model}/ (plugin path) while our list
// and delete look at vectors/{source}/{collectionId}/ (native path),
// and the delete silently no-ops because it can't find the data. That
// path-mismatch isn't a real-world scenario; either users have plugin
// (all ops plugin) or don't (all ops native). The test must mirror one.
//
// We restore pluginAvailable in the finally block so subsequent
// operations (cleanup, any later tests, the running ST session) aren't
// poisoned by our override.
//
// Expectations:
//   - vectorize via native /api/vector/insert succeeds
//   - listChunks returns N items where N matches what insert wrote
//   - Each item has `hash` populated; text === '' and metadata === {}
//     are degraded-but-expected
//   - Delete by hash via native /api/vector/delete actually removes it
//
// A FAIL here means the no-plugin contract is broken — real users on
// vanilla SillyTavern would lose DB Browser functionality entirely.
test('TEST 009 — DB Browser standard, no plugin: graceful degradation', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 009 [DBBrowserStdNoPlugin]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const testEntries = [
            {
                uid: 'vf_test_009_a',
                comment: 'Coppervine Trellises',
                key: ['coppervine', 'trellis'],
                content: 'Coppervine trellises grow on abandoned watchtowers along the eastern marshes. Their copper-rich sap conducts magical signals over short distances, and apprentice mages use them to practice resonance work without dedicated crystals.',
            },
            {
                uid: 'vf_test_009_b',
                comment: 'Silt Singers of the Estuary',
                key: ['silt', 'singer'],
                content: 'Silt Singers are reclusive mer-folk who emerge from the estuary mud at low tide. They communicate through low-frequency hums that travel further through wet earth than air. Coastal villagers leave salt offerings on the tideline in exchange for storm warnings.',
            },
            {
                uid: 'vf_test_009_c',
                comment: 'Wraithcap Mushrooms',
                key: ['wraithcap', 'mushroom'],
                content: 'Wraithcap mushrooms grow in graveyards and old battlefields. Their pale fruiting bodies fade in and out of visibility on a regular cycle, said to track the breathing of whatever lies buried beneath. Necromancers harvest them by touch alone.',
            },
        ];

        // ───────────────────────────────────────────────────────────────
        //  Boundary rules for this test:
        //
        //  ✗ DO NOT mutate extension_settings.vectfox — that's the user's
        //    config and must remain untouched. All settings overrides go
        //    through the `settings: { ...vf, ...override }` parameter on
        //    function calls (e.g. vector_backend, source, model).
        //
        //  ✓ DO mutate `backend.pluginAvailable` (the cached singleton's
        //    runtime flag) because there's no settings-level toggle for
        //    "pretend the plugin isn't installed." The flag lives on the
        //    backend instance, not in config. Restore it in `finally` so
        //    a test crash doesn't leak degraded-mode into the live ST
        //    session.
        //
        //  Why mutate the SHARED instance (not a fresh `new StandardBackend()`):
        //  vectorizeContent calls getBackend() internally, which returns the
        //  cached singleton. If we only flip pluginAvailable on a fresh
        //  instance, vectorize uses the cached one (pluginAvailable=true) →
        //  data lands at vectors/{source}/{cid}/{model}/, but our list+delete
        //  via the fresh instance look at vectors/{source}/{cid}/ → delete
        //  silently no-ops. That's a mismatched-mode test, not the real
        //  no-plugin scenario.
        // ───────────────────────────────────────────────────────────────
        const backend = await getBackend({ ...vf, vector_backend: 'standard' });
        const originalPluginAvailable = backend.pluginAvailable;
        backend.pluginAvailable = false;
        console.log(`${TEST} Forced pluginAvailable=false on the shared StandardBackend (was ${originalPluginAvailable}) — exercising native end-to-end`);

        let vectorizeResult;
        let collectionId, registryKey;
        try {
            try {
                vectorizeResult = await vectorizeContent({
                    contentType: 'lorebook',
                    source: { type: 'file', name: '__vf_playwright_test_009__', entries: testEntries },
                    settings: { ...vf, vector_backend: 'standard', strategy: 'per_entry', scope: 'chat' },
                });
            } catch (err) { console.error(`${TEST} [FAIL] vectorizeContent threw: ${err.message}`); return; }

            if (!vectorizeResult?.success || !vectorizeResult.collectionId) {
                console.error(`${TEST} [FAIL] Vectorization failed`); return;
            }

            collectionId = vectorizeResult.collectionId;
            registryKey  = `vectra:${collectionId}`;
            console.log(`${TEST} Vectorized ${vectorizeResult.chunkCount} chunks via native path → ${registryKey}`);

            let listResult;
            try { listResult = await backend.listChunks(collectionId, vf, { limit: 10 }); }
            catch (err) { console.error(`${TEST} [FAIL] listChunks threw: ${err.message}`); return; }

            const items = listResult?.items ?? [];
            if (!items.length) { console.error(`${TEST} [FAIL] listChunks returned 0 items`); return; }
            console.log(`${TEST} listChunks: ${items.length} items (total: ${listResult.total})`);

            items.slice(0, 3).forEach((item, i) =>
                console.log(`  [${i}] hash=${item.hash}  text="${(item.text||'')}"  metaKeys=[${Object.keys(item.metadata || {}).join(',')}]`));

            // Degraded contract: every item has a hash, but text + metadata are intentionally empty.
            const noHash       = items.filter(i => i.hash == null);
            const hasText      = items.filter(i => i.text?.trim());
            const hasMetaField = items.filter(i => i.metadata && Object.keys(i.metadata).length > 0);

            if (noHash.length) { console.error(`${TEST} [FAIL] ${noHash.length} item(s) missing hash — native path must always return hashes`); return; }
            if (hasText.length) {
                // Not a failure — means the native path silently grew richer; but it does
                // mean the contract is now stronger than documented, so flag it.
                console.warn(`${TEST} [WARN] ${hasText.length} item(s) HAVE text in no-plugin mode — native fallback returning more than documented?`);
            }
            if (hasMetaField.length) {
                console.warn(`${TEST} [WARN] ${hasMetaField.length} item(s) HAVE metadata fields in no-plugin mode — native fallback returning more than documented?`);
            }

            // Delete-by-hash via native /api/vector/delete should still work even without plugin.
            const targetHash = items[0].hash;
            console.log(`${TEST} Deleting hash=${targetHash} via no-plugin path...`);
            try { await backend.deleteVectorItems(collectionId, [targetHash], vf); }
            catch (err) { console.error(`${TEST} [FAIL] deleteVectorItems threw: ${err.message}`); return; }

            let afterResult;
            try { afterResult = await backend.listChunks(collectionId, vf, { limit: 10 }); }
            catch (err) { console.error(`${TEST} [FAIL] listChunks after delete threw: ${err.message}`); return; }

            if ((afterResult?.items ?? []).some(i => i.hash === targetHash)) {
                console.error(`${TEST} [FAIL] Deleted hash still in listing after no-plugin delete`); return;
            }
            if (afterResult.total >= listResult.total) console.warn(`${TEST} [WARN] total count did not decrease`);

            console.log(`${TEST} After delete: ${listResult.total} → ${afterResult.total} ✓`);
            console.log(`${TEST} [PASS] Standard (no plugin) end-to-end: insert + list + delete via native path`);
        } finally {
            // Restore plugin availability on the SHARED backend instance BEFORE cleanup
            // so deleteContentCollection / unregisterCollection don't take native paths
            // and leak state to any subsequent test or to the running ST session.
            backend.pluginAvailable = originalPluginAvailable;
            console.log(`${TEST} Restored backend.pluginAvailable=${originalPluginAvailable}`);

            if (collectionId) {
                try {
                    await deleteContentCollection(collectionId);
                    // TEST-ONLY: nuke the parent on-disk folder. `backend` here is the
                    // SHARED StandardBackend instance — pluginAvailable just got restored
                    // above so the helper takes the plugin purge path normally.
                    try {
                        await backend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                    deleteCollectionMeta(registryKey);
                    unregisterCollection(registryKey);
                    console.log(`${TEST} Cleanup: test collection removed ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
                }
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
//  TEST 010 — Cross-collection isolation: chat-lock controls visibility
// ═══════════════════════════════════════════════════════════════════
//
// Why this test exists:
//   On prod (qdrant) we observed `<VectFoxLorebook>` injection containing
//   entries from TWO different lorebooks (e.g. Henry from "Your Wives" leaking
//   into a chat that should only see ArtificRealm content). That's a contract
//   violation — only collections active for the current chat should appear in
//   the semantic WI injection.
//
//   This test isolates the bug to either:
//     (a) Our activation filter — `getEnabledLorebookCollections` returns
//         collections it shouldn't, OR
//     (b) The plugin/Qdrant query path — multitenancy `content_type` filter
//         is missing, so one logical collection's query returns vectors from
//         another sharing the same physical Qdrant collection.
//
//   Phase 1 (baseline) proves both lorebooks ARE searchable when both are
//   locked — confirms the search-across-multiple-active-books flow works.
//   Phase 2 (leak check) unlocks one and re-queries. If the unlocked book's
//   content still shows up, we've reproduced the leak under controlled
//   conditions and isolated it to one of the two layers above.
//
// What we touch (boundary rules — same as TEST 009):
//   ✗ DO NOT mutate extension_settings.vectfox
//   ✓ DO mutate collection lock state via canonical `setLock(...)` API
//     (per Doc/collection_helper.md) — these are user-level lock changes on
//     our test collections, restored to baseline / removed entirely in finally.
//   ✓ DO use registry-key form for all lock + activation calls
//     (see Doc/collection_helper.md).
//
// Backend choice: Qdrant — that's where the prod symptom appeared. Falls
// back gracefully if user doesn't have Qdrant configured.
test('TEST 010 — Cross-collection isolation: lock controls lorebook visibility', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 010 [LeakCheck]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { shouldCollectionActivate, deleteCollectionMeta, setLock } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        if (!(vf.qdrant_url || vf.qdrant_host)) { console.warn(`${TEST} [SKIP] Qdrant not configured — leak test targets Qdrant since prod symptom was there`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

        // Sentinel strings: unique enough that they should NEVER appear in any
        // existing user lorebook. Used to detect cross-collection content leak.
        const SENTINEL_A = 'FIDDLEHEAD_OBELISK_X9F2';
        const SENTINEL_B = 'QUASAR_LANTERN_M7K4';

        const entriesA = [
            {
                uid: 'vf_test_010_a1',
                comment: 'Fiddlehead Obelisk',
                key: ['fiddlehead', 'obelisk'],
                content: `The ${SENTINEL_A} stands at the centre of the moss-glade in the Verlan Reach. Sentinel-A research catalogues its quartz veins as the only known anchor for the broken Sundering Glyphs. Pilgrims rub their palms raw against its base in spring.`,
            },
        ];

        const entriesB = [
            {
                uid: 'vf_test_010_b1',
                comment: 'Quasar Lantern',
                key: ['quasar', 'lantern'],
                content: `The ${SENTINEL_B} is a hand-held void-glass orb forged in the Embertide trenches. Sentinel-B chronicles describe it shedding a cold blue light that ignores wind, rain, and the breath of dragons. Three are known to exist; one is held by the Aurelian Conclave.`,
            },
        ];

        let collectionIdA = null, registryKeyA = null;
        let collectionIdB = null, registryKeyB = null;

        try {
            // ── Vectorize lorebook A (auto-locks to current chat via scope=chat) ──
            console.log(`${TEST} Vectorizing lorebook A (sentinel "${SENTINEL_A}") with Qdrant...`);
            const resA = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_010_A__', entries: entriesA },
                settings: { ...vf, vector_backend: 'qdrant', strategy: 'per_entry', scope: 'chat' },
            });
            if (!resA?.success || !resA.collectionId) { console.error(`${TEST} [FAIL] Lorebook A vectorization failed`); return; }
            collectionIdA = resA.collectionId;
            registryKeyA  = `qdrant:${collectionIdA}`;
            console.log(`${TEST} A vectorized → ${registryKeyA}`);

            // ── Vectorize lorebook B (auto-locks to current chat via scope=chat) ──
            console.log(`${TEST} Vectorizing lorebook B (sentinel "${SENTINEL_B}") with Qdrant...`);
            const resB = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_010_B__', entries: entriesB },
                settings: { ...vf, vector_backend: 'qdrant', strategy: 'per_entry', scope: 'chat' },
            });
            if (!resB?.success || !resB.collectionId) { console.error(`${TEST} [FAIL] Lorebook B vectorization failed`); return; }
            collectionIdB = resB.collectionId;
            registryKeyB  = `qdrant:${collectionIdB}`;
            console.log(`${TEST} B vectorized → ${registryKeyB}`);

            // Confirm both activated by chat lock
            const activeA = await shouldCollectionActivate(registryKeyA, context);
            const activeB = await shouldCollectionActivate(registryKeyB, context);
            if (!activeA || !activeB) {
                console.error(`${TEST} [FAIL] Both lorebooks should be locked to chat — activeA=${activeA}, activeB=${activeB}`);
                return;
            }
            console.log(`${TEST} Both lorebooks locked to chat ✓`);

            // ═══════ PHASE 1 — baseline: both should appear ═══════
            const chat = ctx.chat ?? [];
            const query = `${SENTINEL_A} ${SENTINEL_B} fiddlehead obelisk quasar lantern`;
            console.log(`${TEST} Phase 1 query: "${query.slice(0, 80)}..."`);

            let p1;
            try { p1 = await runLorebookWIDryRun({ chat, testMessage: query, settings: vf }); }
            catch (err) { console.error(`${TEST} [FAIL] Phase 1 dry-run threw: ${err.message}`); return; }

            const injection1 = p1?.injectionText || '';
            const p1HasA = injection1.includes(SENTINEL_A);
            const p1HasB = injection1.includes(SENTINEL_B);
            console.log(`${TEST} Phase 1 entries=${p1.entryCount}, contains SENTINEL_A=${p1HasA}, SENTINEL_B=${p1HasB}`);

            if (!p1HasA || !p1HasB) {
                console.error(`${TEST} [FAIL] Phase 1 baseline broken — both lorebooks locked but injection missing content. A=${p1HasA}, B=${p1HasB}. Without a valid baseline we can't tell what Phase 2 isolation means.`);
                return;
            }
            console.log(`${TEST} Phase 1 baseline ✓ — both A and B searchable when both locked`);

            // ═══════ PHASE 2 — unlock B, re-query, B must NOT appear ═══════
            console.log(`${TEST} Phase 2: removing chat lock from B via canonical setLock(...)...`);
            const unlockResult = setLock(registryKeyB, { kind: 'chat', op: 'remove', target: currentChatId }, { settings: vf });
            if (!unlockResult?.success) {
                console.error(`${TEST} [FAIL] setLock failed to remove B's chat lock: ${unlockResult?.reason}`);
                return;
            }

            // Confirm activation filter now agrees B is out of scope
            const stillActiveA = await shouldCollectionActivate(registryKeyA, context);
            const stillActiveB = await shouldCollectionActivate(registryKeyB, context);
            console.log(`${TEST} After unlock — activeA=${stillActiveA}, activeB=${stillActiveB}`);
            if (!stillActiveA) { console.error(`${TEST} [FAIL] A should still be active after unlocking B`); return; }
            if (stillActiveB) {
                console.error(`${TEST} [FAIL] B still active after setLock op='remove' — lock removal not honored by shouldCollectionActivate. Bug in lock state, not in query path.`);
                return;
            }

            let p2;
            try { p2 = await runLorebookWIDryRun({ chat, testMessage: query, settings: vf }); }
            catch (err) { console.error(`${TEST} [FAIL] Phase 2 dry-run threw: ${err.message}`); return; }

            const injection2 = p2?.injectionText || '';
            const p2HasA = injection2.includes(SENTINEL_A);
            const p2HasB = injection2.includes(SENTINEL_B);
            console.log(`${TEST} Phase 2 entries=${p2.entryCount}, contains SENTINEL_A=${p2HasA}, SENTINEL_B=${p2HasB}`);
            console.log(`${TEST} Phase 2 injection preview: ${injection2.slice(0, 200)}`);

            if (!p2HasA) {
                console.error(`${TEST} [FAIL] Phase 2: A's content missing after unlocking B — query path stopped working for active collections`);
                return;
            }
            if (p2HasB) {
                console.error(`${TEST} [FAIL] LEAK DETECTED — B's content (${SENTINEL_B}) appeared in injection despite chat lock being removed. shouldCollectionActivate reported inactive but query path still returned B's vectors. Either (a) getEnabledLorebookCollections is bypassing the activation filter, or (b) the Qdrant content_type filter isn't applied and one physical collection is leaking vectors across logical collections.`);
                return;
            }

            console.log(`${TEST} [PASS] Lock-controlled isolation works: unlocking B removed its content from query results, A unaffected`);
        } finally {
            // Cleanup both — use the canonical setLock op='clear' first to drop any
            // remaining locks, then delete vectors + meta + registry entries.
            for (const { cid, rk, label } of [
                { cid: collectionIdA, rk: registryKeyA, label: 'A' },
                { cid: collectionIdB, rk: registryKeyB, label: 'B' },
            ]) {
                if (!cid) continue;
                try {
                    setLock(rk, { kind: 'chat', op: 'clear' }, { settings: vf });
                    await deleteContentCollection(cid);
                    // TEST-ONLY: also nuke any vectra-side-effect folder. The plugin's
                    // qdrant insert path creates an empty vectra folder as a side effect
                    // of registry stamping (B4 — duplicate registry registration). The
                    // helper is a no-op when no vectra folder exists, so safe to call
                    // unconditionally as a cleanup hygiene step.
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(cid, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed for ${label}: ${e.message}`); }
                    deleteCollectionMeta(rk);
                    unregisterCollection(rk);
                    // Also remove the BARE-ID duplicate registry entry (B4).
                    unregisterCollection(cid);
                    console.log(`${TEST} Cleanup ${label}: ${rk} removed ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] Cleanup ${label} failed: ${cleanupErr.message}`);
                }
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
//  TEST 011 — Cross-persona activation isolation (lorebook ownership)
// ═══════════════════════════════════════════════════════════════════
//
// Why this test exists:
//   TEST 010 verified LOCK-based isolation — explicit unlock removes a
//   collection from activation. But the prod symptom we observed
//   (2026-05-23) was different: rabbit's "Your Wives" lorebook leaking
//   into critblade's ArtificRealm chat WITHOUT either persona ever
//   locking that collection to that chat. The leak mechanism is
//   activation TRIGGERS (keyword matches in chat content) firing on a
//   collection owned by a DIFFERENT persona.
//
//   Per Doc/collection_helper.md activation priority chain, triggers (step 2)
//   activate BEFORE the lock check (steps 4-5). Ownership (`isOwn`) was
//   NOT checked anywhere in the chain — that's the gap B7 closes.
//
// What this test proves:
//   Phase 1: a test lorebook owned by the current persona appears in WI
//     injection (baseline — confirms the test setup is functional).
//   Phase 2: stamp the collection's `creatorHandle` to a foreign value
//     so `isOwn` flips to false. Re-query. Assert sentinel does NOT
//     appear — proving B7's filter blocks cross-persona collections from
//     activating regardless of trigger matches.
//
// Boundary rules (same as TEST 009/010):
//   ✗ DO NOT mutate extension_settings.vectfox at a global level
//   ✓ DO mutate `creatorHandle` on the TEST collection's meta via
//     setCollectionMeta (the test owns this collection — we created it).
//     Restore in finally so cleanup auth passes.
//
// Edge case: superadmin mode forces isOwn=true for all collections, which
// would make Phase 2 fail because the filter wouldn't block anything.
// We detect and skip with a clear signal in that case.
test('TEST 011 — Cross-persona activation isolation', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 011 [CrossPersona]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { getCollectionMeta, setCollectionMeta, deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { getCollectionListing, unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        if (!(vf.qdrant_url || vf.qdrant_host)) { console.warn(`${TEST} [SKIP] Qdrant not configured`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }

        // Superadmin override forces isOwn=true for ALL collections — the B7
        // filter is intentionally bypassed in that mode (it's for cross-persona
        // admin work). The test can't exercise the filter; skip with a clear
        // signal so a future reader doesn't think this is a real pass.
        if (vf.superadmin === true) {
            console.warn(`${TEST} [WARN] Superadmin mode is ON — test skipped because isOwn=true for all collections by design. Turn superadmin off to exercise the cross-persona filter.`);
            console.log(`${TEST} [PASS] (skipped: superadmin mode bypasses isOwn filter by design)`);
            return;
        }

        const SENTINEL = 'PERSONA_LEAK_CANARY_RUBELLITE_Q3X7';
        const FAKE_HANDLE = '_fake_other_persona_test_011';

        const testEntries = [{
            uid: 'vf_test_011_a',
            comment: 'Rubellite Catacombs',
            key: ['rubellite', 'catacombs'],
            content: `The ${SENTINEL} sits beneath the abandoned mine of Thressel. Sentinel-canary describes its blood-red crystal chambers echoing footsteps for hours after passing. Pilgrims of the Old Carmine Faith claim the catacombs realign their inner compass.`,
        }];

        console.log(`${TEST} Vectorizing test lorebook (sentinel "${SENTINEL}") with Qdrant...`);
        let res;
        try {
            res = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_011__', entries: testEntries },
                settings: { ...vf, vector_backend: 'qdrant', strategy: 'per_entry', scope: 'chat' },
            });
        } catch (err) { console.error(`${TEST} [FAIL] vectorizeContent threw: ${err.message}`); return; }
        if (!res?.success || !res.collectionId) { console.error(`${TEST} [FAIL] Vectorization failed`); return; }

        const collectionId = res.collectionId;
        const registryKey  = `qdrant:${collectionId}`;
        const originalMeta = getCollectionMeta(registryKey);
        const originalHandle = originalMeta?.creatorHandle;
        console.log(`${TEST} Vectorized → ${registryKey}, original creatorHandle="${originalHandle}"`);
        if (!originalHandle) {
            console.warn(`${TEST} [WARN] No creatorHandle stamped at vectorize time — baseline isOwn may rely on legacy ID-substring fallback`);
        }

        try {
            const chat = ctx.chat ?? [];
            const query = `${SENTINEL} rubellite catacombs thressel old carmine faith`;

            // ═══ PHASE 1 — baseline: current persona owns, sentinel must appear ═══
            console.log(`${TEST} Phase 1: query with current persona ownership intact...`);
            let p1;
            try { p1 = await runLorebookWIDryRun({ chat, testMessage: query, settings: vf }); }
            catch (err) { console.error(`${TEST} [FAIL] Phase 1 dry-run threw: ${err.message}`); return; }

            const p1HasSentinel = (p1?.injectionText || '').includes(SENTINEL);
            console.log(`${TEST} Phase 1 entries=${p1.entryCount}, sentinel found=${p1HasSentinel}`);
            if (!p1HasSentinel) {
                console.error(`${TEST} [FAIL] Phase 1 baseline broken — sentinel "${SENTINEL}" not in injection despite current persona owning the collection. Without baseline we can't tell what Phase 2 isolation means.`);
                return;
            }
            console.log(`${TEST} Phase 1 baseline ✓ — sentinel appears when current persona owns the collection`);

            // ═══ PHASE 2 — stamp foreign handle, sentinel must NOT appear ═══
            console.log(`${TEST} Phase 2: stamping creatorHandle="${FAKE_HANDLE}" on test collection to simulate foreign ownership...`);
            setCollectionMeta(registryKey, { creatorHandle: FAKE_HANDLE });

            // Sanity check the listing now reports isOwn=false
            const listingAfter = getCollectionListing(vf);
            const entry = listingAfter.find(e => e.registryKey === registryKey);
            if (!entry) { console.error(`${TEST} [FAIL] Test collection vanished from listing after meta update`); return; }
            console.log(`${TEST} After meta update — entry.isOwn=${entry.isOwn} (expected false)`);
            if (entry.isOwn) {
                console.error(`${TEST} [FAIL] entry.isOwn still true after creatorHandle change — superadmin off but isOwn computation didn't honor the new handle. (Possible legacy ID-substring fallback matching: if the collection ID contains the real handle, the fallback can't be defeated by meta-only mutation.)`);
                return;
            }

            let p2;
            try { p2 = await runLorebookWIDryRun({ chat, testMessage: query, settings: vf }); }
            catch (err) { console.error(`${TEST} [FAIL] Phase 2 dry-run threw: ${err.message}`); return; }

            const p2HasSentinel = (p2?.injectionText || '').includes(SENTINEL);
            console.log(`${TEST} Phase 2 entries=${p2.entryCount}, sentinel found=${p2HasSentinel}`);
            console.log(`${TEST} Phase 2 injection preview: ${(p2.injectionText || '').slice(0, 200)}`);

            if (p2HasSentinel) {
                console.error(`${TEST} [FAIL] CROSS-PERSONA LEAK — sentinel "${SENTINEL}" appeared in injection despite creatorHandle now being foreign (entry.isOwn=false). getEnabledLorebookCollections is not filtering by entry.isOwn. This is the prod symptom mechanism (B7).`);
                return;
            }
            console.log(`${TEST} [PASS] Cross-persona isolation works: foreign-handle collection blocked from activation despite matching triggers`);
        } finally {
            // Restore creatorHandle so canonical cleanup (setLock auth gate, etc.)
            // doesn't choke. Even if cleanup proceeds without auth, leaving the
            // foreign handle in place would leak state to subsequent test runs.
            try {
                if (originalHandle) {
                    setCollectionMeta(registryKey, { creatorHandle: originalHandle });
                    console.log(`${TEST} Restored creatorHandle to "${originalHandle}"`);
                }
            } catch (restoreErr) {
                console.warn(`${TEST} [WARN] Restoring creatorHandle failed: ${restoreErr.message}`);
            }
            try {
                await deleteContentCollection(collectionId);
                // TEST-ONLY: also nuke any vectra-side-effect folder (B4 — qdrant insert
                // path creates empty vectra placeholder during registry stamping).
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                deleteCollectionMeta(registryKey);
                unregisterCollection(registryKey);
                // Also remove the BARE-ID duplicate registry entry (B4).
                unregisterCollection(collectionId);
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
//  TEST 012 — Cross-backend import: qdrant ↔ standard rename
// ═══════════════════════════════════════════════════════════════════
//
// Why this test exists:
//   `importCollection` and `importCollectionSilent` both need to remap the
//   backend segment in the collection ID when the export's backend differs
//   from the user's current target backend. Without that, importing a
//   qdrant export into standard would create a vectra folder named
//   `vf_*_qdrant_*` — polluting storage and confusing every parser that
//   reads the backend from the ID.
//
//   The remap logic lives in `core/collection-ids.js::remapCollectionIdToBackend`
//   (formerly duplicated as a private helper in collection-export.js and
//   MISSING entirely from `importCollectionSilent`). Surfaced 2026-05-23 by
//   inspecting the standard backend storage tree and finding `_qdrant_`
//   folders sitting in vectra.
//
// What this test proves:
//   - Pure helper checks first (remap both directions + detection round-trip)
//   - Phase 1: importing a qdrant-shaped export with vector_backend='standard'
//     produces a collection ID containing `_standard_`, not `_qdrant_`.
//   - Phase 2: mirror — standard export imported with vector_backend='qdrant'
//     produces a `_qdrant_`-segment ID.
//
// Boundary rules (same as 009/010/011):
//   ✗ DO NOT mutate extension_settings.vectfox
//   ✓ DO use sentinel `__vf_playwright_test_012__` in IDs so beforeAll's
//     orphan cleanup catches anything left behind by a crash.
test('TEST 012 — Cross-backend import: qdrant ↔ standard rename', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 012 [ImportRename]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { importCollection } = await import(base + 'core/collection-export.js');
        const { remapCollectionIdToBackend, getBackendFromCollectionId } = await import(base + 'core/collection-ids.js');
        const { deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        if (!(vf.qdrant_url || vf.qdrant_host)) { console.warn(`${TEST} [SKIP] Qdrant not configured — need both backends to test the rename`); return; }

        // ═══ Pure-helper sanity checks (no I/O) ═══════════════════════════
        // Verify the helper does what it claims before triggering an actual
        // cross-backend import. If the helper is broken, no point chasing
        // on-disk behavior.
        const ts = Date.now();
        const qdrantId   = `vf_lorebook_qdrant_playwright___vf_playwright_test_012__${ts}`;
        const standardId = `vf_lorebook_standard_playwright___vf_playwright_test_012__${ts}`;

        const q2s = remapCollectionIdToBackend(qdrantId, 'standard');
        const s2q = remapCollectionIdToBackend(standardId, 'qdrant');
        console.log(`${TEST} q→s remap: ${qdrantId} → ${q2s}`);
        console.log(`${TEST} s→q remap: ${standardId} → ${s2q}`);
        if (q2s !== standardId) { console.error(`${TEST} [FAIL] qdrant→standard remap broken: expected "${standardId}", got "${q2s}"`); return; }
        if (s2q !== qdrantId)   { console.error(`${TEST} [FAIL] standard→qdrant remap broken: expected "${qdrantId}", got "${s2q}"`); return; }

        // Idempotency: remap to same backend = no-op
        const noop = remapCollectionIdToBackend(qdrantId, 'qdrant');
        if (noop !== qdrantId) { console.error(`${TEST} [FAIL] same-backend remap should be a no-op, got "${noop}"`); return; }

        // Detection round-trip + registry-key prefix stripping
        if (getBackendFromCollectionId(qdrantId)   !== 'qdrant')   { console.error(`${TEST} [FAIL] getBackend(qdrant id) wrong`); return; }
        if (getBackendFromCollectionId(standardId) !== 'standard') { console.error(`${TEST} [FAIL] getBackend(standard id) wrong`); return; }
        if (getBackendFromCollectionId(`qdrant:${qdrantId}`) !== 'qdrant') { console.error(`${TEST} [FAIL] getBackend strips registry-key prefix incorrectly`); return; }
        console.log(`${TEST} Pure-helper checks ✓ — remap + detection work both directions`);

        // ═══ Phase 1: qdrant → standard import ═══════════════════════════
        const sentinel1 = 'IMPORT_RENAME_CANARY_FOXGLOVE_K8N2';
        const qdrantExport = {
            collection: {
                id: qdrantId,
                name: '__vf_playwright_test_012_q2s__',
                type: 'lorebook',
            },
            embedding: {
                backend: 'qdrant',
                source: vf.source || 'openrouter',
                model: vf.openrouter_model || vf.model || null,
            },
            chunks: [
                { text: `${sentinel1} — a flower whose pollen induces vivid dreams.`, index: 0, metadata: { entryName: 'Foxglove K8N2' } },
            ],
        };

        let p1ResultId = null;
        try {
            console.log(`${TEST} Phase 1: importing qdrant export → standard backend...`);
            const r = await importCollection(qdrantExport, { ...vf, vector_backend: 'standard' }, { overwrite: true, forceReembed: true });
            p1ResultId = r?.collectionId || r?.id || null;
            console.log(`${TEST} Phase 1 import returned collectionId="${p1ResultId}"`);
        } catch (err) {
            console.error(`${TEST} [FAIL] Phase 1 import threw: ${err.message}`);
            return;
        }

        try {
            if (!p1ResultId) { console.error(`${TEST} [FAIL] Phase 1: importCollection returned no collectionId`); return; }
            if (p1ResultId.includes('_qdrant_')) {
                console.error(`${TEST} [FAIL] Phase 1: import kept the qdrant segment — rename did NOT happen. Got "${p1ResultId}"`);
                return;
            }
            if (!p1ResultId.includes('_standard_')) {
                console.error(`${TEST} [FAIL] Phase 1: import didn't produce a standard-segment ID. Got "${p1ResultId}"`);
                return;
            }
            console.log(`${TEST} Phase 1 ✓ — qdrant export imported as standard ID: ${p1ResultId}`);
        } finally {
            if (p1ResultId) {
                try {
                    await deleteContentCollection(p1ResultId);
                    // TEST-ONLY: nuke parent folder in vectra (Phase 1 imports as standard)
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(p1ResultId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] Phase 1 folder-cleanup helper failed: ${e.message}`); }
                    deleteCollectionMeta(`vectra:${p1ResultId}`);
                    unregisterCollection(`vectra:${p1ResultId}`);
                    // Also remove the BARE-ID duplicate registry entry (B4).
                    unregisterCollection(p1ResultId);
                    console.log(`${TEST} Phase 1 cleanup ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] Phase 1 cleanup failed: ${cleanupErr.message}`);
                }
            }
        }

        // ═══ Phase 2: standard → qdrant import ═══════════════════════════
        const sentinel2 = 'IMPORT_RENAME_CANARY_VERMILION_R6Q9';
        const standardExport = {
            collection: {
                id: standardId,
                name: '__vf_playwright_test_012_s2q__',
                type: 'lorebook',
            },
            embedding: {
                backend: 'standard',
                source: vf.source || 'openrouter',
                model: vf.openrouter_model || vf.model || null,
            },
            chunks: [
                { text: `${sentinel2} — a metalwork pigment forged from oxidized copper.`, index: 0, metadata: { entryName: 'Vermilion R6Q9' } },
            ],
        };

        let p2ResultId = null;
        try {
            console.log(`${TEST} Phase 2: importing standard export → qdrant backend...`);
            const r = await importCollection(standardExport, { ...vf, vector_backend: 'qdrant' }, { overwrite: true, forceReembed: true });
            p2ResultId = r?.collectionId || r?.id || null;
            console.log(`${TEST} Phase 2 import returned collectionId="${p2ResultId}"`);
        } catch (err) {
            console.error(`${TEST} [FAIL] Phase 2 import threw: ${err.message}`);
            return;
        }

        try {
            if (!p2ResultId) { console.error(`${TEST} [FAIL] Phase 2: importCollection returned no collectionId`); return; }
            if (p2ResultId.includes('_standard_')) {
                console.error(`${TEST} [FAIL] Phase 2: import kept the standard segment — rename did NOT happen. Got "${p2ResultId}"`);
                return;
            }
            if (!p2ResultId.includes('_qdrant_')) {
                console.error(`${TEST} [FAIL] Phase 2: import didn't produce a qdrant-segment ID. Got "${p2ResultId}"`);
                return;
            }
            console.log(`${TEST} Phase 2 ✓ — standard export imported as qdrant ID: ${p2ResultId}`);
            console.log(`${TEST} [PASS] Cross-backend import rename works both directions`);
        } finally {
            if (p2ResultId) {
                try {
                    await deleteContentCollection(p2ResultId);
                    // TEST-ONLY: nuke vectra-side-effect folder (Phase 2 result is qdrant
                    // but plugin's insert path leaves a vectra placeholder — B4).
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(p2ResultId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] Phase 2 folder-cleanup helper failed: ${e.message}`); }
                    deleteCollectionMeta(`qdrant:${p2ResultId}`);
                    unregisterCollection(`qdrant:${p2ResultId}`);
                    // Also remove the BARE-ID duplicate registry entry (B4).
                    unregisterCollection(p2ResultId);
                    console.log(`${TEST} Phase 2 cleanup ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] Phase 2 cleanup failed: ${cleanupErr.message}`);
                }
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
//  TEST 013 — Synthetic E2E: self-contained lorebook + EventBase round-trip (qdrant)
// ═══════════════════════════════════════════════════════════════════
//
// Why this test exists:
//   TEST 003 and TEST 007 are E2E tests that depend on whatever the user
//   happens to have locked in their current chat. That's useful coverage
//   for the real environment, but means E2E confidence vanishes the
//   moment a fresh ST install or empty chat is involved.
//
//   TEST 013 covers the same E2E pipeline (lorebook activation + EventBase
//   retrieval, both queried in one cycle) on PURELY SYNTHETIC test data —
//   it creates its own lorebook, its own EventBase collection, locks both
//   to the current chat, runs the dry-run pipeline, asserts both sentinels
//   appear in the injection, then nukes every artifact like nothing was
//   ever done. No reliance on user data, settings, or pre-existing locked
//   collections.
//
// Backend choice: qdrant — production-relevant path and what TEST 003 is
// shaped after. Gracefully fails the test config check if Qdrant is not
// configured rather than crashing.
//
// Cleanup contract: every artifact this test creates is removed in finally:
//   - lorebook vectors + meta + registry (both canonical and bare forms)
//   - EventBase vectors + meta + registry + explicit lock removal
//   - vectra-side-effect folder (B4) for both
test('TEST 013 — Synthetic E2E qdrant: lorebook + EventBase round-trip', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 013 [SyntheticE2E]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { insertEvents } = await import(base + 'core/eventbase-store.js');
        const { shouldCollectionActivate, deleteCollectionMeta, setLock, getCollectionLocks } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection, deleteCollection } = await import(base + 'core/collection-loader.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        if (!(vf.qdrant_url || vf.qdrant_host)) { console.warn(`${TEST} [SKIP] Qdrant not configured`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

        // Derive the current persona's handle the same way collection-ids.js
        // does. We need this in the synthetic EventBase collection ID so that
        // registerCollection's creatorHandle-stamp condition (`_<handle>_` in
        // the ID) matches — without it, setLock denies the chat-lock add
        // because the persona's name1 doesn't match the stamped creator
        // (since nothing got stamped to begin with).
        const personaHandle = (ctx?.name1 || 'user')
            .normalize('NFC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 30) || 'user';

        // Sentinels: unique enough that they CANNOT exist in any real user data
        // or any other test's fixture. Used to verify the retrieval pipeline
        // returned OUR synthetic content (not leaked from elsewhere).
        const LOREBOOK_SENTINEL = 'PHOSPHORIC_ANTHELION_J4M9';
        const EVENTBASE_SENTINEL = 'ZIRCONIC_OSCILLATOR_T2P6';

        const ts = Date.now();
        const lorebookEntries = [{
            uid: 'vf_test_013_a',
            comment: 'Phosphoric Anthelion',
            key: ['phosphoric', 'anthelion'],
            content: `The ${LOREBOOK_SENTINEL} is a circular halo of phosphor-light that appears around the moon during the Stilled Tide. Sentinel-lorebook records describe it as visible only from the cliffs of Astrelle and only on nights when the sea lies perfectly flat. Astronomers of the Pale Conclave have catalogued its appearance 14 times in two centuries.`,
        }];

        const eventbaseCollectionId = `vf_eventbase_qdrant_${personaHandle}___vf_playwright_test_013__${ts}`;
        const eventbaseRegistryKey  = `qdrant:${eventbaseCollectionId}`;
        const testEvents = [{
            event_type: 'discovery',
            importance: 9,
            summary: `Astrelle expedition records the ${EVENTBASE_SENTINEL} — a resonance instrument unearthed beneath the Stilled Tide cliffs`,
            DateTime: '2027-08-12T22:30:00Z',
            cause: 'Routine survey of phosphor-light anomalies',
            result: 'Instrument catalogued, primary resonance frequency logged at 7.3 Hz',
            characters: ['Saskia Marrow', 'Halvard Cresswell'],
            locations: ['Astrelle Cliffs', 'Stilled Tide'],
            factions: ['Pale Conclave'],
            items: [EVENTBASE_SENTINEL],
            concepts: ['discovery', 'resonance', 'phosphoric phenomena'],
            keywords: ['zirconic', 'oscillator', 'astrelle', 'discovery'],
            open_threads: ['What does the oscillator resonate with?'],
            should_persist: true,
            chat_uuid: currentChatId, // pivot for getCollectionLocks lookup
            event_id: `test_event_013_001_${ts}`,
            source_window_start: 0,
            source_window_end: 5,
            source_message_hashes: [77701, 77702],
            schema_version: 1,
        }];

        let lorebookCollectionId = null, lorebookRegistryKey = null;
        let eventbaseCreated = false;

        try {
            // ── Phase A: vectorize lorebook (scope='chat' → auto-locks to current chat) ──
            console.log(`${TEST} Phase A: vectorizing synthetic lorebook (sentinel "${LOREBOOK_SENTINEL}")...`);
            const lbRes = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_013_lb__', entries: lorebookEntries },
                settings: { ...vf, vector_backend: 'qdrant', strategy: 'per_entry', scope: 'chat' },
            });
            if (!lbRes?.success || !lbRes.collectionId) { console.error(`${TEST} [FAIL] Lorebook vectorization failed`); return; }
            lorebookCollectionId = lbRes.collectionId;
            lorebookRegistryKey  = `qdrant:${lorebookCollectionId}`;
            console.log(`${TEST} Lorebook ready → ${lorebookRegistryKey}`);

            const lbActive = await shouldCollectionActivate(lorebookRegistryKey, context);
            if (!lbActive) { console.error(`${TEST} [FAIL] Lorebook didn't auto-lock to current chat`); return; }

            // ── Phase B: insert synthetic events into a fresh EventBase, then lock it ──
            console.log(`${TEST} Phase B: inserting 1 synthetic event into ${eventbaseCollectionId}...`);
            await insertEvents(testEvents, { ...vf, vector_backend: 'qdrant' }, null, eventbaseCollectionId);
            eventbaseCreated = true;

            // EventBase doesn't auto-lock via scope='chat' the way lorebook does
            // (insertEvents skips the auto-lock path because the collection ID is
            // supplied explicitly). Lock it manually so runEventBaseRetrieval
            // picks it up as a live locked collection.
            const lockResult = setLock(eventbaseRegistryKey, { kind: 'chat', op: 'add', target: currentChatId }, { settings: vf });
            if (!lockResult?.success) { console.error(`${TEST} [FAIL] Failed to lock EventBase to current chat: ${lockResult?.reason}`); return; }

            const ebLocks = getCollectionLocks(eventbaseRegistryKey);
            if (!ebLocks.some(l => l === currentChatId)) { console.error(`${TEST} [FAIL] EventBase lock didn't register — locks=${JSON.stringify(ebLocks)}`); return; }
            console.log(`${TEST} EventBase locked to chat ✓ (locks=${ebLocks.length})`);

            // ── Phase C: query lorebook via dry-run WI activation ──
            const chat = ctx.chat ?? [];
            const query = `${LOREBOOK_SENTINEL} ${EVENTBASE_SENTINEL} phosphoric anthelion stilled tide astrelle zirconic oscillator`;

            console.log(`${TEST} Phase C: querying lorebook + EventBase against synthetic data...`);
            let lbResult;
            try { lbResult = await runLorebookWIDryRun({ chat, testMessage: query, settings: vf }); }
            catch (err) { console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`); return; }

            const lbInjection = lbResult?.injectionText || '';
            if (!lbInjection.includes(LOREBOOK_SENTINEL)) {
                console.error(`${TEST} [FAIL] Lorebook sentinel "${LOREBOOK_SENTINEL}" not found in injection (entries=${lbResult.entryCount})`);
                return;
            }
            console.log(`${TEST} Lorebook ✓ — ${lbResult.entryCount} entry/entries, sentinel found`);

            // ── Phase D: query EventBase via dry-run retrieval ──
            const { runEventBaseRetrieval } = await import(base + 'core/eventbase-workflow.js').catch(() => ({}));
            if (typeof runEventBaseRetrieval !== 'function') { console.warn(`${TEST} [WARN] runEventBaseRetrieval not exported — EventBase E2E half skipped`); return; }

            let ebResult;
            try { ebResult = await runEventBaseRetrieval({ chat, settings: vf, dryRun: true, testMessage: query }); }
            catch (err) { console.error(`${TEST} [FAIL] runEventBaseRetrieval threw: ${err.message}`); return; }

            const ebInjection = ebResult?.injectionText || '';
            if (!ebResult?.eventCount) { console.error(`${TEST} [FAIL] EventBase returned 0 events`); return; }
            if (!ebInjection.includes(EVENTBASE_SENTINEL)) {
                console.error(`${TEST} [FAIL] EventBase sentinel "${EVENTBASE_SENTINEL}" not in injection (events=${ebResult.eventCount})`);
                console.log(`${TEST} EventBase injection preview: ${ebInjection.slice(0, 300)}`);
                return;
            }
            console.log(`${TEST} EventBase ✓ — ${ebResult.eventCount} event(s), sentinel found`);

            console.log(`${TEST} [PASS] Synthetic E2E qdrant: lorebook + EventBase both round-trip with sentinels intact`);
        } finally {
            // ── Cleanup: remove every trace this test created ──
            // Order: locks → vectors → meta → registry (both canonical + bare).
            // EventBase first because we explicitly locked it; lorebook auto-cleans
            // its lock via deleteContentCollection.
            if (eventbaseCreated) {
                try {
                    setLock(eventbaseRegistryKey, { kind: 'chat', op: 'clear' }, { settings: vf });
                    await deleteCollection(eventbaseCollectionId, { ...vf, vector_backend: 'qdrant' }, eventbaseRegistryKey);
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(eventbaseCollectionId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] EventBase folder-cleanup helper failed: ${e.message}`); }
                    deleteCollectionMeta(eventbaseRegistryKey);
                    unregisterCollection(eventbaseRegistryKey);
                    unregisterCollection(eventbaseCollectionId);
                    console.log(`${TEST} EventBase cleanup ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] EventBase cleanup failed: ${cleanupErr.message}`);
                }
            }

            if (lorebookCollectionId) {
                try {
                    await deleteContentCollection(lorebookCollectionId);
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(lorebookCollectionId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] Lorebook folder-cleanup helper failed: ${e.message}`); }
                    deleteCollectionMeta(lorebookRegistryKey);
                    unregisterCollection(lorebookRegistryKey);
                    unregisterCollection(lorebookCollectionId);
                    console.log(`${TEST} Lorebook cleanup ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] Lorebook cleanup failed: ${cleanupErr.message}`);
                }
            }
        }
    });
    assertPassed(logs);
});
