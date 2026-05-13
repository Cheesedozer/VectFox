# Plan: Native Qdrant Sparse Vectors + Hybrid Fusion + RRF

**TL;DR:** Move BM25 from plugin-side scoring to Qdrant-native sparse vectors with `modifier: idf`, and replace the dual-call (search + scroll) hybrid path with a single `/query` call using `prefetch` and server-side RRF. Tokenization stays in VectHare (reusing the existing CJK tokenizer in [core/bm25-scorer.js](../core/bm25-scorer.js)); the sparse vector `{indices, values}` payload is computed in the browser and shipped over the existing `/chunks/insert` and `/chunks/hybrid-query` endpoints. Both repos change — Similharity is **not** the only side touched.

---

## Answer to "is the change mainly on `similharity/qdrant-backend.js`?"

**No — it's split roughly 50/50.** Here's why:

- The CJK tokenizer (Intl.Segmenter + Jieba + TinySegmenter + bigram fallback) lives in [core/bm25-scorer.js](../core/bm25-scorer.js) on the **VectHare browser side**. Similharity has only a simple English tokenizer.
- Qdrant's `modifier: idf` needs the same tokenization at ingest and query — so the tokenizer must run wherever both ingest and query texts are first seen.
- Cleanest option: tokenize in VectHare for both ingest and query, ship sparse vectors `{indices, values}` to Similharity as opaque payload, and let Similharity pass them through to Qdrant unchanged.

**Surface area:**

| Side | Files touched | Role |
|---|---|---|
| VectHare | `core/bm25-scorer.js` (export hashing/encoder), new `core/sparse-vector-encoder.js`, `core/eventbase-store.js` / chunk insert sites, `backends/qdrant.js`, `index.js` (settings + version probe), UI tooltip | Tokenize → hash → sparse vector at ingest **and** query; send through plugin |
| Similharity | `qdrant-backend.js` (collection schema, insertVectors, hybridQuery rewrite), `index.js` (pass-through in `/chunks/insert` and `/chunks/hybrid-query`) | Collection bootstrap with sparse vector config, accept opaque sparse payload, call Qdrant `/query` with prefetch + RRF |

---

## Tokenizer decision — confirmed reuse, no new tokenizer

Reuse [core/bm25-scorer.js](../core/bm25-scorer.js) `tokenize()` end-to-end. That function already handles:
- Latin: lowercase + punctuation strip + stop-word removal + Porter stemming
- CJK: routes by script (Chinese → `Intl.Segmenter('zh')` or Jieba; Japanese → `Intl.Segmenter('ja')` or TinySegmenter; Korean → `Intl.Segmenter('ko')`)
- Mode switching via `setCjkTokenizerMode(mode)` (`intl` / `jieba` / `jieba_tw` / `tiny_segmenter`)
- Bigram fallback when `Intl.Segmenter` is unavailable

**Constraint:** the *same* tokenizer mode must be active at upsert and at query, or IDF stats won't match. Today this is already a requirement for the plugin-side BM25, but Qdrant's server-side IDF makes the constraint *harder* — a tokenizer-mode change requires a collection rebuild, not just a per-query realignment.

**Mitigation:** store the active CJK mode in collection metadata at first upsert / migration (Qdrant payload on a sentinel point with `type: "_vecthare_meta"`). On query, if the saved mode differs from the current mode, **refuse the query and show a modal popup** explaining the user must delete the collection and re-vectorize from scratch to switch tokenizer modes. See **Tokenizer Mode Lock — Mismatch Handling** below.

---

## Sparse vector format

Qdrant native sparse vector wire format:
```json
{
  "indices": [12345, 67890, 11111],   // uint32 token IDs
  "values":  [2.0,   1.0,   3.0]      // float term frequencies (or log(1+tf))
}
```

**Token → index hashing:** 32-bit unsigned hash (FNV-1a or CRC32) of the tokenized string. Hash collisions at scale (~50k unique tokens per typical chat corpus) are statistically negligible at 32 bits. No vocabulary file to maintain.

**Values:** raw term frequency. Qdrant computes IDF server-side via `modifier: idf`. We do **not** apply length normalization here — Qdrant handles that internally as part of its BM25-modifier scoring.

**Encoder location:** new file `core/sparse-vector-encoder.js` exporting:
```js
encodeSparseVector(text, options?) → { indices: Uint32Array, values: Float32Array }
encodeSparseQuery(text, options?)  → same shape, but TF capped at 1 (binary presence — query side)
```
Both delegate to `tokenize()` from `bm25-scorer.js`. No tokenizer code duplication.

---

## Collection schema change

In [similharity/qdrant-backend.js](../../similharity/qdrant-backend.js) `ensureCollection`, change the `PUT /collections/{name}` body from:
```js
{ vectors: { size: vectorSize, distance: 'Cosine' } }
```
to:
```js
{
  vectors: { size: vectorSize, distance: 'Cosine' },
  sparse_vectors: {
    text_sparse: { modifier: 'idf' }
  }
}
```

**Migration:** Qdrant does not support adding a sparse vector field to an existing collection in-place. Any collection that pre-dates this change must be recreated. Plan for two paths:

1. **Fresh collections** — automatic; first upsert creates the new schema.
2. **Existing collections** — add an "Upgrade to Sparse" button in VectHare's ChunkBase tab that:
   - Reads all points from the existing collection (scroll loop, paginated)
   - Drops the collection
   - Recreates with new schema
   - Tokenizes each point's `text` payload → sparse vector
   - Re-upserts in batches, **reusing the existing dense vectors** (no re-embedding needed; sparse is additive)

The migration is cheap because it does **not** re-embed. The dense vectors are kept as-is; we only compute and attach sparse vectors. For a 2000-event story this is purely tokenization cost (~seconds in the browser).

---

## Query path change

### Today (plugin-side, two API calls + JS fusion)
[similharity/qdrant-backend.js:572-861](../../similharity/qdrant-backend.js) `hybridQuery()`:
1. `POST /collections/{c}/points/search` — dense ANN, topK × 2
2. `POST /collections/{c}/points/scroll` — keyword candidates via `should: keywordConditions` filter, loops until exhausted
3. JS-side BM25 over scrolled candidates (with corpus stats computed per-query)
4. JS-side RRF or weighted fusion
5. JS-side dual-signal bonus (×1.08) and single-signal penalty (×0.55 / ×0.60)

### After (one API call, all server-side)
```js
POST /collections/{c}/query
{
  prefetch: [
    {
      query: <denseQueryVector>,
      using: "",                // default dense vector
      limit: topK * 4
    },
    {
      query: { indices: [...], values: [...] },
      using: "text_sparse",
      limit: topK * 4
    }
  ],
  query: { fusion: "rrf" },     // server-side RRF; alternative: "dbsf" (distribution-based)
  limit: topK,
  filter: { ... },              // existing tenant/content_type filters unchanged
  with_payload: true
}
```

**`prefetch.limit`** at `topK * 4` matches the spirit of the current `topK * 2` for dense + the scrolled keyword set, while keeping per-vector candidate pools bounded. Tune after first round of testing.

---

## A/B/C testing — 3 fusion modes, pick 1 winner, delete the other 2

The current plugin-side fusion has three extras Qdrant does **not** replicate natively:
1. **Dual-signal bonus** — up to +8% boost for docs ranked in both lists
2. **Single-signal penalty** — ×0.55 vector-only, ×0.60 keyword-only
3. **Per-call choice** between RRF and weighted-linear fusion

To compare them fairly, three fusion modes coexist temporarily during A/B/C testing.

### The three modes

Setting: `hybrid_fusion_mode` (dropdown in **Core → Hybrid Search & BM25**)

| Mode | What it does | IDF source | Bonuses/penalties |
|---|---|---|---|
| `'legacy'` | Current path: dense search + keyword scroll + plugin-side BM25 + plugin-side fusion | ANN-bounded (biased) | Yes |
| `'native_sparse_legacy_fusion'` | Qdrant `/query` with `prefetch` but **no `fusion`** — server returns un-fused per-prefetch lists; browser applies bonuses/penalties + RRF | Global corpus (accurate) | Yes |
| `'native_rrf'` | Qdrant `/query` with `prefetch` + `fusion: "rrf"` — server fuses and returns final ranked list | Global corpus (accurate) | No |

Why three: comparing `'legacy'` directly to `'native_rrf'` confounds two variables (IDF accuracy + presence of bonuses). The middle option `'native_sparse_legacy_fusion'` isolates them — it shares accurate IDF with `'native_rrf'` and shares bonuses with `'legacy'`. After A/B/C you'll know which variable actually moved the needle.

### Data transfer for `'native_sparse_legacy_fusion'`

Bounded by `prefetch.limit = topK * 4` per prefetch × 2 prefetches:
- For `topK=20`: ≤ 160 docs returned, ~1KB each → **~160KB per query**
- Not the full corpus; corpus stays server-side
- Less data than today's `'legacy'` path on long stories (the current scroll loop can return more)

### Where the modes diverge in code

| File | `'legacy'` | `'native_sparse_legacy_fusion'` | `'native_rrf'` |
|---|---|---|---|
| `similharity/qdrant-backend.js` | Existing `hybridQuery()` | New `hybridQueryNativeUnfused()` | New `hybridQueryNative()` |
| `similharity/index.js` `/chunks/hybrid-query` | Routes by `body.fusionMode` | same | same |
| `VectHare/backends/qdrant.js` | Sends `fusionMode: 'legacy'` | Sends `fusionMode: 'native_sparse_legacy_fusion'` + sparse query vector | Sends `fusionMode: 'native_rrf'` + sparse query vector |
| `VectHare/core/hybrid-search.js` | No change | New JS-side fusion fn over un-fused prefetch lists (reuses existing bonus/penalty math) | No change |

### Cleanup contract (after a winner is picked)

**All A/B-only code is tagged with `// ABC-DELETE` so a single grep finds every line to remove.** When you pick a winner, the cleanup is purely mechanical:

```
grep -r "ABC-DELETE" .       → list all sites
delete all marked blocks
delete 2 of the 3 query methods in qdrant-backend.js
delete 2 of the 3 client branches in VectHare/backends/qdrant.js
delete the dropdown + hint from ui-manager.js
collapse hybrid_fusion_mode setting to a hardcoded constant in index.js defaultSettings
```

Files to fully delete or partially trim per winner:

| Winner | Delete entirely | Trim |
|---|---|---|
| `'legacy'` wins | New sparse encoder, sparse-vector ingest path, `hybridQueryNative*` methods, migration tool, the entire rest of this plan beyond Phase 1 testing infra | Drop sparse vector schema from `ensureCollection` |
| `'native_sparse_legacy_fusion'` wins | `hybridQuery()` (legacy plugin-side BM25), keyword-scroll path, `_calculateBM25Scores`, plugin-side `_fuseResults` BM25 branch | Keep JS fusion fn but rename to drop `_legacy_` suffix |
| `'native_rrf'` wins | `hybridQuery()` (legacy), `hybridQueryNativeUnfused()`, JS fusion fn, all bonus/penalty math in [core/hybrid-search.js](../core/hybrid-search.js) | Cleanest — Qdrant does everything |

**Tag every A/B-only line, branch, and method with `// ABC-DELETE` before merging Phase 3.** This is the load-bearing piece of the cleanup contract.

---

## Phasing

### Phase 1 — Sparse encoder (VectHare, no Qdrant calls yet)
- Add [core/sparse-vector-encoder.js](../core/sparse-vector-encoder.js) with `encodeSparseVector` / `encodeSparseQuery`
- Unit tests in `tests/sparse-vector-encoder.test.js`:
  - Same text → same sparse vector (deterministic)
  - CJK tokenizer mode change → different indices (regression guard)
  - Hash collision rate stays < 0.1% on a 50k-token sample
- No production wiring yet; safe to land first.

### Phase 2 — Ingestion path
- Wire `encodeSparseVector` into the upsert flow at the EventBase ingest site (and chunk ingest if we want sparse for those too — likely yes for character cards and lorebooks where proper nouns matter).
- Extend `/chunks/insert` request body: `items[].sparseVector` (optional, opaque pass-through).
- In [similharity/qdrant-backend.js](../../similharity/qdrant-backend.js) `insertVectors()`: when `item.sparseVector` is present, change Qdrant point shape from `{ vector: [...] }` to `{ vector: { "": [...], text_sparse: { indices, values } } }`.
- Update `ensureCollection` to declare `sparse_vectors.text_sparse: { modifier: 'idf' }`.
- Gate behind a settings flag `qdrant_native_sparse_enabled` (default `false` initially; flip to `true` after Phase 4).
- Persist active tokenizer mode in a sentinel collection-metadata point (`type: "_vecthare_meta"`) at first upsert.

### Phase 3 — Query path (new endpoint, old endpoint preserved)
- Add `hybridQueryNative()` method to [similharity/qdrant-backend.js](../../similharity/qdrant-backend.js) that calls Qdrant `/query` with `prefetch` and `fusion: "rrf"`.
- In [similharity/index.js:1224](../../similharity/index.js) `/chunks/hybrid-query` handler: accept a `nativeSparse: true` flag in the body; route to `hybridQueryNative()` when set, else the existing `hybridQuery()`.
- In [VectHare/backends/qdrant.js](../backends/qdrant.js) `hybridQuery()`: if `settings.qdrant_native_sparse_enabled`, compute the sparse query vector locally, include it and `nativeSparse: true` in the request body. The existing fetch URL stays the same.
- Tokenizer-mode mismatch check: before the call, read the collection metadata sentinel; if mode differs, fall back to the old path and warn.

### Phase 4 — Migration tool (DEV-ONLY, throwaway code)

**Scope:** product is pre-production. The migration tool only needs to run on the developer's machine once. Treat it as throwaway code — explicitly designed to be deleted after use.

**Placement:** **Action tab**, in a dedicated section labeled **"Dev Tools (Remove Before Release)"** at the bottom of the tab. Button: *"Upgrade Collection to Native Sparse Vectors"*. Tooltip: *"One-time dev migration. Re-tokenizes existing text into Qdrant-native sparse vectors. Does not re-embed (no API cost). Delete this section before release."*

**Easy-delete contract:**

All migration code lives in dedicated files (no edits to existing files except a single import line, also tagged):

| File | Purpose | Delete how |
|---|---|---|
| `core/migrate-to-sparse.js` (new) | Browser-side migration driver: scroll → tokenize → upsert | `rm` |
| `similharity/routes/migrate-to-sparse.js` (new, mounted by index.js) | Server endpoints: `/chunks/migrate-to-sparse/scroll`, `/chunks/migrate-to-sparse/upsert`, `/chunks/migrate-to-sparse/swap` | `rm` + remove one `router.use(...)` line from `index.js` |
| `ui/migrate-to-sparse-panel.html` snippet (new partial) | The button + progress UI for the Action tab Dev Tools section | `rm` + remove one `<!-- @include -->` marker from `ui-manager.js` |

Every other touch is single-line and tagged `// MIGRATE-DELETE`:
- One import in [core/migrate-to-sparse.js](../core/migrate-to-sparse.js) entry point
- One `router.use` in [similharity/index.js](../../similharity/index.js)
- One section block in [ui/ui-manager.js](../ui/ui-manager.js)

**Deletion checklist (one paragraph in CHANGELOG when removed):**
```
grep -r "MIGRATE-DELETE" .   → expect 3 hits, remove all
rm core/migrate-to-sparse.js
rm similharity/routes/migrate-to-sparse.js
rm ui/migrate-to-sparse-panel.html
```

**Flow (when button is clicked):**
1. Browser → `POST /chunks/migrate-to-sparse/create { collectionId }` — server creates `<name>_v2` with sparse schema
2. Browser scrolls `<name>` in 250-point batches via existing `/chunks/list` endpoint
3. For each batch: tokenize each `payload.text` locally → `{indices, values}`
4. Browser → `POST /chunks/migrate-to-sparse/upsert { collectionId: '<name>_v2', points: [...] }` — server upserts kept-dense + new-sparse
5. After all batches: Browser → `POST /chunks/migrate-to-sparse/swap { from: '<name>_v2', to: '<name>' }` — server uses Qdrant aliases to atomically swap, then drops old
6. Browser persists the active CJK tokenizer mode into the new collection's metadata sentinel point (see Tokenizer Mode Lock section)

**Why browser-side tokenization for migration:** the rich CJK tokenizer only exists in the browser. Sending text out and back adds bandwidth but no meaningful latency (this is a one-time op, runs at ~3-4s for a 2000-event chat).

**Why aliases:** if the browser closes mid-migration, the original collection is untouched and queries keep working. Half-built `<name>_v2` is dead data to drop on retry. Without aliases, an interrupted migration breaks queries.

**Progress UI:** reuse existing ProgressTracker. Show *"Migrating 1240 / 5000 events..."* + cancel button.

**No backwards-compat:** since this is dev-only and runs once, the migration tool does **not** need to handle:
- Resuming from partial state (just delete `<name>_v2` and rerun)
- Multiple concurrent migrations (single-user dev machine)
- Old VectHare clients (developer controls both ends)

Skip everything that would be required for a real user-facing migration.

### Phase 5 — Cleanup (after a stable release)
- Delete plugin-side BM25 scoring (`_calculateBM25Scores`, `_fuseResults` bonus/penalty logic) from [similharity/qdrant-backend.js](../../similharity/qdrant-backend.js).
- Delete the keyword-scroll path.
- Delete A2 client-side fallback in [core/hybrid-search.js](../core/hybrid-search.js) if no longer needed (keep A1 for non-Qdrant backends like Vectra).
- §13 doc matrix collapses: A1 stays for Vectra / non-native; A3 becomes "native sparse"; A2 is gone.

---

## Settings additions ([index.js](../index.js) defaultSettings)

```js
qdrant_native_sparse_enabled: false,       // master switch
qdrant_sparse_query_limit_multiplier: 4,   // prefetch.limit = topK * this
hybrid_fusion_mode: 'legacy',              // ABC-DELETE: 'legacy' | 'native_sparse_legacy_fusion' | 'native_rrf'
qdrant_sparse_fusion: 'rrf',               // 'rrf' | 'dbsf' (only used when mode=='native_rrf')
```

UI additions:
- **Core → Hybrid Search & BM25:**
  - Toggle: *"Enable Qdrant Native Sparse Vectors"* — hint: *"Requires Qdrant 1.10+; existing collections must be migrated."*
  - Dropdown: *"Hybrid Fusion Mode"* (3 options, tagged `// ABC-DELETE`) — only visible when sparse vectors enabled
- **Action → Dev Tools section** (tagged `// MIGRATE-DELETE`): the migration button

---

## Tokenizer Mode Lock — Mismatch Handling

Once a collection is upserted (or migrated) with sparse vectors, the active CJK tokenizer mode at that time becomes **load-bearing**. Qdrant's `modifier: idf` computes IDF over whatever token IDs we send; if a later query tokenizes the same Chinese text differently (Jieba vs. Intl.Segmenter produces different segmentation), the query's sparse indices won't match any indexed terms and BM25 silently returns garbage.

### Detection

On every hybrid query (when `qdrant_native_sparse_enabled` is true):
1. Read the sentinel metadata point from the target collection (one extra Qdrant scroll, cached per-session)
2. Compare `metadata.cjk_tokenizer_mode` against `getCjkTokenizerMode()` from [core/bm25-scorer.js](../core/bm25-scorer.js)
3. If they differ → abort query, surface modal

### User-facing modal

Title: **"Tokenizer Mode Mismatch"**

Body:
```
This collection was vectorized with the "<saved_mode>" CJK tokenizer.
Your current setting is "<current_mode>".

Mixed-mode queries produce inaccurate results because BM25 indices are
tokenizer-specific.

To switch tokenizer modes for this collection, you must:
  1. Delete the collection
  2. Re-vectorize all content from scratch

Options:
  [Switch back to <saved_mode>]   (recommended — keeps existing data)
  [Open Settings]                 (to change mode and acknowledge re-vectorize)
  [Cancel query]
```

Default action: *"Switch back to `<saved_mode>`"* — one-click revert restores working queries.

### Why not auto-revert silently

A silent revert hides a real user intent (they changed the setting on purpose). The popup forces a conscious decision: keep your data and revert the mode, or accept that you're re-vectorizing.

### Where to write it

- Sentinel write: in the migration tool (Phase 4) and in the first-upsert path of a fresh collection (Phase 2, `insertVectors` first-call detection)
- Sentinel read + mismatch check: in [VectHare/backends/qdrant.js](../backends/qdrant.js) `hybridQuery()`, gated by `qdrant_native_sparse_enabled`
- Modal: new function in [ui/ui-manager.js](../ui/ui-manager.js) `showTokenizerMismatchModal(saved, current, collectionId)`; reuses SillyTavern's existing modal framework

### Cleanup

The mismatch check is **not** A/B-only — it's permanent infrastructure for whatever fusion mode wins. Do not tag with `// ABC-DELETE`.

---

## Qdrant version requirement

- `modifier: idf` on sparse vectors → Qdrant **1.10+**
- `/query` API with `prefetch` and `fusion` → Qdrant **1.10+**

Add a one-time probe in [backends/qdrant.js](../backends/qdrant.js) init: `GET /` returns `{ version: "x.y.z" }`. Parse; if `< 1.10`, force `qdrant_native_sparse_enabled = false` and surface a warning in the UI. Users on Qdrant Cloud are already past this; only self-hosted Qdrant < 1.10 is at risk.

---

## Risks & open questions

1. **Hash collisions at corpus growth** — 32-bit hashes give ~1 in 2³² collision per token pair; over 50k unique tokens, expected collisions ≈ 0.3. Worst case a query keyword silently matches an unrelated doc token; impact is similar to a noise word. If we ever observe quality regressions, switch to 64-bit hashes — Qdrant's sparse vector indices accept uint32; 64-bit would require folding, but Qdrant has had discussions about widening this. Worth filing as a follow-up only if observed.
2. **Multitenancy collection (`vecthare_multitenancy`)** — single shared collection means all content types pay the sparse-vector storage cost even if (e.g.) image OCR data doesn't benefit. Likely fine; storage cost is small (~1-3 KB / point at this corpus length). Verify after Phase 2 with a `du` on the Qdrant data dir.
3. **Bonus/penalty regression** — addressed by the 3-mode A/B/C above. Winner determined empirically before any deletion.
4. **Migration interruption** — dev-only tool; rerun after fixing. Atomic alias swap means original collection is intact until migration completes.
5. **Tokenizer-mode lock** — handled by sentinel + modal popup; see **Tokenizer Mode Lock — Mismatch Handling** section.

---

## Estimated effort

| Phase | Scope | Effort |
|---|---|---|
| 1. Sparse encoder + tests | VectHare only | 0.5 day |
| 2. Ingestion wiring + sentinel + tokenizer-lock modal | Both repos + UI | 1.5 days |
| 3. Native query paths (×2: unfused + RRF) + fusion mode dropdown | Both repos | 1.5 days |
| 4. Migration tool (dev-only, throwaway) + alias swap | Both repos + UI | 1 day |
| 5. A/B/C validation against long-story chat | Empirical, no code | 0.5 day |
| 6. Cleanup (delete losing 2 of 3 modes + migration tool) | Both repos | 0.5 day |
| **Total** | | **5.5 days** |
