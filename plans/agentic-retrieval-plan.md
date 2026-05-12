# Plan: Agentic Retrieval Mode for EventBase

**TL;DR:** Add an optional pre-retrieval LLM planning step that consumes the existing pre-search candidates plus recent chat context, then emits 1–4 targeted follow-up queries (with optional payload filters) which run in parallel against Qdrant. Results merge with the existing pre-search output and feed the existing 4-weight re-ranker untouched. **Purely additive — never replaces the current flow.** Qdrant (A3) only.

---

## 0. Goals and non-goals

### Goals
- Close the "narrative reasoning at retrieval time" gap vs. other memory extension **without** giving up our scale advantage or auto-extracted metadata.
- One small/fast LLM call per retrieval round (~$0.0002, ~300ms added latency).
- Reuse existing `Promise.all` fanout pattern for the planner's queries.
- Settings-gated, off by default. Graceful fallback to the existing flow on planner failure.
- A3 (Qdrant native sparse + payload filters) only.
- No change to the 4-weight re-ranker, dedup, or injection logic.

### Non-goals
- Replacing the existing semantic search flow.
- A2/A1 support (the planner emits payload filters that A2/A1 can't enforce efficiently).
- Lorebook agentic mode (Phase 2 only if benchmarks show it helps; default scope = chat events, but implentation should be flexible for adding this).
- Multi-turn reflection / re-querying when first batch returns thin (Phase 2 polish).
- Streaming planner output (single-shot JSON is enough; pure latency win not worth the complexity).
- Re-enabling the keyword anchor boost ([core/eventbase-retrieval.js:222](../core/eventbase-retrieval.js#L222)). Currently commented out to give the agentic feature an unbiased baseline; re-enable decision deferred until benchmarks run.

---

## 1. Architectural fit

### 1.1 Top-level: two fully independent pipelines, two prompt slots

The agentic feature lives entirely inside the EventBase chat pipeline. The lorebook
semantic-WI pipeline is unchanged and emits its own injection into a separate
prompt slot (`EXTENSION_PROMPT_TAG`), independent of `EVENTBASE_PROMPT_TAG`. The two
paths share no merge, no dedup, no re-ranker — they only co-occur in the final
prompt as side-by-side sections.

```
                              ┌──────────────────────────────────────┐
                              │ EventBase chat pipeline              │
                              │ (agentic add-on lives in here)       │
User message + recent ───┬──▶│ → top-K events                       │──▶  EventBase
chat                     │    │ → setExtensionPrompt(EVENTBASE_TAG)  │     prompt slot
                         │    └──────────────────────────────────────┘
                         │
                         │    ┌──────────────────────────────────────┐
                         └──▶│ Lorebook semantic WI (independent,   │──▶  World Info
                              │ unchanged)                            │     prompt slot
                              │ → setExtensionPrompt(EXTENSION_TAG)   │
                              └──────────────────────────────────────┘
```

Both pipelines fire in parallel; the lorebook path runs concurrently with — and
completely ignorant of — whatever EventBase + agentic does on the other side.

### 1.2 Zoom into the EventBase pipeline: where the agentic step inserts

```
                                  ┌──────────────────────────────────────┐
                                  │ STAGE 1 — Existing pre-search        │
User message + recent chat ─────▶│ retrieveEvents() in                  │
                                  │ core/eventbase-retrieval.js          │
                                  │ → top-K candidate events             │
                                  └─────────────────┬────────────────────┘
                                                    │
                                                    ▼
                                  ┌──────────────────────────────────────┐
                                  │ STAGE 2-5 — Agentic planner          │
                                  │ (skipped if disabled or A1/A2)       │
                                  │ 2. Planner LLM → 1-4 queries+filters │
                                  │ 3. Batch-embed planner queries       │
                                  │ 4. Parallel Qdrant queries           │
                                  │ 5. Per-query .catch() → graceful     │
                                  └─────────────────┬────────────────────┘
                                                    │
                                                    ▼
                                  ┌──────────────────────────────────────┐
                                  │ STAGE 6 — Re-feed through            │
                                  │ retrieveEvents(skipLiveQuery: true)  │
                                  │ Reuses: importance filter, 4-weight  │
                                  │ rerank, character dedup, context     │
                                  │ dedup, top-K trim                    │
                                  └─────────────────┬────────────────────┘
                                                    │
                                                    ▼
                                       EventBase prompt slot
```

**Hard dependency inside the EventBase pipeline:** the planner must run after the pre-search completes — it consumes those candidates as input. Within the planner stage, the 1–4 emitted queries fan out in parallel via `Promise.all`. The lorebook pipeline is fully independent and runs in parallel with this entire box.

---

## 2. File-level surface area

| File | Role | Action |
|---|---|---|
| `core/agentic-retrieval.js` | **NEW** — planner LLM call, query batching, Qdrant fanout, fallback | Create |
| `core/agentic-prompt.js` | **NEW** — system prompt + few-shot examples for the planner | Create |
| `core/eventbase-retrieval.js` | Existing pre-search and re-rank | Add optional `agenticCandidates` param to `retrieveEvents` (merge before re-rank); no other changes |
| `core/eventbase-workflow.js` | Orchestration around `retrieveEvents` | Call planner between pre-search and final re-rank when `agentic_retrieval_enabled` |
| `core/summarizer.js` | Existing OpenRouter/vLLM call infra | Reuse: extract the OpenRouter/vLLM call helpers into a shared `_callLLM(...)` so the planner can call it without duplicating provider logic |
| `core/core-vector-api.js` | Existing `queryCollection` | Add lightweight `queryCollectionWithVector(colId, vector, filters, ...)` that skips re-embedding when caller already has the vector. Used by planner fanout to avoid embedding the same text twice |
| `index.js` | Settings defaults registration | Add 5 new keys (see §6) |
| `ui/ui-manager.js` | **NEW** — "AgentMode" tab (peer of Core / EventBase / ChunkBase / Action) | All agentic settings live here. Provider/model/API-key fields inherit from summarize_* when left empty. Controls: enable toggle, provider dropdown, model field with "Choose" button, chat-depth slider, candidates slider, max queries slider, timeout numeric, debug log toggle |
| `tests/agentic-retrieval.test.js` | **NEW** — unit tests for planner + fallback | Create |
| `Doc/dev_helper.md` | Dev reference | Add "Agentic Retrieval" section describing the flow + the deferred anchor-boost decision |

**Repo-side split:**
- VectHare browser side: all of the above.
- Similharity side: zero changes. The existing `hybridQueryNative` already accepts payload filters via `_buildHybridFilter()` ([similharity/qdrant-backend.js:665](../../similharity/qdrant-backend.js#L665)) — we just send richer filters in the body.

---

## 3. Planner LLM contract

### 3.1 Input shape

```
SYSTEM PROMPT (static, ~300 tokens) — see core/agentic-prompt.js
─────────────────────────────────────────────────────────────────
You are a retrieval planner for a roleplay memory system. ...
Available payload fields, schema, decomposition guide, 2 few-shot
examples (1 English, 1 CJK).

USER MESSAGE (dynamic, ~300 tokens)
─────────────────────────────────────────────────────────────────
Recent chat (last N turns, oldest first):
  [-N] {{character}}: ...
  ...
  [-1] {{character}}: ...

Current user message:
  <verbatim user input>

Candidate events from pre-search (top 10-12, 1 line each):
  E1  [0.82] <event_type> — <text first 80 chars>
            chars: [...] | concepts: [...] | importance: X
            DateTime: <iso8601> | source_window_end: <int>
  ...

DB stats (optional, lightweight scroll):
  total_events: 1,847
  top_characters: Mayla (1248), Critblade (1102), ...

Plan retrieval.
```

### 3.2 Output schema (strict JSON, no markdown fence)

```ts
interface PlannerOutput {
  queries: string[];                      // 1-4 short search strings (5-15 words each)
  filters?: {
    characters_any?: string[];
    locations_any?: string[];
    factions_any?: string[];
    concepts_any?: string[];
    event_type_any?: string[];
    importance_gte?: number;              // 1..10
    source_window_end_gte?: number;       // for DateTime/chapter ranges
    source_window_end_lte?: number;
  };
  rationale: string;                      // 1 sentence, debugging only
}
```

Validated by `_validatePlannerOutput(json)` — rejects extra top-level keys, clamps `queries.length` to 4, drops unknown filter keys, normalizes `*_any` arrays to lowercase. Validation failure → planner is treated as failed; fallback to pre-search only.

### 3.3 LLM call settings

| Setting | Value |
|---|---|
| Provider | `agentic_retrieval_provider` — when empty, **inherits `summarize_provider`** |
| Model | `agentic_retrieval_model` — when empty, **inherits `summarize_model`**. Recommended explicit override: `anthropic/claude-haiku-4-5` for OpenRouter (cheaper + faster than the typical summarize model) |
| API key | `agentic_retrieval_openrouter_api_key` / `agentic_retrieval_vllm_api_key` — when empty, **inherits `summarize_*_api_key`** |
| vLLM URL | `agentic_retrieval_vllm_url` — when empty, **inherits `summarize_vllm_url`** |
| Temperature | 0.2 (deterministic structured output) |
| Max tokens | 400 |
| Response format | `{ type: "json_object" }` when provider supports it (OpenRouter passes through to upstream) |
| Timeout | `agentic_retrieval_timeout_ms`, default 30000 (matches summarize default — some models need >5s on a 1500-token planner prompt) |

**Inheritance rule:** at call time, each `agentic_retrieval_*` field is checked first; if it's an empty string / null / undefined, the corresponding `summarize_*` value is used. Implement once as `_resolveAgenticLLMConfig(settings)` in `core/agentic-retrieval.js` that returns a fully-resolved config object.

Reuse `_callOpenRouter` / `_callVLLM` from `core/summarizer.js` via a shared helper. Don't duplicate API key resolution, retry, or timeout logic — extract the provider-call functions into shared form so the planner reuses them with a different resolved config object.

---

## 4. Filter translation (planner → Qdrant payload filter)

The planner emits the JSON shape in §3.2; the Qdrant payload filter shape expected by `hybridQueryNative` is the existing one in [similharity/qdrant-backend.js:665](../../similharity/qdrant-backend.js#L665). Translation table:

| Planner field | Qdrant must clause |
|---|---|
| `characters_any: ["Mayla"]` | `should: [{ key: "characters", match: { value: "Mayla" } }]` (Qdrant treats array payload values as multi-value matchany; one `should` clause per name) |
| `locations_any: [...]` | Same pattern with `key: "locations"` |
| `factions_any`, `concepts_any`, `event_type_any` | Same pattern with corresponding `key` |
| `importance_gte: 6` | `{ key: "importance", range: { gte: 6 } }` |
| `source_window_end_gte: 480` | `{ key: "source_window_end", range: { gte: 480 } }` |

**Important:** Use `should` (OR) for `*_any` filters, not `must` (AND). Over-filtering kills recall; the planner's intent is "these are likely relevant," not "these must all be present."

Implement as `_translatePlannerFilters(filters) → qdrantFilter` in `agentic-retrieval.js`. Returns `null` when no filters are present, so the query falls back to unfiltered (matches existing `_buildHybridFilter` contract).

---

## 5. Concrete flow in `core/agentic-retrieval.js`

```js
export async function retrieveEventsAgentic({ 
  searchText, keywordQuery, chatLength, settings, 
  liveCollectionIds, additionalCandidates, ...rest 
}) {
  // STAGE 1 — existing pre-search, unchanged
  const preSearch = await retrieveEvents({
    searchText, keywordQuery, chatLength, settings,
    liveCollectionIds, additionalCandidates, ...rest
  });

  // STAGE 2 — early exit if disabled or A1/A2
  if (!settings.agentic_retrieval_enabled) return preSearch;
  if (settings.vector_backend !== 'qdrant') {
    if (settings.eventbase_debug_logging) {
      console.log('[VectHarePlus-Agentic] Skipped: requires Qdrant backend');
    }
    return preSearch;
  }

  // STAGE 3 — planner LLM call
  let plan;
  try {
    plan = await callPlanner({
      recentChat: searchText,
      userMessage: keywordQuery,
      candidates: preSearch.events.slice(0, 12),
      settings,
    });
  } catch (err) {
    console.warn('[VectHarePlus-Agentic] Planner call failed, using pre-search only:', err.message);
    return preSearch;
  }

  if (!plan?.queries?.length) return preSearch;

  // STAGE 4 — batch-embed all planner queries in ONE API call
  let queryVectors;
  try {
    queryVectors = await batchEmbed(plan.queries, settings);
  } catch (err) {
    console.warn('[VectHarePlus-Agentic] Embedding batch failed, using pre-search only:', err.message);
    return preSearch;
  }

  // STAGE 5 — parallel Qdrant queries, one per (collection × planner-query)
  const qdrantFilter = _translatePlannerFilters(plan.filters);
  const promises = [];
  for (const colId of liveCollectionIds) {
    for (let i = 0; i < plan.queries.length; i++) {
      promises.push(
        queryCollectionWithVector(colId, queryVectors[i], plan.queries[i], qdrantFilter, settings)
          .then(r => r.metadata?.map((m, j) => ({ ...m, _hash: r.hashes[j] })) || [])
          .catch(err => {
            console.warn(`[VectHarePlus-Agentic] Query failed (${colId}, "${plan.queries[i]}"):`, err.message);
            return [];
          })
      );
    }
  }
  const agenticHits = (await Promise.all(promises)).flat();

  // STAGE 6 — feed everything back into the existing re-ranker via additionalCandidates
  // This reuses dedup + re-rank + context-dedup logic with zero duplication.
  return retrieveEvents({
    searchText, keywordQuery, chatLength, settings,
    liveCollectionIds: [],                        // already pre-searched; skip live query
    additionalCandidates: [...preSearch.events, ...agenticHits],
    skipLiveQuery: true,
    ...rest,
  });
}
```

**Why STAGE 6 re-runs `retrieveEvents` with `skipLiveQuery: true`:** the existing function already handles importance filtering, 4-weight re-ranking, character-overlap dedup, context-dedup, and top-K trim. By feeding the union of `preSearch.events + agenticHits` as `additionalCandidates`, we get all that for free — no duplicate logic, no risk of drifting from the canonical scoring path.

---

## 6. Settings to register in `index.js`

```js
agentic_retrieval_enabled: false,                                  // master toggle
agentic_retrieval_provider: '',                                    // '' → inherit summarize_provider
agentic_retrieval_model: '',                                       // '' → inherit summarize_model
agentic_retrieval_openrouter_api_key: '',                          // '' → inherit summarize_openrouter_api_key
agentic_retrieval_vllm_url: '',                                    // '' → inherit summarize_vllm_url
agentic_retrieval_vllm_api_key: '',                                // '' → inherit summarize_vllm_api_key
agentic_retrieval_max_queries: 4,                                  // hard ceiling on planner output (slider 1-4)
agentic_retrieval_candidates_to_show: 12,                          // pre-search slice given to planner (slider 5-20)
agentic_retrieval_chat_depth: 5,                                   // # of past chat turns sent to planner (slider 3-15)
agentic_retrieval_timeout_ms: 30000,
agentic_retrieval_debug_logging: false,                            // separate from eventbase_debug_logging
```

### 6.1 How "past chat replies" are sourced (for `agentic_retrieval_chat_depth`)

The planner needs *narrative context* (what's been happening recently), not the same `searchText` the embedding-search uses. Source is `getContext().chat` — the live SillyTavern chat array, same source the existing flow already reads:

```js
function _getRecentChatForPlanner(settings) {
  const chat = getContext().chat || [];
  const depth = settings.agentic_retrieval_chat_depth || 5;
  return chat
    .filter(m => !m.is_system)                  // skip system messages, same as applySemanticEntriesToPrompt
    .slice(-depth)                              // newest N turns
    .map(m => ({
      speaker: m.is_user ? '{{user}}' : (m.name || '{{character}}'),
      text: (m.mes || '').toString(),
    }));
}
```

This is independent from the existing `searchText` / `keywordQuery` parameters of `retrieveEvents` — the planner gets its own slice for its own purpose.

### 6.2 GUI: new "AgentMode" tab

A new top-level tab in [ui/ui-manager.js](../ui/ui-manager.js), peer of Core / EventBase / ChunkBase / Action. Layout top-to-bottom:

**Section: Master**
- **Enable Agentic Retrieval** (checkbox, default off)
- *Info callout:* "Requires Qdrant backend (A3). Adds ~$0.0002 and ~300ms per turn. Always merged with normal search — never replaces it."

**Section: LLM Provider (inheritance from summarizer)**
- **Provider** (dropdown: `inherit from summarizer` (default) / openrouter / vllm)
- **Model** (text input + "Choose" button pattern reused from summarize model UI; empty = inherit)
- **OpenRouter API Key** (password input, empty = inherit)
- **vLLM URL** (text input, empty = inherit; only visible when provider = vllm)
- **vLLM API Key** (password input, empty = inherit; only visible when provider = vllm)
- *Helper text under each empty field:* "Leave blank to use the Summarize Before Store setting."

**Section: Retrieval Tuning**
- **Past chat turns sent to planner** (slider 3–15, default 5)
- **Candidates shown to planner from pre-search** (slider 5–20, default 12)
- **Max planner queries** (slider 1–4, default 4)
- **Timeout (ms)** (numeric, default 30000)

**Section: Debug**
- **Enable agent-mode debug logging** (checkbox, default off)
- *Helper text:* "Logs include: `[VectHarePlus-Agentic]` mode marker, full LLM prompt sent, LLM round-trip time in ms, Qdrant fanout round-trip time in ms."

---

## 7. Failure modes & fallback behavior

| Failure | Behavior |
|---|---|
| `agentic_retrieval_enabled = false` | Skip stage 2 entirely → identical to today |
| Backend ≠ Qdrant | Skip stages 2-5, log once → pre-search only |
| Planner returns invalid JSON | Catch in `callPlanner`, log warn → pre-search only |
| Planner returns 0 queries | Skip stages 4-5 → pre-search only |
| Planner exceeds configured timeout (default 30s) | AbortSignal.timeout on the fetch → log "TIMED OUT after Xms" with the configured limit → pre-search only |
| Batch embedding fails | Catch in stage 4 → pre-search only |
| One of N Qdrant queries fails | Per-promise `.catch(err) → []`, other queries still merge |
| All Qdrant queries fail | Stage 5 returns `agenticHits = []` → stage 6 re-ranks pre-search events normally |
| Planner emits filter that returns 0 results | Empty result is fine; pre-search events still rank in stage 6 |

**Critical invariant:** the agentic feature MUST NEVER produce a worse result than today's flow. Every failure path falls back cleanly to the unmodified pre-search output.

---

## 7.5. Debug logging spec (when `agentic_retrieval_debug_logging` is true)

All agent-mode log lines are prefixed with `[VectHarePlus-Agentic]` so they're greppable and visually distinct from `[EventBase]` and `[Qdrant]` lines.

Per retrieval round, emit these in order:

```
[VectHarePlus-Agentic] mode=ON  trigger=user_message_id=<id>
[VectHarePlus-Agentic] Pre-search returned <N> candidates (top score=<x.xx>)
[VectHarePlus-Agentic] Past chat turns sent to planner: <depth>
[VectHarePlus-Agentic] Narrative context preview (one ~50-word snippet per turn — count = depth):
  [-N] <speaker>: <first ~50 words of message body, ellipsis if truncated...>
  ...
  [-2] <speaker>: <first ~50 words...>
  [-1] <speaker>: <first ~50 words...>
[VectHarePlus-Agentic] LLM prompt size: system+user approx <T> tokens (<a>+<b> chars)
[VectHarePlus-Agentic] LLM call complete: <ms>ms
[VectHarePlus-Agentic] Planner output:
{
  "queries": [...],
  "filters": {...},
  "rationale": "..."
}
[VectHarePlus-Agentic] Embedding batch: <N> queries → <ms>ms
[VectHarePlus-Agentic] Qdrant fanout: <N> queries × <M> collections = <X> parallel calls
[VectHarePlus-Agentic] Qdrant fanout complete: <ms>ms (slowest single call: <ms>ms)
[VectHarePlus-Agentic] Per-query hits:
  Q1 "<query text>"  → <N> hits (top score=<x.xx>)
  Q2 ...
[VectHarePlus-Agentic] Agentic-only hits (not in pre-search): <N>
[VectHarePlus-Agentic] Final merged candidates: <preSearch.length> + <agenticHits.length> = <total>
[VectHarePlus-Agentic] Total wall-clock for agent overhead: <ms>ms
```

The four timing buckets the user explicitly asked for:
1. **LLM call ms** — from fetch start to JSON parse done.
2. **Embedding batch ms** — from batch call start to all vectors returned.
3. **Qdrant fanout ms** — from `Promise.all` start to all collections done.
4. **Total agent overhead ms** — sum of the above + any glue, measured against a `performance.now()` taken at agent-stage entry.

Implementation note: use `performance.now()` for sub-ms precision and log integers (`Math.round(ms)`) for readability. Wrap each instrumented stage in:
```js
const t0 = performance.now();
const result = await someStage(...);
console.log(`[VectHarePlus-Agentic] <stage>: ${Math.round(performance.now() - t0)}ms`);
```

---

## 8. Benchmark / acceptance plan

Before merging, run the same 20-query test set against three modes:

1. **Today's behavior** — anchor boost OFF (current state of `eventbase-retrieval.js`).
2. **Anchor boost ON** — restore the `+0.25` boost, agentic disabled.
3. **Agentic ON** — anchor boost OFF, agentic enabled.

For each mode, record per-query:
- Top-5 events injected (event_id + score).
- Whether the human-labeled "correct" event(s) appear in top-5.
- Wall-clock latency.

Acceptance criteria for shipping:
- Mode 3 (Agentic) recall ≥ Mode 2 (Anchor boost) recall on the 20-query set.
- Mode 3 latency ≤ Mode 1 latency + 500ms (P95).
- Mode 3 wins decisively on "why" / "what happened to" / reflective query types (these are exactly what agentic is designed for; flat semantic search should lose them).
- Zero cases where Mode 3 ranks worse than Mode 1 (proof of "purely additive" guarantee).

Decision after benchmark: re-enable anchor boost, drop anchor boost permanently, or make it a per-user toggle.

---

## 9. Phased rollout

### Phase 1 — minimum shippable
- Stages 1-6 as specified above
- OpenRouter only (vLLM second)
- English + CJK few-shot examples in the system prompt
- Default off; behind a setting; A3-only

### Phase 2 — polish (after Phase 1 is benchmarked)
- vLLM provider support for the planner
- Reflective re-query: if `agenticHits.length < 3`, run planner once more with the prompt "your search returned thin — try different angles"
- Lorebook agentic mode (opt-in, second checkbox) — flow + filters need to be designed for this from day 1 even though they're not wired up in Phase 1
- DB stats blurb in planner prompt (top characters/locations from a cached scroll)
- Per-collection stats for "Mayla has 1,248 events; 8 mention ransom" hints to planner
- **Anchor boost slider on Core tab.** Decide based on benchmark results: re-enable the `+0.25` boost (now disabled in [core/eventbase-retrieval.js:222](../core/eventbase-retrieval.js#L222)), drop it permanently, or expose as a configurable slider (range 0.0–0.5, default chosen post-benchmark). The slider lives in the **Core tab**, not AgentMode — it's a re-ranker tuning knob that applies regardless of whether AgentMode is on.

### Phase 3 — investigation only (no commit until decided)
- Replace planner LLM call with a structured-output local model (no API cost)
- Compare cost/quality tradeoff vs. Haiku

---

## 10. Open questions / decisions — RESOLVED

All questions resolved during planning conversation. Recorded here for traceability.

1. **Default planner model.** ✅ **RESOLVED** — The AgentMode tab inherits `summarize_*` settings when its own fields are left empty. Users who want a cheaper planner can override the model to e.g. `anthropic/claude-haiku-4-5`; users who don't care just let it use whatever their summarizer is configured with.

2. **Candidate summary format.** ✅ **RESOLVED** — Keep the full-payload format from §3.1 (chars, concepts, importance, DateTime). 12 candidates × ~80 tokens is fine for Haiku and gives the planner enough signal. Optimization deferred.

3. **Filter strictness.** ✅ **RESOLVED** — `should` (OR) is correct per Qdrant semantics. If the planner produces filter combinations that miss intended events, fix it in the prompt rather than tightening the filter logic.

4. **CJK few-shot example.** ✅ **RESOLVED** — Use the conversation's exact `贖身` example as the second few-shot in `core/agentic-prompt.js`. Exercises bilingual query emission and CJK keyword handling.

5. **Anchor boost decision.** ✅ **DEFERRED INTENTIONALLY** — Currently disabled in [core/eventbase-retrieval.js:222](../core/eventbase-retrieval.js#L222). Will be revisited as a Core-tab slider in Phase 2 once benchmark data is in. See §9 Phase 2 bullet on "Anchor boost slider on Core tab."

6. **Debug logging requirements.** ✅ **RESOLVED** — See §7.5 for the full spec. Four required timing buckets: LLM call ms, embedding batch ms, Qdrant fanout ms, total agent overhead ms. Plus the full LLM prompt is logged when debug is on.

7. **How past replies are sourced + configurable depth.** ✅ **RESOLVED** — See §6.1. Source: `getContext().chat` (same chat array existing flow already reads), filtered to non-system messages, sliced to `agentic_retrieval_chat_depth` from the tail. Default 3, slider range 1–15 in the AgentMode tab.

---

## 11. Out-of-scope for this plan

- Agentic mode for the Standard (Chunk) pipeline (lorebook, documents, URLs, wiki, character cards). Phase 2 candidate, not Phase 1.
- Multi-turn agent loops with tool use (full ReAct-style). The single-call planner is deliberately a smaller architectural commitment.
- Caching planner outputs across turns. Each turn re-plans because the context shifts; cache is unlikely to hit.
- Streaming the planner's JSON output. Single-shot completion is simpler and the latency cost is already < 500ms.
