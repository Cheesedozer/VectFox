# Dev Helper

## 1) Pipeline Architecture — Strict Path Separation

EventBase is the **exclusive** retrieval path for chat content. The legacy `eventbase_enabled` toggle has been removed — chat history (live and uploaded archive `.jsonl`) is hard-routed through EventBase ingestion + retrieval. Legacy chunking for chat is no longer supported.

### Two pipelines, strict ownership

| Pipeline | Content scope | Owned collections | Code entry point |
|---|---|---|---|
| **EventBase pipeline** | Chat history only (live chat + archive `.jsonl`) | `vecthare_eventbase_*`, `vecthare_archiveevent_*` | `eventbase-workflow.js` → `eventbase-retrieval.js` |
| **Standard (Chunk) pipeline** | Non-chat content only — Lorebook / World Info, Character Cards, URLs / web pages, custom documents, wiki pages, YouTube transcripts | `vecthare_lorebook_*`, `vecthare_document_*`, user collections | `chat-vectorization.js` → `queryAndMergeCollections` |

The two paths never see each other's content. There is no overlap in collection prefixes or content types.

### Key isolation rule (`core/chat-vectorization.js` → `gatherCollectionsToQuery`)

- `vecthare_eventbase_*` → **always** skipped by the standard pipeline (EventBase pipeline owns them exclusively)
- `vecthare_archiveevent_*` → **always** skipped by the standard pipeline (EventBase pipeline owns them exclusively)
- `vecthare_chat_*` → **always** skipped by the standard pipeline (legacy chunk-based chat collections; no longer created since the EventBase toggle was removed, but pre-existing ones are excluded unconditionally)

### Archive Chat History — Two content paths

| Path | Content Type in UI | Collection prefix | Storage format | Retrieval |
|---|---|---|---|---|
| **A — EventBase** | `Chat → Upload` tab | `vecthare_archiveevent_*` | Event-shaped (same schema as live EventBase) | Phase A (EventBase re-ranker) |
| **B — Chunk** | `Document` content type | `vecthare_document_*` | Chunk-shaped | Phase B (standard pipeline) |

Archive event collections are **not** auto-locked to any chat after ingestion. Users must manually check "Active for current chat" on the collection card to activate retrieval for a given chat.

### Why this matters

Before the toggle removal, `vecthare_eventbase_*` collections could be included in the standard pipeline when EventBase was OFF, causing them to be queried twice per generation: once by the EventBase pipeline (structured event retrieval with dedup-depth) and once by the standard pipeline (raw chunk retrieval). The standard pipeline query was always redundant and could inject duplicate content. With the toggle gone, this class of bug is structurally impossible.

---

## 2) Extraction Level Location
Extraction levels are defined in: `core/keyword-boost.js`

Exact export name:
`EXTRACTION_LEVELS`

```javascript
export const EXTRACTION_LEVELS = {
    off: {
        label: 'Off',
        description: 'No auto-extraction, only WI trigger keys',
        enabled: false,
    },
    minimal: {
        label: 'Minimal',
        description: 'First 1500 chars, max 5 keywords',
        enabled: true,
        headerSize: 1500,
        minFrequency: 1,
        maxKeywords: 5,
    },
    balanced: {
        label: 'Balanced',
        description: 'First 5000 chars, max 12 keywords',
        enabled: true,
        headerSize: 5000,
        minFrequency: 1,
        maxKeywords: 12,
    },
    aggressive: {
        label: 'Aggressive',
        description: 'Full text scan, max 15 keywords',
        enabled: true,
        headerSize: null, // null = full text
        minFrequency: 1,
        maxKeywords: 15,
    },
};
```

## 3) Default Summarizer Token/Timeout Constants 
Located in: `core/summarizer.js`

Exact constant names:
- `DEFAULT_MAX_TOKENS`
- `DEFAULT_TIMEOUT_MS`

## 4) Group Batch Message Settings (going to demise as this is chunk based logic)
Located in: `core/summarizer.js`

Exact variable names used in grouped summarize flow:
- `groupMaxTokens`
- `groupTimeoutMs`

Notes:
- `groupMaxTokens` is computed from per-item budget and count, capped at 8192.
- `groupTimeoutMs` is computed as base timeout + per-item scaling, capped at 180000 ms.

## 5) Collection Active State — Two Separate Controls

There are **two independent toggles** for collection activity. They store data in different fields and must be checked separately.

### A) Card Pause/Resume Button (`enabled` flag)
- **UI:** Play/pause icon button on each collection card in the Database Browser
- **Writes:** `setCollectionEnabled(registryKey, false)` → stores `{ enabled: false }` under `extension_settings.vecthareplus.collections[registryKey]`
- **Key format:** `collection.registryKey || collection.id` — for EventBase collections registered via `eventbase-store.js`, this is the **plain collection ID** (no `backend:source:` prefix) because `registerCollection(collectionId)` is called with the raw ID
- **Read:** `isCollectionEnabled(collectionId)` in `core/collection-metadata.js` line 318
- **Default:** `true` (enabled) when no metadata exists

### B) "Active for current chat" Checkbox (lock system)
- **UI:** Checkbox in the Collection Settings panel (gear icon → "Active for current chat")
- **Writes:** `setCollectionLock(collectionId, chatId)` / `removeCollectionLock(collectionId, chatId)` → stores chat IDs in `{ lockedToChatIds: [...] }` under the **plain collection ID** entry in metadata
- **Key format:** Plain collection ID (`state.collectionId` which is `collection.id`, not `collection.registryKey`)
- **Read:** `isCollectionLockedToChat(collectionId, chatId)` in `core/collection-metadata.js` line 626
- **Role:** This is a **fallback activation** — not a gate. A collection locked to the current chat activates even with no triggers/conditions. A collection NOT locked can still activate if its triggers or conditions match.

### Activation Priority (in `shouldCollectionActivate`, `core/collection-metadata.js`)

```
1. Pause button (enabled=false)     → BLOCKED always, nothing else checked
2. Activation Triggers match        → ACTIVE  (regardless of lock state)
3. Advanced Conditions pass         → ACTIVE  (regardless of lock state)
4. "Active for current chat" locked → ACTIVE  (manual always-on fallback)
5. Nothing matched                  → BLOCKED
```

Behaviour matrix:

| Checkbox | Triggers/Conditions | Result |
|---|---|---|
| ✗ unchecked | keywords match | ✓ ACTIVE (triggers win) |
| ✓ checked | empty | ✓ ACTIVE (lock fallback) |
| ✓ checked | keywords match | ✓ ACTIVE (triggers win) |
| ✓ checked | set but no match | ✓ ACTIVE (lock fallback) |
| ✗ unchecked | set but no match | ✗ BLOCKED |
| ✗ unchecked | empty | ✗ BLOCKED |
| any | Pause button on | ✗ BLOCKED always |

> **Old Priority 1.3 is removed.** Previously there was a blocking gate (`NOT_LOCKED_TO_CURRENT_CHAT`) that prevented collections with a `lockedToChatIds` field from activating in other chats. This gate is gone — the lock is now purely additive (activation fallback), not restrictive.

### Key files
- `core/collection-metadata.js` — `shouldCollectionActivate`, `isCollectionEnabled`, `setCollectionEnabled`, `isCollectionLockedToChat`, `setCollectionLock`, `removeCollectionLock`, `getCollectionLocks`
- `ui/database-browser.js` line ~1055 — card toggle handler (`vecthare-action-toggle`)
- `ui/database-browser.js` function `saveActivation` — "Active for current chat" save handler
- `ui/database-browser.js` function `openActivationEditor` — reads lock state to populate checkbox

---

## 6) EventBase Window Dedup — chat_metadata Fingerprint Cache

### Problem with old approach
`isWindowAlreadyExtracted` used a semantic DB query (`queryCollection(..., 50, ...)`) to check if a window was already extracted. This was:
- Capped at 50 results → missed already-extracted windows if >50 events in DB
- Slow — requires embedding a dummy query + ANN search on every window

### Current approach (O(1), no DB query)
Window fingerprints are stored in `extension_settings.vecthareplus.eventbase_extracted_windows[chatUUID]` as a flat string array. Using `extension_settings` (not `chat_metadata`) ensures they survive page reloads — `saveSettingsDebounced()` is called after each window so the cache is immediately persisted.

- **Fingerprint format:** sorted source hashes joined by comma, e.g. `"123,456,789"`
- **On extraction:** `markWindowExtracted(sourceHashes, uuid)` appends the fingerprint (called in `eventbase-workflow.js` after successful insert)
- **On dedup check:** `isWindowAlreadyExtracted(sourceHashes, ...)` does `array.includes(fingerprint)` — synchronous, instant
- **Why NOT chat_metadata:** `chat_metadata` is only saved to disk when ST saves the chat (e.g. when a message is generated). Stopping mid-vectorization and reloading Chrome would lose all fingerprints written during that run.

### Key files
- `core/eventbase-store.js` — `isWindowAlreadyExtracted`, `markWindowExtracted`, `EXTRACTED_WINDOWS_KEY`
- `core/eventbase-workflow.js` — calls `markWindowExtracted(sourceHashes)` after `insertEvents` succeeds

### Migration note
Windows extracted before this fix have no fingerprint in cache. First run after update will attempt to re-insert them — Qdrant silently overwrites same hash-keyed points (no duplicates). All future runs use the cache correctly.

---

## 7) GUI Settings — Tab Placement & EventBase Relevance

After the Phase 2 GUI reorg, settings are grouped by which path consumes them:

| Setting | UI tab | EventBase relevant? | What it actually does |
|---|---|---|---|
| **Insert Batch Size** (default 50) | ChunkBase → Ingestion | **No** | Controls chunks-per-API-call during chunk vectorization. EventBase inserts tiny batches (2–10 events per window) so this has no meaningful effect on EventBase. |
| **Dedup Depth** (default 50 messages) | Core | **Yes** | Used in `eventbase-retrieval.js` as `settings.deduplication_depth`. Filters out retrieved events whose source window falls within the last N messages of the current chat — avoids injecting content already visible in context. 0 = disabled. Also used by chunk-path retrieval in `chat-vectorization.js`. |
| **Hybrid Search & BM25 block** (Keyword Scoring Method, BM25 k1/b, Fusion Method, RRF K) | Core → Hybrid Search & BM25 | **A1/A2 only** | These are Vectra (Standard backend) controls. On Qdrant, hybrid is always A3 server-side native — k1/b/RRF K are managed by Qdrant's `modifier: idf` and the `fusion: rrf` API, and these UI knobs have no effect. EventBase callers inject `ebSettings` with `keyword_scoring_method` overridden from `eventbase_keyword_scoring_method` (internal, defaults `'bm25'`, not in UI). See §13 for the full matrix. |
| **Query Keyword Budget** (`hybrid_keyword_level`) | ChunkBase → Keyword Budget | **No** | Read only by `scoreResults()` (A1) and `hybridSearch()` (A2). A3 doesn't use it — the sparse-vector encoder tokenizes the full query and Qdrant handles IDF weighting. EventBase has its own importance/persist/recency re-ranker that dominates the final order anyway. |

---

## 8) Similharity Plugin Speedup (Simultaneous Embedding Requests)
Plugin file changed: `../similharity/index.js`

What we changed:
- In `getVectorsForSource(...)`, API/network providers now run embedding calls in parallel using `Promise.all(...)`.
- Parallel provider set:
  - `openai`
  - `togetherai`
  - `mistral`
  - `electronhub`
  - `openrouter`
  - `nomicai`
  - `cohere`
- Local GPU providers remain sequential to avoid contention/queueing/OOM behavior:
  - `transformers`
  - `ollama`
  - `llamacpp`
  - `koboldcpp`

Why this speeds up:
- Before: one request embedding N items sequentially, total about N x T.
- After (API providers): N requests fired concurrently inside one batch, total about T (subject to upstream limits).

Related client-side behavior (VectHare):
- In `core/core-vector-api.js`, local GPU sources default to small batch behavior unless user explicitly overrides `insert_batch_size`.

---

## 9) Module Integration Analysis — EventBase Compatibility

Analysis of whether non-EventBase modules should be integrated into the EventBase pipeline.

### temporal-decay.js — NOT compatible

**Module:** [`core/temporal-decay.js`](core/temporal-decay.js)
**Decision:** ❌ Do not add to EventBase.

`applyDecayToResults` checks `chunk.metadata.source === 'chat'` and `chunk.metadata.messageId`. EventBase [`EventBase`](core/eventbase-schema.js) events do not carry `source: 'chat'` or a `messageId` field — they use `source_window_end`. Every event would be skipped with `decayApplied: false`.

Additionally, EventBase already has its own `_recencyBonus` — an exponential decay term computed from `source_window_end` and `chatLength` — baked into the 4-weight re-ranker formula in [`eventbase-store.js`](core/eventbase-store.js). Applying `temporal-decay.js` would be redundant and silently do nothing.

### hybrid-search.js — Used indirectly (do not wire directly)

**Module:** [`core/hybrid-search.js`](core/hybrid-search.js)
**Decision:** ✅ EventBase benefits from it — but through `queryCollection()`, not by direct call.

EventBase calls `queryEvents()` → `queryCollection()` (via an `ebSettings` shim that pins `keyword_scoring_method` to `eventbase_keyword_scoring_method || 'bm25'`). Inside `queryCollection()`, the A1/A2/A3 routing decides whether to invoke `clientSideHybridSearch()` (A2) or the backend's native hybrid (A3, `backend.hybridQuery()`). On Standard backend, EventBase is always A1 unless `eventbase_keyword_scoring_method` is explicitly set to `'hybrid'`. On Qdrant, A3 (native sparse + server-side RRF) is the **only** hybrid path — the previous user-toggle was removed after the A/B/C testing picked native_rrf as the winner. `hybrid_native_prefer` remains as a hidden settings.json escape hatch (default `true`) for testing A2 without UI.

Do **not** call `hybridSearch()` directly from `eventbase-retrieval.js` or `eventbase-workflow.js`. It operates at the backend/collection layer — returns raw `{ hashes, metadata }` and bypasses `queryEvents()`, the store schema hydration, and EventBase-specific field population (`score`, `importance`, etc.).

### Summary table

| Module | Add directly to EventBase? | Reason |
|---|---|---|
| [`temporal-decay.js`](core/temporal-decay.js) | No | Already covered by `_recencyBonus` in the 4-weight formula; `applyDecayToResults` would silently skip all events due to missing `source: 'chat'` / `messageId` fields |
| [`hybrid-search.js`](core/hybrid-search.js) | No (used indirectly) | EventBase inherits A2/A3 hybrid automatically via `queryCollection()`. Direct calls would bypass `queryEvents()` and the store layer. |

---

## 10) EventBase Settings Impact Table

Three retrieval paths exist after the keyword-level simplification. All paths are chosen inside `queryCollection()` — EventBase inherits whichever applies to the active backend.

| Path | When | Where it runs | Keyword scoring | Fusion |
|---|---|---|---|---|
| A1 — BM25 re-rank | Standard backend default; or Qdrant with `keyword_scoring_method=bm25` and `hybrid_native_prefer=false` (hidden settings-only) | Browser | Okapi BM25 over ANN top-K only | Weighted linear: `α·vectorScore + β·bm25Score` (no RRF, no bonuses) |
| A2 — client-side hybrid (ANN-bound) | Standard backend with `keyword_scoring_method=hybrid`; or Qdrant with `hybrid_native_prefer=false` (hidden settings-only) | Browser | Okapi BM25 over the ANN candidate set only — vector top-K × 3, capped at 100 (`hybrid-search.js` line 100) | **RRF** (default) or weighted; **min-max normalization** per batch; **dual-signal bonus** (up to +8%); single-signal penalty (×0.55 vector-only, ×0.60 text-only) |
| **A3 — Qdrant native sparse + native RRF** | **Qdrant default. The only hybrid path on Qdrant.** | **Qdrant server** | **BM25 via Qdrant's native sparse vector with `modifier: "idf"`. IDF computed globally over the true full corpus** (every indexed document, not just keyword-matching subset). Sparse vectors stored on each point as `{indices, values}` at upsert via FNV-1a-hashed CJK-tokenized tokens. | **Qdrant-native RRF** (`fusion: "rrf"`) — single `/points/query` call with `prefetch: [dense, sparse]`. No bonuses, no penalties, no JS post-processing. |

**Fusion method detail:**

| Feature | A1 | A2 | A3 |
|---|---|---|---|
| RRF | ✗ | ✓ (client-side) | ✓ (server-side, Qdrant) |
| Weighted linear | ✓ (always) | ✓ (opt-in) | ✗ (Qdrant only ships `rrf` / `dbsf`) |
| Min-max normalization (batch-relative) | ✗ | ✓ | n/a (server-internal) |
| Saturation normalization `score/(score+k)` | ✗ | ✓ (BM25 side) | n/a (server-internal) |
| Dual-signal bonus (explicit ×1.0–1.08) | ✗ | ✓ | ✗ (Qdrant RRF handles dual-presence implicitly) |
| Single-signal penalty | ✗ | ✓ | ✗ |
| BM25 corpus scope | ANN top-K (≤100, `topK*2`) | ANN top-K × 3 (≤100) | **Full corpus** — global IDF via Qdrant `modifier: idf` |
| BM25 IDF accuracy | Biased (ANN subset) | Biased (ANN subset, same scope as A1) | **Globally accurate** (full corpus) |
| Network round-trips per query | 1 (vector search only) | 1 + corpus load (full chunk fetch on first query per session) | **1** (single `/points/query` call) |
| Tokenizer mode lock | n/a | n/a | ✓ — sentinel point stores `cjk_tokenizer_mode`; mismatch shows modal and refuses query |

| Setting | Affects EventBase? | Notes |
|---|---|---|
| `keyword_scoring_method` (`bm25` \| `hybrid`) | **No** | ChunkBase path only, and only for Standard backend. On Qdrant, A3 is the only hybrid path and this setting is ignored. EventBase callers override this to `eventbase_keyword_scoring_method \|\| 'bm25'` before passing settings to `queryCollection()`. |
| `eventbase_keyword_scoring_method` | **Yes (Standard only)** | EventBase-only internal key. Defaults to `'bm25'`; not exposed in UI. Override in browser console if needed. Has effect **only on Standard backend** (chooses A1 vs A2). On Qdrant, A3 takes over regardless. |
| `hybrid_keyword_level` (`minimal` / `balance` / `maximum`) | Negligible | Controls keywords extracted for A1 BM25 (30/50/70). Ignored under A2 (full query tokenized) and A3 (sparse encoder tokenizes everything; Qdrant handles IDF). |
| `hybrid_native_prefer` | Hidden setting | No longer in the UI. Default `true` keeps Qdrant on A3 (native sparse + RRF). Flip to `false` via JSON only to test A2 client-side hybrid against Qdrant. |
| `hybrid_fusion_method` (`rrf` / `weighted`) | A2 only | A1 always uses weighted linear. A3 always uses Qdrant-native RRF (this setting has no effect on Qdrant). |
| `hybrid_vector_weight`, `hybrid_text_weight` | A2 weighted mode only | Used only when `hybrid_fusion_method = weighted` on the Standard backend. |
| `hybrid_rrf_k` | A2 RRF mode only | Qdrant uses its own internal default for A3; this knob doesn't reach the server. |
| `bm25_k1`, `bm25_b` | A1 and A2 only | BM25 TF saturation (k1, default 1.5) and length normalization (b, default 0.75). A3 uses Qdrant's `modifier: idf` internals — these knobs are not exposed to the server. |
| `keyword_extraction_level`, `keyword_boost_base_weight` | No | Ingestion-only settings. No longer used in any retrieval path. |
| `cjk_tokenizer_mode` (`intl` / `jieba` / `jieba_tw` / `tiny_segmenter`) | **Yes (locked per Qdrant collection)** | Used by the sparse-vector encoder at upsert and query. Locked into each Qdrant collection via a sentinel point on first upsert. Changing this setting after migration triggers a mismatch modal on the next query (revert / open settings / cancel). |
| `hybrid_search_enabled` | Removed | Setting deleted. Hybrid is now always available; path chosen by backend and `keyword_scoring_method`. |
| `deduplication_depth` | Yes | EventBase context deduplication — suppress events already visible in recent chat window. |
| `eventbase_retrieval_top_k`, `eventbase_retrieval_min_importance`, EventBase rerank weights | Yes | Active for all three retrieval paths. |

---

## 11) Mirrored Function — `extractQueryKeywords`

| Item | Value |
|---|---|
| Origin | `similharity/index.js` lines 54–146 |
| VectHare copy | `core/query-keyword-extractor.js` |
| Exports | `extractQueryKeywords(text, maxKeywords)`, `isCJKToken(token)`, `RETRIEVAL_KEYWORD_LEVELS`, `DEFAULT_RETRIEVAL_KEYWORD_LEVEL` |
| Stop-word source | Imports `DEFAULT_STOP_WORD_SET` from `./stop-words.js` (full multi-language list, English + CJK; mirrored from `similharity/stop-words.js`) |

**Keep-in-sync note:** if the extraction algorithm changes in `similharity/index.js` (e.g. anchor budget, bigram fallback, Latin regex), update `core/query-keyword-extractor.js` to match. The console log prefix was changed from `[Qdrant]` to `[VectHare]` — that difference is intentional.


## Scene support — REMOVED

Scenes were a chunk-based-chat-era feature for bundling raw message chunks into
composite "scene" chunks (with `isScene: true` metadata). With chat now handled
exclusively by EventBase (events extracted by LLM, not raw message chunks), the
original semantic no longer applied, and the feature was removed wholesale.

**What was deleted:**
- Modules: `core/scenes.js`, `ui/scene-markers.js`, `ui/scenes-panel.js`, `ui/scenes.css`
- Chunk visualizer "Scenes" tab (and all its renderers in `ui/chunk-visualizer.js`)
- Bookmark scene-marker buttons attached to chat messages
- Scene-aware temporal decay (`applySceneAwareDecay`, `getSceneContext`, `sceneAware` flag)
- `per_scene` chunking strategy + content-type entry
- Scene-filtering in `chat-vectorization.js` (`filterSceneDisabledChunks`)
- Scene-aware checkbox in the Database Browser settings panel
- `applySceneAwareDecay` test block in `tests/temporal-decay.test.js`

**Orphan-but-harmless data (silently ignored):**
- `settings.temporal_decay.sceneAware: true` in saved user configs
- `settings.chunking_strategy: "per_scene"` in saved user configs
- `meta.temporalDecay.sceneAware` on collection metadata
- `metadata.isScene` / `metadata.sceneStart` / `metadata.sceneEnd` / `metadata.containedHashes`
  / `metadata.disabledByScene` on existing chunks in vector DBs

These fields are no longer read by any code; they sit dormant on disk and have
no migration step. They will eventually rot out of the data as collections are
re-vectorized or replaced.

**Prompt text that still mentions "scene":** `core/summarizer.js` and
`core/eventbase-schema.js` use the word generically in LLM instructions
("filler scene", "where the scene takes place") — that's English, not feature
wiring, and was left alone.

---

## 12) javascript to get these variables in chrome console
const ctx = SillyTavern.getContext();
const chatUUID = ctx.chatMetadata?.integrity || ctx.chatId;
const handleId = (ctx.name1 || 'user').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '').substring(0, 30) || 'user';
const charName = (ctx.name2 || 'chat').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '').substring(0, 30) || 'chat';
console.log({ chatUUID, handleId, charName });

// Check current chat's integrity and which EventBase collection it WOULD map to
(() => {
  const md = SillyTavern.getContext().chatMetadata;
  return {
    integrity: md?.integrity || '(missing — using chatId fallback)',
    chatFile: SillyTavern.getContext().chatId,
  };
})()

---

## 13) Hybrid Search & BM25 — GUI Placement Matrix

Backend determines path; on Qdrant there is only one hybrid path (A3). On Standard, the user picks A1 vs A2.

- **ChunkBase** owns non-chat content only: Lorebook / World Info, Character Cards, URLs / web pages, custom documents, wiki pages, YouTube transcripts. Uses `keyword_scoring_method`.
- **EventBase** owns chat content only: Current Chat history and uploaded Archive Chat history (`.jsonl`). Uses `eventbase_keyword_scoring_method` (internal, not in UI, defaults `'bm25'`).

Both paths call `queryCollection()` but EventBase callers (`eventbase-retrieval.js`, `eventbase-workflow.js`, `eventbase-store.js`) always inject an `ebSettings` shim:
```js
const ebSettings = { ...settings, keyword_scoring_method: settings.eventbase_keyword_scoring_method || 'bm25' };
```
This ensures ChunkBase's `keyword_scoring_method` never leaks into EventBase queries.

### Settings × routing case

| Setting | Storage key | Applies to | **A1** — Standard + BM25 | **A2** — Standard + Hybrid | **A3** — Qdrant native sparse + RRF |
|---|---|---|---|---|---|
| Keyword Scoring Method | `keyword_scoring_method` | **ChunkBase only** | ✅ selects A1 path | ✅ selects A2 path | ❌ ignored — A3 is the only Qdrant path |
| EventBase Scoring Method | `eventbase_keyword_scoring_method` | **EventBase only** | ✅ selects A1 path (Standard) | ✅ selects A2 path (Standard) | ❌ ignored on Qdrant |
| BM25 k1 | `bm25_k1` | Standard only | ✅ used | ✅ used | ❌ Qdrant `modifier: idf` internal |
| BM25 b | `bm25_b` | Standard only | ✅ used | ✅ used | ❌ Qdrant `modifier: idf` internal |
| Query Keyword Budget | `hybrid_keyword_level` | A1 only | ✅ used | ❌ full query tokenized | ❌ sparse encoder tokenizes everything |
| Fusion Method (RRF / Weighted) | `hybrid_fusion_method` | A2 only | ❌ not used (A1 always weighted) | ✅ used | ❌ Qdrant always RRF (server-side) |
| RRF K | `hybrid_rrf_k` | A2 RRF mode only | ❌ not used | ✅ used | ❌ Qdrant uses its own default |
| CJK Tokenizer Mode | `cjk_tokenizer_mode` | A3 (locked per Qdrant collection) | n/a | n/a | ✅ locked into collection at upsert via sentinel point |
| Prefer Native Backend Hybrid | `hybrid_native_prefer` | Hidden settings escape hatch | n/a | n/a | Default `true`. Flip to `false` via settings.json to force Qdrant onto A2 for testing. No UI. |

### Key observations

1. **Qdrant has exactly one hybrid path — A3.** The A/B/C testing in [plans/qdrant-native-sparse-hybrid-rrf.md](../plans/qdrant-native-sparse-hybrid-rrf.md) picked native sparse + native RRF as the winner; the dropdown and the "Prefer Native Backend Hybrid" checkbox were both removed. A3 runs entirely server-side via Qdrant's `/points/query` endpoint with `prefetch: [dense, sparse]` and `fusion: "rrf"`.
2. **A3 uses globally-accurate IDF.** Qdrant's `modifier: "idf"` computes IDF over the true full corpus (every indexed document), not the ANN-bounded subset. This eliminates the BM25 IDF bias that A1 and A2 carry.
3. **Path routing is content-type-scoped.** ChunkBase's `keyword_scoring_method` no longer affects EventBase. Changing to "Hybrid" in ChunkBase tab only switches lorebook queries.
4. **Sparse vectors are tokenizer-locked.** The CJK tokenizer mode at upsert is baked into a sentinel metadata point on each Qdrant collection. Querying after a mode change shows a modal asking the user to revert or re-vectorize.
5. **Migration tool (dev-only).** Existing dense-only Qdrant collections must be migrated to add sparse vectors — Action tab → Dev Tools → "Upgrade Collection to Native Sparse Vectors". The button is tagged `// MIGRATE-DELETE` in code for easy removal before release.

### GUI hide/show rules

| Backend | Visible in Core | Visible in ChunkBase |
|---|---|---|
| **Qdrant** (A3 — only option) | Native-active notice + CJK Tokenizer Mode dropdown (Keyword Extraction subsection). **Fusion Method and RRF K are hidden** — Qdrant ignores them. | *(no hybrid controls)* |
| **Standard + BM25** (A1) | Keyword Scoring Method, BM25 k1, BM25 b | Query Keyword Budget |
| **Standard + Hybrid** (A2) | Keyword Scoring Method, BM25 k1, BM25 b, Fusion Method, RRF K | *(no hybrid controls)* |

Notes:
- "Prefer Native Backend Hybrid" checkbox was removed. The setting `hybrid_native_prefer` still exists in defaults (`true`) as an escape hatch for testing A2 against Qdrant without UI.
- Fusion Method and RRF K Constant are hidden on Qdrant because Qdrant runs `fusion: "rrf"` server-side with its own internal k constant; exposing the controls would be misleading. They reappear when the user switches `vector_backend` to Standard (where A2 actually uses them).
- The CJK Tokenizer Mode dropdown lives in the Keyword Extraction subsection (always visible). It's the **only** Hybrid Search & BM25 control that affects A3 — it drives the sparse-vector encoder.
- Visibility is driven by [`updateNativeHybridUI()`](../ui/ui-manager.js) which fires on changes to `vector_backend` and `keyword_scoring_method`. On Qdrant it always shows the Native-active notice (no toggle).

### Server-side hybrid fusion — yes, fully supported

A3 leverages **all four** of Qdrant's relevant server-side features:

| Qdrant feature | A3 uses it? | How |
|---|---|---|
| Dense vector ANN | ✅ | Default unnamed vector slot |
| **Sparse vectors** (`modifier: "idf"`) | ✅ | Named slot `text_sparse`, FNV-1a-hashed token indices, raw TF values; Qdrant computes IDF globally |
| **Hybrid fusion** (`/points/query` with `prefetch`) | ✅ | Single call with `prefetch: [dense, sparse]` |
| **Native RRF** (`fusion: "rrf"`) | ✅ | Server-side fusion; alternative `"dbsf"` available but unused |
| Reranking pipelines | ❌ | EventBase's own importance/persist/recency re-ranker runs in JS after retrieval; Qdrant's experimental reranker not used |

### Cross-reference

- Architecture/cleanup plan: [plans/qdrant-native-sparse-hybrid-rrf.md](../plans/qdrant-native-sparse-hybrid-rrf.md).
- GUI reorg plan: [plans/GUI_reorganize.md](../plans/GUI_reorganize.md) §13–§22 (Phase 2).
- Routing code: `queryCollection()` at [core/core-vector-api.js](../core/core-vector-api.js).
- A3 client entrypoint: `hybridQuery()` at [backends/qdrant.js](../backends/qdrant.js).
- A3 server entrypoint: `hybridQueryNative()` at [similharity/qdrant-backend.js](../../similharity/qdrant-backend.js).
- Sparse encoder: [core/sparse-vector-encoder.js](../core/sparse-vector-encoder.js).
- Tokenizer lock + mismatch modal: [core/tokenizer-lock.js](../core/tokenizer-lock.js).
- EventBase invocation: `queryEvents()` at [core/eventbase-store.js](../core/eventbase-store.js) and direct `queryCollection` calls in [core/eventbase-retrieval.js](../core/eventbase-retrieval.js), [core/eventbase-workflow.js](../core/eventbase-workflow.js).

---

## 9) Trigger / Condition Activation — English Only

Activation Triggers and Advanced Conditions (Collection Settings → Activation panel) are **English-only**. They do not work reliably for CJK (Chinese / Japanese / Korean) stories.

### Why

**Triggers** match keywords against recent messages using JavaScript `String.includes()` and `/\b.../` regex anchors. `\b` is an ASCII word-boundary — it does not fire between CJK characters, so regex triggers will never match CJK text. Plain-string triggers (`includes()`) technically match substrings, but CJK chat messages lack the whitespace separators that make keyword matching useful, so hit rates are extremely low.

**Advanced Conditions → Emotion** relies on two detection paths, both English-only:

1. **Character Expressions classifier (primary)**: The sprite classification model bundled with the Character Expressions SillyTavern extension is trained on English text. CJK input produces unreliable or random emotion labels.
2. **`EMOTION_KEYWORDS` fallback (secondary)**: Defined in `core/conditional-activation.js` → `EMOTION_KEYWORDS`. Every entry is an English word or English regex pattern (e.g. `joy: ['joy', 'happy', 'smile', '/\\b(grin|beam)\\w*/i']`). Zero CJK coverage.

**Advanced Conditions → Message Contains / Pattern** also use `includes()` / regex with `\b` anchors — same limitation as Triggers.

### What works for CJK

- **Active for current chat / Character lock** (manual always-on) — no language dependency.
- **Advanced Conditions → Message Count / Turn Count** — purely numeric, language-independent.

### If CJK keyword matching is needed

Add CJK terms to `EMOTION_KEYWORDS` in `core/conditional-activation.js`, or extend `matchesEmotionPatterns()` to use `\p{L}` Unicode word boundaries (requires the `u` flag on the regex). Neither is implemented as of 2026-05-11.
