# Hybrid Keyword Retrieval — Simplification & Alignment Plan

Simplify retrieval to **three clean paths**: **Case A1** (client-side BM25 re-rank, standard backend default), **Case A2** (client-side hybrid full scan, opt-in for standard backend), and **Case A3** (native hybrid, Qdrant/Milvus default). Drop the `hybrid_search_enabled` toggle and the old keyword-boost-only path. Keep a `keyword_scoring_method` dropdown for the standard backend with two values: `bm25` and `hybrid`.

Scope: **all retrieval paths** (EventBase + legacy chunk-based). Ingestion-side keyword extraction is **not touched**. LanceDB falls under the standard-backend rules.

---

## 1. Current behavior (traced)

| Case | Hybrid | Native | Code path | Keyword extraction |
|------|--------|--------|-----------|--------------------|
| 1 | OFF | n/a | [eventbase-retrieval.js:178](../core/eventbase-retrieval.js#L178) `extractChatKeywords` + [core-vector-api.js:939](../core/core-vector-api.js#L939) `scoreResults()` | Hardcoded cap=8, ignores GUI level. `scoreResults()` branches on `keyword_scoring_method` (keyword/bm25/hybrid) |
| 2 | ON | OFF | [hybrid-search.js:89](../core/hybrid-search.js#L89) `clientSideHybridSearch` → [hybrid-search.js:415](../core/hybrid-search.js#L415) `bm25Tokenize(query)` | No cap — entire query tokenized; ignores GUI level |
| 3 | ON | ON | [qdrant.js:736](../backends/qdrant.js#L736) → POST to server → [similharity/index.js:54](../../similharity/index.js#L54) `extractQueryKeywords(text, 50)` | 50 CJK + 10 English overflow, anchor + context split. GUI level has no effect |

Three different mental models. The `keyword_extraction_level` dropdown (off/minimal 5/balanced 12/aggressive 15) drives **none** of them at runtime. The `keyword_scoring_method` dropdown (keyword/bm25/hybrid) only drives Case 1's `scoreResults()` path.

**Performance note (the reason A1 exists):** [bm25-scorer.js:739](../core/bm25-scorer.js#L739) `applyBM25Scoring()` only operates on the K ANN candidates — fast, no bulk corpus load. [hybrid-search.js:89](../core/hybrid-search.js#L89) `clientSideHybridSearch()` builds a BM25 index over **all chunks** in the collection — slow on large corpora (e.g. 5000+ chunks shows the chunk-load progress prompt on every reply). Native hybrid (Case 3) avoids both because the backend has its own text index.

---

## 2. Desired behavior

Three paths:

| Path | When | Keyword extraction | Loads all chunks? | GUI |
|------|------|--------------------|-------------------|-----|
| **A1 — client-side BM25 re-rank** | Standard backend, `keyword_scoring_method = bm25` (default) | Copied `extractQueryKeywords` (CJK > English), capped by `hybrid_keyword_level` | No — only ranks K ANN candidates | `keyword_scoring_method` dropdown shown; level dropdown shown |
| **A2 — client-side hybrid full scan** | Standard backend, `keyword_scoring_method = hybrid` | Copied `extractQueryKeywords`, capped by `hybrid_keyword_level` | **Yes** — full corpus BM25 index | `keyword_scoring_method` dropdown shown; level dropdown shown |
| **A3 — native hybrid** | Backend supports native AND `hybrid_native_prefer = true` (default for Qdrant/Milvus) | Server-side `extractQueryKeywords(text, 50)` — unchanged | No — backend handles it | `keyword_scoring_method` and level dropdowns hidden; static text "50 keywords" |

Overflow is always +10 English when CJK fills the primary budget. Not shown in dropdown labels.

**Defaults:**
- Standard / LanceDB: A1 (BM25 re-rank). User can opt into A2 if they want full hybrid quality and accept the corpus-scan cost.
- Qdrant / Milvus: A3 (native hybrid via `hybrid_native_prefer = true`). If a user unchecks `hybrid_native_prefer`, the backend falls back to A1/A2 selection like the standard backend.

---

## 3. What gets removed

### 3.1 `hybrid_search_enabled` toggle — remove entirely

**Setting:** `hybrid_search_enabled` in [index.js:~108](../index.js) — delete default.

**UI:** `#vecthare_hybrid_search_enabled` checkbox in [ui-manager.js:456-460](../ui/ui-manager.js#L456-L460) — remove HTML + event listener at [ui-manager.js:2394-2405](../ui/ui-manager.js#L2394-L2405). The `#vecthare_hybrid_params` container it toggles should now always be visible (its contents — fusion method, weights, RRF K — apply to A2 and A3).

**Routing:** [core-vector-api.js:~870](../core/core-vector-api.js) — `queryCollection()` currently checks `if (settings.hybrid_search_enabled)` to decide between `hybridSearch()` and `scoreResults()`. New routing logic (see §4.5):

```javascript
if (backendSupportsNative && settings.hybrid_native_prefer) {
    return hybridSearch(...);  // A3 — native via hybridSearch's native path
}
if (settings.keyword_scoring_method === 'hybrid') {
    return hybridSearch(...);  // A2 — client-side hybrid
}
return scoreResults(...);       // A1 — BM25 re-rank
```

**EventBase:** [eventbase-retrieval.js:~155](../core/eventbase-retrieval.js) — `useHybrid` variable currently derived from `settings.hybrid_search_enabled`. Replace with the same routing logic so EventBase picks A1/A2/A3 the same way as `queryCollection()`.

### 3.2 `keyword_scoring_method` dropdown — trim, not remove

**Setting:** `keyword_scoring_method` in [index.js:~108](../index.js) — keep, but only `bm25` and `hybrid` are valid values. Default `bm25`.

**UI:** `#vecthare_keyword_scoring_method` dropdown in [ui-manager.js:428-437](../ui/ui-manager.js#L428-L437) — remove the `keyword` option. Keep `bm25` and `hybrid`. Update label/hint text to reflect the new meaning ("BM25 re-ranks ANN top-K (fast); Hybrid scores the full corpus (slow on large collections)").

**Visibility:** show only when A3 is NOT in effect (i.e. backend doesn't support native hybrid, or `hybrid_native_prefer` is false). When A3 is in effect, hide and replace with static text "Native hybrid: 50 keywords (CJK priority + English overflow)".

**Code:** `scoreResults()` function in [core-vector-api.js:939-977](../core/core-vector-api.js#L939-L977) — keep, but simplify to only the BM25 branch (the `keyword` branch is removed; the `hybrid` branch is unreachable here since `hybrid` routing now goes to `hybridSearch()`).

`#vecthare_bm25_params` (k1/b sliders) visibility now follows: visible when A1 or A2 active; hidden under A3.

### 3.3 Case 1 keyword boost in EventBase — remove

[eventbase-retrieval.js:168-192](../core/eventbase-retrieval.js#L168-L192) — the block that calls `extractChatKeywords(boostText, ...)` then `applyKeywordBoost(rawCandidates, ...)`. Remove the entire block. The new routing replaces it.

Callers of `extractChatKeywords` in other files ([chat-vectorization.js:1916](../core/chat-vectorization.js#L1916)) are **not touched** — legacy chunk pipeline's Stage 4.3 still uses it for ingestion-side metadata. The function stays in `keyword-boost.js`.

### 3.4 Dead code candidates (remove or leave)

- `applyKeywordBoost()` / `applyKeywordBoosts()` / `getOverfetchAmount()` in [keyword-boost.js:1213-1318](../core/keyword-boost.js#L1213-L1318) — only called from the `keyword` branch of `scoreResults()` and from EventBase's removed boost block. **Safe to delete from retrieval paths after §3.2 + §3.3.** Confirm no other caller before deleting.
- `applyBM25Scoring()` in [bm25-scorer.js:739-792](../core/bm25-scorer.js#L739-L792) — **kept**, still used by A1.

---

## 4. What gets added / changed

### 4.1 Copy `extractQueryKeywords` into VectHare

Copy `extractQueryKeywords()` (~90 lines) from [similharity/index.js:54-146](../../similharity/index.js#L54-L146) into a new file `core/query-keyword-extractor.js`. Include:

- The function itself
- `_CJK_SPAN_RE` regex
- Stop-word import (reuse `DEFAULT_STOP_WORD_SET` — check if VectHare already has a compatible set in [bm25-scorer.js](../core/bm25-scorer.js); otherwise copy from [similharity/stop-words.js](../../similharity/stop-words.js))

Export: `extractQueryKeywords(text, maxKeywords)` → returns `string[]`.

Tag file header: `// Mirrors similharity/index.js extractQueryKeywords — keep in sync when algorithm changes.`

Add note in [Doc/dev_helper.md](../Doc/dev_helper.md) documenting the mirrored function and its origin.

### 4.2 New retrieval keyword level config

New constant in `core/query-keyword-extractor.js`:

```javascript
export const RETRIEVAL_KEYWORD_LEVELS = {
    minimal: { label: 'Minimal — 30 keywords', maxKeywords: 30 },
    balance: { label: 'Balance — 50 keywords', maxKeywords: 50 },
    maximum: { label: 'Maximum — 70 keywords', maxKeywords: 70 },
};
export const DEFAULT_RETRIEVAL_KEYWORD_LEVEL = 'balance';
```

New setting in [index.js](../index.js) defaults:

```javascript
hybrid_keyword_level: 'balance',  // 'minimal' (30), 'balance' (50), 'maximum' (70)
keyword_scoring_method: 'bm25',   // trimmed: 'bm25' | 'hybrid'
```

Existing `EXTRACTION_LEVELS` (off/minimal 5/balanced 12/aggressive 15) and `keyword_extraction_level` setting are **untouched** — they serve ingestion only.

The `hybrid_keyword_level` dropdown applies to **both A1 and A2** (both are client-side and benefit from CJK-priority extraction). A3 uses its own server-side fixed cap of 50.

### 4.3 `core/hybrid-search.js` — A2 (client-side hybrid): use `extractQueryKeywords` + stem Latin tokens

[hybrid-search.js:415](../core/hybrid-search.js#L415) inside `performBM25Search`:

**Before:**
```javascript
const queryTokens = bm25Tokenize(query, { stem: true, removeStopWords: true, minLength: 2 });
```

**After:**
```javascript
const maxKeywords = RETRIEVAL_KEYWORD_LEVELS[settings.hybrid_keyword_level || 'balance'].maxKeywords;
const rawKeywords = extractQueryKeywords(query, maxKeywords);
const queryTokens = rawKeywords.map(token => isCJK(token) ? token : porterStemmer(token));
```

- `extractQueryKeywords` selects **which** words matter (CJK priority, anchor/context, frequency).
- Porter stemmer normalizes Latin tokens to match the BM25 document index (which was built with stemming). CJK tokens are not stemmed (same as `bm25Tokenize` behavior).
- `porterStemmer` needs to be exported from [bm25-scorer.js](../core/bm25-scorer.js) (currently internal). Add export.
- `isCJK` helper: reuse `_CJK_SPAN_RE` test or import from the extractor.

**Threading:** `performBM25Search` currently receives only `{ k1, b, fieldBoosting }`. Extend to also pass `settings` from `clientSideHybridSearch` (which already has it in scope) at [hybrid-search.js:138-142](../core/hybrid-search.js#L138-L142).

### 4.4 `core/bm25-scorer.js` — A1 (BM25 re-rank): align query tokenization

In `applyBM25Scoring()` at [bm25-scorer.js:756](../core/bm25-scorer.js#L756):

**Before:**
```javascript
const queryTokens = tokenize(query);
```

**After:**
```javascript
const maxKeywords = RETRIEVAL_KEYWORD_LEVELS[options.hybridKeywordLevel || 'balance'].maxKeywords;
const rawKeywords = extractQueryKeywords(query, maxKeywords);
const queryTokens = rawKeywords.map(token => isCJK(token) ? token : porterStemmer(token));
```

The candidate documents passed into `createBM25Scorer(results, ...)` are tokenized inside `BM25Scorer.indexDocuments()` using the existing `tokenize()` (which already stems Latin). So query tokenization must match — that's why we still stem after `extractQueryKeywords`.

Thread `hybridKeywordLevel` through the options object from the caller (`scoreResults()`).

### 4.5 `core/core-vector-api.js` — three-case routing

[core-vector-api.js:~870](../core/core-vector-api.js) — `queryCollection()`:

**New logic:**
```javascript
const backend = getBackendForCollection(collectionId);
const nativeHybridAvailable = backend?.supportsHybridSearch?.() === true;
const useNative = nativeHybridAvailable && settings.hybrid_native_prefer;

if (useNative || settings.keyword_scoring_method === 'hybrid') {
    return await hybridSearch(collectionId, searchText, topK, settings, { queryVector });
    // hybridSearch internally picks native vs client-side based on the same flags
}

// A1 — BM25 re-rank
const annResults = await backend.search(collectionId, queryVector, topK * overfetch);
return scoreResults(annResults, searchText, settings);
```

`scoreResults()` is simplified to only the BM25 branch (uses `applyBM25Scoring()` updated per §4.4).

### 4.6 `core/eventbase-retrieval.js` — same three-case routing

Replace the existing `useHybrid` block with the same routing as §4.5. EventBase calls into the appropriate path based on `keyword_scoring_method` and `hybrid_native_prefer`.

Remove:
- `extractChatKeywords` import (if only used here)
- `applyKeywordBoost` import
- The Case 1 keyword-boost-only block (lines ~168-192)
- References to `keyword_extraction_level` / `keyword_boost_base_weight` in this file

### 4.7 `ui/ui-manager.js` — GUI changes

#### Remove:
- `#vecthare_hybrid_search_enabled` checkbox + label + hint
- The `keyword` option from `#vecthare_keyword_scoring_method` (keep the dropdown itself with `bm25` + `hybrid`)
- Event listeners for the removed checkbox

#### Make always visible:
- `#vecthare_hybrid_params` container (fusion method, weights, RRF K) — was toggled by `hybrid_search_enabled`, now always shown (applies to A2/A3).

#### Conditional visibility:
- `#vecthare_hybrid_native_prefer` checkbox: show only when active backend reports `supportsHybridSearch()`. For now: show when `vector_backend` is `qdrant` or `milvus`; hide for `standard` / `lancedb`. Wire to `#vecthare_vector_backend` change handler at [ui-manager.js:2130-2152](../ui/ui-manager.js#L2130-L2152).
- `#vecthare_keyword_scoring_method` dropdown + `#vecthare_hybrid_keyword_level` dropdown + `#vecthare_bm25_params`: visible when A3 is NOT in effect (i.e. `!(nativeHybridAvailable && hybrid_native_prefer)`). Hidden under A3.
- A3 static text: when A3 is active, show `"Native hybrid: 50 keywords (CJK priority + English overflow)"` in place of the dropdowns.

#### New `#vecthare_hybrid_keyword_level` dropdown:
- Options: `minimal` — "Minimal — 30 keywords", `balance` — "Balance — 50 keywords", `maximum` — "Maximum — 70 keywords"
- Bound to `settings.hybrid_keyword_level`, default `'balance'`.
- Place near hybrid params section.
- Applies to both A1 and A2.

Visibility recomputes on changes to: `vector_backend`, `hybrid_native_prefer`, `keyword_scoring_method`.

### 4.8 `Doc/dev_helper.md` — update

- Update the settings table (section starting at [line 198](../Doc/dev_helper.md#L198)):
  - Remove `hybrid_search_enabled` row — toggle is gone.
  - Update `keyword_scoring_method` row — values are now `bm25` (default, A1 fast re-rank) / `hybrid` (A2 full scan, slow on large corpora). Standard backend only; ignored when A3 active.
  - Remove `keyword_extraction_level` / `keyword_boost_base_weight` "only when hybrid disabled" row — Case 1 keyword-boost path is gone.
  - Add `hybrid_keyword_level` row: controls query keyword extraction for A1 and A2. Values: minimal (30) / balance (50) / maximum (70). Ignored under A3.
  - Add note: `hybrid_native_prefer` only meaningful when backend supports native hybrid (Qdrant/Milvus).
- Add new section documenting the mirrored `extractQueryKeywords` function:
  - Origin: `similharity/index.js:54`
  - Location: `core/query-keyword-extractor.js`
  - Keep-in-sync note: if the algorithm changes in similharity, update VectHare's copy.

---

## 5. Behavior matrix after the fix

| Backend | Native prefer | `keyword_scoring_method` | Active path | Loads all chunks? | GUI |
|---------|--------------|--------------------------|-------------|-------------------|-----|
| Standard | n/a (hidden) | `bm25` (default) | A1 — BM25 re-rank | No | Method dropdown shown; level dropdown shown |
| Standard | n/a (hidden) | `hybrid` | A2 — client-side hybrid | **Yes** | Method dropdown shown; level dropdown shown |
| Qdrant | ON (default) | ignored | A3 — native | No | Method + level dropdowns hidden; "50 keywords" text |
| Qdrant | OFF | `bm25` | A1 | No | Method + level dropdowns shown |
| Qdrant | OFF | `hybrid` | A2 | **Yes** | Method + level dropdowns shown |
| Milvus | ON | ignored | A3 — native | No | Method + level dropdowns hidden |
| Milvus | OFF | `bm25` | A1 | No | Method + level dropdowns shown |
| LanceDB | n/a (hidden) | `bm25` (default) | A1 | No | Same as Standard |

---

## 6. Ingestion — explicitly NOT touched

These are separate concerns and stay as-is:

| Component | Setting | Values | Function |
|-----------|---------|--------|----------|
| Chat history ingestion | `keyword_extraction_level` | off / minimal(5) / balanced(12) / aggressive(15) | `extractBM25Keywords()` |
| Lorebook/content ingestion | UI `keywordLevel` | off / minimal(5) / balanced(12) / aggressive(15) | `extractTextKeywords()` |
| Content-vectorizer dropdown | `#vecthare_cv_keyword_level` | off / minimal / balanced / aggressive | Unchanged |
| `EXTRACTION_LEVELS` constant | in `keyword-boost.js` | off / minimal / balanced / aggressive | Unchanged |

---

## 7. Verification

Manual:

1. **A1 — Standard backend, BM25 (default).** Open console. Send a chat message with a 5000-chunk collection active. Confirm **no** chunk-load progress prompt appears. Confirm log shows `[BM25] Applying BM25 scoring to N results` where N ≈ topK overfetch (e.g. 50–100), not the full corpus. Confirm extracted query tokens come from `extractQueryKeywords` and respect the level dropdown.
2. **A2 — Standard backend, switch to Hybrid.** Send a query. Confirm log shows `[HybridSearch] Using client-side ... fusion`. Confirm chunk-load happens (this is expected for A2). Verify keyword level dropdown still respected.
3. **A3 — Qdrant, native prefer ON.** Confirm both `keyword_scoring_method` and `hybrid_keyword_level` dropdowns are hidden, static "50 keywords" text shown. Server log shows `[Qdrant] extractQueryKeywords final → N tokens` (≤ 60).
4. **A3 fallback — Qdrant, native prefer OFF.** Both dropdowns reappear. Behavior matches A1/A2 by user's choice.
5. **GUI — Standard backend.** `hybrid_native_prefer` checkbox is hidden. Method + level dropdowns visible.
6. **GUI — Qdrant backend.** `hybrid_native_prefer` checkbox visible. When checked: method + level dropdowns hidden, static text shown. When unchecked: dropdowns shown.
7. **No regression — hybrid params.** Fusion method, vector/text weights, RRF K, BM25 k1/b are visible whenever A2 or A3 is active.
8. **No regression — ingestion.** Content vectorizer dropdown still shows off/minimal/balanced/aggressive. Lorebook vectorization still uses `extractTextKeywords` with old levels.

---

## 8. File change summary

| File | Action |
|------|--------|
| `core/query-keyword-extractor.js` | **New** — copied `extractQueryKeywords` + `RETRIEVAL_KEYWORD_LEVELS` |
| `core/hybrid-search.js` | **Modify** — A2: replace `bm25Tokenize(query)` with `extractQueryKeywords` + stem; thread settings |
| `core/bm25-scorer.js` | **Modify** — A1: `applyBM25Scoring` uses `extractQueryKeywords` + stem; export `porterStemmer` |
| `core/core-vector-api.js` | **Modify** — three-case routing in `queryCollection()`; simplify `scoreResults()` to BM25-only |
| `core/eventbase-retrieval.js` | **Modify** — same three-case routing; remove Case 1 keyword-boost block |
| `ui/ui-manager.js` | **Modify** — remove `hybrid_search_enabled` toggle; trim `keyword_scoring_method` to 2 options; add `hybrid_keyword_level` dropdown; conditional visibility for A3 |
| `index.js` | **Modify** — remove `hybrid_search_enabled` default; trim `keyword_scoring_method` (default `bm25`); add `hybrid_keyword_level` |
| `Doc/dev_helper.md` | **Modify** — update settings table, add mirrored-function note, document A1/A2/A3 |
