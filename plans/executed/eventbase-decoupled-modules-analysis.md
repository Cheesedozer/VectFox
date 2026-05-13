# EventBase Decoupling Analysis — Complete Module Scan

**Date:** 2026-05-05
**Scope:** All `*.js` files in the project, checked for EventBase coupling in **both directions**:
- **Forward (→):** file imports/references an eventbase module or `eventbase_*` setting
- **Reverse (←):** file is imported BY an eventbase module (EventBase depends on it)

---

## 1. Core EventBase Modules (the pipeline itself)

These 6 files form the EventBase pipeline. They all depend on each other internally.

| File | Role | Own imports (non-eventbase project deps) |
|------|------|----------------------------------------|
| [`core/eventbase-schema.js`](core/eventbase-schema.js) | Schema constants, validator, embed-text builder | None — leaf module |
| [`core/eventbase-extractor.js`](core/eventbase-extractor.js) | LLM extraction + JSON parsing | `core/text-cleaning.js` |
| [`core/eventbase-store.js`](core/eventbase-store.js) | Qdrant storage + fingerprint cache | `core/core-vector-api.js`, `core/collection-ids.js`, `core/collection-loader.js` |
| [`core/eventbase-retrieval.js`](core/eventbase-retrieval.js) | Vector retrieval + re-ranking | `core/collection-ids.js`, `core/keyword-boost.js` |
| [`core/eventbase-injection.js`](core/eventbase-injection.js) | Event formatting for prompt injection | None — leaf module |
| [`core/eventbase-workflow.js`](core/eventbase-workflow.js) | Orchestration (ingestion + retrieval) | `core/collection-ids.js`, `core/constants.js`, `core/core-vector-api.js`, `core/collection-metadata.js`, `ui/progress-tracker.js` |

**Dependency graph (non-eventbase project files only):**
```
eventbase-schema.js       (no project deps)
eventbase-injection.js    (no project deps)
eventbase-extractor.js    → text-cleaning.js
eventbase-store.js        → core-vector-api.js, collection-ids.js, collection-loader.js
eventbase-retrieval.js    → collection-ids.js, keyword-boost.js
eventbase-workflow.js     → collection-ids.js, constants.js, core-vector-api.js,
                            collection-metadata.js, progress-tracker.js
```

---

## 2. Files with REVERSE Coupling ← (imported BY EventBase — EventBase depends on them)

These files have **zero** EventBase references in their own code. They don't know EventBase exists.
However, **removing or breaking these files would break the EventBase pipeline**.

| File | Imported by | What EventBase uses | Also has own deps? |
|------|-----------|-------------------|-------------------|
| [`core/text-cleaning.js`](core/text-cleaning.js) | eventbase-extractor | `cleanText()` | ST only |
| [`core/collection-ids.js`](core/collection-ids.js) | eventbase-store, eventbase-retrieval, eventbase-workflow | `getChatUUID()`, `buildEventBaseCollectionId()`, `VECTHARE_EVENTBASE` constant | ST only |
| [`core/collection-loader.js`](core/collection-loader.js) | eventbase-store | `registerCollection()` | → core-vector-api, collection-metadata, collection-ids |
| [`core/collection-metadata.js`](core/collection-metadata.js) | eventbase-workflow | `isCollectionEnabled()`, `isCollectionLockedToChat()` | → collection-ids |
| [`core/core-vector-api.js`](core/core-vector-api.js) | eventbase-store, eventbase-workflow | `insertVectorItems()`, `queryCollection()`, `getSavedHashes()` | → keyword-boost, bm25-scorer, hybrid-search, providers, backend-manager, webllm, async-utils, string-utils |
| [`core/constants.js`](core/constants.js) | eventbase-workflow | `EXTENSION_PROMPT_TAG` constant | None |
| [`core/keyword-boost.js`](core/keyword-boost.js) | eventbase-retrieval | `extractChatKeywords()`, `applyKeywordBoost()` | → bm25-scorer |
| [`ui/progress-tracker.js`](ui/progress-tracker.js) | eventbase-workflow | `progressTracker` instance | ST only |

---

## 3. Files with FORWARD Coupling → (import EventBase modules)

These files **import from** EventBase modules. Removing or changing EventBase would break them.

| File | What it imports from EventBase | Coupling type |
|------|-------------------------------|---------------|
| [`core/chat-vectorization.js`](core/chat-vectorization.js) | Dynamic: `runEventBaseIngestion`, `runEventBaseRetrieval` from `eventbase-workflow.js`; reads `eventbase_enabled` setting | **Import + Settings** |
| [`core/collection-loader.js`](core/collection-loader.js) | Dynamic: `clearWindowCacheForChat` from `eventbase-store.js` (line 151, on collection deletion) | **Import** (also has ← coupling above) |
| [`ui/ui-manager.js`](ui/ui-manager.js) | Dynamic: `DEFAULT_EXTRACTION_PROMPT` from `eventbase-schema.js`; reads/writes ALL `eventbase_*` settings (43 references) | **Import + Settings** |
| [`ui/content-vectorizer.js`](ui/content-vectorizer.js) | Dynamic: `runEventBaseIngestion` from `eventbase-workflow.js`; reads `eventbase_enabled` | **Import + Settings** |

Note: [`core/collection-loader.js`](core/collection-loader.js) appears in **both** §2 and §3 — it is **bidirectionally coupled** (EventBase imports `registerCollection` from it, and it imports `clearWindowCacheForChat` from EventBase).

---

## 4. Files with Settings-Only Coupling

These files don't import EventBase modules but read `eventbase_*` settings.

| File | Settings read | Purpose |
|------|-------------|---------|
| [`core/core-vector-api.js`](core/core-vector-api.js) | `eventbase_debug_logging` | Debug logging during query execution (4 occurrences) |
| [`backends/qdrant.js`](backends/qdrant.js) | `eventbase_debug_logging` | Debug logging during Qdrant queries (1 occurrence) |

---

## 5. Files with ID/Setting Definitions (used BY EventBase)

| File | What it provides |
|------|-----------------|
| [`core/collection-ids.js`](core/collection-ids.js) | Exports `VECTHARE_EVENTBASE` prefix constant and `buildEventBaseCollectionId()` function |
| [`index.js`](index.js:161) | All 19 `eventbase_*` default settings (lines 161–186) |

---

## 6. Files with Comment-Only Coupling

| File | Reference | Impact |
|------|-----------|--------|
| [`core/content-vectorization.js`](core/content-vectorization.js:45) | Comment noting EventBase only handles chat messages, not non-chat content | Zero — comment only, no code path change |

---

## 7. TRANSITIVE Coupling (indirect — EventBase depends on these through a chain)

These files are not directly imported by any EventBase module, but they are imported by modules that EventBase **does** directly import (see §2). Changing their exports could affect EventBase indirectly.

| File | Dependency chain |
|------|----------------|
| [`core/bm25-scorer.js`](core/bm25-scorer.js) | EventBase → keyword-boost → **bm25-scorer** AND EventBase → core-vector-api → **bm25-scorer** |
| [`core/hybrid-search.js`](core/hybrid-search.js) | EventBase → core-vector-api → **hybrid-search** |
| [`core/providers.js`](core/providers.js) | EventBase → core-vector-api → **providers** |
| [`backends/backend-manager.js`](backends/backend-manager.js) | EventBase → core-vector-api → **backend-manager** |
| [`providers/webllm.js`](providers/webllm.js) | EventBase → core-vector-api → **webllm** |
| [`utils/async-utils.js`](utils/async-utils.js) | EventBase → core-vector-api → **async-utils** |
| [`utils/string-utils.js`](utils/string-utils.js) | EventBase → core-vector-api → **string-utils** |

These files have zero EventBase references themselves. They are completely unaware of EventBase. The transitive dependency is **one-way** (EventBase → them).

---

## 8. TRULY DECOUPLED Files (zero relationship in either direction)

These files have **no imports from EventBase**, **are not imported by EventBase**, have **no EventBase settings**, and have **no EventBase comments**. They are completely independent.

### 8.1 Core Logic Modules

| File | Key Exports |
|------|-------------|
| [`core/scenes.js`](core/scenes.js) | `createSceneChunk`, `deleteSceneChunk`, `filterSceneChunks`, etc. |
| [`core/chunking.js`](core/chunking.js) | Text chunking algorithms |
| [`core/chunk-groups.js`](core/chunk-groups.js) | `buildChunkGroups`, `processChunkGroups`, `applySoftLinks` |
| [`core/temporal-decay.js`](core/temporal-decay.js) | Temporal decay functions |
| [`core/emotion-classifier.js`](core/emotion-classifier.js) | Emotion detection |
| [`core/summarizer.js`](core/summarizer.js) | Chunk summarization |
| [`core/conditional-activation.js`](core/conditional-activation.js) | Conditional rules engine |
| [`core/world-info-integration.js`](core/world-info-integration.js) | World info → vector query |
| [`core/collection-export.js`](core/collection-export.js) | Collection export |
| [`core/png-export.js`](core/png-export.js) | PNG export |
| [`core/keyword-learner.js`](core/keyword-learner.js) | Keyword learning from chat |

### 8.2 Backend Modules

| File | Notes |
|------|-------|
| [`backends/backend-interface.js`](backends/backend-interface.js) | Abstract interface |
| [`backends/lancedb.js`](backends/lancedb.js) | LanceDB adapter |
| [`backends/milvus.js`](backends/milvus.js) | Milvus adapter |
| [`backends/standard.js`](backends/standard.js) | Standard adapter |

### 8.3 UI Modules

| File | Notes |
|------|-------|
| [`ui/chunk-visualizer.js`](ui/chunk-visualizer.js) | Chunk debug visualizer |
| [`ui/database-browser.js`](ui/database-browser.js) | DB browser panel |
| [`ui/diagnostics.js`](ui/diagnostics.js) | Diagnostics panel |
| [`ui/health-dashboard.js`](ui/health-dashboard.js) | Health dashboard |
| [`ui/icons.js`](ui/icons.js) | SVG icons |
| [`ui/scene-markers.js`](ui/scene-markers.js) | Scene markers overlay |
| [`ui/scenes-panel.js`](ui/scenes-panel.js) | Scenes management panel |
| [`ui/search-debug.js`](ui/search-debug.js) | Search debug panel |
| [`ui/text-cleaning-manager.js`](ui/text-cleaning-manager.js) | Text cleaning UI |

### 8.4 Utility Modules

| File | Notes |
|------|-------|
| [`utils/async-utils.js`](utils/async-utils.js) | Async helpers (transitively coupled via core-vector-api, but not directly) |
| [`utils/data-structures.js`](utils/data-structures.js) | Data structures |
| [`utils/dom-utils.js`](utils/dom-utils.js) | DOM helpers |
| [`utils/storage-manager.js`](utils/storage-manager.js) | Storage abstraction |
| [`utils/string-utils.js`](utils/string-utils.js) | String helpers (transitively coupled via core-vector-api) |
| [`utils/vector-distance.js`](utils/vector-distance.js) | Vector distance math |

### 8.5 Diagnostics Modules

All files in `diagnostics/` are decoupled.

### 8.6 Other

| File | Notes |
|------|-------|
| [`providers/webllm.js`](providers/webllm.js) | WebLLM provider (transitively coupled via core-vector-api) |
| All files in `tests/` | Test files |
| All files in `styles/` | CSS files |
| `manifest.json`, `package.json`, `vitest.config.js` | Config files |
| `README.md`, `BM25_INTEGRATION.md` | Documentation |

---

## 9. Summary Statistics

| Category | Count | Key files |
|----------|-------|-----------|
| **Core EventBase pipeline** | 6 files | schema, extractor, store, retrieval, injection, workflow |
| **← Reverse coupled** (imported BY EventBase) | 8 files | text-cleaning, collection-ids, collection-loader, collection-metadata, core-vector-api, constants, keyword-boost, progress-tracker |
| **→ Forward coupled** (import EventBase) | 4 files | chat-vectorization, collection-loader, ui-manager, content-vectorizer |
| **↔ Bidirectionally coupled** | 1 file | collection-loader (both directions) |
| **Settings-only coupling** | 2 files | core-vector-api, qdrant |
| **Transitively coupled** (indirect chain) | 5 files | bm25-scorer, hybrid-search, providers, backend-manager, webllm |
| **Truly decoupled** (zero relationship) | ~30+ files | scenes, chunking, chunk-groups, temporal-decay, emotion-classifier, summarizer, conditional-activation, world-info-integration, collection-export, png-export, keyword-learner, database-browser, diagnostics, etc. |

---

## 10. Key Architectural Insight

The EventBase pipeline follows a **clean one-way dependency pattern**:

```
eventbase-schema.js  ←  eventbase-extractor.js  ←  eventbase-store.js
                          eventbase-injection.js  ←  eventbase-retrieval.js
                                                       ↓
                                               eventbase-workflow.js (orchestrator)
                                                       ↓
                          chat-vectorization.js  ←  content-vectorizer.js  (consumers)
```

**Reverse dependencies (EventBase → external):**
```
eventbase-extractor.js    → text-cleaning.js
eventbase-store.js        → core-vector-api.js → bm25-scorer, hybrid-search, providers, backend-manager
                          → collection-ids.js
                          → collection-loader.js → collection-metadata.js
eventbase-retrieval.js    → keyword-boost.js → bm25-scorer.js
eventbase-workflow.js     → collection-metadata.js, constants.js, progress-tracker.js
```

**Key takeaway (revised):** “Decoupled from EventBase” does **not** mean “safe to remove from VectHare.”
Many of these modules are still required by the active **chunk-based pipeline** (`chat-vectorization` + `content-vectorization` + retrieval/injection flow). Removing them can break non-EventBase features even if EventBase itself remains intact.

---

## 11. NOT Safe to Remove (still required by chunk-based vector flow)

Given current behavior, these files are still part of production chunk workflows and should **not** be removed.

### 11.1 Chunk ingestion / retrieval orchestrators

| File | Why not safe to remove |
|------|-------------------------|
| [`core/chat-vectorization.js`](core/chat-vectorization.js) | Main chunk retrieval/injection orchestrator when EventBase is off; also handles chat auto-sync chunk path |
| [`core/content-vectorization.js`](core/content-vectorization.js) | Primary chunk vectorization pipeline for chat (non-EventBase mode) + all non-chat content types |
| [`ui/content-vectorizer.js`](ui/content-vectorizer.js) | UI entry point that triggers chunk vectorization for non-chat and chat when EventBase is disabled |

### 11.2 Collection and query infrastructure used by chunk flow

| File | Why not safe to remove |
|------|-------------------------|
| [`core/core-vector-api.js`](core/core-vector-api.js) | Chunk insert/query/purge primitives used across chunk ingestion + retrieval |
| [`core/collection-loader.js`](core/collection-loader.js) | Registry/discovery used by chunk collection selection and lifecycle |
| [`core/collection-metadata.js`](core/collection-metadata.js) | `enabled`, locks, triggers/conditions metadata used by chunk activation/filtering |
| [`core/collection-ids.js`](core/collection-ids.js) | Chat collection IDs and registry key parsing used by chunk gather/filter logic |
| [`core/constants.js`](core/constants.js) | Prompt tag constants used by chunk prompt injection path |

### 11.3 Chunk retrieval/ranking/activation features currently in use

| File | Why not safe to remove |
|------|-------------------------|
| [`core/keyword-boost.js`](core/keyword-boost.js) | Query keyword extraction + chunk score boosting in chunk retrieval |
| [`core/conditional-activation.js`](core/conditional-activation.js) | Search context + chunk/collection condition evaluation used by chunk filtering |
| [`core/chunk-groups.js`](core/chunk-groups.js) | Inclusive/exclusive group processing and virtual links in chunk result post-processing |
| [`core/temporal-decay.js`](core/temporal-decay.js) | Optional temporal relevance adjustment in chunk pipeline |
| [`core/scenes.js`](core/scenes.js) | Scene-based chunk disabling and scene-aware behavior in chunk flow |
| [`core/world-info-integration.js`](core/world-info-integration.js) | Semantic WI retrieval merged into chunk injection flow |

### 11.4 Chunk preparation dependencies

| File | Why not safe to remove |
|------|-------------------------|
| [`core/chunking.js`](core/chunking.js) | Core text chunking for vectorization |
| [`core/summarizer.js`](core/summarizer.js) | Optional summarization path during chunk vectorization/grouping |
| [`core/text-cleaning.js`](core/text-cleaning.js) | Cleaning of chat/content text before chunking/vectorization |

### 11.5 Backends/providers/utilities required by chunk data path

| File | Why not safe to remove |
|------|-------------------------|
| [`backends/backend-manager.js`](backends/backend-manager.js) | Backend resolution used by chunk query/insert operations |
| [`backends/standard.js`](backends/standard.js) | Standard backend adapter for chunk storage/query |
| [`backends/qdrant.js`](backends/qdrant.js) | Qdrant backend adapter for chunk storage/query |
| [`core/providers.js`](core/providers.js) | Embedding provider routing used by chunk vectorization/query |
| [`providers/webllm.js`](providers/webllm.js) | WebLLM provider path used by embedding stack |
| [`core/bm25-scorer.js`](core/bm25-scorer.js) | BM25/tokenization scoring used in chunk hybrid/boost logic |
| [`core/hybrid-search.js`](core/hybrid-search.js) | Hybrid search mode for chunk retrieval |
| [`utils/async-utils.js`](utils/async-utils.js) | Async helpers used in vector/query infrastructure |
| [`utils/string-utils.js`](utils/string-utils.js) | String helpers used in vector/query infrastructure |
| [`utils/data-structures.js`](utils/data-structures.js) | Queue/LRU used in chat chunk sync/retrieval internals |

### 11.6 UI and debug components still tied to chunk workflows

| File | Why not safe to remove |
|------|-------------------------|
| [`ui/database-browser.js`](ui/database-browser.js) | Collection enable/locks/activation controls that gate chunk querying |
| [`ui/search-debug.js`](ui/search-debug.js) | Debug trace/fate tracking invoked throughout chunk retrieval stages |
| [`ui/progress-tracker.js`](ui/progress-tracker.js) | Progress/cancel path for chunk vectorization workflows |

### Practical rule

Before removing any “decoupled-from-EventBase” file, validate whether it is part of the chunk path in [`core/chat-vectorization.js`](core/chat-vectorization.js), [`core/content-vectorization.js`](core/content-vectorization.js), or [`ui/content-vectorizer.js`](ui/content-vectorizer.js). If yes, it is **not safe to remove** under current mixed-mode architecture.
