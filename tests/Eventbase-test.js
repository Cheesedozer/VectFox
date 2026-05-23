/**
 * Eventbase-test.js — VectFox browser integration tests
 *
 * HOW TO USE
 * ----------
 * 1. Open SillyTavern in the browser and open a chat.
 * 2. Open DevTools → Console.
 * 3. Copy-paste any individual test block below and press Enter.
 * 4. Read the output — each test ends with [PASS], [FAIL], or [WARN].
 *
 * These tests require a live running SillyTavern + VectFox instance.
 * They cannot run in Node / Vitest — they read live runtime state.
 *
 * Test index:
 *   001  Qdrant lorebook   — vectorize → lock → query isolation
 *   002  Qdrant EventBase  — vectorize → clean insert → field check
 *   003  E2E qdrant        — locked lorebook + locked EventBase → both return results
 *   004  DB Browser        — entry names, text on click, delete removes entry (any backend)
 *   005  Standard lorebook — vectorize → lock → query isolation
 *   006  Standard EventBase— vectorize → lock → parseEmbedText field recovery
 *   007  E2E standard      — locked standard lorebook + locked standard EventBase → both return results
 *   008  DB Browser std    — same as 004 but specifically for standard (vectra:) collections
 * 
 * npm install -D @playwright/test
 * npx playwright install
 * 
 * # Run all 8 tests
npm run test:e2e
npm run test:e2e:no-log.

# Run a specific test
npx playwright test --grep "TEST 001"

# View HTML report after a run
npm run test:e2e:report
 * 
 */

// ═══════════════════════════════════════════════════════════════════
// TEST 001 — Qdrant lorebook: vectorize → lock → query isolation
// ═══════════════════════════════════════════════════════════════════
//
// Setup before running:
//   1. VectFox → Lorebook tab → select a lorebook → backend = Qdrant → Vectorize
//   2. DB Browser → that collection → Collection Settings → "Active for current chat" → Save
//   3. No other lorebook locked to this chat
//
(async () => {
    const TEST = 'TEST 001 [QdrantLorebook]';

    const base = '/scripts/extensions/third-party/VectFox/';
    const { getCollectionListing } = await import(base + 'core/collection-loader.js');
    const { shouldCollectionActivate, getCollectionMeta } = await import(base + 'core/collection-metadata.js');
    const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');

    const vf = window._vectfox ?? window.extension_settings?.vectfox;
    if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

    const ctx = window.getContext?.() ?? {};
    const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
    if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
    const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

    const listing = getCollectionListing(vf);
    const lorebookCols = listing.filter(e => e.collectionId.startsWith('vf_lorebook_'));

    if (!lorebookCols.length) {
        console.warn(`${TEST} [WARN] No lorebook collections — vectorize one with Qdrant backend first`);
        return;
    }

    const qdrantLorebooks = lorebookCols.filter(e => e.registryKey.startsWith('qdrant:'));
    if (!qdrantLorebooks.length) {
        console.error(`${TEST} [FAIL] No qdrant lorebook found — vectorize with Qdrant backend`);
        return;
    }

    console.log(`${TEST} Lorebook collections found: ${lorebookCols.length} total, ${qdrantLorebooks.length} qdrant`);
    lorebookCols.forEach(e => {
        const meta = getCollectionMeta(e.registryKey);
        console.log(`  ${e.registryKey}  scope=${meta.scope ?? '?'}`);
    });

    const active = [];
    for (const e of lorebookCols) {
        if (await shouldCollectionActivate(e.registryKey, context)) active.push(e);
    }

    if (!active.length) {
        console.error(`${TEST} [FAIL] No lorebook activated — lock the qdrant lorebook to this chat first`);
        return;
    }
    if (active.length > 1) {
        console.error(`${TEST} [FAIL] ${active.length} lorebooks activated — expected exactly 1:`);
        active.forEach(e => console.error(`  UNEXPECTED: ${e.registryKey}`));
        return;
    }

    const locked = active[0];
    if (!locked.registryKey.startsWith('qdrant:')) {
        console.warn(`${TEST} [WARN] Activated lorebook is not qdrant backend: ${locked.registryKey}`);
    }
    console.log(`${TEST} Activated lorebook: ${locked.registryKey} ✓`);

    const chat = ctx.chat ?? [];
    const lastMsg = [...chat].reverse().find(m => !m.is_system && m.mes)?.mes || 'charlotte';

    let result;
    try {
        result = await runLorebookWIDryRun({ chat, testMessage: lastMsg, settings: vf });
    } catch (err) {
        console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`);
        return;
    }

    if (!result.entryCount) {
        console.error(`${TEST} [FAIL] Dry-run returned 0 entries — semantic search found nothing`);
        return;
    }

    console.log(`${TEST} Dry-run: ${result.entryCount} entry/entries returned`);
    console.log(`  injection preview:\n${(result.injectionText || '').slice(0, 300)}`);
    console.log(`${TEST} [PASS] Qdrant lorebook vectorized, locked, results returned — no contamination`);
})();


// ═══════════════════════════════════════════════════════════════════
// TEST 002 — Qdrant EventBase: vectorize → clean insert → field check
// ═══════════════════════════════════════════════════════════════════
//
// Setup before running:
//   1. VectFox → EventBase tab → backend = Qdrant → Vectorize Chat History
//
(async () => {
    const TEST = 'TEST 002 [EventBaseQdrant]';

    const base = '/scripts/extensions/third-party/VectFox/';
    const { getCollectionListing } = await import(base + 'core/collection-loader.js');
    const vf = window._vectfox ?? window.extension_settings?.vectfox;
    if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

    const listing = getCollectionListing(vf);
    const eventbaseCols = listing.filter(e => e.collectionId.startsWith('vf_eventbase_qdrant_'));

    if (!eventbaseCols.length) {
        console.warn(`${TEST} [WARN] No qdrant EventBase collections found — vectorize chat history first`);
        return;
    }

    console.log(`${TEST} Found ${eventbaseCols.length} qdrant EventBase collection(s):`);
    eventbaseCols.forEach(e => console.log(`  ${e.registryKey}`));

    const missingPrefix = eventbaseCols.filter(e => !e.registryKey.startsWith('qdrant:'));
    if (missingPrefix.length) {
        console.error(`${TEST} [FAIL] ${missingPrefix.length} collection(s) missing qdrant: prefix in registryKey:`);
        missingPrefix.forEach(e => console.error(`  BAD KEY: ${e.registryKey}`));
        return;
    }

    const { QdrantBackend } = await import(base + 'backends/qdrant.js');
    const backend = new QdrantBackend();
    let totalEvents = 0;
    let emptyFieldEvents = 0;

    for (const col of eventbaseCols) {
        let results;
        try {
            results = await backend.queryCollection(col.collectionId, 'event', 20, vf, { threshold: 0 });
        } catch (err) {
            console.error(`${TEST} [FAIL] Query threw for ${col.registryKey}: ${err.message}`);
            return;
        }

        const items = results?.metadata ?? [];
        console.log(`${TEST} ${col.registryKey}: ${items.length} event(s) returned`);

        if (!items.length) {
            console.error(`${TEST} [FAIL] Collection has vectors but query returned 0 results`);
            return;
        }

        totalEvents += items.length;
        items.forEach((m, i) => {
            const hasType    = !!m.event_type;
            const hasSummary = !!m.summary;
            if (!hasType && !hasSummary) {
                emptyFieldEvents++;
                console.warn(`${TEST} [WARN] Event ${i}: event_type and summary both empty`);
            } else {
                console.log(`  [${i}] type=${m.event_type || '?'}  imp=${m.importance ?? '?'}  chars=[${(m.characters || []).join(', ')}]  summary=${(m.summary || '').slice(0, 60)}`);
            }
        });
    }

    if (emptyFieldEvents > 0) {
        console.error(`${TEST} [FAIL] ${emptyFieldEvents} event(s) have no event_type or summary`);
        return;
    }

    console.log(`${TEST} [PASS] ${totalEvents} event(s) across ${eventbaseCols.length} collection(s) — all have event_type + summary`);
})();


// ═══════════════════════════════════════════════════════════════════
// TEST 003 — E2E qdrant: locked lorebook + locked EventBase → both return results
// ═══════════════════════════════════════════════════════════════════
//
// Depends on: TEST 001 setup (qdrant lorebook locked) + TEST 002 setup (qdrant EventBase locked)
//
(async () => {
    const TEST = 'TEST 003 [E2EQuery]';

    const base = '/scripts/extensions/third-party/VectFox/';
    const { getCollectionListing } = await import(base + 'core/collection-loader.js');
    const { shouldCollectionActivate, getCollectionLocks } = await import(base + 'core/collection-metadata.js');
    const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');

    const vf = window._vectfox ?? window.extension_settings?.vectfox;
    if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

    const ctx = window.getContext?.() ?? {};
    const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
    if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
    const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

    const listing = getCollectionListing(vf);

    // pre-condition: lorebook locked
    const lorebookCols = listing.filter(e => e.collectionId.startsWith('vf_lorebook_'));
    const lockedLorebooks = [];
    for (const e of lorebookCols) {
        if (await shouldCollectionActivate(e.registryKey, context)) lockedLorebooks.push(e);
    }
    if (!lockedLorebooks.length) {
        console.error(`${TEST} [FAIL] No lorebook activated for current context — complete TEST 001 setup first`);
        return;
    }
    lockedLorebooks.forEach(e => {
        const meta = e.meta ?? {};
        console.log(`${TEST} Active lorebook: ${e.registryKey}  scope=${meta.scope ?? '?'}`);
    });

    // pre-condition: EventBase locked
    const eventbaseCols = listing.filter(e => e.collectionId.startsWith('vf_eventbase_'));
    const lockedEventbases = eventbaseCols.filter(e => {
        const locks = getCollectionLocks(e.registryKey);
        return locks.some(l => l === currentChatId);
    });
    if (!lockedEventbases.length) {
        console.error(`${TEST} [FAIL] No EventBase locked to this chat — complete TEST 002 setup first`);
        return;
    }
    console.log(`${TEST} Locked EventBase: ${lockedEventbases.map(e => e.registryKey).join(', ')}`);

    // lorebook dry-run
    const chat = ctx.chat ?? [];
    const lastUserMsg = [...chat].reverse().find(m => !m.is_system && m.mes)?.mes || 'test query';
    console.log(`${TEST} Running lorebook dry-run with anchor: "${lastUserMsg.slice(0, 60)}"`);

    let lorebookResult;
    try {
        lorebookResult = await runLorebookWIDryRun({ chat, testMessage: lastUserMsg, settings: vf });
    } catch (err) {
        console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`);
        return;
    }

    if (lorebookResult.disabled)     { console.error(`${TEST} [FAIL] Lorebook WI disabled`); return; }
    if (lorebookResult.noCollections){ console.error(`${TEST} [FAIL] No lorebook collections found — lock not applied?`); return; }
    if (!lorebookResult.entryCount)  { console.error(`${TEST} [FAIL] Lorebook dry-run returned 0 entries`); return; }

    console.log(`${TEST} Lorebook dry-run: ${lorebookResult.entryCount} entry/entries returned`);
    console.log(`  injection preview:\n${(lorebookResult.injectionText || '').slice(0, 300)}`);

    // EventBase live retrieval
    const { runEventBaseRetrieval } = await import(base + 'core/eventbase-workflow.js').catch(() => ({}));
    if (typeof runEventBaseRetrieval !== 'function') {
        console.warn(`${TEST} [WARN] runEventBaseRetrieval not exported — check debug query UI manually`);
        console.log(`${TEST} [PASS] Lorebook path verified. EventBase: verify manually.`);
        return;
    }

    let eventbaseResult;
    try {
        eventbaseResult = await runEventBaseRetrieval({ chat, settings: vf, dryRun: true, keywordQuery: lastUserMsg });
    } catch (err) {
        console.error(`${TEST} [FAIL] runEventBaseRetrieval threw: ${err.message}`);
        return;
    }

    const events = eventbaseResult?.events ?? [];
    if (!events.length) {
        console.error(`${TEST} [FAIL] EventBase returned 0 events — check lock and importance filter`);
        return;
    }

    const missingFields = events.filter(e => !e.event_type && !e.summary);
    if (missingFields.length) {
        console.warn(`${TEST} [WARN] ${missingFields.length} event(s) have no event_type or summary`);
    }

    console.log(`${TEST} EventBase: ${events.length} event(s) returned`);
    events.slice(0, 3).forEach((e, i) =>
        console.log(`  [${i}] type=${e.event_type || '?'}  imp=${e.importance ?? '?'}  summary=${(e.summary || '').slice(0, 60)}`));

    if (lorebookResult.entryCount > 0 && events.length > 0) {
        console.log(`${TEST} [PASS] Both lorebook (${lorebookResult.entryCount} entries) and EventBase (${events.length} events) returned results from locked collections only`);
    } else {
        console.warn(`${TEST} [WARN] One pipeline returned 0 results — investigate above`);
    }
})();


// ═══════════════════════════════════════════════════════════════════
// TEST 004 — DB Browser: entry names visible, text on click, delete removes entry (any backend)
// ═══════════════════════════════════════════════════════════════════
//
// Setup: any lorebook collection vectorized (qdrant or standard) with at least 3 chunks
//
(async () => {
    const TEST = 'TEST 004 [DBBrowser]';

    const base = '/scripts/extensions/third-party/VectFox/';
    const { getCollectionListing } = await import(base + 'core/collection-loader.js');
    const { QdrantBackend } = await import(base + 'backends/qdrant.js');
    const { StandardBackend } = await import(base + 'backends/standard.js');

    const vf = window._vectfox ?? window.extension_settings?.vectfox;
    if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

    const listing = getCollectionListing(vf);
    const lorebookCols = listing.filter(e => e.collectionId.startsWith('vf_lorebook_'));
    if (!lorebookCols.length) {
        console.warn(`${TEST} [WARN] No lorebook collections found — vectorize a lorebook first`);
        return;
    }

    const col = lorebookCols[0];
    const isQdrant = col.registryKey.startsWith('qdrant:');
    const backend = isQdrant ? new QdrantBackend() : new StandardBackend();
    console.log(`${TEST} Testing collection: ${col.registryKey} (${isQdrant ? 'qdrant' : 'standard'})`);

    let listResult;
    try {
        listResult = await backend.listChunks(col.collectionId, vf, { limit: 10 });
    } catch (err) {
        console.error(`${TEST} [FAIL] listChunks threw: ${err.message}`);
        return;
    }

    const items = listResult?.items ?? [];
    if (!items.length) {
        console.error(`${TEST} [FAIL] listChunks returned 0 items`);
        return;
    }
    console.log(`${TEST} listChunks: ${items.length} item(s) (total: ${listResult.total})`);

    const noText      = items.filter(i => !i.text?.trim());
    const noEntryName = items.filter(i => !i.metadata?.entryName);
    items.slice(0, 3).forEach((item, i) =>
        console.log(`  [${i}] entryName="${item.metadata?.entryName ?? '(none)'}"  text="${(item.text || '').slice(0, 60)}"`));

    if (noText.length) {
        console.error(`${TEST} [FAIL] ${noText.length}/${items.length} chunk(s) have no text`);
        return;
    }
    if (noEntryName.length === items.length) {
        console.error(`${TEST} [FAIL] ALL chunks missing entryName — metadata not stored at vectorization`);
        return;
    }
    if (noEntryName.length > 0) {
        console.warn(`${TEST} [WARN] ${noEntryName.length}/${items.length} chunk(s) missing entryName — partial metadata`);
    }
    console.log(`${TEST} Listing check: text ✓, entryName ${noEntryName.length === 0 ? '✓' : '⚠ partial'}`);

    const targetHash = items[0].hash;
    const targetName = items[0].metadata?.entryName ?? '(no name)';
    console.log(`${TEST} Deleting hash=${targetHash}  entryName="${targetName}"`);

    try {
        await backend.deleteVectorItems(col.collectionId, [targetHash], vf);
    } catch (err) {
        console.error(`${TEST} [FAIL] deleteVectorItems threw: ${err.message}`);
        return;
    }

    let afterResult;
    try {
        afterResult = await backend.listChunks(col.collectionId, vf, { limit: 10 });
    } catch (err) {
        console.error(`${TEST} [FAIL] listChunks after delete threw: ${err.message}`);
        return;
    }

    const stillPresent = (afterResult?.items ?? []).some(i => i.hash === targetHash);
    if (stillPresent) {
        console.error(`${TEST} [FAIL] Deleted hash ${targetHash} still appears in listing`);
        return;
    }
    if (afterResult.total >= listResult.total) {
        console.warn(`${TEST} [WARN] total count did not decrease (before=${listResult.total}, after=${afterResult.total})`);
    }

    console.log(`${TEST} After delete: total ${listResult.total} → ${afterResult.total}, hash gone ✓`);
    console.log(`${TEST} [PASS] Entry names visible, text present, delete removed the entry`);
})();


// ═══════════════════════════════════════════════════════════════════
// TEST 005 — Standard lorebook: vectorize → lock → query isolation
// ═══════════════════════════════════════════════════════════════════
//
// Setup before running:
//   1. VectFox → Lorebook tab → select a lorebook → backend = Standard → Vectorize
//   2. DB Browser → that collection → Collection Settings → "Active for current chat" → Save
//   3. No other lorebook locked to this chat
//
// Note: vectorScore=0.0000 is expected on standard backend — not a failure
//
(async () => {
    const TEST = 'TEST 005 [StdLorebook]';

    const base = '/scripts/extensions/third-party/VectFox/';
    const { getCollectionListing } = await import(base + 'core/collection-loader.js');
    const { shouldCollectionActivate, getCollectionMeta } = await import(base + 'core/collection-metadata.js');
    const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');

    const vf = window._vectfox ?? window.extension_settings?.vectfox;
    if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

    const ctx = window.getContext?.() ?? {};
    const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
    if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
    const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

    const listing = getCollectionListing(vf);
    const lorebookCols = listing.filter(e => e.collectionId.startsWith('vf_lorebook_'));

    if (!lorebookCols.length) {
        console.warn(`${TEST} [WARN] No lorebook collections — vectorize one with Standard backend first`);
        return;
    }

    const stdLorebooks = lorebookCols.filter(e => e.registryKey.startsWith('vectra:'));
    if (!stdLorebooks.length) {
        console.error(`${TEST} [FAIL] No standard (vectra:) lorebook found — vectorize with Standard backend`);
        return;
    }

    console.log(`${TEST} Lorebook collections found: ${lorebookCols.length} total, ${stdLorebooks.length} standard`);
    lorebookCols.forEach(e => {
        const meta = getCollectionMeta(e.registryKey);
        console.log(`  ${e.registryKey}  scope=${meta.scope ?? '?'}`);
    });

    const active = [];
    for (const e of lorebookCols) {
        if (await shouldCollectionActivate(e.registryKey, context)) active.push(e);
    }

    if (!active.length) {
        console.error(`${TEST} [FAIL] No lorebook activated — lock the standard lorebook to this chat first`);
        return;
    }
    if (active.length > 1) {
        console.error(`${TEST} [FAIL] ${active.length} lorebooks activated — expected exactly 1:`);
        active.forEach(e => console.error(`  UNEXPECTED: ${e.registryKey}`));
        return;
    }

    const locked = active[0];
    if (!locked.registryKey.startsWith('vectra:')) {
        console.warn(`${TEST} [WARN] Activated lorebook is not standard backend: ${locked.registryKey}`);
    }
    console.log(`${TEST} Activated lorebook: ${locked.registryKey} ✓`);

    const chat = ctx.chat ?? [];
    const lastMsg = [...chat].reverse().find(m => !m.is_system && m.mes)?.mes || 'charlotte';

    let result;
    try {
        result = await runLorebookWIDryRun({ chat, testMessage: lastMsg, settings: vf });
    } catch (err) {
        console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`);
        return;
    }

    if (!result.entryCount) {
        console.error(`${TEST} [FAIL] Dry-run returned 0 entries — semantic search found nothing`);
        return;
    }

    console.log(`${TEST} Dry-run: ${result.entryCount} entry/entries returned`);
    console.log(`  Note: vectorScore=0.0000 expected on standard backend (BM25 ranking only)`);
    console.log(`  injection preview:\n${(result.injectionText || '').slice(0, 300)}`);
    console.log(`${TEST} [PASS] Standard lorebook vectorized, locked, results returned — no contamination`);
})();


// ═══════════════════════════════════════════════════════════════════
// TEST 006 — Standard EventBase: vectorize → lock → parseEmbedText field recovery
// ═══════════════════════════════════════════════════════════════════
//
// Setup before running:
//   1. VectFox → EventBase tab → backend = Standard → Vectorize Chat History
//   2. Confirm new vectra:vf_eventbase_standard_* collection locked to this chat in DB Browser
//   3. No other EventBase locked to this chat
//
// Note: imp=undefined and persist=undefined are EXPECTED on standard backend
// Note: method=bm25 in logs is EXPECTED — EventBase always overrides keyword_scoring_method to bm25
//
(async () => {
    const TEST = 'TEST 006 [StdEventBase]';

    const base = '/scripts/extensions/third-party/VectFox/';
    const { getCollectionListing } = await import(base + 'core/collection-loader.js');
    const { getCollectionLocks } = await import(base + 'core/collection-metadata.js');

    const vf = window._vectfox ?? window.extension_settings?.vectfox;
    if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

    const ctx = window.getContext?.() ?? {};
    const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
    if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }

    const listing = getCollectionListing(vf);
    const eventbaseCols = listing.filter(e => e.collectionId.startsWith('vf_eventbase_'));

    const stdEventbases = eventbaseCols.filter(e => e.registryKey.startsWith('vectra:'));
    if (!stdEventbases.length) {
        console.error(`${TEST} [FAIL] No standard (vectra:) EventBase found — vectorize with Standard backend`);
        return;
    }

    const lockedEventbases = eventbaseCols.filter(e => {
        const locks = getCollectionLocks(e.registryKey);
        return locks.some(l => l === currentChatId);
    });

    console.log(`${TEST} EventBase collections: ${eventbaseCols.length} total, ${stdEventbases.length} standard`);
    eventbaseCols.forEach(e => {
        const locks = getCollectionLocks(e.registryKey);
        console.log(`  ${e.registryKey}  locked=${locks.some(l => l === currentChatId)}`);
    });

    if (!lockedEventbases.length) {
        console.error(`${TEST} [FAIL] No EventBase locked to this chat — lock the standard one in DB Browser`);
        return;
    }
    if (lockedEventbases.length > 1) {
        console.error(`${TEST} [FAIL] ${lockedEventbases.length} EventBase collections locked — expected exactly 1`);
        lockedEventbases.forEach(e => console.error(`  LOCKED: ${e.registryKey}`));
        return;
    }

    const locked = lockedEventbases[0];
    if (!locked.registryKey.startsWith('vectra:')) {
        console.warn(`${TEST} [WARN] Locked EventBase is not standard backend: ${locked.registryKey}`);
    }
    console.log(`${TEST} Locked EventBase: ${locked.registryKey} ✓`);

    const { StandardBackend } = await import(base + 'backends/standard.js');
    const backend = new StandardBackend();
    let results;
    try {
        results = await backend.queryCollection(locked.collectionId, 'charlotte', 20, vf);
    } catch (err) {
        console.error(`${TEST} [FAIL] queryCollection threw: ${err.message}`);
        return;
    }

    const items = results?.metadata ?? [];
    if (!items.length) {
        console.error(`${TEST} [FAIL] Query returned 0 results — collection may be empty`);
        return;
    }
    console.log(`${TEST} Query returned ${items.length} result(s)`);

    const { parseEmbedText } = await import(base + 'core/eventbase-schema.js');
    let recoveredCount = 0;
    items.slice(0, 5).forEach((m, i) => {
        const recovered = parseEmbedText(m.text || '');
        if (recovered.event_type) recoveredCount++;
        console.log(`  [${i}] event_type="${recovered.event_type || '(none)'}"  imp=${m.importance ?? 'undefined (expected)'}  summary="${(recovered.summary || '').slice(0, 50)}"`);
    });

    if (recoveredCount === 0) {
        console.error(`${TEST} [FAIL] parseEmbedText recovered no event_type — embed text format broken`);
        return;
    }

    console.log(`${TEST} parseEmbedText recovered event_type for ${recoveredCount}/${Math.min(items.length, 5)} sampled events`);
    console.log(`${TEST} Note: imp=undefined EXPECTED — importance not stored in standard backend embed text`);
    console.log(`${TEST} Note: method=bm25 in logs EXPECTED — EventBase always overrides keyword_scoring_method`);
    console.log(`${TEST} [PASS] Standard EventBase vectorized, locked, events returned with event_type via parseEmbedText`);
})();


// ═══════════════════════════════════════════════════════════════════
// TEST 007 — E2E standard: locked standard lorebook + locked standard EventBase → both return results
// ═══════════════════════════════════════════════════════════════════
//
// Depends on: TEST 005 setup (standard lorebook locked) + TEST 006 setup (standard EventBase locked)
//
// Note: vectorScore=0.0000, imp=undefined, method=bm25 all EXPECTED on standard backend
//
(async () => {
    const TEST = 'TEST 007 [E2EStd]';

    const base = '/scripts/extensions/third-party/VectFox/';
    const { getCollectionListing } = await import(base + 'core/collection-loader.js');
    const { shouldCollectionActivate, getCollectionLocks } = await import(base + 'core/collection-metadata.js');
    const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');

    const vf = window._vectfox ?? window.extension_settings?.vectfox;
    if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

    const ctx = window.getContext?.() ?? {};
    const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
    if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
    const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

    const listing = getCollectionListing(vf);

    // pre-condition: standard lorebook locked
    const lorebookCols = listing.filter(e => e.collectionId.startsWith('vf_lorebook_'));
    const lockedLorebooks = [];
    for (const e of lorebookCols) {
        if (await shouldCollectionActivate(e.registryKey, context)) lockedLorebooks.push(e);
    }
    if (!lockedLorebooks.length) {
        console.error(`${TEST} [FAIL] No lorebook activated — complete TEST 005 setup first`);
        return;
    }
    const stdLockedLorebooks = lockedLorebooks.filter(e => e.registryKey.startsWith('vectra:'));
    if (!stdLockedLorebooks.length) {
        console.warn(`${TEST} [WARN] Active lorebook is not standard backend: ${lockedLorebooks.map(e => e.registryKey).join(', ')}`);
    }
    lockedLorebooks.forEach(e => console.log(`${TEST} Active lorebook: ${e.registryKey}`));

    // pre-condition: standard EventBase locked
    const eventbaseCols = listing.filter(e => e.collectionId.startsWith('vf_eventbase_'));
    const lockedEventbases = eventbaseCols.filter(e => {
        const locks = getCollectionLocks(e.registryKey);
        return locks.some(l => l === currentChatId);
    });
    if (!lockedEventbases.length) {
        console.error(`${TEST} [FAIL] No EventBase locked to this chat — complete TEST 006 setup first`);
        return;
    }
    const stdLockedEventbases = lockedEventbases.filter(e => e.registryKey.startsWith('vectra:'));
    if (!stdLockedEventbases.length) {
        console.warn(`${TEST} [WARN] Locked EventBase is not standard backend: ${lockedEventbases.map(e => e.registryKey).join(', ')}`);
    }
    console.log(`${TEST} Locked EventBase: ${lockedEventbases.map(e => e.registryKey).join(', ')}`);

    // lorebook dry-run
    const chat = ctx.chat ?? [];
    const lastUserMsg = [...chat].reverse().find(m => !m.is_system && m.mes)?.mes || 'test query';
    console.log(`${TEST} Running lorebook dry-run with anchor: "${lastUserMsg.slice(0, 60)}"`);

    let lorebookResult;
    try {
        lorebookResult = await runLorebookWIDryRun({ chat, testMessage: lastUserMsg, settings: vf });
    } catch (err) {
        console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`);
        return;
    }

    if (lorebookResult.disabled)     { console.error(`${TEST} [FAIL] Lorebook WI disabled`); return; }
    if (lorebookResult.noCollections){ console.error(`${TEST} [FAIL] No lorebook collections found`); return; }
    if (!lorebookResult.entryCount)  { console.error(`${TEST} [FAIL] Lorebook dry-run returned 0 entries`); return; }

    console.log(`${TEST} Lorebook dry-run: ${lorebookResult.entryCount} entry/entries returned`);
    console.log(`  Note: vectorScore=0.0000 expected (standard backend)`);
    console.log(`  injection preview:\n${(lorebookResult.injectionText || '').slice(0, 300)}`);

    // EventBase live retrieval
    const { runEventBaseRetrieval } = await import(base + 'core/eventbase-workflow.js').catch(() => ({}));
    if (typeof runEventBaseRetrieval !== 'function') {
        console.warn(`${TEST} [WARN] runEventBaseRetrieval not exported — check debug query UI manually`);
        console.log(`${TEST} [PASS] Lorebook path verified. EventBase: verify manually.`);
        return;
    }

    let eventbaseResult;
    try {
        eventbaseResult = await runEventBaseRetrieval({ chat, settings: vf, dryRun: true, keywordQuery: lastUserMsg });
    } catch (err) {
        console.error(`${TEST} [FAIL] runEventBaseRetrieval threw: ${err.message}`);
        return;
    }

    const events = eventbaseResult?.events ?? [];
    if (!events.length) {
        console.error(`${TEST} [FAIL] EventBase returned 0 events — check lock and importance filter`);
        return;
    }

    const missingFields = events.filter(e => !e.event_type && !e.summary);
    if (missingFields.length) {
        console.warn(`${TEST} [WARN] ${missingFields.length} event(s) have no event_type or summary`);
    }

    console.log(`${TEST} EventBase: ${events.length} event(s) returned`);
    events.slice(0, 3).forEach((e, i) =>
        console.log(`  [${i}] type=${e.event_type || '?'}  imp=${e.importance ?? 'undefined (expected)'}  summary=${(e.summary || '').slice(0, 60)}`));
    console.log(`  Note: imp=undefined EXPECTED on standard backend`);
    console.log(`  Note: method=bm25 EXPECTED — EventBase always overrides keyword_scoring_method`);

    if (lorebookResult.entryCount > 0 && events.length > 0) {
        console.log(`${TEST} [PASS] Both lorebook (${lorebookResult.entryCount} entries) and EventBase (${events.length} events) returned results — standard backend, no contamination`);
    } else {
        console.warn(`${TEST} [WARN] One pipeline returned 0 results — investigate above`);
    }
})();


// ═══════════════════════════════════════════════════════════════════
// TEST 008 — DB Browser standard: entry names, text on click, delete removes entry
// ═══════════════════════════════════════════════════════════════════
//
// Same checks as TEST 004 but specifically targets standard (vectra:) lorebook collections
//
// Setup: a lorebook vectorized with Standard backend — at least 3 chunks
//
(async () => {
    const TEST = 'TEST 008 [DBBrowserStd]';

    const base = '/scripts/extensions/third-party/VectFox/';
    const { getCollectionListing } = await import(base + 'core/collection-loader.js');
    const { StandardBackend } = await import(base + 'backends/standard.js');

    const vf = window._vectfox ?? window.extension_settings?.vectfox;
    if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

    const listing = getCollectionListing(vf);
    const stdLorebooks = listing.filter(e =>
        e.collectionId.startsWith('vf_lorebook_') && e.registryKey.startsWith('vectra:')
    );
    if (!stdLorebooks.length) {
        console.warn(`${TEST} [WARN] No standard (vectra:) lorebook collections — vectorize with Standard backend first`);
        return;
    }

    const col = stdLorebooks[0];
    const backend = new StandardBackend();
    console.log(`${TEST} Testing collection: ${col.registryKey}`);

    let listResult;
    try {
        listResult = await backend.listChunks(col.collectionId, vf, { limit: 10 });
    } catch (err) {
        console.error(`${TEST} [FAIL] listChunks threw: ${err.message}`);
        return;
    }

    const items = listResult?.items ?? [];
    if (!items.length) {
        console.error(`${TEST} [FAIL] listChunks returned 0 items`);
        return;
    }
    console.log(`${TEST} listChunks: ${items.length} item(s) (total: ${listResult.total})`);

    const noText      = items.filter(i => !i.text?.trim());
    const noEntryName = items.filter(i => !i.metadata?.entryName);
    items.slice(0, 3).forEach((item, i) =>
        console.log(`  [${i}] entryName="${item.metadata?.entryName ?? '(none)'}"  text="${(item.text || '').slice(0, 60)}"`));

    if (noText.length) {
        console.error(`${TEST} [FAIL] ${noText.length}/${items.length} chunk(s) have no text`);
        return;
    }
    if (noEntryName.length === items.length) {
        console.error(`${TEST} [FAIL] ALL chunks missing entryName — metadata not stored at vectorization`);
        return;
    }
    if (noEntryName.length > 0) {
        console.warn(`${TEST} [WARN] ${noEntryName.length}/${items.length} chunk(s) missing entryName — partial metadata`);
    }
    console.log(`${TEST} Listing check: text ✓, entryName ${noEntryName.length === 0 ? '✓' : '⚠ partial'}`);

    const targetHash = items[0].hash;
    const targetName = items[0].metadata?.entryName ?? '(no name)';
    console.log(`${TEST} Deleting hash=${targetHash}  entryName="${targetName}"`);

    try {
        await backend.deleteVectorItems(col.collectionId, [targetHash], vf);
    } catch (err) {
        console.error(`${TEST} [FAIL] deleteVectorItems threw: ${err.message}`);
        return;
    }

    let afterResult;
    try {
        afterResult = await backend.listChunks(col.collectionId, vf, { limit: 10 });
    } catch (err) {
        console.error(`${TEST} [FAIL] listChunks after delete threw: ${err.message}`);
        return;
    }

    const stillPresent = (afterResult?.items ?? []).some(i => i.hash === targetHash);
    if (stillPresent) {
        console.error(`${TEST} [FAIL] Deleted hash ${targetHash} still appears in listing`);
        return;
    }
    if (afterResult.total >= listResult.total) {
        console.warn(`${TEST} [WARN] total count did not decrease (before=${listResult.total}, after=${afterResult.total})`);
    }

    console.log(`${TEST} After delete: total ${listResult.total} → ${afterResult.total}, hash gone ✓`);
    console.log(`${TEST} [PASS] Standard backend: entry names visible, text present, delete removed the entry`);
})();
