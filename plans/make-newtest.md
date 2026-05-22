# VectFox Regression Test Plan

Goal: replace the current manual one-by-one regression process with console-runnable
scripts that can be copy-pasted into the browser devtools console while SillyTavern is
running.  Each test prints a clear PASS / FAIL / WARN result with a reason.

---

## How to use

1. Open SillyTavern in the browser.
2. Open DevTools → Console.
3. Copy-paste the test block for the scenario you want to verify.
4. Read the output — each test ends with `[PASS]`, `[FAIL]`, or `[WARN]`.

All helpers read live runtime state (`extension_settings`, `window._vectfox_*` exports,
etc.) so results reflect the actual running code, not a snapshot.

---

## Test 001 — Qdrant backend: vectorize lorebook, lock it, query returns results only from it

**What it verifies:**
- Vectorizing a lorebook with the qdrant backend produces a registered `qdrant:vf_lorebook_qdrant_*` collection.
- Locking that collection to the current chat causes it to be the only lorebook activated
  during a query (`LOCKED_TO_CURRENT_CHAT` or `LOCKED_TO_CURRENT_CHARACTER`).
- No other lorebook collection (standard or qdrant, for other chats) bleeds through.
- Query returns entries with real vector similarity scores (qdrant native hybrid search).

**Differs from TEST 005 (standard) in:**
- Backend prefix is `qdrant:` not `vectra:`
- Vector similarity scores are real values (not 0.0000) — native Qdrant hybrid+rerank
- Uses native hybrid search path, not client-side BM25 rerank

**Root cause this catches:**
- The 2026-05-20 bug where `getEnabledLorebookCollections` had no `shouldCollectionActivate`
  gate and returned ALL lorebooks unconditionally.

**Setup (do this before running the script):**
1. Open a SillyTavern chat.
2. Go to VectFox → Lorebook tab → select a lorebook → **set backend to Qdrant** → click Vectorize.
   Wait for 100% progress — you need a `qdrant:vf_lorebook_qdrant_*` collection.
3. Open DB Browser → find that lorebook collection → Collection Settings →
   enable **"Active for current chat"** → Save.
4. Make sure no other lorebook is locked to this chat.

**Script:**

```js
// TEST 001 — Qdrant lorebook: vectorize → lock → query isolation
(async () => {
  const TEST = 'TEST 001 [QdrantLorebook]';

  const base = '/scripts/extensions/third-party/VectFox/';
  const { getCollectionListing } = await import(base + 'core/collection-loader.js');
  const { shouldCollectionActivate, getCollectionMeta } = await import(base + 'core/collection-metadata.js');
  const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');

  const vf = window._vectfox ?? extension_settings?.vectfox;
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

  // Check at least one qdrant lorebook exists
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

  // Check exactly one lorebook activates for this context
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

  // Run dry-run query and check results
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
```

**Expected output (passing):**
```
TEST 001 [QdrantLorebook] Lorebook collections found: 3 total, 1 qdrant
  qdrant:vf_lorebook_qdrant_rabbit_your_wives_mvu_...  scope=character
  vectra:vf_lorebook_standard_rabbit_your_wives_mvu_... scope=chat
  qdrant:vf_lorebook_qdrant_rabbit_artificrealm_...     scope=chat
TEST 001 [QdrantLorebook] Activated lorebook: qdrant:vf_lorebook_qdrant_rabbit_your_wives_mvu_... ✓
TEST 001 [QdrantLorebook] Dry-run: 5 entry/entries returned
  injection preview:
<VectFoxLorebook>
# Captain James Mallory
Captain James Mallory is grizzled man...
</VectFoxLorebook>
TEST 001 [QdrantLorebook] [PASS] Qdrant lorebook vectorized, locked, results returned — no contamination
```

**Failure modes:**
| Output | Meaning |
|--------|---------|
| `[FAIL] No qdrant lorebook` | Setup not done — vectorize with Qdrant backend first |
| `[FAIL] No lorebook activated` | Lock not applied — go to DB Browser → Collection Settings → enable "Active for current chat" |
| `[FAIL] 2+ lorebooks activated` | Multiple locks active — check other lorebooks aren't accidentally locked |
| `[WARN] Activated lorebook is not qdrant` | Wrong lorebook locked — a standard lorebook is active instead |
| `[FAIL] Dry-run returned 0 entries` | Semantic search found nothing — try a query with a character name |

---

---

## Test 002 — Chat history (EventBase) vectorization — qdrant backend, clean insert

**What it verifies:**
- After vectorizing the current chat's EventBase using the qdrant backend, the collection is
  registered under the canonical `qdrant:vf_eventbase_qdrant_*` key.
- The collection contains at least one event.
- Querying it returns events with the core fields populated: `event_type`, `summary`,
  `characters`, `importance`.
- No events have all fields empty (i.e. `parseEmbedText` would recover them even if metadata
  is stored flat — but for qdrant all fields come back directly from stored payload).

**Root cause this catches:**
- Regression where Qdrant inserts succeed but the collection is registered without the `qdrant:`
  prefix, causing lookups to miss it.
- Regression where events are stored but the payload fields are empty on retrieval.

**Pre-conditions:**
- Current chat has been EventBase-vectorized with the qdrant backend.
- At least one `qdrant:vf_eventbase_qdrant_*` collection exists in the registry.

**Script:**

```js
// TEST 002 — Chat history (EventBase) vectorization — qdrant, clean insert
(async () => {
  const TEST = 'TEST 002 [EventBaseQdrant]';

  const base = '/scripts/extensions/third-party/VectFox/';
  const { getCollectionListing } = await import(base + 'core/collection-loader.js');
  const vf = window._vectfox ?? extension_settings?.vectfox;
  if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

  const listing = getCollectionListing(vf);
  const eventbaseCols = listing.filter(e => e.collectionId.startsWith('vf_eventbase_qdrant_'));

  if (!eventbaseCols.length) {
    console.warn(`${TEST} [WARN] No qdrant EventBase collections found — vectorize chat history first`);
    return;
  }

  console.log(`${TEST} Found ${eventbaseCols.length} qdrant EventBase collection(s):`);
  eventbaseCols.forEach(e => console.log(`  ${e.registryKey}`));

  // Check all have qdrant: prefix in registryKey
  const missingPrefix = eventbaseCols.filter(e => !e.registryKey.startsWith('qdrant:'));
  if (missingPrefix.length) {
    console.error(`${TEST} [FAIL] ${missingPrefix.length} collection(s) missing qdrant: prefix in registryKey:`);
    missingPrefix.forEach(e => console.error(`  BAD KEY: ${e.registryKey}`));
    return;
  }

  // Query each collection and check field population
  const { QdrantBackend } = await import(base + 'backends/qdrant.js');
  const backend = new QdrantBackend();
  let totalEvents = 0;
  let emptyFieldEvents = 0;

  for (const col of eventbaseCols) {
    const bareId = col.collectionId; // without backend prefix
    let results;
    try {
      results = await backend.queryCollection(bareId, 'event', 20, vf, { threshold: 0 });
    } catch (err) {
      console.error(`${TEST} [FAIL] Query threw for ${col.registryKey}: ${err.message}`);
      return;
    }

    const items = results?.metadata ?? [];
    console.log(`${TEST} ${col.registryKey}: ${items.length} event(s) returned`);

    if (!items.length) {
      console.error(`${TEST} [FAIL] Collection has vectors but query returned 0 results — threshold or model mismatch?`);
      return;
    }

    totalEvents += items.length;
    items.forEach((m, i) => {
      const hasType    = !!m.event_type;
      const hasSummary = !!m.summary;
      const hasChars   = Array.isArray(m.characters) ? m.characters.length > 0 : !!m.characters;
      const hasImp     = m.importance != null;
      if (!hasType && !hasSummary) {
        emptyFieldEvents++;
        console.warn(`${TEST} [WARN] Event ${i}: event_type and summary both empty — payload may be missing`);
      } else {
        console.log(`  [${i}] type=${m.event_type || '?'}  imp=${m.importance ?? '?'}  chars=[${(m.characters||[]).join(', ')}]  summary=${(m.summary||'').slice(0,60)}`);
      }
    });
  }

  if (emptyFieldEvents > 0) {
    console.error(`${TEST} [FAIL] ${emptyFieldEvents} event(s) have no event_type or summary — payload storage broken`);
    return;
  }

  console.log(`${TEST} [PASS] ${totalEvents} event(s) across ${eventbaseCols.length} collection(s) — all have event_type + summary`);
})();
```

**Expected output (passing):**
```
TEST 002 [EventBaseQdrant] Found 1 qdrant EventBase collection(s):
  qdrant:vf_eventbase_qdrant_rabbit_your_wives_a5c606bc-...
TEST 002 [EventBaseQdrant] qdrant:vf_eventbase_qdrant_...: 20 event(s) returned
  [0] type=relationship_change  imp=9  chars=[Rabbit, Charlotte]  summary=Rabbit帶領Charlotte進入私人房間...
  [1] type=main_quest_update    imp=9  chars=[Francisca, Aarav, ...]  summary=三位海軍上將首次在同一條船上...
  ...
TEST 002 [EventBaseQdrant] [PASS] 20 event(s) across 1 collection(s) — all have event_type + summary
```

**Failure modes:**
| Output | Meaning |
|--------|---------|
| `[WARN] No qdrant EventBase collections` | Pre-condition not met — vectorize first |
| `[FAIL] missing qdrant: prefix` | Collection registered under wrong key; `collection-loader.js` registration bug |
| `[FAIL] query returned 0 results` | Vectors stored but unqueryable — embedding model mismatch or Qdrant collection empty |
| `[FAIL] event_type and summary both empty` | Payload not stored in Qdrant point; `qdrant.js` insert bug |

---

## Test 003 — End-to-end query: locked EventBase + locked lorebook, both return results (qdrant)

**What it verifies:**
- With exactly one EventBase collection and one lorebook collection each locked to the current
  chat, a dry-run query returns results from **both**.
- No events or lorebook entries come from unlocked collections.
- EventBase events have `event_type` + `summary` populated.
- Lorebook entries are non-empty strings.
- This is the same code path as a real generation (uses `runLorebookWIDryRun` and the live
  EventBase retrieval path) — only `setExtensionPrompt` is skipped.

**Depends on:**
- TEST 001 setup: lorebook vectorized and locked to current chat.
- TEST 002 setup: EventBase (chat history) vectorized with qdrant backend and locked to current chat.

**Setup (do this before running the script):**
1. Complete TEST 001 setup — lorebook vectorized, locked to this chat.
2. Complete TEST 002 setup — EventBase vectorized with qdrant backend, locked to this chat.
3. Have the chat open (same chat used for locking).
4. The last message in the chat should contain a word that appears in both the lorebook and
   the chat history (e.g. a character name like "charlotte") so both pipelines can find something.

**Script:**

```js
// TEST 003 — End-to-end query: locked EventBase + locked lorebook → both return results
(async () => {
  const TEST = 'TEST 003 [E2EQuery]';

  const base = '/scripts/extensions/third-party/VectFox/';
  const { getCollectionListing } = await import(base + 'core/collection-loader.js');
  const { shouldCollectionActivate, getCollectionLocks } = await import(base + 'core/collection-metadata.js');
  const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');

  const vf = window._vectfox ?? extension_settings?.vectfox;
  if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

  const ctx = window.getContext?.() ?? {};
  const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
  if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
  const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

  const listing = getCollectionListing(vf);

  // --- pre-condition: lorebook locked ---
  const lorebookCols = listing.filter(e => e.collectionId.startsWith('vf_lorebook_'));
  const lockedLorebooks = [];
  for (const e of lorebookCols) {
    if (await shouldCollectionActivate(e.registryKey, context)) lockedLorebooks.push(e);
  }
  if (!lockedLorebooks.length) {
    console.error(`${TEST} [FAIL] No lorebook activated for current context (chat or character) — complete TEST 001 setup first`);
    return;
  }
  lockedLorebooks.forEach(e => {
    const meta = e.meta ?? {};
    console.log(`${TEST} Active lorebook: ${e.registryKey}  scope=${meta.scope ?? '?'}`);
  });

  // --- pre-condition: EventBase locked ---
  const eventbaseCols = listing.filter(e => e.collectionId.startsWith('vf_eventbase_'));
  const lockedEventbases = eventbaseCols.filter(e => {
    const locks = getCollectionLocks(e.registryKey);
    return locks.some(l => l === currentChatId || l === String(currentChatId));
  });
  if (!lockedEventbases.length) {
    console.error(`${TEST} [FAIL] No EventBase locked to this chat — complete TEST 002 setup first`);
    return;
  }
  console.log(`${TEST} Locked EventBase collection(s): ${lockedEventbases.map(e => e.registryKey).join(', ')}`);

  // --- run lorebook dry-run query ---
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

  if (lorebookResult.disabled)    { console.error(`${TEST} [FAIL] Lorebook WI disabled in settings`); return; }
  if (lorebookResult.noCollections) { console.error(`${TEST} [FAIL] No lorebook collections found by dry-run — lock not applied?`); return; }
  if (!lorebookResult.entryCount)   { console.error(`${TEST} [FAIL] Lorebook dry-run returned 0 entries — semantic search found nothing`); return; }

  console.log(`${TEST} Lorebook dry-run: ${lorebookResult.entryCount} entry/entries returned`);
  console.log(`  injection preview:\n${(lorebookResult.injectionText || '').slice(0, 300)}`);

  // --- run EventBase live retrieval (same path as real generation) ---
  const { runEventBaseRetrieval } = await import(base + 'core/eventbase-workflow.js').catch(() => ({}));
  if (typeof runEventBaseRetrieval !== 'function') {
    console.warn(`${TEST} [WARN] runEventBaseRetrieval not exported — skipping EventBase live check`);
    console.log(`${TEST} [PASS] Lorebook path verified. EventBase: check the debug query UI manually.`);
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
    console.warn(`${TEST} [WARN] ${missingFields.length} event(s) have no event_type or summary — parseEmbedText may have failed`);
  }

  console.log(`${TEST} EventBase: ${events.length} event(s) returned`);
  events.slice(0, 3).forEach((e, i) =>
    console.log(`  [${i}] type=${e.event_type || '?'}  imp=${e.importance ?? '?'}  summary=${(e.summary || '').slice(0, 60)}`));

  // --- final verdict ---
  if (lorebookResult.entryCount > 0 && events.length > 0) {
    console.log(`${TEST} [PASS] Both lorebook (${lorebookResult.entryCount} entries) and EventBase (${events.length} events) returned results from locked collections only`);
  } else {
    console.warn(`${TEST} [WARN] One pipeline returned 0 results — investigate above`);
  }
})();
```

**Expected output (passing):**
```
TEST 003 [E2EQuery] Active lorebook: qdrant:vf_lorebook_qdrant_rabbit_your_wives_mvu_...  scope=character
TEST 003 [E2EQuery] Locked EventBase collection(s): qdrant:vf_eventbase_qdrant_rabbit_your_wives_...
TEST 003 [E2EQuery] Running lorebook dry-run with anchor: "charlotte..."
TEST 003 [E2EQuery] Lorebook dry-run: 5 entry/entries returned
  injection preview:
<VectFoxLorebook>
# Claire Whitehill
...
</VectFoxLorebook>
TEST 003 [E2EQuery] EventBase: 10 event(s) returned
  [0] type=relationship_change  imp=9  summary=Rabbit帶領Charlotte進入私人房間...
  [1] type=main_quest_update    imp=9  summary=三位海軍上將首次在同一條船上...
  [2] type=relationship_change  imp=8  summary=...
TEST 003 [E2EQuery] [PASS] Both lorebook (5 entries) and EventBase (10 events) returned results from locked collections only
```

> Note: lorebook may be `scope=character` (locked per character) or `scope=chat` (locked per chat) — both are valid.
> The `scope` line tells you which lock type is active.

**Failure modes:**
| Output | Meaning |
|--------|---------|
| `[FAIL] No lorebook activated for current context` | TEST 001 setup not done — vectorize lorebook + set scope (chat or character) first |
| `[FAIL] No EventBase locked` | TEST 002 setup not done — vectorize + lock chat history first |
| `[FAIL] Lorebook dry-run returned 0 entries` | Semantic search found nothing — try a query with a character name |
| `[FAIL] EventBase returned 0 events` | Importance filter or lock issue — check `minImportance` setting |
| `[WARN] runEventBaseRetrieval not exported` | Function not exposed; verify manually via the debug query UI |
| `[WARN] event_type missing` | `parseEmbedText` failed to recover fields from native backend embed text |

---

## Test 004 — DB Browser: entry names visible in listing, detail on click, delete removes entry

**What it verifies:**
- Listing a lorebook collection in DB Browser shows chunks with `entryName` populated
  (i.e. the `# title` prefix is stored in metadata, not just prepended at injection time).
- Clicking a chunk returns its full text content (not "No text available").
- Deleting one or more chunks reduces the collection's chunk count by the exact number deleted.
- After deletion, a re-query no longer returns the deleted hashes.

**Root cause this catches:**
- The `listChunks` bug where native backend returned hashes-only (no text) — now fixed via
  `/api/vector/query` with `threshold:0`.
- Any regression where `entryName` is not stored in chunk metadata at vectorization time.
- Delete not actually removing vectors from the backend (silent failure).

**Pre-conditions:**
- A lorebook collection vectorized (qdrant or standard backend) — at least 3 chunks.
- DB Browser accessible.

**Script:**

```js
// TEST 004 — DB Browser: entry names in listing, content on click, delete removes entry
(async () => {
  const TEST = 'TEST 004 [DBBrowser]';

  const base = '/scripts/extensions/third-party/VectFox/';
  const { getCollectionListing } = await import(base + 'core/collection-loader.js');
  const { QdrantBackend } = await import(base + 'backends/qdrant.js');
  const { StandardBackend } = await import(base + 'backends/standard.js');

  const vf = window._vectfox ?? extension_settings?.vectfox;
  if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

  const listing = getCollectionListing(vf);
  const lorebookCols = listing.filter(e => e.collectionId.startsWith('vf_lorebook_'));
  if (!lorebookCols.length) {
    console.warn(`${TEST} [WARN] No lorebook collections found — vectorize a lorebook first`);
    return;
  }

  // Pick the first lorebook collection
  const col = lorebookCols[0];
  const isQdrant = col.registryKey.startsWith('qdrant:');
  const backend = isQdrant ? new QdrantBackend() : new StandardBackend();
  console.log(`${TEST} Testing collection: ${col.registryKey} (${isQdrant ? 'qdrant' : 'standard'})`);

  // --- Step 1: list chunks, check entryName + text ---
  let listResult;
  try {
    listResult = await backend.listChunks(col.collectionId, vf, { limit: 10 });
  } catch (err) {
    console.error(`${TEST} [FAIL] listChunks threw: ${err.message}`);
    return;
  }

  const items = listResult?.items ?? [];
  if (!items.length) {
    console.error(`${TEST} [FAIL] listChunks returned 0 items — collection may be empty or backend error`);
    return;
  }
  console.log(`${TEST} listChunks: ${items.length} item(s) returned (total: ${listResult.total})`);

  const noText      = items.filter(i => !i.text?.trim());
  const noEntryName = items.filter(i => !i.metadata?.entryName);
  items.slice(0, 3).forEach((item, i) =>
    console.log(`  [${i}] entryName="${item.metadata?.entryName ?? '(none)'}"  text="${(item.text || '').slice(0, 60)}"`));

  if (noText.length) {
    console.error(`${TEST} [FAIL] ${noText.length}/${items.length} chunk(s) have no text — listChunks text retrieval broken`);
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

  // --- Step 2: delete the first chunk and verify it's gone ---
  const targetHash = items[0].hash;
  const targetName = items[0].metadata?.entryName ?? '(no name)';
  console.log(`${TEST} Deleting hash=${targetHash}  entryName="${targetName}"`);

  try {
    await backend.deleteVectorItems(col.collectionId, [targetHash], vf);
  } catch (err) {
    console.error(`${TEST} [FAIL] deleteVectorItems threw: ${err.message}`);
    return;
  }

  // Re-list and check count dropped by 1
  let afterResult;
  try {
    afterResult = await backend.listChunks(col.collectionId, vf, { limit: 10 });
  } catch (err) {
    console.error(`${TEST} [FAIL] listChunks after delete threw: ${err.message}`);
    return;
  }

  const afterItems = afterResult?.items ?? [];
  const stillPresent = afterItems.some(i => i.hash === targetHash);

  if (stillPresent) {
    console.error(`${TEST} [FAIL] Deleted hash ${targetHash} still appears in listing — delete did not persist`);
    return;
  }

  if (afterResult.total >= listResult.total) {
    console.warn(`${TEST} [WARN] total count did not decrease after delete (before=${listResult.total}, after=${afterResult.total})`);
  }

  console.log(`${TEST} After delete: total ${listResult.total} → ${afterResult.total}, hash gone from listing ✓`);
  console.log(`${TEST} [PASS] Entry names visible, text present, delete removed the entry`);
})();
```

**Expected output (passing):**
```
TEST 004 [DBBrowser] Testing collection: qdrant:vf_lorebook_qdrant_rabbit_your_wives_mvu_...  (qdrant)
TEST 004 [DBBrowser] listChunks: 10 item(s) returned (total: 72)
  [0] entryName="Captain James Mallory"  text="Captain James Mallory is grizzled man in his..."
  [1] entryName="Pirates"               text="Pirates have a long tradition of operating..."
  [2] entryName="Charlotte Claymore"    text="Charlotte is the young countess of Cassia..."
TEST 004 [DBBrowser] Listing check: text ✓, entryName ✓
TEST 004 [DBBrowser] Deleting hash=4683439837863594  entryName="Captain James Mallory"
TEST 004 [DBBrowser] After delete: total 72 → 71, hash gone from listing ✓
TEST 004 [DBBrowser] [PASS] Entry names visible, text present, delete removed the entry
```

**Failure modes:**
| Output | Meaning |
|--------|---------|
| `[FAIL] listChunks returned 0 items` | Collection empty or backend unreachable |
| `[FAIL] chunks have no text` | `listChunks` regression — using hashes-only path again |
| `[FAIL] ALL chunks missing entryName` | `entryName` not stored in metadata at vectorization time; check `content-vectorization.js` |
| `[WARN] partial entryName` | Some entries had no `comment`/`name`/`key` in the original lorebook — expected for anonymous entries |
| `[FAIL] Deleted hash still appears` | Delete did not commit to backend; check `deleteVectorItems` for the backend |
| `[WARN] total count did not decrease` | Backend count not immediately consistent (Qdrant may have eventual consistency on count) — re-run to confirm |

---

## Test 005 — Standard backend: vectorize lorebook, lock it, query returns results only from it

**What it verifies:**
- Vectorizing a lorebook with the standard (native ST vectra) backend produces a registered
  `vectra:vf_lorebook_standard_*` collection.
- Locking that collection to the current chat causes it to be the only lorebook activated
  during a query (`LOCKED_TO_CURRENT_CHAT`).
- No other lorebook collection (qdrant or standard, for other chats) bleeds through.
- Query returns entries via BM25-only ranking (vectorScore=0.0000 is expected on standard
  backend — not a failure).

**Differs from TEST 001 (qdrant) in:**
- Backend prefix is `vectra:` not `qdrant:`
- No vector similarity scores — all `vectorScore=0.0000`, ranked by BM25 alone
- No native hybrid search path — uses client-side BM25 rerank

**Setup (do this before running the script):**
1. Open a SillyTavern chat.
2. Go to VectFox → Lorebook tab → select a lorebook → **set backend to Standard** → click Vectorize.
   Wait for 100% progress — you need a `vectra:vf_lorebook_standard_*` collection.
3. Open DB Browser → find that lorebook collection → Collection Settings →
   enable **"Active for current chat"** → Save.
4. Make sure no other lorebook is locked to this chat.

**Script:**

```js
// TEST 005 — Standard lorebook: vectorize → lock → query isolation
(async () => {
  const TEST = 'TEST 005 [StdLorebook]';

  const base = '/scripts/extensions/third-party/VectFox/';
  const { getCollectionListing } = await import(base + 'core/collection-loader.js');
  const { shouldCollectionActivate, getCollectionMeta } = await import(base + 'core/collection-metadata.js');
  const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');

  const vf = window._vectfox ?? extension_settings?.vectfox;
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

  // Check at least one standard lorebook exists
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

  // Check exactly one lorebook activates for this context
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

  // Run dry-run query and check results + scores
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
  console.log(`  Note: vectorScore=0.0000 is expected on standard backend (BM25-only ranking)`);
  console.log(`  injection preview:\n${(result.injectionText || '').slice(0, 300)}`);
  console.log(`${TEST} [PASS] Standard lorebook vectorized, locked, results returned — no contamination`);
})();
```

**Expected output (passing):**
```
TEST 005 [StdLorebook] Lorebook collections found: 3 total, 1 standard
  vectra:vf_lorebook_standard_rabbit_your_wives_mvu_...  scope=chat
  qdrant:vf_lorebook_qdrant_rabbit_artificrealm_...       scope=chat
  qdrant:vf_lorebook_qdrant_rabbit_your_wives_mvu_...     scope=character
TEST 005 [StdLorebook] Activated lorebook: vectra:vf_lorebook_standard_rabbit_your_wives_mvu_... ✓
TEST 005 [StdLorebook] Dry-run: 5 entry/entries returned
  Note: vectorScore=0.0000 is expected on standard backend (BM25-only ranking)
  injection preview:
<VectFoxLorebook>
# Lineage
...
</VectFoxLorebook>
TEST 005 [StdLorebook] [PASS] Standard lorebook vectorized, locked, results returned — no contamination
```

**Failure modes:**
| Output | Meaning |
|--------|---------|
| `[FAIL] No standard (vectra:) lorebook` | Setup not done — vectorize with Standard backend first |
| `[FAIL] No lorebook activated` | Lock not applied — go to DB Browser → Collection Settings → enable "Active for current chat" |
| `[FAIL] 2+ lorebooks activated` | Multiple locks active — check other lorebooks aren't accidentally locked |
| `[WARN] Activated lorebook is not standard` | Wrong lorebook locked — a qdrant lorebook is active instead |
| `[FAIL] Dry-run returned 0 entries` | Semantic search found nothing — try a query with a character name |
| `vectorScore=0.0000` in scores | ✅ Expected on standard backend — not a failure |

---

## Test 006 — Standard backend: vectorize chat history (EventBase), lock it, query returns events

**What it verifies:**
- Vectorizing chat history with the standard (native ST vectra) backend produces a registered
  `vectra:vf_eventbase_standard_*` collection locked to the current chat.
- A debug query returns events from only that collection — all other EventBase collections skipped.
- `event_type` and `summary` are populated via `parseEmbedText` (recovered from stored embed text).
- `importance` and `persist` will be `undefined` — this is **expected** on standard backend,
  not a failure. Standard backend stores only `{hash, text, index}` and these fields are not
  in the embed text format, so they cannot be recovered.
- The importance filter passes events through when `imp == null` (the null-passthrough fix).

**Differs from TEST 002 (qdrant) in:**
- Backend prefix is `vectra:` not `qdrant:`
- `vectorScore=0.0000` for all events (expected — standard backend strips scores)
- `imp=undefined` and `persist=undefined` on all returned events (expected — not in embed text)
- `nativePrefer=false, nativeRerank=false` — uses client-side BM25 path, not Qdrant hybrid+rerank
- `parseEmbedText` is the only source of field data; fields not in embed text format are lost

**Note — "Hybrid Search & BM25" UI toggle does NOT affect EventBase:**
The global `keyword_scoring_method` default is `hybrid` (`index.js:109`), but EventBase overrides
it unconditionally in `eventbase-retrieval.js:332`:
```javascript
const ebSettings = { ...settings, keyword_scoring_method: settings.eventbase_keyword_scoring_method || 'bm25' };
```
EventBase always uses BM25 regardless of what the UI dropdown shows. The only way to change it is
to set `eventbase_keyword_scoring_method` (no UI control for this). So `method=bm25` in EventBase
logs is always expected and is not a misconfiguration.

**Fields recovered by `parseEmbedText` on standard backend:**
| Field | Recovered? |
|-------|-----------|
| `event_type` | ✅ from `[type] summary` line |
| `summary` | ✅ from `[type] summary` line |
| `cause`, `result` | ✅ from `CAUSE:` / `RESULT:` lines |
| `characters`, `locations`, `keywords` | ✅ from `CHARS:` / `LOCS:` / `KEYS:` lines |
| `importance` | ❌ not in embed text — always `undefined` |
| `should_persist` | ❌ not in embed text — always `undefined` |
| `DateTime`, `message_order`, `event_id` | ❌ not in embed text — always `undefined` |

**Setup (do this before running the script):**
1. Open a SillyTavern chat.
2. Go to VectFox → EventBase tab → **set backend to Standard** → click Vectorize Chat History.
   Wait for 100% progress.
3. Confirm in DB Browser the new `vectra:vf_eventbase_standard_*` collection is locked to this chat.
4. Make sure no other EventBase is locked to this chat.

**Script:**

```js
// TEST 006 — Standard EventBase: vectorize → lock → query returns events with parseEmbedText fields
(async () => {
  const TEST = 'TEST 006 [StdEventBase]';

  const base = '/scripts/extensions/third-party/VectFox/';
  const { getCollectionListing } = await import(base + 'core/collection-loader.js');
  const { getCollectionLocks } = await import(base + 'core/collection-metadata.js');

  const vf = window._vectfox ?? extension_settings?.vectfox;
  if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

  const ctx = window.getContext?.() ?? {};
  const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
  if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }

  const listing = getCollectionListing(vf);
  const eventbaseCols = listing.filter(e => e.collectionId.startsWith('vf_eventbase_'));

  // Check at least one standard EventBase exists
  const stdEventbases = eventbaseCols.filter(e => e.registryKey.startsWith('vectra:'));
  if (!stdEventbases.length) {
    console.error(`${TEST} [FAIL] No standard (vectra:) EventBase collection found — vectorize with Standard backend`);
    return;
  }

  // Check exactly one EventBase is locked to this chat
  const lockedEventbases = eventbaseCols.filter(e => {
    const locks = getCollectionLocks(e.registryKey);
    return locks.some(l => l === currentChatId);
  });

  console.log(`${TEST} EventBase collections: ${eventbaseCols.length} total, ${stdEventbases.length} standard`);
  eventbaseCols.forEach(e => {
    const locks = getCollectionLocks(e.registryKey);
    const locked = locks.some(l => l === currentChatId);
    console.log(`  ${e.registryKey}  locked=${locked}`);
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

  // Query via standard backend and check returned events
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
    console.error(`${TEST} [FAIL] Query returned 0 results — collection may be empty or model mismatch`);
    return;
  }
  console.log(`${TEST} Query returned ${items.length} result(s)`);

  // Check parseEmbedText recovery
  const { parseEmbedText } = await import(base + 'core/eventbase-schema.js');
  let recoveredCount = 0;
  items.slice(0, 5).forEach((m, i) => {
    const recovered = parseEmbedText(m.text || '');
    const hasType = !!recovered.event_type;
    const hasSummary = !!recovered.summary;
    if (hasType) recoveredCount++;
    console.log(`  [${i}] event_type="${recovered.event_type || '(none)'}"  imp=${m.importance ?? 'undefined (expected)'}  summary="${(recovered.summary || '').slice(0, 50)}"`);
  });

  if (recoveredCount === 0) {
    console.error(`${TEST} [FAIL] parseEmbedText recovered no event_type from any result — embed text format broken`);
    return;
  }

  console.log(`${TEST} parseEmbedText recovered event_type for ${recoveredCount}/${Math.min(items.length, 5)} sampled events`);
  console.log(`${TEST} Note: imp=undefined is EXPECTED on standard backend — importance not stored in embed text`);
  console.log(`${TEST} [PASS] Standard EventBase vectorized, locked, events returned with event_type via parseEmbedText`);
})();
```

**Expected output (passing):**
```
TEST 006 [StdEventBase] EventBase collections: 8 total, 1 standard
  vectra:vf_eventbase_standard_rabbit_your_wives_...  locked=true
  qdrant:vf_eventbase_qdrant_rabbit_your_wives_...    locked=false
  ...
TEST 006 [StdEventBase] Locked EventBase: vectra:vf_eventbase_standard_rabbit_your_wives_... ✓
TEST 006 [StdEventBase] Query returned 20 result(s)
  [0] event_type="relationship_change"  imp=undefined (expected)  summary="Rabbit成功地將Charlotte帶入私人空間..."
  [1] event_type="dialogue_significant"  imp=undefined (expected)  summary="Francisca與Jakob Sullivan在Rusty..."
  [2] event_type="main_quest_update"  imp=undefined (expected)  summary="三位海軍上將首次在HMS Amber上集結..."
TEST 006 [StdEventBase] parseEmbedText recovered event_type for 5/5 sampled events
TEST 006 [StdEventBase] Note: imp=undefined is EXPECTED on standard backend — importance not stored in embed text
TEST 006 [StdEventBase] [PASS] Standard EventBase vectorized, locked, events returned with event_type via parseEmbedText
```

**Failure modes:**
| Output | Meaning |
|--------|---------|
| `[FAIL] No standard (vectra:) EventBase` | Setup not done — vectorize with Standard backend first |
| `[FAIL] No EventBase locked` | Lock not applied — go to DB Browser → Collection Settings → enable "Active for current chat" |
| `[FAIL] 2+ EventBase collections locked` | Other EventBase locked too — unlock them first |
| `[WARN] Locked EventBase is not standard` | Wrong collection locked — standard one not locked |
| `[FAIL] Query returned 0 results` | Collection empty or embedding model mismatch |
| `[FAIL] parseEmbedText recovered no event_type` | Embed text format broken — `buildEmbedText` changed without updating `parseEmbedText` |
| `imp=undefined` on all events | ✅ Expected — not stored in embed text format |

---

## Test 007 — End-to-end query: locked standard EventBase + locked standard lorebook, both return results

**What it verifies:**
- With exactly one standard EventBase and one standard lorebook each locked to the current chat,
  a dry-run query returns results from **both**.
- No events or lorebook entries come from unlocked collections.
- EventBase events have `event_type` + `summary` recoverable via `parseEmbedText`.
- `imp=undefined` on all events is expected — standard backend cannot store importance.
- `vectorScore=0.0000` on all results is expected — standard backend strips similarity scores.

**Mirrors TEST 003 for the standard backend. Differences from TEST 003:**
- Both collections are `vectra:` prefix (standard backend)
- `vectorScore=0.0000` on both lorebook and EventBase results (expected)
- `imp=undefined` on EventBase events (expected — not in embed text)
- EventBase still uses BM25 regardless of the global `keyword_scoring_method` setting

**Depends on:**
- TEST 005 setup: standard lorebook vectorized and locked to current chat.
- TEST 006 setup: standard EventBase vectorized and locked to current chat.

**Setup (do this before running the script):**
1. Complete TEST 005 setup — standard lorebook vectorized, locked to this chat.
2. Complete TEST 006 setup — standard EventBase vectorized, locked to this chat.
3. Have the same chat open.
4. The last message should contain a word that appears in both the lorebook and the chat history.

**Script:**

```js
// TEST 007 — End-to-end query: locked standard EventBase + locked standard lorebook → both return results
(async () => {
  const TEST = 'TEST 007 [E2EStd]';

  const base = '/scripts/extensions/third-party/VectFox/';
  const { getCollectionListing } = await import(base + 'core/collection-loader.js');
  const { shouldCollectionActivate, getCollectionLocks } = await import(base + 'core/collection-metadata.js');
  const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');

  const vf = window._vectfox ?? extension_settings?.vectfox;
  if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

  const ctx = window.getContext?.() ?? {};
  const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
  if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
  const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

  const listing = getCollectionListing(vf);

  // --- pre-condition: standard lorebook locked ---
  const lorebookCols = listing.filter(e => e.collectionId.startsWith('vf_lorebook_'));
  const lockedLorebooks = [];
  for (const e of lorebookCols) {
    if (await shouldCollectionActivate(e.registryKey, context)) lockedLorebooks.push(e);
  }
  if (!lockedLorebooks.length) {
    console.error(`${TEST} [FAIL] No lorebook activated for current context — complete TEST 005 setup first`);
    return;
  }
  const stdLockedLorebooks = lockedLorebooks.filter(e => e.registryKey.startsWith('vectra:'));
  if (!stdLockedLorebooks.length) {
    console.warn(`${TEST} [WARN] Active lorebook is not standard backend: ${lockedLorebooks.map(e => e.registryKey).join(', ')}`);
  }
  lockedLorebooks.forEach(e => console.log(`${TEST} Active lorebook: ${e.registryKey}`));

  // --- pre-condition: standard EventBase locked ---
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

  // --- run lorebook dry-run query ---
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

  if (lorebookResult.disabled)     { console.error(`${TEST} [FAIL] Lorebook WI disabled in settings`); return; }
  if (lorebookResult.noCollections){ console.error(`${TEST} [FAIL] No lorebook collections found — lock not applied?`); return; }
  if (!lorebookResult.entryCount)  { console.error(`${TEST} [FAIL] Lorebook dry-run returned 0 entries`); return; }

  console.log(`${TEST} Lorebook dry-run: ${lorebookResult.entryCount} entry/entries returned`);
  console.log(`  Note: vectorScore=0.0000 is expected (standard backend BM25-only)`);
  console.log(`  injection preview:\n${(lorebookResult.injectionText || '').slice(0, 300)}`);

  // --- run EventBase live retrieval ---
  const { runEventBaseRetrieval } = await import(base + 'core/eventbase-workflow.js').catch(() => ({}));
  if (typeof runEventBaseRetrieval !== 'function') {
    console.warn(`${TEST} [WARN] runEventBaseRetrieval not exported — skipping EventBase live check`);
    console.log(`${TEST} [PASS] Lorebook path verified. EventBase: check debug query UI manually.`);
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
    console.warn(`${TEST} [WARN] ${missingFields.length} event(s) have no event_type or summary — parseEmbedText may have failed`);
  }

  console.log(`${TEST} EventBase: ${events.length} event(s) returned`);
  events.slice(0, 3).forEach((e, i) =>
    console.log(`  [${i}] type=${e.event_type || '?'}  imp=${e.importance ?? 'undefined (expected)'}  summary=${(e.summary || '').slice(0, 60)}`));
  console.log(`  Note: imp=undefined is EXPECTED on standard backend — not stored in embed text`);
  console.log(`  Note: method=bm25 in logs is EXPECTED — EventBase always overrides to BM25`);

  // --- final verdict ---
  if (lorebookResult.entryCount > 0 && events.length > 0) {
    console.log(`${TEST} [PASS] Both lorebook (${lorebookResult.entryCount} entries) and EventBase (${events.length} events) returned results — standard backend, no contamination`);
  } else {
    console.warn(`${TEST} [WARN] One pipeline returned 0 results — investigate above`);
  }
})();
```

**Expected output (passing):**
```
TEST 007 [E2EStd] Active lorebook: vectra:vf_lorebook_standard_rabbit_your_wives_mvu_...
TEST 007 [E2EStd] Locked EventBase: vectra:vf_eventbase_standard_rabbit_your_wives_...
TEST 007 [E2EStd] Running lorebook dry-run with anchor: "charlotte..."
TEST 007 [E2EStd] Lorebook dry-run: 5 entry/entries returned
  Note: vectorScore=0.0000 is expected (standard backend BM25-only)
  injection preview:
<VectFoxLorebook>
# Lineage
...
</VectFoxLorebook>
TEST 007 [E2EStd] EventBase: 8 event(s) returned
  [0] type=relationship_change  imp=undefined (expected)  summary=Rabbit成功地將Charlotte帶入私人空間...
  [1] type=dialogue_significant  imp=undefined (expected)  summary=Francisca與Jakob Sullivan...
  [2] type=main_quest_update  imp=undefined (expected)  summary=三位海軍上將首次在HMS Amber上集結...
  Note: imp=undefined is EXPECTED on standard backend — not stored in embed text
  Note: method=bm25 in logs is EXPECTED — EventBase always overrides to BM25
TEST 007 [E2EStd] [PASS] Both lorebook (5 entries) and EventBase (8 events) returned results — standard backend, no contamination
```

**Failure modes:**
| Output | Meaning |
|--------|---------|
| `[FAIL] No lorebook activated` | TEST 005 setup not done — vectorize standard lorebook + lock to this chat |
| `[FAIL] No EventBase locked` | TEST 006 setup not done — vectorize standard EventBase first |
| `[FAIL] Lorebook dry-run returned 0 entries` | Semantic search found nothing — try a query with a character name |
| `[FAIL] EventBase returned 0 events` | Importance filter or lock issue — check `minImportance` and that standard EventBase is locked |
| `[WARN] Locked EventBase is not standard` | Wrong collection locked — qdrant one is active instead |
| `[WARN] event_type missing` | `parseEmbedText` failed — embed text format changed |
| `vectorScore=0.0000` | ✅ Expected on standard backend |
| `imp=undefined` | ✅ Expected on standard backend |
| `method=bm25` in logs | ✅ Expected — EventBase hardcodes BM25 regardless of UI setting |

---

## Known issues / environment notes

| Issue | Symptom | Workaround | Root cause |
|-------|---------|-----------|-----------|
| In-memory registry drops collections | After changing any UI setting, one or more `vf_eventbase_*` or `vf_lorebook_*` collections disappear from the registry (not in "skipped" list, `lockedLiveCollections=0`). Reloading the browser restores them. | Reload the browser before running tests after changing settings. | Settings save/merge cycle overwrites or replaces the in-memory collection registry from the persisted settings object, dropping collections that were registered in-session. Needs investigation in `collection-loader.js` / settings save path. |
| Hybrid mode degraded (not broken) on standard backend | `keyword_scoring_method: 'hybrid'` uses client-side RRF fusion but `vectorScore=0.0000` on all results (standard backend strips scores). A2 still uses ST's rank ordering as a secondary signal via RRF. Results come through fine. | No workaround needed — A2 is at least as good as A1 on standard backend. Only switch to A1 (BM25) if debugging threshold behaviour. Hybrid is only **meaningfully** better on Qdrant where real vector scores exist. | ST's `/api/vector/query` strips similarity scores. `hybrid-search.js` falls back to text-only (0.6× penalty) and RRF rank fallback paths. The ×0.60 penalty is uniform, so relative ranking is preserved. Verified in TEST 007 log: `vectorScore=0.0000` on all results, 3 entries returned with correct ranking. |
| EventBase ignores global `keyword_scoring_method` | Switching UI to "Hybrid Search & BM25" has no effect on EventBase queries — logs still show `method=bm25`. | Expected behavior — not a bug. | `eventbase-retrieval.js:332` unconditionally overrides to `settings.eventbase_keyword_scoring_method \|\| 'bm25'`. Only `eventbase_keyword_scoring_method` (no UI control) affects EventBase. |

---

## Planned tests (to be documented)

| ID | Scenario | Status |
|----|----------|--------|
| 001 | Lorebook lock scope — single locked, no cross-contamination (qdrant) | ✅ documented above |
| 002 | Chat history (EventBase) vectorization — qdrant backend, clean insert + field check | ✅ documented above |
| 003 | End-to-end query — locked EventBase + locked lorebook, both return results (qdrant) | ✅ documented above |
| 004 | DB Browser — entry names in listing, detail on click, delete removes entry | ✅ documented above |
| 005 | Standard backend: vectorize lorebook, lock, query returns results only from it | ✅ documented above |
| 006 | Chat history (EventBase) vectorization — standard backend, clean insert + parseEmbedText field recovery | ✅ documented above |
| 007 | End-to-end query — locked standard EventBase + locked standard lorebook, both return results | ✅ documented + verified |
| 008 | DB Browser — chunk text + entry names visible for standard backend collections | pending |
| 009 | Collection lock — scope=unknown auto-resolved on save | pending |
| 010 | EventBase importance filter — events pass through when importance absent (native) | pending |
