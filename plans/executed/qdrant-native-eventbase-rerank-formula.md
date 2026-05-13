# Plan: Push EventBase Re-rank into Qdrant via Formula Query (A3 only)

**TL;DR:** A3 already pushes dense+sparse hybrid + RRF fusion server-side in a single `/query` call. The EventBase re-ranker (cosine + importance + persist + recency weighted sum) still runs in browser JS on the result list. Push it into the same Qdrant call as an outer `formula` query on top of the existing hybrid prefetch, so each per-collection query returns the final re-ranked top-K in one round-trip. Anchor boost, pairwise dedup, dual-query merge, and cross-collection merge stay client-side. A1/A2 paths are unchanged — they have no Qdrant to push to.

Predecessor: [qdrant-native-sparse-hybrid-rrf.md](qdrant-native-sparse-hybrid-rrf.md). This plan builds on the native-sparse hybrid landed there.

---

## Decisions baked into this plan

| # | Topic | Decision |
|---|---|---|
| 1 | Cosine-weight semantic | **Accept the shift.** Outer `$score` is the inner prefetch's RRF fused score, not raw cosine. Retune `w.cosine` after first eval pass. The "prefer vectorScore" code path goes away on A3. |
| 2 | Anchor boost | **Stays client-side** as a flat additive post-step on the returned top-K. Server-side tokenized-any-of would miss multi-token LLM-extracted keywords (e.g. `"贖身的儀式"`), so substring-on-message preserves correct semantics with negligible cost (microseconds for N≈20 candidates). |
| 3 | Missing `source_window_end` payload index | **Add it.** Integer payload index, same shape as the existing `timestamp` index. Required for `exp_decay` and the `range` filter to scale on large collections. |
| 4 | RRF vs DBSF | **RRF only.** GUI option for fusion method is already removed. Don't plumb DBSF through. Inner prefetch stays `fusion: "rrf"` (hardcoded as today). |
| 5 | Dedup overfetch | Outer `limit = finalTopK × 2` — matches today's `topK = finalTopK × 2` overfetch in [eventbase-retrieval.js:113](../core/eventbase-retrieval.js#L113). Inner `prefetch.limit` stays at the current `topK × 4`. |
| 6 | Dual-query / cross-collection merge | **Option (c)** — apply the formula in each per-`(collection, query-text)` call; concat-dedup-trim on the client after merging across calls. Lose the "max raw cosine wins" semantic in favor of "max final-score wins". Net: same merge structure, scoring just runs server-side per call. |

---

## What moves server-side and what stays client-side

```
retrieveEvents()
├── for each (collection × queryText):                  → MOVES TO QDRANT (formula in /query call)
│   ├── dense + sparse hybrid + RRF                     (already server-side)
│   ├── min-importance filter                           ← currently client
│   ├── dedup-depth filter (source_window_end < thr)    ← currently client
│   ├── weighted-sum scoring                            ← currently client
│   │     w.cosine    × $score
│   │     w.importance × importance/10
│   │     w.persist    × (should_persist == true ? 1 : 0)
│   │     w.recency    × exp_decay(source_window_end, origin=chatLength, scale=halfLife)
│   └── returns top (finalTopK × 2)                     ← currently overfetch is client-side
│
├── merge across collections / dual queries              STAYS CLIENT (concat by event_id, max final_score)
├── anchor boost (substring of stored keywords in user msg) STAYS CLIENT
├── pairwise dedup (event_type + character Jaccard + window proximity) STAYS CLIENT
├── dedup-depth secondary check (skipContextDedup branch) STAYS CLIENT (cross-chat case)
└── final slice to finalTopK                            STAYS CLIENT
```

---

## File-by-file changes

### Similharity side

#### `similharity/qdrant-backend.js`

**(a) Payload index** — add `source_window_end` to `createPayloadIndexes()`:

```js
// In the indexConfigs array, alongside timestamp/importance:
{ field: 'source_window_end', schema: 'integer' },
```

Qdrant supports adding payload indexes in-place; existing collections do **not** need rebuild. Add an idempotent migration helper that runs on plugin startup or the first hybrid call: `PUT /collections/{name}/index { field_name: 'source_window_end', field_schema: 'integer' }` — the call returns 200 if it already exists, so no version guard needed.

**(b) New method** `hybridQueryNativeWithRerank()` — alongside the existing `hybridQueryNative()`. Two methods rather than a flag because the body shape changes meaningfully and the existing path is in use for non-EventBase chunk search.

```js
async hybridQueryNativeWithRerank(
  collectionName,
  denseVector,
  sparseVector,
  topK,
  rerankParams,   // see schema below
  options = {},
  filters = {}
) { ... }
```

`rerankParams` schema:
```js
{
  weights: { cosine: 0.4, importance: 0.2, persist: 0.2, recency: 0.2 },  // pre-normalized client-side
  chatLength: 1842,                                // for recency origin
  halfLife: 368,                                   // = max(40, chatLength * 0.20), client-computed
  minImportance: 1,                                // for outer filter
  visibleThreshold: 1832,                          // = chatLength - dedupDepth; -1 disables the filter
  applyContextDedupFilter: true,                   // false when skipContextDedup (cross-chat case)
}
```

Body sent to Qdrant:
```js
{
  prefetch: [{
    prefetch: [
      { query: denseVector,  limit: options.prefetchLimit || topK * 4, filter: <tenant filter> },
      { query: sparseVector, using: 'text_sparse', limit: options.prefetchLimit || topK * 4, filter: <tenant filter> }
    ],
    query: { fusion: 'rrf' },
    limit: topK * 2,    // overfetch from hybrid into the formula stage
  }],
  query: {
    formula: {
      sum: [
        { mult: [weights.cosine,     '$score'] },
        { mult: [weights.importance, { div: ['importance', 10] }] },
        { mult: [weights.persist,    { condition: { key: 'should_persist', match: { value: true } },
                                       if_true: 1, if_false: 0 }] },
        { mult: [weights.recency,    { exp_decay: { key: 'source_window_end',
                                                    origin: chatLength,
                                                    scale: halfLife,
                                                    midpoint: 0.5 } }] }
      ]
    }
  },
  filter: {
    must: [
      { range: { importance:        { gte: minImportance } } },
      ...(applyContextDedupFilter && visibleThreshold >= 0
        ? [{ range: { source_window_end: { lt: visibleThreshold } } }]
        : []),
      ...tenantConditions  // content_type / type / sourceId as today
    ]
  },
  limit: topK,            // final outer limit = finalTopK * 2 (passed in as topK)
  with_payload: true,
}
```

> **Verify against Qdrant docs at implementation time:** exact JSON shape for `formula`, `condition`, and `exp_decay`. Qdrant's formula query landed in **1.13**; syntax above is the documented form as of writing. If `condition` is not the exact operator name, the alternative is to use a filter-derived boolean variable referenced from the formula.

The return shape stays the same as `hybridQueryNative()` — `{ hash, text, score, metadata, fusionMethod, nativeSparse }`. The `score` is now the formula output (re-ranked score), not the raw RRF fused score. Add a `rerankApplied: true` marker on each result so the client can branch.

#### `similharity/index.js`

Add a sibling route or extend `/chunks/hybrid-query`. Cleanest: a new route `/chunks/hybrid-query-rerank`, parallel to `/chunks/hybrid-query`. Body adds the `rerankParams` block; everything else is identical to the existing hybrid-query route. The route validates that `sparseQueryVector` and `rerankParams` are both present, calls `qdrantBackend.hybridQueryNativeWithRerank()`, returns the same envelope as `/chunks/hybrid-query` plus `rerankApplied: true`.

Rationale for a separate route: cleaner contract, no overloading of an existing endpoint that's also used by ChunkBase / non-EventBase chunk search.

### VectHare side

#### `backends/qdrant.js`

Add a new method `hybridQueryWithRerank(collectionId, searchText, topK, settings, rerankParams, hybridOptions)`. Mirrors the existing `hybridQuery()` ([qdrant.js:753](../backends/qdrant.js#L753)) but:

- POSTs to `/api/plugins/similharity/chunks/hybrid-query-rerank`
- Includes the `rerankParams` block in the body
- Result metadata includes the formula score in `score` (no separate `vectorScore` / `textScore` shown to the re-ranker — those fields aren't useful here)

The existing `hybridQuery()` stays untouched for ChunkBase and other non-EventBase callers.

#### `core/eventbase-retrieval.js`

Branch the per-`(collection, queryText)` call:

```js
// At the per-collection loop in retrieveEvents() (line 142 today):
const useNativeRerank = (
  settings.vector_backend === 'qdrant' &&
  settings.hybrid_native_prefer !== false &&
  settings.eventbase_native_rerank === true   // new opt-in flag, see below
);

if (useNativeRerank) {
  // Build rerankParams from current settings + chat state
  const rerankParams = {
    weights: _normalizeWeights({
      cosine:     settings.eventbase_rerank_w_cosine     ?? DEFAULT_WEIGHTS.cosine,
      importance: settings.eventbase_rerank_w_importance ?? DEFAULT_WEIGHTS.importance,
      persist:    settings.eventbase_rerank_w_persist    ?? DEFAULT_WEIGHTS.persist,
      recency:    settings.eventbase_rerank_w_recency    ?? DEFAULT_WEIGHTS.recency,
    }),
    chatLength,
    halfLife: Math.max(40, chatLength * 0.20),
    minImportance: settings.eventbase_retrieval_min_importance || 1,
    visibleThreshold: (settings.deduplication_depth ?? 0) > 0 ? chatLength - settings.deduplication_depth : -1,
    applyContextDedupFilter: !skipContextDedup,
  };
  // Each per-collection promise calls hybridQueryWithRerank instead of queryCollection
  promises.push(
    hybridQueryWithRerank(colId, queryText, finalTopK * 2, ebSettings, rerankParams)
      .then(({ hashes, metadata }) => /* same mapping as today */)
  );
} else {
  // Existing path — JS re-rank pipeline as today
  promises.push(queryCollection(colId, queryText, topK, ebSettings).then(...));
}
```

After the per-collection merge, the post-rerank pipeline simplifies:

```js
// When useNativeRerank: each candidate already carries _finalScore (= formula score)
// in meta.score. Min-importance and dedup-depth filters already applied server-side.
// So skip:
//   - importance filter (already done)
//   - rebuild weights / compute weighted sum (already done)
//   - recency function (already done)
//   - dedup-depth filter (already done unless skipContextDedup)
// Still do, client-side:
//   - anchor boost (additive on top of meta.score)
//   - pairwise dedup
//   - cross-chat dedup-depth (when skipContextDedup === false, but the per-collection
//     filter already handles that; this fallback only applies when client wanted to
//     skip the server filter, which doesn't happen in non-cross-chat case)
//   - final slice to finalTopK
```

Anchor boost adjustment (preserves current substring semantic):

```js
if (useNativeRerank) {
  for (const e of mergedCandidates) {
    const anchorBoost = anchorBoostAmount > 0 && anchorText && (e.keywords || []).some(
      k => k.length >= 2 && anchorText.includes(k.toLowerCase())
    ) ? anchorBoostAmount : 0;
    e._finalScore = (e.score ?? 0) + anchorBoost;
  }
  mergedCandidates.sort((a, b) => b._finalScore - a._finalScore);
} else {
  // Existing JS re-rank path as today
}
```

#### Settings + GUI

New setting: `eventbase_native_rerank` (bool, default **off**).
- Surfaced in **Core → EventBase** section as "Push EventBase re-rank to Qdrant (experimental)".
- Tooltip: "Compute the importance/persist/recency weighted score inside Qdrant instead of the browser. Requires Qdrant 1.13+. Anchor boost and dedup still run locally. Cosine weight semantics shift slightly — re-tune if recall changes."
- Gated visible only when `vector_backend === 'qdrant'` and `hybrid_native_prefer !== false`.

Default-off is deliberate: the cosine-weight semantic shift needs a real eval pass before turning on by default. After two weeks of opt-in with no regressions, consider flipping the default.

---

## Qdrant version requirement

Formula queries require **Qdrant 1.13+**. Add a version probe — either:

1. **At plugin startup**, check `GET /` (Qdrant root returns `{ "title": "qdrant - vector search engine", "version": "1.15.0" }` or similar). Cache the result, log a warning if < 1.13, refuse to enable `eventbase_native_rerank` if the version is too old.
2. **First-call probe**, lazily on the first `/chunks/hybrid-query-rerank` request — same logic, cached after first success.

Recommend option (1) — runs once at boot, fails fast, surface in plugin logs.

If Qdrant version is < 1.13: the route returns 400 with a clear error, VectHare side falls back to the JS re-rank path and disables the setting in GUI (greyed out with a tooltip explaining the version requirement).

---

## Semantic shifts — what to validate before flipping the default

### Shift 1: cosine weight operates on RRF fused score

**Before:** `w.cosine × vectorScore` where `vectorScore` is the raw cosine from the dense leg of the hybrid call (kept separately in metadata for this exact purpose — see [eventbase-retrieval.js:212-214](../core/eventbase-retrieval.js#L212-L214)).

**After:** `w.cosine × $score` where `$score` is the RRF fused score of the inner prefetch.

Practical impact:
- RRF score for the top hit is `≈ 1/(60 + 1) = 0.0164`; for rank 20 it's `≈ 1/80 = 0.0125`. Range is small and rank-derived.
- Raw cosine for a good hit is `≈ 0.6 - 0.9`; for a bad hit `≈ 0.1 - 0.3`. Wider, more discriminating.
- A `w.cosine` tuned against raw cosine will produce a vanishingly small contribution against RRF score. Need to either:
  - Re-tune `w.cosine` upward by ~30-40× (raw rough estimate from the scale ratio), or
  - Multiply the formula's `$score` term by a constant before mixing (e.g. `mult: [weights.cosine, mult: [40, '$score']]`). Cleaner — no user-visible change.

**Recommended:** include a hardcoded `RRF_SCORE_SCALE = 40.0` constant in the formula so the user-visible `w.cosine` retains roughly its old meaning. Document the constant clearly. After eval, adjust if needed.

### Shift 2: per-collection result is "max final-score wins" instead of "max raw cosine wins"

**Before:** Across multiple `(collection, queryText)` calls, when the same `event_id` appears in multiple results, the JS merge keeps the copy with the highest **cosine score** so the re-ranker downstream sees the best raw similarity signal ([eventbase-retrieval.js:163-167](../core/eventbase-retrieval.js#L163-L167)).

**After:** The merge sees re-ranked formula scores. The "winner" copy is the one with the highest combined importance/persist/recency-weighted score, not raw cosine. In practice this is a minor change — when an event is found by both queries, both copies typically share the same payload fields (importance, persist, source_window_end), so the formula scores are very close, and the dense leg's relative strength dominates.

This is acceptable and matches option (c) from the investigation report.

### Side-by-side comparison mode (`eventbase_compare_rerank`)

Purpose: let an opted-in user (with `eventbase_native_rerank: true`) verify that the native re-rank produces rankings sufficiently close to the JS re-rank before flipping the default. Pure observability — does not change which events get injected.

**Activation**: only meaningful when `eventbase_native_rerank === true`. When `eventbase_compare_rerank === true` is also set, the comparison runs; otherwise it's a no-op.

**Flow inside `retrieveEvents()`**:

```js
const compareMode = settings.eventbase_native_rerank === true
                 && settings.eventbase_compare_rerank === true;

if (useNativeRerank) {
  // Real path: run the native re-rank (this drives the returned events)
  const nativePromise = hybridQueryWithRerank(colId, queryText, finalTopK * 2, ebSettings, rerankParams);

  if (compareMode) {
    // Parallel JS pipeline for comparison only — uses the same queryText/topK
    // but goes through queryCollection() + JS re-rank. Results are not returned
    // to the caller, only logged.
    const jsPromise = queryCollection(colId, queryText, finalTopK * 2, ebSettings)
                        .then(r => _applyJsRerankInline(r, settings, chatLength, anchorText, anchorBoostAmount));
    promises.push(Promise.all([nativePromise, jsPromise]).then(([native, js]) => {
      _logComparison(colId, queryText, native, js);
      return native;  // native is what flows through to the rest of the pipeline
    }));
  } else {
    promises.push(nativePromise);
  }
} else {
  // useNativeRerank === false: existing JS path, no comparison possible
  promises.push(queryCollection(colId, queryText, topK, ebSettings).then(...));
}
```

**What `_logComparison` reports per `(collection, queryText)` pair**:

1. **Top-K overlap.** Intersection size of the top-K hash sets from each path. Reported as `overlap_at_k: 7/10` style.
2. **Symmetric difference.** Events in one top-K but not the other, with their ranks in each. Surfaces "the native path promoted event X to rank 3 but JS had it at rank 14" cases — the kind of disagreement that matters for the user-visible outcome.
3. **Rank correlation on the union.** Spearman ρ over the union of both top-K's (events absent from one side get a rank past the end of their list). Single scalar, easy to chart over time. Kendall τ-b is the more robust alternative if tied scores are common — pick one and stick with it.
4. **Per-event score-component delta** (verbose, optional sub-flag `eventbase_compare_rerank_verbose`). For each event in the union, log:
   - JS side: `cosine_contrib`, `importance_contrib`, `persist_contrib`, `recency_contrib`, `anchor_boost`, `final`
   - Native side: `formula_score`, `anchor_boost`, `final`
   - This identifies *which weight or signal* is causing rank divergence, not just whether one exists.
5. **Timing.** `native_ms` and `js_ms` for the per-call cost. The native path is one extra round-trip away from the JS path's baseline (queryCollection + JS map+sort), so the deltas should be small.

**Where logs go**:
- Always console (gated by `eventbase_debug_logging` to avoid noise when EventBase debug is off — i.e. compare mode shows nothing useful without debug logging on).
- Also into the `debug` object returned by `retrieveEvents` (line 374-380 today), under a new key `rerankComparison: [...]` — one entry per `(collection, queryText)`. The search-debug UI can render this as a side-by-side panel later if useful.

**Cost when on**: doubles the per-collection retrieval cost (one extra Qdrant call per (collection, queryText) — the JS-side `queryCollection`). Acceptable for a debug mode. Not safe to leave on in production.

### Pass/fail criteria for default-on

After the eval window (suggested two weeks of internal opt-in with compare mode on):

- **Quantitative**: Spearman ρ > 0.85 across ≥ 50 real queries spanning short and long chats. `overlap_at_k=10` ≥ 7 out of 10 on average.
- **Qualitative**: spot-check ≥ 10 queries with known-good answers (events the user remembers and expects). No regressions where the JS path retrieved the right event and the native path didn't.
- **Latency**: native path's per-call time within 1.2× of the JS path's per-call time (the native path replaces JS scoring with one extra Qdrant round-trip plus formula evaluation; should be slightly slower per call but eliminates the post-merge re-rank).
- **No production rollbacks** during the eval window.

---

## Rollout sequence

1. **Phase 0 (prep, no behavior change)**
   - Add `source_window_end` to the payload index list. Deploy. Verify existing collections pick up the index automatically (Qdrant adds in-place).
   - Probe Qdrant version at plugin startup, log it.

2. **Phase 1 (mechanism, off by default)**
   - Add `hybridQueryNativeWithRerank()` in `similharity/qdrant-backend.js`.
   - Add `/chunks/hybrid-query-rerank` route in `similharity/index.js`.
   - Add `hybridQueryWithRerank()` in `VectHare/backends/qdrant.js`.
   - Branch `eventbase-retrieval.js` on `settings.eventbase_native_rerank`.
   - Add the GUI toggle. Default off.
   - Add side-by-side comparison mode behind `eventbase_compare_rerank`.

3. **Phase 2 (eval window)**
   - Internal users opt in. Run side-by-side mode. Collect rank-correlation and spot-check data.
   - Adjust `RRF_SCORE_SCALE` constant if needed.
   - Adjust default `w.cosine` if needed (separate setting migration).

4. **Phase 3 (default-on)**
   - Once pass/fail criteria are met, flip default. Keep the toggle for rollback.

5. **Phase 4 (cleanup, optional)**
   - Once stable for a month and no rollbacks, consider removing the JS re-rank branch for the Qdrant path entirely. (Standard backend keeps its JS re-rank as today — that path doesn't change.)

---

## Out of scope

- **DBSF** — decision #4, GUI option already removed.
- **Pushing pairwise dedup to Qdrant** — Qdrant has no operator that compares each candidate against accepted candidates. Stays client-side.
- **Pushing cross-collection merge to Qdrant** — Qdrant has no cross-collection query. Stays client-side.
- **Pushing anchor boost to Qdrant** — semantic regression for multi-token LLM keywords. Stays client-side.
- **Changing A1/A2** — these paths have no Qdrant; nothing to push. The plan touches only the Qdrant code path.
- **Re-architecting the dual-query merge** — option (c) keeps the existing structure.

---

## Open questions to confirm at implementation time

1. **Formula JSON shape** — verify the exact field names (`condition` / `if_true` / `if_false`, `exp_decay` key/origin/scale/midpoint, `$score` reference) against the Qdrant docs for the version actually deployed. The shapes in this plan reflect what the docs document as of writing; minor field-name drift is plausible.
2. **`exp_decay` midpoint semantics** — Qdrant's `midpoint` is the score value reached at `distance == scale`. Setting `midpoint: 0.5` makes the function equal `0.5 ^ (age / halfLife)` (matching the current JS formula). Verify against actual Qdrant behavior in a small probe before relying on the math.
3. **Filter conditions inside `formula.condition`** — confirm Qdrant accepts the same filter object shape used at the top-level `filter`. If not, the persist boost needs an alternative encoding (e.g. a payload-typed integer `should_persist_int: 0 | 1` populated at upsert).
4. **RRF score scale constant** — `RRF_SCORE_SCALE = 40` is an estimate from typical hybrid score ranges. Confirm with a quick distribution probe on a real collection before flipping the default.
