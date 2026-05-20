# Dev Helper

## 1) Pipeline Architecture — Strict Path Separation

EventBase is the **exclusive** retrieval path for chat content. The legacy `eventbase_enabled` toggle has been removed — chat history (live and uploaded archive `.jsonl`) is hard-routed through EventBase ingestion + retrieval. Legacy chunking for chat is no longer supported.

### Two pipelines, strict ownership

| Pipeline | Content scope | Owned collections | Code entry point |
|---|---|---|---|
| **EventBase pipeline** | Chat history only (live chat + archive `.jsonl`) | `vectfox_eventbase_*`, `vectfox_archiveevent_*` | `eventbase-workflow.js` → `eventbase-retrieval.js` |
| **Standard (Chunk) pipeline** | Non-chat content only — Lorebook / World Info, Character Cards, URLs / web pages, custom documents, wiki pages, YouTube transcripts | `vf_lorebook_*`, `vf_document_*`, user collections | `chat-vectorization.js` → `queryAndMergeCollections` |

The two paths never see each other's content. There is no overlap in collection prefixes or content types.

### Key isolation rule (`core/chat-vectorization.js` → `gatherCollectionsToQuery`)

- `vectfox_eventbase_*` → **always** skipped by the standard pipeline (EventBase pipeline owns them exclusively)
- `vectfox_archiveevent_*` → **always** skipped by the standard pipeline (EventBase pipeline owns them exclusively)
- `vectfox_chat_*` → **always** skipped by the standard pipeline (legacy chunk-based chat collections; no longer created since the EventBase toggle was removed, but pre-existing ones are excluded unconditionally)

### Archive Chat History — Two content paths

| Path | Content Type in UI | Collection prefix | Storage format | Retrieval |
|---|---|---|---|---|
| **A — EventBase** | `Chat → Upload` tab | `vectfox_archiveevent_*` | Event-shaped (same schema as live EventBase) | Phase A (EventBase re-ranker) |
| **B — Chunk** | `Document` content type | `vectfox_document_*` | Chunk-shaped | Phase B (standard pipeline) |

Archive event collections are **not** auto-locked to any chat after ingestion. Users must manually check "Active for current chat" on the collection card to activate retrieval for a given chat.

### Why this matters

Before the toggle removal, `vectfox_eventbase_*` collections could be included in the standard pipeline when EventBase was OFF, causing them to be queried twice per generation: once by the EventBase pipeline (structured event retrieval with dedup-depth) and once by the standard pipeline (raw chunk retrieval). The standard pipeline query was always redundant and could inject duplicate content. With the toggle gone, this class of bug is structurally impossible.

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

---

## 4) EventBase Window Dedup — chat_metadata Fingerprint Cache

### Problem with old approach
`isWindowAlreadyExtracted` used a semantic DB query (`queryCollection(..., 50, ...)`) to check if a window was already extracted. This was:
- Capped at 50 results → missed already-extracted windows if >50 events in DB
- Slow — requires embedding a dummy query + ANN search on every window

### Current approach (O(1), no DB query)
Window fingerprints are stored in `extension_settings.vectfoxplus.eventbase_extracted_windows[chatUUID]` as a flat string array. Using `extension_settings` (not `chat_metadata`) ensures they survive page reloads — `saveSettingsDebounced()` is called after each window so the cache is immediately persisted.

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

## 5) GUI Settings — Tab Placement & EventBase Relevance

After the Phase 2 GUI reorg, settings are grouped by which path consumes them:

| Setting | UI tab | EventBase relevant? | What it actually does |
|---|---|---|---|
| **Insert Batch Size** (default 50) | ChunkBase → Ingestion | **No** | Controls chunks-per-API-call during chunk vectorization. EventBase inserts tiny batches (2–10 events per window) so this has no meaningful effect on EventBase. |
| **Dedup Depth** (default 50 messages) | Core | **Yes** | Used in `eventbase-retrieval.js` as `settings.deduplication_depth`. Filters out retrieved events whose source window falls within the last N messages of the current chat — avoids injecting content already visible in context. 0 = disabled. Also used by chunk-path retrieval in `chat-vectorization.js`. |
| **Hybrid Search & BM25 block** (Keyword Scoring Method, BM25 k1/b, Fusion Method, RRF K) | Core → Hybrid Search & BM25 | **A1/A2 only** | These are Vectra (Standard backend) controls. On Qdrant, hybrid is always A3 server-side native — k1/b/RRF K are managed by Qdrant's `modifier: idf` and the `fusion: rrf` API, and these UI knobs have no effect. EventBase callers inject `ebSettings` with `keyword_scoring_method` overridden from `eventbase_keyword_scoring_method` (internal, defaults `'bm25'`, not in UI). See §13 for the full matrix. |
| **Query Keyword Budget** (`hybrid_keyword_level`) | ChunkBase → Keyword Budget | **No** | Read only by `scoreResults()` (A1) and `hybridSearch()` (A2). A3 doesn't use it — the sparse-vector encoder tokenizes the full query and Qdrant handles IDF weighting. EventBase has its own importance/persist/recency re-ranker that dominates the final order anyway. |

---

## 6) Similharity Plugin Speedup (Simultaneous Embedding Requests)
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

Related client-side behavior (vectfox):
- In `core/core-vector-api.js`, local GPU sources default to small batch behavior unless user explicitly overrides `insert_batch_size`.

---

## 7) Module Integration Analysis — EventBase Compatibility

Analysis of whether non-EventBase modules should be integrated into the EventBase pipeline.

### temporal-decay.js — DELETED

The whole `core/temporal-decay.js` subsystem (and `tests/temporal-decay.test.js`) was removed. It only operated on chunks with `metadata.source === 'chat'` — a stamp produced exclusively by the legacy chunk-based chat path that EventBase replaced. EventBase events never carried that stamp, so the subsystem was unreachable from the EventBase pipeline. Recency on the EventBase side is — and always was — handled by the `_recencyBonus` term inside the 4-weight re-ranker formula in [`eventbase-store.js`](core/eventbase-store.js) (computed from `source_window_end` and `chatLength`). Mentioned here only because the rest of this document used to cross-reference the old module.

### hybrid-search.js — Used indirectly (do not wire directly)

**Module:** [`core/hybrid-search.js`](core/hybrid-search.js)
**Decision:** ✅ EventBase benefits from it — but through `queryCollection()`, not by direct call.

EventBase calls `queryEvents()` → `queryCollection()` (via an `ebSettings` shim that pins `keyword_scoring_method` to `eventbase_keyword_scoring_method || 'bm25'`). Inside `queryCollection()`, the A1/A2/A3 routing decides whether to invoke `clientSideHybridSearch()` (A2) or the backend's native hybrid (A3, `backend.hybridQuery()`). On Standard backend, EventBase is always A1 unless `eventbase_keyword_scoring_method` is explicitly set to `'hybrid'`. On Qdrant, A3 (native sparse + server-side RRF) is the **only** hybrid path — the previous user-toggle was removed after the A/B/C testing picked native_rrf as the winner. `hybrid_native_prefer` remains as a hidden settings.json escape hatch (default `true`) for testing A2 without UI.

Do **not** call `hybridSearch()` directly from `eventbase-retrieval.js` or `eventbase-workflow.js`. It operates at the backend/collection layer — returns raw `{ hashes, metadata }` and bypasses `queryEvents()`, the store schema hydration, and EventBase-specific field population (`score`, `importance`, etc.).

### Summary table

| Module | Add directly to EventBase? | Reason |
|---|---|---|
| `core/temporal-decay.js` | n/a — module deleted | Subsystem only fired on `source: 'chat'` chunks (legacy chunk path). Recency on EventBase is handled by `_recencyBonus` inside the 4-weight formula. |
| [`hybrid-search.js`](core/hybrid-search.js) | No (used indirectly) | EventBase inherits A2/A3 hybrid automatically via `queryCollection()`. Direct calls would bypass `queryEvents()` and the store layer. |

---

## 8) Retrieval Paths — A1 / A2 / A3 Comparison

Three retrieval paths exist. The path is chosen automatically inside `queryCollection()` based on (a) backend and (b) `keyword_scoring_method`. EventBase, ChunkBase, and the Query Tester all flow through this same dispatch.

| | **A1 — BM25 re-rank** | **A2 — Client-side hybrid** | **A3 — Qdrant native** ⭐ |
|---|---|---|---|
| **When active** | Standard backend default; or Qdrant + hidden `hybrid_native_prefer=false` + `keyword_scoring_method=bm25` | Standard backend + `keyword_scoring_method=hybrid`; or Qdrant + hidden `hybrid_native_prefer=false` + `hybrid` | Qdrant backend default — the **only** hybrid path on Qdrant |
| **Where it runs** | Browser JS | Browser JS | Qdrant server |
| **Candidate set (what BM25 actually scores)** | ANN top-K (`topK × 2`, capped 100) | ANN top-K × 3 (capped 100) | **Union of dense top-K + sparse top-K** — sparse can surface rare-term docs the dense layer missed |
| **Retrieval recall ceiling** | Vector ANN only | Vector ANN only (slightly wider candidate window) | **Wider** — sparse retrieval finds docs the dense layer missed |
| **BM25 IDF source** | Toggle: `bm25_use_corpus_idf` — `true` (default) uses **full-corpus df values** cached in browser; `false` uses local df over candidate set only | Same toggle as A1 | **Always full-corpus** via Qdrant's `modifier: "idf"` (server-side) |
| **Sparse-vector index** | None — pure vector ANN | None — pure vector ANN | Yes — `text_sparse` named vector on every point, built at upsert via FNV-1a-hashed CJK tokens |
| **Fusion algorithm** | Weighted linear: `α·vectorScore + β·BM25_norm` (after `BM25/maxBM25`) | RRF (default, `hybrid_rrf_k`=60) **or** weighted; min-max normalization; +0–8% dual-signal bonus; single-signal penalty (×0.55 / ×0.60) | Qdrant-native RRF via `prefetch: [dense, sparse]`, `fusion: "rrf"`. No bonuses, no penalties, no JS post-processing. |
| **Network round-trips per query** | 1 (vector ANN); +1 one-time per session for cold corpus-stats build when toggle ON | Same as A1 | **1** (single `/points/query`) |
| **Tokenizer** | Client-side (Intl.Segmenter / Jieba / Jieba TW / TinySegmenter) | Same | Client-side at query; locked **per collection** at upsert via sentinel point. Mismatch shows modal and refuses query. |
| **Knobs that apply** | `bm25_k1`, `bm25_b`, `bm25_use_corpus_idf`, `hybrid_keyword_level` | Above + `hybrid_fusion_method`, `hybrid_vector_weight`, `hybrid_text_weight`, `hybrid_rrf_k` | None of the above — Qdrant uses its internal defaults |
| **Native EventBase rerank (cosine + importance + persist + recency in one call)** | n/a | n/a | Available when `eventbase_native_rerank=true` (default) + Qdrant ≥ 1.13 |

### ⚠️ "Corpus-wide IDF" is NOT "Corpus-wide search"

The `bm25_use_corpus_idf` toggle is the source of the most common misconception. It is worth being explicit:

| Question | Answer |
|---|---|
| Does ON make BM25 score all chunks in the collection? | **No.** BM25 still only scores the ANN top-K candidates the vector layer surfaced. |
| What does ON actually change? | The **IDF weights** used for the per-query terms. With ON, IDF is computed from corpus-wide df values (e.g. `df(贖身)=5 / N=1394`). With OFF, df is recomputed per query against just the local candidate set (e.g. `df(贖身)=3 / N=40`) — which biases IDF toward zero whenever the candidates already share the term. |
| How can a doc that doesn't appear in the ANN top-K still affect the score? | It can't be a result. It can only contribute to global df values, which feed into the per-term IDF weights of docs that *are* in the candidate set. |
| What if I want true full-corpus retrieval (find docs that vector missed)? | Use **A3 (Qdrant)**. Only that path stores a sparse-vector index over every chunk and can match by term across the full collection. The standard backend has no inverted/sparse index. |

So `bm25_use_corpus_idf` should be read as: *"Use corpus df values when computing IDF weights for the candidates BM25 is already scoring."* The toggle improves **scoring quality** within the existing recall window; it does **not** widen the recall window.

#### Cost and lifecycle of the corpus-stats cache

Implemented in [core/corpus-stats.js](../core/corpus-stats.js). When the toggle is ON:

| Aspect | Detail |
|---|---|
| Build trigger | Lazy — first call to `getCorpusStats(collectionId)` per session per collection. Subsequent calls hit a hot Map. |
| Build cost (measured, 1394 chunks Traditional Chinese on Intl.Segmenter) | 674 ms total: fetch=407 ms, parse=57 ms, tokenize+df=210 ms. Logged as `[CorpusStats] Built for ...` with full breakdown. |
| Sustained memory | ~400 KB per collection: `{ totalDocs, documentFrequencies: Map<term, df>, avgDocLength, builtAt }`. Chunk texts are **not** retained — only the derived statistics. |
| Auto-invalidation | Fires on `insertVectorItems` / `deleteVectorItems` / `purgeVectorIndex` (core-vector-api.js) and `insertChunksWithVectors` (collection-export.js import path). Lazy rebuild on next query. |
| Manual clear (force-rebuild for testing) | `(await import('/scripts/extensions/third-party/VectFox/core/corpus-stats.js')).clearCorpusStatsCache()` |
| Failure mode | Best-effort. Module-load or fetch failure logs a warning and falls back to local-IDF BM25 for that query — never discards the underlying vector results. See [feedback memory: optional enhancements must degrade]. |

#### Why default ON

For typical 1-2k-chunk collections, cold build is sub-second and main-thread freeze is under 300 ms — imperceptible. Steady-state cost is one Map lookup per query token. The ranking benefit is small when EventBase's importance/persist post-rank dominates the score, but the cost is small enough that "default ON" is the right call. Users with very large collections (>10k chunks) where the build starts to bite can flip it off; the scaling threshold and mitigation options (yield-in-loop / Web Worker / server-side df) are noted in the corpus-stats.js header.

### Path selection (decision tree)

```
backend == 'qdrant' ?
  ├─ yes → hybrid_native_prefer !== false (default true) ?
  │         ├─ yes → A3
  │         └─ no  → keyword_scoring_method == 'hybrid' ? A2 : A1
  └─ no (standard/vectra) → keyword_scoring_method == 'hybrid' ? A2 : A1
```

EventBase overrides `keyword_scoring_method` with `eventbase_keyword_scoring_method` (default `'bm25'`) before dispatch, so for EventBase on Standard backend the default is **A1**, not A2.

### Settings reference (consolidated)

| Setting | Default | Affects | Notes |
|---|---|---|---|
| `keyword_scoring_method` (`bm25` \| `hybrid`) | `hybrid` | ChunkBase A1/A2 selector on Standard backend | Ignored on Qdrant (A3 wins). EventBase overrides this with `eventbase_keyword_scoring_method`. |
| `eventbase_keyword_scoring_method` | `bm25` | EventBase A1/A2 selector on Standard backend | Internal key, not exposed in UI. Override via `extension_settings.vectfox` in console. |
| `hybrid_native_prefer` | `true` | A3 vs A1/A2 on Qdrant | Hidden — not in UI. JSON-only. Flip to `false` to force client-side path on Qdrant for A/B testing. |
| `bm25_k1`, `bm25_b` | 1.5 / 0.75 | A1 and A2 (client-side BM25 internals) | BM25+ TF saturation and length normalization. A3 uses Qdrant's internal defaults (these knobs don't reach the server). |
| `bm25_use_corpus_idf` | **`true`** | A1 and A2 IDF source | See "Corpus-wide IDF ≠ Corpus-wide search" above. Lazily fetches and caches `{N, df}` map for the entire collection. ~700 ms cold build, ~400 KB sustained. Auto-invalidates on writes. |
| `hybrid_keyword_level` (`minimal` / `balance` / `maximum`) | `balance` | A1 query keyword budget (30/50/70 tokens) | Negligible effect under A2 (full query tokenized) and A3 (sparse encoder tokenizes everything). |
| `hybrid_fusion_method` (`rrf` / `weighted`) | `rrf` | A2 fusion algorithm | A1 always uses weighted linear. A3 always uses Qdrant-native RRF (this setting doesn't reach the server). |
| `hybrid_vector_weight`, `hybrid_text_weight` | 0.5 / 0.5 | A2 weighted mode only | Used only when `hybrid_fusion_method = 'weighted'` on Standard backend. |
| `hybrid_rrf_k` | 60 | A2 RRF mode only | Qdrant uses its own internal default for A3; this knob doesn't reach the server. |
| `cjk_tokenizer_mode` (`intl` / `jieba` / `jieba_tw` / `tiny_segmenter`) | `intl` | A3 (locked per Qdrant collection at upsert via sentinel point) | Mismatch between current setting and the collection's locked tokenizer triggers a modal and refuses the query. On A1/A2 the tokenizer is also used but not locked — changing it just means inconsistent tokenization until re-vectorize. |
| `deduplication_depth` | 0 (disabled) | All three paths | EventBase context-window dedup: suppress events whose source window falls within the last N messages. Same JS path post-retrieval. |
| `eventbase_retrieval_top_k` | 10 | All three paths | Final number of events injected. Internal overfetch is `top_k × 2 × 2 = 40` for A1 (see §8 Retrieval Paths + keyword-boost.js:1304). |
| `eventbase_retrieval_min_importance` | 1 | All three paths | Drops events below this importance threshold after retrieval. |
| `eventbase_rerank_w_cosine` / `_w_importance` / `_w_persist` / `_w_recency` | 0.55 / 0.20 / 0.15 / 0.10 | All three paths (formula coefficients) | A3 with `eventbase_native_rerank=true` applies them server-side via Qdrant formula; A1/A2 apply them in JS in `eventbase-retrieval.js`. |
| `eventbase_native_rerank` | `true` | A3 only | Pushes the 4-weight formula into the same Qdrant `/points/query` call. Requires Qdrant ≥ 1.13. Set `false` to fall back to JS post-processing. |
| `eventbase_compare_rerank` | `false` | A3 only | When ON alongside `eventbase_native_rerank`, runs the JS formula path in parallel for every query and logs `overlap@K` + Spearman ρ. Pure observability, doesn't change the injected events. |
| `eventbase_compare_rerank_verbose` | `false` | A3 only | When both compare settings are ON, emits per-event score rows. Very noisy — development only. |
| `keyword_extraction_level`, `keyword_boost_base_weight` | — | Ingestion only | Not used by any retrieval path. Lives elsewhere; listed here so people stop expecting it to affect retrieval. |
| `hybrid_search_enabled` | — | Removed | Setting deleted. Hybrid is always available; path chosen by backend + `keyword_scoring_method`. |

### Native Formula Rerank (A3 + Qdrant ≥ 1.13)

When `eventbase_native_rerank = true`, `_runOneLiveQuery()` in
[core/eventbase-retrieval.js](../core/eventbase-retrieval.js) calls
`backend.hybridQueryWithRerank()` instead of `backend.hybridQuery()`. This
issues a single Qdrant `/points/query` with the four-weight formula baked in:

```json
{
  "prefetch": [
    { "query": "<denseVector>", "limit": "<prefetchLimit>" },
    { "query": "<sparseVector>", "using": "text_sparse", "limit": "<prefetchLimit>" }
  ],
  "query": {
    "formula": {
      "sum": [
        { "mult": [0.55, { "mult": [1.0, "$score"] }] },
        { "mult": [0.20, { "div": { "left": "importance", "right": 10 } }] },
        { "mult": [0.15, { "key": "should_persist", "match": { "value": true } }] },
        { "mult": [0.10, { "exp_decay": { "x": "source_window_end", "target": "<chatLength>", "scale": "<halfLife>", "midpoint": 0.5 } }] }
      ]
    }
  },
  "filter": { "must_not": [{ "key": "type", "match": { "value": "_vectfox_meta" } }] },
  "limit": "<topK>"
}
```

`$score` is Qdrant's RRF fusion score (peaks at 1.0 when k=1 internally).
The prefetch pool is `prefetchLimit` events (default: `topK × 3`), giving the
formula access to a wider candidate set than the plain RRF top-K — this lets
high-importance/high-recency events that ranked outside the top-K in plain RRF
still surface in the final result.

**What stays client-side even in 6a:**
- **Anchor boost** — multi-token phrase substring match (e.g. `贖身的儀式`)
  requires JS; Qdrant tokenizes terms individually and any-of matching would
  miss phrases.
- **Pairwise deduplication** — content-hash overlap across events.
- **Cross-collection merge** — `Promise.all` per collection, concat-dedup-trim.

**Version requirement:** Qdrant ≥ 1.13 for `formula` query support. If the
request fails with a Qdrant error, check the server version and set
`eventbase_native_rerank = false` to fall back to the JS path.

---

## 9) Mirrored Function — `extractQueryKeywords`

| Item | Value |
|---|---|
| Origin | `similharity/index.js` lines 54–146 |
| vectfox copy | `core/query-keyword-extractor.js` |
| Exports | `extractQueryKeywords(text, maxKeywords)`, `isCJKToken(token)`, `RETRIEVAL_KEYWORD_LEVELS`, `DEFAULT_RETRIEVAL_KEYWORD_LEVEL` |
| Stop-word source | Imports `DEFAULT_STOP_WORD_SET` from `./stop-words.js` (full multi-language list, English + CJK; mirrored from `similharity/stop-words.js`) |

**Keep-in-sync note:** if the extraction algorithm changes in `similharity/index.js` (e.g. anchor budget, bigram fallback, Latin regex), update `core/query-keyword-extractor.js` to match. The console log prefix was changed from `[Qdrant]` to `[vectfox]` — that difference is intentional.



---

## 10) javascript to get these variables in chrome console
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

## 11) Hybrid Search & BM25 — GUI Placement Matrix

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
| CJK Tokenizer Mode | `cjk_tokenizer_mode` | All paths | ✅ used for client-side BM25 tokenization (no locking) | ✅ used for client-side BM25 tokenization (no locking) | ✅ locked into collection at upsert via sentinel point; mismatch modal on query if changed |
| Prefer Native Backend Hybrid | `hybrid_native_prefer` | Hidden settings escape hatch | n/a | n/a | Default `true`. Flip to `false` via settings.json to force Qdrant onto A2 for testing. No UI. |

### Key observations

1. **Qdrant has exactly one hybrid path — A3.** The A/B/C testing in [plans/qdrant-native-sparse-hybrid-rrf.md](../plans/qdrant-native-sparse-hybrid-rrf.md) picked native sparse + native RRF as the winner; the dropdown and the "Prefer Native Backend Hybrid" checkbox were both removed. A3 runs entirely server-side via Qdrant's `/points/query` endpoint with `prefetch: [dense, sparse]` and `fusion: "rrf"`.
2. **A3 uses globally-accurate IDF.** Qdrant's `modifier: "idf"` computes IDF over the true full corpus (every indexed document), not the ANN-bounded subset. This eliminates the BM25 IDF bias that A1 and A2 carry.
3. **Path routing is content-type-scoped.** ChunkBase's `keyword_scoring_method` no longer affects EventBase. Changing to "Hybrid" in ChunkBase tab only switches lorebook queries.
4. **Sparse vectors are tokenizer-locked.** The CJK tokenizer mode at upsert is baked into a sentinel metadata point on each Qdrant collection. Querying after a mode change shows a modal asking the user to revert or re-vectorize.

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
| Reranking pipelines | ✅ (EventBase) / ❌ (BananaBread) | EventBase formula rerank (cosine × RRF + importance + persist + recency) runs **server-side** via `query: { formula: { sum: [...] } }` wrapping the prefetch when `eventbase_native_rerank = true` (Qdrant ≥ 1.13). BananaBread cross-encoder reranking is a separate post-retrieval stage — not wired into the Qdrant query. |

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

## 12) Trigger / Condition Activation — English Only

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

---

## 13) AgentMode — Agentic Retrieval

Optional LLM-planner step that runs between EventBase pre-search and re-rank. Sees the pre-search candidates plus recent chat context, then fans out 1-4 follow-up queries in parallel against Qdrant. **Purely additive — never replaces the existing flow.** A3 (Qdrant) only.

Plan document: [plans/executed/agentic-retrieval-plan.md](../plans/executed/agentic-retrieval-plan.md).

### Files

| File | Role |
|---|---|
| [core/agentic-prompt.js](../core/agentic-prompt.js) | System prompt + 2 few-shot examples (1 English, 1 CJK `贖身` case). Also builds the user-message portion (recent chat + current message + candidate summaries). |
| [core/agentic-retrieval.js](../core/agentic-retrieval.js) | Public `retrieveEventsWithAgent(params)`. Runs pre-search, calls planner LLM, fans out queries, merges, re-feeds through canonical re-ranker. Includes `_resolveAgenticLLMConfig()` for inheritance from summarize_* fields. |
| [core/eventbase-workflow.js](../core/eventbase-workflow.js) | Switches between `retrieveEvents` and `retrieveEventsWithAgent` based on `settings.agentic_retrieval_enabled`. |
| [ui/ui-manager.js](../ui/ui-manager.js) | "AgentMode" tab (peer of Core/EventBase/etc.) with provider/model inheritance, sliders, debug toggle. |

### Flow

```
retrieveEventsWithAgent(params)
 ├─ STAGE 1 — retrieveEvents(params)              (existing pre-search, unchanged)
 ├─ STAGE 2 — early-exit if disabled or non-Qdrant → return pre-search
 ├─ STAGE 3 — _callPlanner({system, user, llmCfg, timeoutMs})
 │    LLM input: recent N turns + current user message + top-K candidate summaries
 │    LLM output: { queries: string[], filters?: {...}, rationale: string }
 ├─ STAGE 4 — Promise.all of queryCollection per (collection × planner-query)
 └─ STAGE 5 — retrieveEvents({skipLiveQuery: true, additionalCandidates: [...]})
              re-runs 4-weight rerank / dedup / context-dedup / top-K trim
```

### Phase 1 limitations (intentional)

- **Planner-emitted filters are NOT applied** to queries yet. The planner may emit `characters_any`, `concepts_any`, `importance_gte` etc. in its JSON output, but the agentic-retrieval module ignores those fields and runs unfiltered hybrid search. Phase 1.5 will extend Similharity's [`_buildHybridFilter`](../../similharity/qdrant-backend.js) to translate the `*_any` shape into Qdrant `should` clauses.

### Settings (all in `index.js` defaults)

```js
agentic_retrieval_enabled                false       // master toggle
agentic_retrieval_provider               ''          // '' → inherit summarize_provider
agentic_retrieval_model                  ''          // '' → inherit summarize_model
agentic_retrieval_openrouter_api_key     ''          // '' → inherit summarize_openrouter_api_key
agentic_retrieval_vllm_url               ''          // '' → inherit summarize_vllm_url
agentic_retrieval_vllm_api_key           ''          // '' → inherit summarize_vllm_api_key
agentic_retrieval_chat_depth             5           // slider 3-15
agentic_retrieval_candidates_to_show     12          // slider 5-20
agentic_retrieval_max_queries            4           // slider 1-4
agentic_retrieval_timeout_ms             30000       // hard timeout for planner call (matches summarize default)
agentic_retrieval_debug_logging          false       // separate from eventbase_debug_logging
```

Inheritance is centralized in `_resolveAgenticLLMConfig(settings)` — read it once, no scattered `||` checks elsewhere.

### Debug log shape (when `agentic_retrieval_debug_logging` is true)

All lines prefixed `[vectfoxPlus-Agentic]` so they're greppable and distinct from `[EventBase]` / `[Qdrant]`.

Per retrieval round emits, in order:
1. `mode=ON trigger=user_message_len=<N>`
2. `Pre-search returned <N> candidates (top score=<x.xx>)`
3. `Past chat turns sent to planner: <depth>`
4. `Narrative context preview` — one ~50-word snippet per turn (matches what the planner actually sees, and the count equals `agentic_retrieval_chat_depth`)
5. `LLM prompt size: system+user approx <T> tokens (<a>+<b> chars)` — size only, not the prompt text (it's noisy and the static system prompt is already in `core/agentic-prompt.js`; the narrative-context preview at step 4 already shows the dynamic part)
6. `LLM call complete: <ms>ms`
7. `Planner output:` followed by the full JSON response from the LLM (queries, filters, rationale)
8. `Qdrant fanout: <N> queries × <M> collections = <X> parallel calls`
9. `Qdrant fanout complete: <ms>ms`
10. `Per-query hits:` — one line per query with top score
11. `Agentic-only hits (not already in pre-search): <N>`
12. `Final merged candidates: <pre> + <agentic> = <total> → <final> after rerank/dedup/trim`
13. `Total wall-clock for agent overhead: <ms>ms (LLM=<ms>ms, fanout=<ms>ms)`

Timing buckets:
- LLM call ms (measured around `_callPlanner`)
- Qdrant fanout ms (measured around the `Promise.all` of `queryCollection` calls)
- Total agent overhead ms (measured from agent-stage entry through stage 5 return)
- Embedding batch ms — implicit inside each `queryCollection` call; not separately timed in Phase 1

### Failure modes — all fall back to pre-search

| Failure | Outcome |
|---|---|
| `agentic_retrieval_enabled = false` | Skip stages 2-5; identical to today |
| `vector_backend !== 'qdrant'` | Skip; log `mode=SKIPPED reason=requires_qdrant_backend` |
| Missing model or API key | Skip; log `mode=SKIPPED reason=missing_model` / `missing_openrouter_api_key` |
| Planner LLM throws / times out / returns invalid JSON | Log warn; return pre-search only |
| Planner returns 0 valid queries (after `_validateAndTrimQueries`) | Log; return pre-search only |
| One of N Qdrant queries fails | Per-promise `.catch(err) → []`; other queries still merge |
| All Qdrant queries fail | `agenticHits = []`; pre-search events still feed stage 5 re-rank |
| `liveCollectionIds` empty | Skip stages 4-5; return pre-search |

**Invariant:** AgentMode MUST NEVER produce a worse result than today's flow. The drop-in shape of `retrieveEventsWithAgent` is designed so that on any failure the return value is exactly what `retrieveEvents` would have returned.

### Debug return shape

When AgentMode runs successfully, the returned `debug` object gains:

```js
{
  agenticMode: true,
  agenticQueries: string[],     // validated planner queries that actually ran
  agenticRationale: string,     // planner's one-sentence rationale (for diagnostics)
  agenticLLMMs: number,
  agenticFanoutMs: number,
  agenticTotalMs: number,
  agenticHitCount: number,      // events the agentic stage contributed before merge/rerank
}
```

Use these fields in future benchmark / diagnostic tooling.

---

## 14) Lock & Auto-Sync UI Workflow

Single section covering every place in the UI that reflects "this collection is active for the current chat": the lock badge in the listing, the Collection Settings checkbox, the WI panel toggle, and the Chat Auto-Sync toggle. All four read from the same source of truth and write back through a small, scope-aware set of helpers. Updated 2026-05-17.

### ⚠️ Canonical Lock & Listing API — USE THESE, DO NOT REIMPLEMENT

**Read this before writing any lock-related code.** These four functions are the *only* entry points new code should call for collection listing, lock state, and registry-key construction. They bundle backend disambiguation, persona/handle ownership, and superadmin checks. Re-implementing the logic inline gets it wrong almost every time — the failure mode is silent: locks land in the wrong storage bucket, get nuked by the next orphan-cleanup pass, and the UI shows nothing changed.

| Function | File:Line | Use when |
|---|---|---|
| **`getCollectionListing(settings)`** | [collection-loader.js:180](../core/collection-loader.js#L180) | You need to iterate every collection (rendering a list, finding matches by pattern, computing aggregate state). |
| **`getLock(collectionId, options)`** | [collection-metadata.js:792](../core/collection-metadata.js#L792) | You need lock state for *one* collection (badge, tooltip, checkbox state, "is this active right now?"). |
| **`setLock(collectionId, action, options)`** | [collection-metadata.js:839](../core/collection-metadata.js#L839) | You need to *mutate* lock state for *one* collection (user clicks lock / unlock / clear). |
| **`buildRegistryKey(collectionId, settings)`** | [collection-ids.js:96](../core/collection-ids.js#L96) | You only have a bare collection ID and need to convert it to the canonical `"backend:id"` storage key (for any metadata read/write). Never hand-roll `` `${backend}:${collectionId}` `` — use this instead. |

#### `getCollectionListing(settings)` — listing iterator

```js
const entries = getCollectionListing(settings);
// entries: Array<{ registryKey, collectionId, backend, meta, isOwn, isActive }>
```

Built-in checks:
- Reads the registry, parses each `backend:id` key.
- `isOwn`: superadmin override OR `meta.creatorHandle` matches current persona handle OR (legacy) bare-ID substring contains current handle.
- `isActive`: calls `isCollectionActiveForContext(registryKey, …)` internally — already keyed correctly.
- Call this **once** per render and reuse the array. Do not call `isCollectionActiveForContext` in a per-card loop.

#### `getLock(collectionId, options)` — single-collection read

```js
const lock = getLock(collection.registryKey || collection.id, {
    chatId: getCurrentChatId(),
    characterId: getContext()?.characterId,
    settings,
});
// lock: null  (caller unauthorized — not superadmin, not owner)
//     | { storageKey, scope, chatLocks, characterLocks, isLocked, isActiveHere, canModify }
```

Built-in checks:
- Authorization: `null` return when current persona is not superadmin AND doesn't own the collection. Use `options.ignoreAuth: true` for headless/system code (import flow, registry registration).
- Scope-aware `isActiveHere`: checks the right list (chat vs character) based on `meta.scope`.
- `canModify` flag: lets the UI grey out the lock button rather than letting the click silently fail.

**Storage-key convention:** callers must pass the registry-key form (`backend:id`). On a `collection` object from `findCollectionByKey` or `getCollectionListing`, use `collection.registryKey || collection.id`. **No silent fallback to bare ID** — passing the wrong form gives wrong-state reads, not errors.

#### `setLock(collectionId, action, options)` — single-collection mutation

```js
const result = setLock(collection.registryKey || collection.id, {
    kind: 'chat',           // 'chat' | 'character'
    op: 'add',              // 'add' | 'remove' | 'clear'
    target: getCurrentChatId(),  // chatId or characterId; ignored when op='clear'
}, { settings });
// result: { success: true } | { success: false, reason: 'unauthorized' | 'invalid kind' | ... }
```

Built-in checks:
- Same authorization gate as `getLock`. Denied mutations log a warning and return `{success:false, reason:'unauthorized'}` — caller must check the result.
- Routes to the right primitive (`setCollectionLock` / `removeCollectionLock` / `clearCollectionLock` / character variants) based on `action.kind`.
- Updates the reverse index (`chat_lock_index`) atomically with the forward write.

#### What NOT to do

These patterns will look correct but produce broken state:

| Wrong | Right |
|---|---|
| `isCollectionActiveForContext(collection.id, …)` | `isCollectionActiveForContext(collection.registryKey \|\| collection.id, …)` — or use `getLock` |
| `setCollectionLock(collection.id, chatId)` | `setLock(collection.registryKey \|\| collection.id, { kind: 'chat', op: 'add', target: chatId }, { settings })` |
| Iterating the registry + checking `creatorHandle.toLowerCase() === handle` inline | `getCollectionListing(settings).filter(e => e.isOwn)` |
| Iterating collections + calling `isCollectionActiveForContext` per card | `getCollectionListing` once → use `entry.isActive` |
| Reading `extension_settings.vectfox.collections[bare_id]` directly | `getCollectionMeta(registryKey)` (storage now keyed by `backend:id`) |
| Auto-resolving bare ID → registry-key by scanning the registry | Caller passes the canonical form; the auto-resolve scan was removed deliberately because it masked wrong-form callers |
| `isCollectionAutoSyncEnabled(collectionId)` — bare ID — silently returns `false` even when the UI shows checked (UI writes via registryKey, this reads from a *different bucket*) — root cause of the 2026-05-17 auto-sync regression | `isCollectionAutoSyncEnabled(registryKey)` — same form the UI + every write path uses |
| `` `${getRegistryBackend(settings.vector_backend)}:${collectionId}` `` hand-rolled at every call site (drift bait — one site forgets and the bug above surfaces) | `buildRegistryKey(collectionId, settings)` |
| `shouldCollectionActivate(collectionId, context)` with bare `collectionId` — its internal `getCollectionMeta` and `isCollectionLockedToChat` calls both read from `extension_settings.vectfox.collections[id]`, which is keyed by `backend:id` form. Passing bare ID returns empty defaults; lock checks always return `false`, so every collection looks unlocked and nothing activates correctly. Root cause of the 2026-05-20 semantic WI lorebook scope bug. | `shouldCollectionActivate(entry.registryKey, context)` where `entry` comes from `getCollectionListing(settings)` |

#### Older primitives — when you might still need them

`setCollectionLock`, `removeCollectionLock`, `clearCollectionLock`, `setCollectionCharacterLock`, etc. ([collection-metadata.js:527+](../core/collection-metadata.js#L527)) are the raw write primitives without authorization. The facade routes to these. **Only call them directly from inside `setLock` or from system code that already enforces auth at a higher layer** (`registerCollection`'s creatorHandle stamping is the canonical example). Application code, UI handlers, and anything user-triggered should go through `setLock`.

### Pause/Resume button — `enabled` flag

Separate concern from locks. It's a hard kill switch — when `false`, the collection is blocked from any activation regardless of locks, triggers, or scope.

- **UI:** Play/pause icon on each collection card in the Database Browser
- **Write:** `setCollectionEnabled(collection.registryKey || collection.id, false)` → stores `{ enabled: false }` under `extension_settings.vectfox.collections[registryKey]`
- **Read:** `isCollectionEnabled(registryKey)` in `core/collection-metadata.js` — pass the registry-key form, not bare ID
- **Default:** `true` (enabled) when no metadata exists
- **All collections use the same key form** — `backend:id`. EventBase collections are registered as `${registryBackend}:${collectionId}` in `eventbase-store.js`, not as plain IDs. The `data-collection-key` attribute on every card is always `collection.registryKey || collection.id`.

### Async runtime activation — `shouldCollectionActivate`

Used by any code path that must decide at runtime whether a collection is currently in scope, respecting triggers, advanced conditions, and manual locks. The semantic WI lorebook search path (`world-info-integration.js`) is the canonical example.

**Must receive the registry-key form.** Internally calls `getCollectionMeta(id)` and `isCollectionLockedToChat(id, chatId)`, both of which read from `extension_settings.vectfox.collections[id]` — keyed by `backend:id`. Passing a bare collection ID silently gets empty defaults and lock checks always return `false`.

**Canonical pattern:**

```js
import { getCollectionListing } from './collection-loader.js';
import { shouldCollectionActivate } from './collection-metadata.js';

const listing = getCollectionListing(settings);
const currentChatId = getCurrentChatId() ? String(getCurrentChatId()) : null;
const currentCharacterId = getContext().characterId != null ? String(getContext().characterId) : null;
const context = { currentChatId, currentCharacterId };

for (const entry of listing) {
    if (!entry.collectionId.startsWith('vf_lorebook_')) continue;
    if (entry.meta.enabled === false) continue;                           // paused
    if (!(await shouldCollectionActivate(entry.registryKey, context))) continue;  // out of scope
    // entry.registryKey is correct for all subsequent getCollectionMeta calls
}
```

Priority chain inside `shouldCollectionActivate`:
```
1. enabled=false          → BLOCKED (pause button)
2. Activation Triggers    → ACTIVE if any keyword matches recent messages
3. Advanced Conditions    → ACTIVE if condition passes
4. Chat lock match        → ACTIVE if currentChatId is in lockedToChatIds
5. Character lock match   → ACTIVE if currentCharacterId is in lockedToCharacterIds
6. Nothing matched        → BLOCKED
```

**Important:** trigger/condition gates are intentional for semantic WI — a lorebook with keyword triggers should activate even without a manual chat lock. A lorebook with no triggers and no lock is out of scope and will not be searched.

### ⚠️ Embedding model resolution — `getModelFromSettings`

Sibling principle to the lock facade — same "use the one helper, never reimplement inline" rule, different domain.

The settings object stores the embedding model under **provider-specific** field names: `openrouter_model`, `ollama_model`, `vllm_model`, `cohere_model`, etc. There is **no flat `settings.model`** — that key is always empty/undefined. Code that reads `settings.model` directly silently produces the wrong value (empty string) without throwing.

**Always use** [`getModelFromSettings(settings, fallback?)`](../core/providers.js#L99) from `core/providers.js`:

```js
import { getModelFromSettings } from './providers.js';

const model = getModelFromSettings(settings);              // → 'qwen/qwen3-embedding-8b' for openrouter
const modelOrNull = getModelFromSettings(settings, null);  // null when provider has no model field
```

It internally calls `getModelField(settings.source)` to look up the right field name, then reads that field.

#### Why this matters

Every site that sends a `model` to the plugin API (`chunks/insert`, `chunks/list`, `chunks/query`, `get-embedding`) is part of the **storage-key contract**. Inserts under `model='qwen/qwen3-embedding-8b'` must be queried under the same `model` value or the plugin's per-model partitioning silently returns 0 results. This bug surfaced as "vectra returns 0 results while qdrant works" — qdrant doesn't partition by model field, so it masked the bug; vectra exposed it.

#### What NOT to do

| Wrong | Right |
|---|---|
| `model: settings.model` (flat key — always empty) | `model: getModelFromSettings(settings)` |
| `settings.model \|\| ''` | `getModelFromSettings(settings)` |
| `settings[getModelField(settings.source)] \|\| null` (one-liner with manual fallback) | `getModelFromSettings(settings, null)` |
| `const modelField = getModelField(s.source); s[modelField] \|\| ''` (4-line inline expansion) | `getModelFromSettings(settings)` |
| Defining a local `getModelFromSettings` private helper (this happened 3 times before consolidation) | Import the canonical one |

#### When to use `getModelField` directly instead

`getModelField(source)` returns the **field name** (a string like `'openrouter_model'`) or `null`. Use it only when you need the *name* itself for a validation check or display:

```js
// Validation: does the user need to configure a model for the current provider?
const modelField = getModelField(settings.source);
if (config.requiresModel && modelField && !settings[modelField]) {
    return { error: 'Model not configured' };
}
```

If you just need the value, `getModelFromSettings(settings)` is shorter and harder to misuse.

### Lock-state read tiers — which layer to call

Three tiers exist. Call the highest tier that covers your use case:

| Tier | Function | Use when |
|---|---|---|
| **API (preferred)** | `getLock(registryKey, opts)` | One collection — UI badge, checkbox, tooltip. Returns `isActiveHere`, `canModify`, `chatLocks`, etc. Bundles auth check. |
| **API (preferred)** | `getCollectionListing(settings)` | All collections — render loop, aggregate state. Use `entry.isActive` — no per-card calls needed. |
| **Underlying** | `isCollectionActiveForContext(registryKey, { chatId, characterId })` | Called internally by both API functions. Do not call per-card in a loop — use `getCollectionListing` instead. Still correct when you have exactly one collection and no auth check is needed (e.g. runtime activation in `world-info-integration.js`). |
| **Raw** | `setCollectionLock` / `removeCollectionLock` etc. | Internal only — called by `setLock` facade. Do not call from application code. |

`isCollectionActiveForContext` returns `true` based on the collection's scope:
- `scope='chat'` → `chatId` is in `lockedToChatIds`
- `scope='character'` → `characterId` is in `lockedToCharacterIds`
- anything else → `false` (no global scope; legacy `global` was migrated to `character` — see below)

### Scope migration — global is gone

`scope='global'` is no longer a valid choice. The Vectorize Content modal exposes only `Character` (default) and `This Chat`. Existing global collections are auto-migrated **once**, on first read by `loadAllCollections`:

```
storedMeta.scope === 'global'  →  setCollectionMeta(writeKey, { scope: 'character' })
```

After migration completes, no code anywhere checks for `'global'`. The only remaining reference is the migration block itself in `core/collection-loader.js`. Do not reintroduce `scope === 'global'` branches elsewhere.

A migrated collection has no character lock by default — it stops auto-activating until the user re-checks "Active for current chat" in Collection Settings (which then calls `setCollectionCharacterLock(currentCharacterId)`).

### DB Browser — lock badge in the listing

In `ui/database-browser.js`, the main render loop calls `getCollectionListing(settings)` once and iterates its entries. Each entry carries `entry.isActive` (pre-computed by `getCollectionListing` via `isCollectionActiveForContext(registryKey, ...)` internally). The badge renderer receives the entry and reads `entry.isActive` — there is no per-card `isCollectionActiveForContext` call in the loop. The badge displays a scope-appropriate tooltip:
- `scope='chat'` → "Active for current chat" (with chat-count suffix if locked to multiple chats)
- `scope='character'` → "Active for current chat (locked to current character)"

A fallback `isCollectionActiveForContext` call survives in the badge helper for callers that pass a raw collection ID instead of an entry — this is internal plumbing, not the intended pattern.

### DB Browser → Collection Settings → "Active for current chat" checkbox

In `ui/database-browser.js`:

| Function | Role |
|---|---|
| `openActivationEditor` | Computes `state.alwaysActive` via `isCollectionActiveForContext` |
| `renderActivationEditor` | Sets `prop('checked', state.alwaysActive)` |
| `refreshActivationLockButton` | Re-syncs checkbox after Manage Locks dialog — same helper |
| `saveActivation` | Mutates locks on Save based on scope |

**`saveActivation` lock mutation:**

```
scope='chat'      + checked   →  setCollectionLock(state.collectionId, currentChatId)
scope='chat'      + unchecked →  removeCollectionLock(state.collectionId, currentChatId)
scope='character' + checked   →  setCollectionCharacterLock(state.collectionId, currentCharacterId)
scope='character' + unchecked →  removeCollectionCharacterLock(state.collectionId, currentCharacterId)
```

`state.collectionId` is the registry-key form (`backend:id`) — set when `openActivationEditor` is called with `collection.registryKey || collection.id`. Key form is correct. **Note:** these calls use the raw primitives directly rather than the `setLock` facade. They bypass the auth check that `setLock` performs, which is acceptable here because `saveActivation` is only reachable by the collection owner. Migration to `setLock` is a known pending cleanup.

Each call only touches the lock for the **current** chat/character. Other chats or characters that have this collection locked keep their entries intact — `removeCollectionLock` filters by id, doesn't wipe the list.

### WI Panel — "Enable Semantic WI Activation" checkbox

In `ui/ui-manager.js`.

**`refreshWIStatus`** (auto-sync from events) fires on:
- WorldInfo tab click
- After lorebook vectorization completes
- `vectfox:collections-updated` custom event
- `CHAT_CHANGED` event
- Initial load

It computes `activeIds` by filtering own-persona lorebooks (creatorHandle stamp) through `isCollectionActiveForContext`, then drives the checkbox + status via an inline `_setWIEnabled(bool)` helper:

| Result | Checkbox | LED | Status |
|---|---|---|---|
| 0 lorebooks (this persona) | ❎ | 🟡 | "No lorebooks vectorized — vectorize one first" |
| 0 active | ❎ | 🟡 | "Lorebook vectorized but not active for this chat — lock it…" |
| ≥1 active | ✅ | 🟢 | "Active for this chat: <names>" |

**Critical:** `_setWIEnabled` calls `prop('checked', enabled)` directly. It does **not** call `.trigger('change')`. This is load-bearing — see "Manual vs auto-sync paths" below.

**Manual change handler** (user clicks the checkbox):

| Action | Behaviour |
|---|---|
| ✓ Check + no own lorebooks | Uncheck, redirect to Content Vectorizer (`'lorebook'`) |
| ✓ Check + no active | Uncheck, redirect to DB Browser |
| ✓ Check + ≥1 active | Persist `enabled_world_info=true`, show settings panel |
| ✗ Uncheck | For each currently-active own lorebook, remove the lock making it active (chat or character per scope). Dispatch `vectfox:collections-updated`. Persist `enabled_world_info=false`. |

### Chat Auto-Sync — "Enable Auto-Sync" checkbox

**Key-form parity is load-bearing.** Four sites read or write the per-collection autoSync flag: `refreshAutoSyncCheckbox` (UI mirror), `getChatAutoSyncStatus` (state evaluator), the change handler (writer), and `synchronizeChat` (the engine that actually fires extraction). All four must use the **registry-key form** (`backend:id`) — built via `buildRegistryKey(collectionId, settings)` or pulled from `entry.registryKey`. The 2026-05-17 regression where the popup never fired and extraction never ran was a single site (`synchronizeChat`) reading with the bare collection ID while everyone else wrote with the registry key. The flag was saved correctly; the reader looked in the wrong bucket and saw `undefined`.

State evaluator: **`getChatAutoSyncStatus(settings)`** in `core/eventbase-workflow.js`. Pure in-memory — no backend probe. Returns one of:

```
{ state: 'no-chat' }
{ state: 'no-collection' }
{ state: 'partial',          collectionId, registryKey }
{ state: 'fully-vectorized', collectionId, registryKey }
```

Match logic: walks the registry, picks the first eventbase entry whose ID matches the current chat's UUID via `buildChatSearchPatterns` + `matchesPatterns` (substring on UUID). This handles legacy ID formats and character renames — the UUID is the stable identifier.

"Fully vectorized" is determined by `isChatFullyVectorized(messages, settings, chatUUID)`, which checks whether the last possible window for the current message count is already in `eventbase_extracted_windows[uuid]`. No DB query, just an O(1) Set lookup.

**`refreshAutoSyncCheckbox(settings)`** fires on:
- AutoSync tab click
- `CHAT_CHANGED` event
- Initial load
- `vectfox:collections-updated` custom event
- `vectfox:eventbase-synced` custom event (after an ingestion run completes)

Resolution table:

| State | autoSync flag | Lock | Checkbox | LED | Status |
|---|---|---|---|---|---|
| `no-chat` | — | — | ❎ | 🟡 | "No chat loaded" |
| `no-collection` | — | — | ❎ | 🟡 | "Not initialized — vectorize chat first" |
| has-collection | false OR no lock | — | ❎ | ⚪ | "Auto-sync inactive" |
| `partial` | true | locked | ✅ | 🟡 | "Locked — will sync to latest history on next auto-sync trigger" |
| `fully-vectorized` | true | locked | ✅ | 🟢 | "Ready — fully synced" |

**Change handler** (user clicks):

| Action | Behaviour |
|---|---|
| ✓ Check + no-chat | Toast warn, uncheck |
| ✓ Check + no-collection | Open Content Vectorizer (`'chat'`) |
| ✓ Check + partial | `setCollectionLock(registryKey, chatId)` + `setCollectionAutoSync(registryKey, true)` + toast "will catch up" |
| ✓ Check + fully-vectorized | `setCollectionLock(registryKey, chatId)` + `setCollectionAutoSync(registryKey, true)` + toast "fully synced" |
| ✗ Uncheck | `setCollectionAutoSync(registryKey, false)` + `removeCollectionLock(registryKey, chatId)` |

`registryKey` here is `status.registryKey` from `getChatAutoSyncStatus` — the canonical `"backend:id"` form. All four metadata read paths (this table, `refreshAutoSyncCheckbox`, `synchronizeChat`, `getChatAutoSyncStatus`) use the same form. After mutation, dispatches `vectfox:collections-updated` and re-runs `refreshAutoSyncCheckbox` so the LED updates.

### Manual vs auto-sync paths

UI elements that mirror lock state are pulled in two ways. The distinction matters because the manual paths have side effects.

| Trigger | Calls `.trigger('change')` | Lock mutation? |
|---|---|---|
| User clicks WI checkbox | (browser-native) | **Yes** — change handler removes/checks locks |
| User clicks Auto-Sync checkbox | (browser-native) | **Yes** — change handler removes/sets chat lock |
| User clicks "Active for current chat" in Collection Settings | (via Save button) | **Yes** — `saveActivation` mutates |
| `refreshWIStatus` auto-uncheck | **No** — `_setWIEnabled` uses `prop()` only | **No** — pure UI mirror |
| `refreshAutoSyncCheckbox` auto-state | **No** — direct `prop()` | **No** — pure UI mirror |
| `refreshActivationLockButton` after Manage Locks | **No** — direct `prop()` | **No** — re-reads state set by the dialog |

**Rule:** auto-sync paths must never invoke the change handler. Otherwise, opening the WI panel could trigger lock removal as a side effect of the UI sync.

### Custom events

| Event | Fired by | Listeners |
|---|---|---|
| `vectfox:collections-updated` | `saveActivation`, WI uncheck handler, Auto-Sync change handler | `refreshWIStatus`, `refreshAutoSyncCheckbox` |
| `vectfox:eventbase-synced` | `runEventBaseIngestion` at end of run | `refreshAutoSyncCheckbox` |

Plus ST's `CHAT_CHANGED` — same two refresh handlers re-run.

### Runtime activation chain (`shouldCollectionActivate`)

The runtime priority list in `core/collection-metadata.js`:

```
1. Pause button (enabled=false)          → BLOCKED
2. Activation Triggers match             → ACTIVE
3. Advanced Conditions pass              → ACTIVE
4. Chat lock match (currentChatId)       → ACTIVE
4. Character lock match (currentCharId)  → ACTIVE
5. Nothing matched                       → BLOCKED
```

There is **no global-scope priority**. That branch (formerly "priority 1.5") was removed when global was unwired. If you find yourself adding a `meta.scope === 'global'` check anywhere, stop — the migration handles legacy data, and there is no path that should produce a new `'global'` value.

### Key files

| File | Role |
|---|---|
| `core/collection-metadata.js` | `isCollectionActiveForContext`, `setCollectionLock`, `removeCollectionLock`, `setCollectionCharacterLock`, `removeCollectionCharacterLock`, `setCollectionAutoSync`, `shouldCollectionActivate` |
| `core/collection-loader.js` | Migration (`scope='global'` → `'character'`), `loadAllCollections` |
| `core/eventbase-workflow.js` | `getChatAutoSyncStatus`, `isChatFullyVectorized`, dispatches `vectfox:eventbase-synced` |
| `core/content-vectorization.js` | Default `scope='character'`, no `'global'` fallback |
| `ui/database-browser.js` | Listing lock badge, `openActivationEditor`, `renderActivationEditor`, `refreshActivationLockButton`, `saveActivation` |
| `ui/ui-manager.js` | `refreshWIStatus` + `_setWIEnabled`, `refreshAutoSyncCheckbox`, WI checkbox handler, Auto-Sync checkbox handler, event listeners |
| `ui/content-vectorizer.js` | Scope picker without global, post-vectorization `refreshWIStatus` call |

### Things you should NOT do

- Don't call `.trigger('change')` from any refresh/auto-sync path. Use `prop('checked', x)` directly and persist settings inline.
- Don't probe the backend for checkbox state. Every state evaluator (`isCollectionActiveForContext`, `getChatAutoSyncStatus`) uses in-memory data only.
- Don't add `scope === 'global'` checks. The only legitimate reference is the one-time migration block in `loadAllCollections`.
- Don't duplicate `isCollectionActiveForContext` logic inline. If you need it in a new place, import it.
- Don't write directly to `lockedToChatIds` / `lockedToCharacterIds`. Use the `setCollectionLock` / `removeCollectionLock` / `setCollectionCharacterLock` / `removeCollectionCharacterLock` helpers — they maintain the `chat_lock_index` reverse map too.

---

## 15) Known Pending Cleanups

### 15.1 ChunkBase phase early-gate — broaden vs current

**Status**: Deferred — investigated 2026-05-17, no code change yet.

`rearrangeChat` ([core/chat-vectorization.js:1193](../core/chat-vectorization.js#L1193)) runs **EventBase Phase A** then unconditionally falls through to **ChunkBase Phase B**. Phase B has two existing gates:

1. **Early (cheap)** at [line 1247-1240](../core/chat-vectorization.js#L1247): `hasCollections = gatherCollectionsToQuery(settings).length > 0` — passes if *any* non-EventBase collection has `enabled=true`. No lock/scope/activation check.
2. **Post-activation (expensive)** at [line 1295](../core/chat-vectorization.js#L1295): `filterActiveCollections` runs the full [`shouldCollectionActivate`](../core/collection-metadata.js#L1080) priority chain (triggers → conditions → chat lock → character lock).

EventBase-only users (the typical case) hit gate 1 and short-circuit — debug log `[VECTFOX ChunkBase] No enabled ChunkBase collections ...` fires once per generation to confirm.

**What was considered**: tightening the early gate so it requires not just "enabled" but "enabled AND has some activation mechanism that could match the current context" — would avoid the keyword-extraction work at [line 1271-1281](../core/chat-vectorization.js#L1271-L1281) when a user has enabled lorebooks that aren't locked/triggered for the current chat.

**Why deferred**: A naïve `isLocked`-only gate would break users who rely on **Activation Triggers** or **Advanced Conditions** for activation without ever locking a collection (priorities 2-3 of `shouldCollectionActivate`). The safe shape is `enabled AND (chat-locked OR character-locked OR has triggers OR has conditions)` — a cheap pre-check that matches every activation path. Not worth doing in isolation; revisit if/when we touch Phase B for another reason.

**Caller count**: 1 — `rearrangeChat` is the only place running the EventBase→ChunkBase ordered workflow ([index.js:273](../index.js#L273) is its sole caller via ST's `generate_interceptor`). No util-extraction is needed if/when we change the gate.

**Search tag in code**: none yet. When acted on, target [core/chat-vectorization.js:1247](../core/chat-vectorization.js#L1247) (the `if (!hasCollections && !canQueryWI)` block).
