/**
 * Eventbase-test.spec.js — Playwright integration tests for VectFox
 *
 * Run all:      npm run test:e2e
 * Run one:      npx playwright test --grep "TEST 001"
 * View report:  npm run test:e2e:report
 *
 * On first run: a Playwright browser window opens. Log in, then open the chat
 * that has your locked collections. Tests start automatically once the chat is open.
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// serial mode — one browser window, shared across all tests
// ---------------------------------------------------------------------------
test.describe.configure({ mode: 'serial' });

let sharedPage;
let sharedContext;

test.beforeAll(async ({ browser }) => {
    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();
    await sharedPage.goto('/');

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
        el.innerHTML = '🧪 <b>VectFox Tests</b> — log in, then open the chat that has your locked collections. Tests start automatically once the chat is open.';
        document.body.prepend(el);
    }).catch(() => {});

    console.log('[setup] Log in and open the correct chat in the Playwright browser window...');

    // Wait for ST's send button — only present once logged in AND inside a chat
    await sharedPage.waitForSelector('#send_but', { timeout: 120000 });

    // Wait until getContext returns a real chatId (chat is actually open)
    console.log('[setup] Waiting for chat to become active...');
    await sharedPage.waitForFunction(
        () => typeof window.getContext === 'function' && !!window.getContext()?.chatId,
        { timeout: 60000 }
    );

    // Let VectFox and other extensions finish initialising
    await sharedPage.waitForTimeout(2000);
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
    const passed    = logs.some(m => m.text.includes('[PASS]'));

    logs.forEach(m => {
        if      (m.type === 'error')   console.error(m.text);
        else if (m.type === 'warning') console.warn(m.text);
        else                           console.log(m.text);
    });

    if (warnLines.length) console.warn('WARNINGS:\n' + warnLines.join('\n'));
    expect(failLines.length, '[FAIL] found:\n' + failLines.join('\n')).toBe(0);
    expect(passed, 'No [PASS] found — test did not reach success path').toBe(true);
}


// ═══════════════════════════════════════════════════════════════════
// TEST 001 — Qdrant lorebook: vectorize → lock → query isolation
// ═══════════════════════════════════════════════════════════════════
// Setup: lorebook vectorized with Qdrant backend + locked to current chat/character in DB Browser
test('TEST 001 — Qdrant lorebook: lock + query isolation', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 001 [QdrantLorebook]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { getCollectionListing } = await import(base + 'core/collection-loader.js');
        const { shouldCollectionActivate, getCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');

        const { extension_settings } = await import('/scripts/extensions.js');
        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const ctx = window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

        const listing = getCollectionListing(vf);
        const lorebookCols = listing.filter(e => e.collectionId.startsWith('vf_lorebook_'));
        if (!lorebookCols.length) { console.warn(`${TEST} [WARN] No lorebook collections`); return; }

        const qdrantLorebooks = lorebookCols.filter(e => e.registryKey.startsWith('qdrant:'));
        if (!qdrantLorebooks.length) { console.error(`${TEST} [FAIL] No qdrant lorebook found`); return; }

        console.log(`${TEST} Lorebook collections: ${lorebookCols.length} total, ${qdrantLorebooks.length} qdrant`);
        lorebookCols.forEach(e => {
            const meta = getCollectionMeta(e.registryKey);
            console.log(`  ${e.registryKey}  scope=${meta.scope ?? '?'}`);
        });

        const active = [];
        for (const e of lorebookCols) {
            if (await shouldCollectionActivate(e.registryKey, context)) active.push(e);
        }
        if (!active.length) { console.error(`${TEST} [FAIL] No lorebook activated — lock the qdrant lorebook first`); return; }
        if (active.length > 1) {
            console.error(`${TEST} [FAIL] ${active.length} lorebooks activated — expected exactly 1`);
            active.forEach(e => console.error(`  UNEXPECTED: ${e.registryKey}`));
            return;
        }

        const locked = active[0];
        if (!locked.registryKey.startsWith('qdrant:')) console.warn(`${TEST} [WARN] Activated lorebook is not qdrant: ${locked.registryKey}`);
        console.log(`${TEST} Activated: ${locked.registryKey} ✓`);

        const chat = ctx.chat ?? [];
        const lastMsg = [...chat].reverse().find(m => !m.is_system && m.mes)?.mes || 'charlotte';
        let result;
        try { result = await runLorebookWIDryRun({ chat, testMessage: lastMsg, settings: vf }); }
        catch (err) { console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`); return; }

        if (!result.entryCount) { console.error(`${TEST} [FAIL] Dry-run returned 0 entries`); return; }
        console.log(`${TEST} Dry-run: ${result.entryCount} entries`);
        console.log(`  preview: ${(result.injectionText || '').slice(0, 200)}`);
        console.log(`${TEST} [PASS] Qdrant lorebook locked, results returned, no contamination`);
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 002 — Qdrant EventBase: clean insert + field check
// ═══════════════════════════════════════════════════════════════════
// Setup: chat history vectorized with Qdrant backend
test('TEST 002 — Qdrant EventBase: insert + field check', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 002 [EventBaseQdrant]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { getCollectionListing } = await import(base + 'core/collection-loader.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const listing = getCollectionListing(vf);
        const eventbaseCols = listing.filter(e => e.collectionId.startsWith('vf_eventbase_qdrant_'));
        if (!eventbaseCols.length) { console.warn(`${TEST} [WARN] No qdrant EventBase — vectorize first`); return; }

        console.log(`${TEST} Found ${eventbaseCols.length} qdrant EventBase collection(s)`);
        const missingPrefix = eventbaseCols.filter(e => !e.registryKey.startsWith('qdrant:'));
        if (missingPrefix.length) { console.error(`${TEST} [FAIL] ${missingPrefix.length} missing qdrant: prefix`); return; }

        const { QdrantBackend } = await import(base + 'backends/qdrant.js');
        const backend = new QdrantBackend();
        let totalEvents = 0, emptyFieldEvents = 0;

        for (const col of eventbaseCols) {
            let results;
            try { results = await backend.queryCollection(col.collectionId, 'event', 20, vf, { threshold: 0 }); }
            catch (err) { console.error(`${TEST} [FAIL] Query threw: ${err.message}`); return; }

            const items = results?.metadata ?? [];
            if (!items.length) { console.error(`${TEST} [FAIL] Query returned 0 results`); return; }
            totalEvents += items.length;
            items.forEach((m, i) => {
                if (!m.event_type && !m.summary) { emptyFieldEvents++; console.warn(`${TEST} [WARN] Event ${i}: empty fields`); }
                else console.log(`  [${i}] type=${m.event_type}  imp=${m.importance}  summary=${(m.summary||'').slice(0,60)}`);
            });
        }
        if (emptyFieldEvents > 0) { console.error(`${TEST} [FAIL] ${emptyFieldEvents} events with empty fields`); return; }
        console.log(`${TEST} [PASS] ${totalEvents} event(s) — all have event_type + summary`);
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 003 — E2E qdrant: locked lorebook + locked EventBase → both return results
// ═══════════════════════════════════════════════════════════════════
// Setup: TEST 001 + TEST 002 setups both complete
test('TEST 003 — E2E qdrant: both locked, both return results', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 003 [E2EQuery]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { getCollectionListing } = await import(base + 'core/collection-loader.js');
        const { shouldCollectionActivate, getCollectionLocks } = await import(base + 'core/collection-metadata.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');

        const { extension_settings } = await import('/scripts/extensions.js');
        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        const ctx = window.getContext?.() ?? {};
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
        try { eventbaseResult = await runEventBaseRetrieval({ chat, settings: vf, dryRun: true, keywordQuery: lastUserMsg }); }
        catch (err) { console.error(`${TEST} [FAIL] runEventBaseRetrieval threw: ${err.message}`); return; }

        const events = eventbaseResult?.events ?? [];
        if (!events.length) { console.error(`${TEST} [FAIL] EventBase returned 0 events`); return; }
        events.slice(0, 3).forEach((e, i) => console.log(`  [${i}] type=${e.event_type}  imp=${e.importance ?? '?'}  summary=${(e.summary||'').slice(0,60)}`));

        console.log(`${TEST} [PASS] Lorebook (${lorebookResult.entryCount}) + EventBase (${events.length}) — locked collections only`);
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 004 — DB Browser: entry names, text, delete (any backend)
// ═══════════════════════════════════════════════════════════════════
// Setup: any lorebook collection vectorized with at least 3 chunks
test('TEST 004 — DB Browser: listing + delete (any backend)', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 004 [DBBrowser]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { getCollectionListing } = await import(base + 'core/collection-loader.js');
        const { QdrantBackend } = await import(base + 'backends/qdrant.js');
        const { StandardBackend } = await import(base + 'backends/standard.js');

        const { extension_settings } = await import('/scripts/extensions.js');
        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const listing = getCollectionListing(vf);
        const lorebookCols = listing.filter(e => e.collectionId.startsWith('vf_lorebook_'));
        if (!lorebookCols.length) { console.warn(`${TEST} [WARN] No lorebook collections`); return; }

        const col = lorebookCols[0];
        const isQdrant = col.registryKey.startsWith('qdrant:');
        const backend = isQdrant ? new QdrantBackend() : new StandardBackend();
        console.log(`${TEST} Testing: ${col.registryKey} (${isQdrant ? 'qdrant' : 'standard'})`);

        let listResult;
        try { listResult = await backend.listChunks(col.collectionId, vf, { limit: 10 }); }
        catch (err) { console.error(`${TEST} [FAIL] listChunks threw: ${err.message}`); return; }

        const items = listResult?.items ?? [];
        if (!items.length) { console.error(`${TEST} [FAIL] listChunks returned 0 items`); return; }
        console.log(`${TEST} listChunks: ${items.length} items (total: ${listResult.total})`);

        const noText      = items.filter(i => !i.text?.trim());
        const noEntryName = items.filter(i => !i.metadata?.entryName);
        items.slice(0, 3).forEach((item, i) =>
            console.log(`  [${i}] entryName="${item.metadata?.entryName ?? '(none)'}"  text="${(item.text||'').slice(0,60)}"`));

        if (noText.length) { console.error(`${TEST} [FAIL] ${noText.length} chunk(s) have no text`); return; }
        if (noEntryName.length === items.length) { console.error(`${TEST} [FAIL] ALL chunks missing entryName`); return; }
        if (noEntryName.length > 0) console.warn(`${TEST} [WARN] ${noEntryName.length} chunk(s) missing entryName`);

        const targetHash = items[0].hash;
        console.log(`${TEST} Deleting hash=${targetHash}  entryName="${items[0].metadata?.entryName ?? '(none)'}"`);
        try { await backend.deleteVectorItems(col.collectionId, [targetHash], vf); }
        catch (err) { console.error(`${TEST} [FAIL] deleteVectorItems threw: ${err.message}`); return; }

        let afterResult;
        try { afterResult = await backend.listChunks(col.collectionId, vf, { limit: 10 }); }
        catch (err) { console.error(`${TEST} [FAIL] listChunks after delete threw: ${err.message}`); return; }

        if ((afterResult?.items ?? []).some(i => i.hash === targetHash)) {
            console.error(`${TEST} [FAIL] Deleted hash still in listing`); return;
        }
        if (afterResult.total >= listResult.total) console.warn(`${TEST} [WARN] total count did not decrease`);

        console.log(`${TEST} After delete: ${listResult.total} → ${afterResult.total} ✓`);
        console.log(`${TEST} [PASS] Entry names visible, text present, delete removed the entry`);
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 005 — Standard lorebook: vectorize → lock → query isolation
// ═══════════════════════════════════════════════════════════════════
// Setup: lorebook vectorized with Standard backend + locked to current chat in DB Browser
// Note: vectorScore=0.0000 is expected — not a failure
test('TEST 005 — Standard lorebook: lock + query isolation', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 005 [StdLorebook]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { getCollectionListing } = await import(base + 'core/collection-loader.js');
        const { shouldCollectionActivate, getCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');

        const { extension_settings } = await import('/scripts/extensions.js');
        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        const ctx = window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

        const listing = getCollectionListing(vf);
        const lorebookCols = listing.filter(e => e.collectionId.startsWith('vf_lorebook_'));
        const stdLorebooks = lorebookCols.filter(e => e.registryKey.startsWith('vectra:'));
        if (!stdLorebooks.length) { console.error(`${TEST} [FAIL] No standard (vectra:) lorebook found`); return; }

        console.log(`${TEST} Collections: ${lorebookCols.length} total, ${stdLorebooks.length} standard`);
        lorebookCols.forEach(e => {
            const meta = getCollectionMeta(e.registryKey);
            console.log(`  ${e.registryKey}  scope=${meta.scope ?? '?'}`);
        });

        const active = [];
        for (const e of lorebookCols) {
            if (await shouldCollectionActivate(e.registryKey, context)) active.push(e);
        }
        if (!active.length) { console.error(`${TEST} [FAIL] No lorebook activated — lock the standard lorebook first`); return; }
        if (active.length > 1) {
            console.error(`${TEST} [FAIL] ${active.length} lorebooks activated — expected 1`);
            active.forEach(e => console.error(`  UNEXPECTED: ${e.registryKey}`));
            return;
        }

        const locked = active[0];
        if (!locked.registryKey.startsWith('vectra:')) console.warn(`${TEST} [WARN] Activated lorebook is not standard: ${locked.registryKey}`);
        console.log(`${TEST} Activated: ${locked.registryKey} ✓`);

        const chat = ctx.chat ?? [];
        const lastMsg = [...chat].reverse().find(m => !m.is_system && m.mes)?.mes || 'charlotte';
        let result;
        try { result = await runLorebookWIDryRun({ chat, testMessage: lastMsg, settings: vf }); }
        catch (err) { console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`); return; }

        if (!result.entryCount) { console.error(`${TEST} [FAIL] Dry-run returned 0 entries`); return; }
        console.log(`${TEST} Dry-run: ${result.entryCount} entries (vectorScore=0.0000 expected)`);
        console.log(`  preview: ${(result.injectionText || '').slice(0, 200)}`);
        console.log(`${TEST} [PASS] Standard lorebook locked, results returned, no contamination`);
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 006 — Standard EventBase: lock → parseEmbedText field recovery
// ═══════════════════════════════════════════════════════════════════
// Setup: chat history vectorized with Standard backend + locked to this chat
// Note: imp=undefined and method=bm25 are expected
test('TEST 006 — Standard EventBase: lock + parseEmbedText recovery', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 006 [StdEventBase]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { getCollectionListing } = await import(base + 'core/collection-loader.js');
        const { getCollectionLocks } = await import(base + 'core/collection-metadata.js');

        const { extension_settings } = await import('/scripts/extensions.js');
        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        const ctx = window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat`); return; }

        const listing = getCollectionListing(vf);
        const eventbaseCols = listing.filter(e => e.collectionId.startsWith('vf_eventbase_'));
        const stdEventbases = eventbaseCols.filter(e => e.registryKey.startsWith('vectra:'));
        if (!stdEventbases.length) { console.error(`${TEST} [FAIL] No standard EventBase found`); return; }

        const lockedEventbases = eventbaseCols.filter(e => getCollectionLocks(e.registryKey).some(l => l === currentChatId));
        console.log(`${TEST} EventBase: ${eventbaseCols.length} total, ${stdEventbases.length} standard`);
        eventbaseCols.forEach(e => console.log(`  ${e.registryKey}  locked=${getCollectionLocks(e.registryKey).some(l => l === currentChatId)}`));

        if (!lockedEventbases.length) { console.error(`${TEST} [FAIL] No EventBase locked to this chat`); return; }
        if (lockedEventbases.length > 1) { console.error(`${TEST} [FAIL] ${lockedEventbases.length} locked — expected 1`); return; }

        const locked = lockedEventbases[0];
        if (!locked.registryKey.startsWith('vectra:')) console.warn(`${TEST} [WARN] Locked EventBase is not standard: ${locked.registryKey}`);
        console.log(`${TEST} Locked: ${locked.registryKey} ✓`);

        const { StandardBackend } = await import(base + 'backends/standard.js');
        let results;
        try { results = await (new StandardBackend()).queryCollection(locked.collectionId, 'charlotte', 20, vf); }
        catch (err) { console.error(`${TEST} [FAIL] queryCollection threw: ${err.message}`); return; }

        const items = results?.metadata ?? [];
        if (!items.length) { console.error(`${TEST} [FAIL] Query returned 0 results`); return; }
        console.log(`${TEST} Query: ${items.length} result(s)`);

        const { parseEmbedText } = await import(base + 'core/eventbase-schema.js');
        let recoveredCount = 0;
        items.slice(0, 5).forEach((m, i) => {
            const r = parseEmbedText(m.text || '');
            if (r.event_type) recoveredCount++;
            console.log(`  [${i}] type="${r.event_type || '(none)'}"  imp=${m.importance ?? 'undefined (expected)'}  summary="${(r.summary||'').slice(0,50)}"`);
        });

        if (recoveredCount === 0) { console.error(`${TEST} [FAIL] parseEmbedText recovered no event_type`); return; }
        console.log(`${TEST} parseEmbedText recovered event_type for ${recoveredCount}/${Math.min(items.length, 5)} events`);
        console.log(`${TEST} [PASS] Standard EventBase locked, events returned, parseEmbedText working`);
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
        const ctx = window.getContext?.() ?? {};
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
        try { eventbaseResult = await runEventBaseRetrieval({ chat, settings: vf, dryRun: true, keywordQuery: lastUserMsg }); }
        catch (err) { console.error(`${TEST} [FAIL] runEventBaseRetrieval threw: ${err.message}`); return; }

        const events = eventbaseResult?.events ?? [];
        if (!events.length) { console.error(`${TEST} [FAIL] EventBase returned 0 events`); return; }
        events.slice(0, 3).forEach((e, i) =>
            console.log(`  [${i}] type=${e.event_type}  imp=${e.importance ?? 'undefined (expected)'}  summary=${(e.summary||'').slice(0,60)}`));

        console.log(`${TEST} [PASS] Lorebook (${lorebookResult.entryCount}) + EventBase (${events.length}) — standard backend, no contamination`);
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 008 — DB Browser standard: entry names, text, delete
// ═══════════════════════════════════════════════════════════════════
// Setup: a lorebook vectorized with Standard backend — at least 3 chunks
test('TEST 008 — DB Browser standard: listing + delete', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 008 [DBBrowserStd]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { getCollectionListing } = await import(base + 'core/collection-loader.js');
        const { StandardBackend } = await import(base + 'backends/standard.js');

        const { extension_settings } = await import('/scripts/extensions.js');
        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const listing = getCollectionListing(vf);
        const stdLorebooks = listing.filter(e =>
            e.collectionId.startsWith('vf_lorebook_') && e.registryKey.startsWith('vectra:')
        );
        if (!stdLorebooks.length) { console.warn(`${TEST} [WARN] No standard lorebook — vectorize with Standard backend first`); return; }

        const col = stdLorebooks[0];
        const backend = new StandardBackend();
        console.log(`${TEST} Testing: ${col.registryKey}`);

        let listResult;
        try { listResult = await backend.listChunks(col.collectionId, vf, { limit: 10 }); }
        catch (err) { console.error(`${TEST} [FAIL] listChunks threw: ${err.message}`); return; }

        const items = listResult?.items ?? [];
        if (!items.length) { console.error(`${TEST} [FAIL] listChunks returned 0 items`); return; }
        console.log(`${TEST} listChunks: ${items.length} items (total: ${listResult.total})`);

        const noText      = items.filter(i => !i.text?.trim());
        const noEntryName = items.filter(i => !i.metadata?.entryName);
        items.slice(0, 3).forEach((item, i) =>
            console.log(`  [${i}] entryName="${item.metadata?.entryName ?? '(none)'}"  text="${(item.text||'').slice(0,60)}"`));

        if (noText.length) { console.error(`${TEST} [FAIL] ${noText.length} chunk(s) have no text`); return; }
        if (noEntryName.length === items.length) { console.error(`${TEST} [FAIL] ALL chunks missing entryName`); return; }
        if (noEntryName.length > 0) console.warn(`${TEST} [WARN] ${noEntryName.length} chunk(s) missing entryName`);

        const targetHash = items[0].hash;
        console.log(`${TEST} Deleting hash=${targetHash}  entryName="${items[0].metadata?.entryName ?? '(none)'}"`);
        try { await backend.deleteVectorItems(col.collectionId, [targetHash], vf); }
        catch (err) { console.error(`${TEST} [FAIL] deleteVectorItems threw: ${err.message}`); return; }

        let afterResult;
        try { afterResult = await backend.listChunks(col.collectionId, vf, { limit: 10 }); }
        catch (err) { console.error(`${TEST} [FAIL] listChunks after delete threw: ${err.message}`); return; }

        if ((afterResult?.items ?? []).some(i => i.hash === targetHash)) {
            console.error(`${TEST} [FAIL] Deleted hash still in listing`); return;
        }
        if (afterResult.total >= listResult.total) console.warn(`${TEST} [WARN] total count did not decrease`);

        console.log(`${TEST} After delete: ${listResult.total} → ${afterResult.total} ✓`);
        console.log(`${TEST} [PASS] Standard: entry names visible, text present, delete removed the entry`);
    });
    assertPassed(logs);
});
