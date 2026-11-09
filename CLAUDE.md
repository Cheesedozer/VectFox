# VectFox — Findings Log

**This file is a findings log, not project instructions.**

It records what is still open after the cleanup on branch
`claude/laughing-gauss-utewp6`. Items from the original audit that were fixed,
deleted or found to be inaccurate have been removed; `git log` holds the
history (dead providers, unused imports and exports, the conditional-activation
barrel, the lock facade, the rerank compare harness, utils trimming, and the
fixes for the chunker fallback, corpus-stats N, emotion cache key, kana double
count, prompt lookup, blank EventBase windows, planner scores and PNG
re-export).

Two rules still apply:

- **Characterization tests pin current behaviour, including bugs.** Fixing a
  bug means editing its test on purpose.
- **Confirm intent before deleting defensive-looking code.**
  `tests/dead-code-deletion-contract.test.js` protects at least one tripwire
  (the `case 'chat':` throw in `generateCollectionId`).

---

## 1. Known defects (not fixed)

- **Three different "is this CJK?" tests.** `core/summarizer.js:~176` divides
  by `text.length` (> 0.1); `core/eventbase-extractor.js` `_detectScript`
  (0.6 / 0.2 of cjk+latin) and `_inferLanguageHint` (< 0.15). Ranges differ
  from `core/script-segmentation.js` too (§3.2). Low impact for
  English-majority content.
- **`core/summarizer.js` `_callOpenRouter` / `_callVLLM`** take `timeoutMs`
  that no caller passes (30 s default is unconditional) and an
  `originalLength` argument that is never read.
- **14 empty `catch {}` blocks** in `core/`, mostly around `toastr.*` calls:
  `content-vectorization.js`, `eventbase-workflow.js`,
  `world-info-integration.js`, `model-config-notifier.js`,
  `collection-loader.js`, `api-keys.js`, `lorebook-rename-detector.js`,
  `tokenizer-lock.js`.
- **Pointless local aliases:** `content-vectorization.js` `baseName =
  sourceName`, `eventbase-extractor.js` `prompt = basePrompt`,
  `collection-loader.js` `cacheKey = registryKey`.
- **`core/keyword-boost.js:~82`** — comment *"for some reason, bigger value
  speed up retrival"* above `= 5000`; the constant's rationale is unknown.
- **Auto Reformat batches run in sequence against a ledger** of the entries
  written so far (`buildLedgerText`); a batch answers with new entries and
  `{"op": "extend"}` additions. On an 89k-char world bible, Claude Haiku 5.5,
  one run each, 200-detail checklist judged by Sonnet 5.5: independent
  batches (the old default) 274 records → 105 merged, ~9 near-duplicates
  left, 33% of sentences restating another entry, 99.5% details, 7 judged
  errors; whole-document 94 entries, 12% restated, 95%, 1 error; ledger (as
  shipped, two runs) 131–134 entries, 0 merged, 12–18% restated, 96.5–97.5%,
  0–1 errors, about the same cost, ~2× the time. Prototypes that also put the whole document in every call
  scored no better than the ledger alone, and an outline-first variant
  (plan entries, then fill groups in parallel) removed duplicate entries but
  restated more (35%) with 12 errors. Run-to-run noise is a few points of
  recall and about six points of restated sentences.
- **The ledger's detail is a setting because models differ**
  (`reformat_ledger_detail`). Shown entry bodies ('full'), Gemini 3.5 Flash
  Lite wrote half as many entries and kept 88% of the checklist (old
  independent batches: 99%); with names only ('names') it kept 99%. Haiku on
  'names' kept 100% but restated 27% of sentences. Each detail has its own
  note in `_buildNotes`: with the completeness-first wording that 'names'
  needs, Haiku on 'full' restated 23% in one run (12–18% with its own note),
  which is inside what noise could explain.
  The default is 'full', so a small model on default settings loses detail
  until the user switches; nothing detects the model.
- **Auto Reformat is not tested on documents longer than ~30 pages.** The
  ledger lists every unmentioned entry by name and first sentence, and drops
  to names only above 120k characters; nothing bounds it beyond that.
- **Whole-document mode still depends on the model**, so
  `reformat_single_pass` defaults off. On a 31k-char world bible: Claude
  Haiku 5.5 medium effort 99%; Gemini 3.5 Flash Lite (any effort) and 3.8
  Flash high ~88% — they summarize long replies. `estimateTokens` (chars/4)
  under-counted the 89k-char document by ~30% (22k vs 29k real tokens).
- **The coverage check is report-only.** The per-batch repair call was
  removed: with it off, recall was unchanged, and its "missing facts" were
  mostly "See also" lines and paraphrased words, which produced junk and
  duplicate entries. Its fact tokens still include any lowercase word of 8+
  letters, so a faithful paraphrase can lower a paragraph's score.
- **Keyword tag weights are decorative.** `applyQueryKeywordBoost` sets a
  matched chunk's score to 1.0 whatever the tag's weight, and the header of
  `keyword-boost.js` still describes additive weights. One-word tags only
  match words `extractChatKeywords` returns (capitalised, mid-sentence).
- **Split Auto-Reformat entries are rejoined at retrieval**
  (`joinSplitEntriesStage`, `core/chunk-assembly.js`): parts are found in the
  `/chunks/list` listing by `reformatRunId` + name + hidden + part count. On a
  backend whose listing has no payload `text`, only the retrieved parts are
  joined. A part edited by hand is used as edited, without its header removed.
- **`max_injected_chunks` (default 20) caps ChunkBase chunks only**, after the
  chat dedup; lorebook (WI) entries and EventBase events have their own
  limits. Cross-collection dedup is exact text only, so two Auto-Reformat runs
  of one file (different wording) still both inject.
- **EventBase `should_persist` is true on every stored event** in the three
  real chats checked (347 of 347; two extraction models), so its 15% weight
  is a constant and ranking is relevance + recency + a little importance
  (mostly 7–9). The extraction examples all show `true`, and ephemeral events
  tend to fall under `eventbase_min_importance_store` anyway.
- **EventBase's relevance floor is off by default**
  (`eventbase_min_similarity`). The native rerank scores candidates by RRF
  rank (~1.0 for the top hit of any query), so with the floor off an
  unrelated message still injects top-K events. The floor is a dense
  `score_threshold` in the plugin (Similharity 3.3.5,
  `rerankParams.minSimilarity`; older plugins ignore it silently) and a
  cosine filter on the JS path, where candidates with only a fused score
  pass. It stays off because the value is model-specific: single-sentence
  queries against real events scored, unrelated / related, ≤0.59 / ≥0.67 on
  google/gemini-embedding-2 and ≤0.41 / ≥0.55 on qwen/qwen3-embedding-8b.
  Not measured with the multi-message query text retrieval actually sends.
- **EventBase duplicate suppression compares wording**
  (`DUPLICATE_TEXT_SIMILARITY` = 0.4 word Jaccard). Calibrated on English
  events only; the CJK path (character pairs) is unit-tested, not measured.
- **JSON schema (`response_format`) for Auto Reformat** was measured and not
  adopted: no completeness gain, lower recall for Flash Lite, and no parse
  failures to fix. Through ST's proxy it would have to be sent as
  `json_schema`; ST does not forward a raw `response_format` to OpenRouter, so
  `agentic-retrieval.js`'s `response_format: json_object` is currently dropped
  (harmless — its parser accepts plain JSON).
- **Similharity plugin (separate branch) `queryCollection`** uses
  `POST /points/search`, which Qdrant 1.19 dropped from its OpenAPI spec. It
  still works on 1.19 but is slated for removal; the other read paths already
  use `/points/query`.

Corrections to the original audit: the purge in `collection-loader.js` already
receives plugin backend names (no remap needed); the `String()` coercions in
`chunking.js` are the non-string arms of ternaries; the
`eventbase-workflow.js` "aliases" are snapshots taken before mutation.

## 2. Test-only / external surfaces (keep)

`core/emotion-classifier.js` has no internal consumers; it exists for
`window.VectFoxEmotionClassifier`, an external API used by the Cotton-Tales
extension. Do not delete it as unused.

`backends/qdrant.js` `knownSources`, `core/providers.js`
`REMOVED_PROVIDER_SETTING_KEYS`, and the `bananabread_api_key` cleanup in
`api-keys.js` mention removed providers on purpose (old registry keys and
settings migration).

## 3. Duplication left in place

### 3.1 The four LLM feature modules

`summarizer.js`, `eventbase-extractor.js`, `reformat-extractor.js` and
`agentic-retrieval.js` share `core/llm-transport.js` but keep separate error
classes, config resolvers and JSON-repair parsers by design ("this feature must
stand on its own…" — `core/reformat-schema.js`). `_parseJsonArray` and
`_parseReformatArray` are the same algorithm. Revisit only as a deliberate
trade of isolation for less code.

### 3.2 CJK ranges

`core/script-segmentation.js` is the widest definition; `keyword-boost.js`
declares its own `CJK_CHAR_RE` (no Hangul); summarizer/eventbase-extractor use
a third set. Unifying changes tokenisation and scoring — needs a retrieval
before/after comparison.

### 3.3 `corpus-stats.js` `_pluginBackendName`

Same logic as `collection-ids.js` `getRegistryBackend`. Blocked by
`tests/corpus-stats.test.js`, whose `script.js` / `extensions.js` mocks lack
the exports `collection-ids.js` imports.

### 3.4 Small idioms

- `_simpleHash` (eventbase-extractor) and `_djb2` (eventbase-workflow) are
  byte-identical. The "circular dep" comment is wrong — the workflow already
  imports the extractor — so these could be merged.
- Snippet builders disagree on order: `eventbase-store.js` slices then
  normalises whitespace; `prompts-i18n.js` normalises then slices.
- ~12 inline clamps, ~8 score-desc comparators, ~17 truncate-with-ellipsis
  sites, 81 direct `extension_settings.vectfox` reads, `/api/plugins/similharity/`
  string-built in many places, the `/chunks/list` envelope built 4+ times.
- `DEFAULT_MAX_TOKENS` / `DEFAULT_TIMEOUT_MS` mean different values in
  summarizer / eventbase-extractor / reformat-extractor.
- Collection prefix literals bypass `COLLECTION_PREFIXES` in
  `world-info-integration.js`, `lorebook-invalidation.js`,
  `eventbase-workflow.js`, `ui/ui-manager.js`.

## 4. Complexity inventory (not refactored)

| Lines | Function |
|---|---|
| 760 | `eventbase-workflow.js` `runEventBaseIngestion` |
| 366 | `eventbase-retrieval.js` `retrieveEvents` |
| 321 | `content-vectorization.js` `vectorizeContent` |
| 311 | `chat-vectorization.js` `rearrangeChat` |
| 259 | `api-keys.js` `migrateLegacyApiKeys` (transient; deletion candidate) |
| 252 | `collection-export.js` `importCollection` |
| 239 | `wiki-search-index.js` `createWikiIndex` |
| 194 | `core-vector-api.js` `insertVectorItems` |

Decomposing these is a behaviour-risk exercise that needs its own plan and
tests.

## 5. Do not touch

`core/vendor/` is third-party (TinySegmenter, wikitext2plaintext, jieba WASM).
