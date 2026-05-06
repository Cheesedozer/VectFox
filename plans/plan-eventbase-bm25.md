# Plan: EventBase Hybrid Search (using existing hybridSearch)

**TL;DR:** Alter `core/eventbase-retrieval.js` to call the existing `hybridSearch` function when `hybrid_search_enabled` is true. This gives EventBase the same native/Qdrant hybrid (RRF/weighted) as the main pipeline, automatically falling back to client‑side fusion for backends that don’t support native hybrid. No new BM25 code, no extra exports.

---

## Goals
- Reuse `hybridSearch` from `core/hybrid-search.js` instead of reinventing client‑side BM25.
- Honour `hybrid_search_enabled` (new default = true), `prefer_native_backend_hybrid` (default = true), and `hybrid_fusion_method`.
- Keep dual‑query (user last message + full context) to maintain precision and recall.
- Preserve backward compatibility when hybrid is disabled.

---

## Implementation (single file change)

**Only modify [`core/eventbase-retrieval.js`](core/eventbase-retrieval.js).**

### Phase 1 – Add import and helper
Add at the top:

Create a small wrapper inside `retrieveEvents`:

### Phase 2 – Replace dual‑vector‑query block (lines ~115‑161)
Replace the current `if (dualQuery) { ... } else { ... }` with:


### Phase 3 – Skip keyword boost when hybrid is used
After building `rawCandidates`, add:

### Phase 4 – Debug logging
Add to the returned `debug` object:
- `hybridUsed: useHybrid`
- `fusionMethod: settings.hybrid_fusion_method` (only if hybrid used)

---

## Default settings (update in `index.js` / UI)

For **new installations**, the following defaults should be set in the `defaultSettings` object inside [`index.js`](index.js:50):

- `keyword_scoring_method: 'bm25'`   (changed from previous default of `'keyword'`)
- `hybrid_search_enabled: true`      (enables hybrid search for both main chat and EventBase)
- `prefer_native_backend_hybrid: true` (uses Qdrant/Milvus native hybrid when available)

The `keyword_scoring_method` setting remains meaningful for the main chat pipeline; EventBase now follows the global `hybrid_search_enabled` toggle (so the `keyword_scoring_method` value does not affect EventBase).
These defaults give users a stronger retrieval baseline out of the box, while still allowing them to change settings later.

---

## Why this is better than the original plan
- **No new BM25 code** – reuses battle‑tested `hybridSearch`.
- **Native Qdrant hybrid** works immediately when available; client‑side fallback for other backends.
- **Simpler** – only one file changes; no exports, no wrapper store function.
- **Respects user’s existing hybrid preferences** (RRF/weighted, native preference).

---

## Verification
| Scenario | Expected outcome |
|----------|------------------|
| `hybrid_search_enabled = true` (new default) | Uses hybrid (native or client) for both queries. |
| Qdrant + `prefer_native_backend_hybrid = true` | Fast native RRF/weighted fusion. |
| Standard backend + hybrid on | Falls back to client‑side fusion – still works. |
| `hybrid_search_enabled = false` | Falls back to current pure vector + keyword boost. |
| Single‑query case (`keywordQuery === searchText`) | Only one hybrid query is executed. |

---

## Question answered
> If "Prefer Native Backend Hybrid" is checked and backend is "standard", will it just ignore it?

**Yes.** `hybridSearch` checks `backend.supportsHybridSearch()`; for Standard backend it returns `false`, so it automatically falls back to the client‑side fusion path. The checkbox has no effect on Standard – harmless.

---

## Next steps
1. (No code changes yet – plan only) Review and approve this simplified approach.
2. When ready to implement, modify only `core/eventbase-retrieval.js` as described.
3. (Optional) Update default settings in `index.js` to enable hybrid by default.
