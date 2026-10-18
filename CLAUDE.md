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
- **Auto Reformat** can still produce near-duplicate entries whose names differ
  by a suffix (e.g. "GAMA" vs "GAMA app"); merge only unifies exact name/alias
  keys.
- **Auto Reformat whole-document mode loses content with small models.**
  Gemini 3.5 Flash Lite given a 31k-char document in one call writes ~6k
  tokens and drops about a third of the facts (coverage check flags ~20
  paragraphs vs 0–2 batched), even with a length target in the prompt. That is
  why `reformat_single_pass` defaults off. Batches that also carry the whole
  document as read-only context kept batched-level coverage with fewer
  duplicates, at ~4× the input tokens (quadratic in document length); not
  implemented.
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
