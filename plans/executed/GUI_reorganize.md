# GUI Reorganization Plan

## Goal
Make the **Core** tab contain only settings that genuinely affect both retrieval paths (EventBase + Chunk). Move chunk-specific settings to the renamed **ChunkBase** tab so users understand which path each setting controls.

---
#### Phase 1

## 1. Rename "Weight" tab → "ChunkBase"

**Location:** [ui/ui-manager.js:58](ui/ui-manager.js#L58)

```html
<button class="vecthare-tab-btn" data-tab="weight">Weight</button>
```

The `data-tab="weight"` slug can stay (avoids touching CSS / tab-switch logic). Only the visible label changes to `ChunkBase`.

The card titled **"Temporal Weighting Defaults (Non-Chat Collections)"** at [ui/ui-manager.js:551](ui/ui-manager.js#L551) already says "Chat history/EventBase retrieval does not use this setting" — keep it as-is, it lives correctly under ChunkBase.

---

## 2. Settings to move from "Core" → "ChunkBase"

These settings have **no effect on EventBase** and should leave the Core tab.

### From Screenshot 1 (Core tab):

| Setting | Setting key | Why move | Evidence |
|---|---|---|---|
| **Insert Batch Size** | `insert_batch_size` | EventBase inserts ≤ 5 events per `insertVectorItems` call (capped by `Max Events per Window`); never reaches batch threshold. Only chunk path benefits. | [eventbase-workflow.js:202](core/eventbase-workflow.js#L202), [core-vector-api.js:668](core/core-vector-api.js#L668) |
| **Minimum Messages Before Injection** | `min_chat_length` | EventBase ignores it; uses `eventbase_min_importance_store` / `eventbase_retrieval_min_importance` instead. | [chat-vectorization.js](core/chat-vectorization.js) only |
| **Similarity Threshold** | `score_threshold` | EventBase uses importance-based filtering + weighted re-ranking (`eventbase_rerank_w_*`); never applies a raw-score cutoff. | [chat-vectorization.js:2103](core/chat-vectorization.js#L2103) only |

### From Screenshot 2 (Core tab):

Investigated against EventBase code paths:

| Setting | Setting key | EventBase? | Disposition |
|---|---|---|---|
| **CJK Tokenizer Mode** | `cjk_tokenizer_mode` | No — EventBase does no keyword extraction | **Move to ChunkBase** |
| **Custom Stopwords** | `custom_stopwords` | No — only chunk keyword extraction reads it | **Move to ChunkBase** |
| **Query Depth** | `query` | No — EventBase receives a pre-built `searchText` from the caller | **Move to ChunkBase** |
| **Dedup Depth** | `deduplication_depth` | **Yes** — used by both [chat-vectorization.js:1480](core/chat-vectorization.js#L1480) AND [eventbase-retrieval.js:240](core/eventbase-retrieval.js#L240) | **Keep in Core** |
| **Top K** | `top_k` | No — EventBase has its own `eventbase_retrieval_top_k` ([eventbase-retrieval.js:259](core/eventbase-retrieval.js#L259)) | **Move to ChunkBase** |

---

## 3. Settings that genuinely belong in "Core" (shared across both paths)

After cleanup, the Core tab should keep only:

- **Embedding provider / source / model** (universal — required for both paths to function)
- **API Rate Limiting (max calls / interval)** — *technically* applies to insertion for both paths, though for EventBase the LLM extraction latency makes it a practical no-op. Leave it in Core; the chunk path is where it matters.
- **Dedup Depth** — confirmed shared by both retrieval paths.
- **Summarization settings** (merged in from the old Summarize tab — see section 8). The provider/model/prompt are shared by chunk-summarization-before-store *and* EventBase event extraction.

Everything else currently in Core is chunk-specific and should move out.

---

## 4. Proposed final ChunkBase tab structure

Suggested ordering (group by lifecycle: ingestion → query → retrieval → ranking):

```
ChunkBase
├── Ingestion
│   └── Insert Batch Size
├── Keyword Extraction
│   ├── CJK Tokenizer Mode
│   └── Custom Stopwords
├── Query
│   ├── Query Depth
│   └── Top K
├── Retrieval Gating
│   ├── Minimum Messages Before Injection
│   └── Similarity Threshold
└── Temporal Weighting Defaults (existing card — keep)
```

---

## 5. Implementation notes (for whoever does the actual move)

- All target settings are rendered in [ui/ui-manager.js](ui/ui-manager.js). The HTML for each control can be cut from the Core card (`data-vecthare-tab="core"` block starting at [ui-manager.js:71](ui/ui-manager.js#L71)) and pasted into the Weight/ChunkBase card.
- Setting **keys do not change** — only DOM placement moves. No migration needed for `extension_settings.vecthare`; existing user values continue to work.
- Tab-switching logic (`data-tab` / `data-vecthare-tab`) keeps working as long as the slug stays `weight`. Only swap the visible label string `Weight` → `ChunkBase`.
- After the move, scan [index.js](index.js) defaults block to confirm none of the moved keys reference "Core" in their comments — update copy if so.

---

## 6. Out of scope (not changing)

- Tab slug `weight` stays (only label changes)
- EventBase tab keeps all its retrieval / extraction-behavior settings (window size, overlap, importance thresholds, max events, temperature, top_k, re-rank weights). Only its LLM transport overrides are removed — see section 9.
- No setting key renames, no default value changes
- No removal of any user-facing functionality — settings either move tabs or get unified with their Core counterpart via migration (section 9).

---

## 7. Tab reorder + default tab

**Current layout** ([ui/ui-manager.js:55-68](ui/ui-manager.js#L55-L68)):

```
Row 1:  Core | Weight | RAG | WorldInfo
Row 2:  AutoSync | Summarize | Action | EventBase
```

**Target layout:**

```
Row 1:  Action | Core | EventBase | ChunkBase
Row 2:  AutoSync | WorldInfo | RAG
```

Notes:
- **Action** moves to row 1, position 1, and becomes the **default active tab** when the panel first opens.
- **Summarize** is removed as a standalone tab (its content is merged into Core — see section 8). Row 2 ends up with 3 buttons; that's fine.
- **ChunkBase** is the renamed Weight tab from section 1.
- Order rationale: most-used "do something" tab first (Action), then the two universal config tabs (Core, EventBase), then the chunk-path config (ChunkBase), with peripheral integrations (AutoSync, WorldInfo, RAG) in row 2.

**Implementation:**
- Move the `active` class from the Core button at [ui-manager.js:57](ui/ui-manager.js#L57) onto the new Action button.
- Move the `vecthare-tab-active` class from the Core card at [ui-manager.js:71](ui/ui-manager.js#L71) onto the Action card at [ui-manager.js:792](ui/ui-manager.js#L792).
- Reorder the `<button>` elements in the two `vecthare-tab-nav-row` divs to match the target layout.
- Tab slugs (`data-tab` values) are unchanged — purely a DOM-order swap plus a default-active flip. Tab-switching JS at [ui-manager.js:1454-1455](ui/ui-manager.js#L1454-L1455) needs no edits.

---

## 8. Merge Summarize tab → Core

**Why it qualifies as Core:** The hint at [ui-manager.js:740](ui/ui-manager.js#L740) already states *"Provider required for summarization / EventBase extraction LLM calls"* — confirming the same provider/model/prompt powers both:

- **Chunk path:** "Summarize Before Store" condenses each message before embedding.
- **EventBase path:** Same LLM is invoked for event extraction from windows ([eventbase-extractor.js](core/eventbase-extractor.js) reads the same `vecthare_summarize_*` keys).

So this is a genuine shared dependency, not a chunk-only feature.

**What moves:** The full `data-vecthare-tab="summarize"` card at [ui-manager.js:721-789](ui/ui-manager.js#L721-L789) — including:

| Setting key (storage) | DOM element ID | Field |
|---|---|---|
| `summarize_provider` | `vecthare_summarize_provider` | Summarization Provider (OpenRouter / vLLM) |
| `summarize_openrouter_api_key` | `vecthare_summarize_openrouter_apikey` ⚠ | OpenRouter API Key |
| `summarize_vllm_url` | `vecthare_summarize_vllm_url` | vLLM Base URL |
| `summarize_vllm_api_key` | `vecthare_summarize_vllm_apikey` ⚠ | vLLM API Key |
| `summarize_model` | `vecthare_summarize_model` | Summarization Model |
| `summarize_prompt` | `vecthare_summarize_prompt` | Summarization Prompt |

⚠ **Naming mismatch trap:** The storage key uses `api_key` (with underscore) but the DOM ID uses `apikey` (no underscore). The bind code at [ui-manager.js:2061-2082](ui/ui-manager.js#L2061-L2082) bridges them. **Do not "fix" this inconsistency** during the move — see §12.1.

**Suggested placement in Core:** As a separate sub-card titled **"LLM Summarization & EventBase Extraction"** appended after the existing embedding provider section. Keep the existing yellow "⚠ Each new message stored will make one additional LLM call" banner.

**Implementation:**
- Cut the entire `<div class="vecthare-card" data-vecthare-tab="summarize">…</div>` block.
- Paste it inside the Core card (`data-vecthare-tab="core"`), adjusting the wrapper so it becomes a sub-section rather than a sibling card.
- Remove the `<button … data-tab="summarize">` from the tab nav (handled by section 7's reorder).
- The `data-vecthare-tab="summarize"` selector is no longer referenced by anything once the button is gone — leave the JS alone, the show/hide logic is keyed off `data-tab` clicks.
- Setting keys do not change → no migration needed.

**Subtitle update for Core card:** [ui-manager.js:79](ui/ui-manager.js#L79) currently reads *"Configure embedding provider and vectorization parameters"*. After this merge, suggest: *"Configure embedding provider, summarization LLM, and shared retrieval parameters"*.

---

## 9. Remove EventBase tab's LLM override fields

**Why:** The EventBase tab currently has its own *Extraction Provider / Model ID / OpenRouter API Key (override)* fields ([ui-manager.js:886-900](ui/ui-manager.js#L886-L900)). The hint already reads *"Uses OpenRouter API key from Summarize settings if not overridden below"* — i.e. they exist purely as overrides on top of the Summarize settings. With Summarize merged into Core (section 8), Core becomes the single source of truth for the extraction LLM, so a per-tab override layer adds confusion without value.

**Settings being removed from the UI:**

| Setting key | Currently bound to |
|---|---|
| `eventbase_provider` | [ui-manager.js:2965-2974](ui/ui-manager.js#L2965-L2974) |
| `eventbase_model` | [ui-manager.js:2976-2982](ui/ui-manager.js#L2976-L2982) |
| `eventbase_openrouter_api_key` | [ui-manager.js:2984-2988](ui/ui-manager.js#L2984-L2988) |
| `eventbase_vllm_url` (if present) | same block |
| `eventbase_vllm_api_key` (if present) | same block |

**Code changes required in [core/eventbase-extractor.js](core/eventbase-extractor.js):**

The extractor currently reads `settings.eventbase_*` first and only falls back to `summarize_*` for the API key. After this change it must read `summarize_*` directly:

- [line 44-51](core/eventbase-extractor.js#L44-L51) `_getOpenRouterApiKey()` → drop the `eventbase_openrouter_api_key` branch, read `summarize_openrouter_api_key` (then ST secrets fallback).
- [line 314, 367](core/eventbase-extractor.js#L314) `settings.eventbase_model` → `settings.summarize_model`.
- [line 446](core/eventbase-extractor.js#L446) `settings.eventbase_provider` → `settings.summarize_provider`.
- Same treatment for any vLLM URL / key reads.

**One-time migration on load** ([index.js](index.js) defaults block):

Existing users may have `eventbase_*` populated but `summarize_*` empty. Add a tiny migration in the settings-init code that runs once:

```js
// Migrate legacy EventBase LLM overrides into the unified Core settings
if (!settings.summarize_model && settings.eventbase_model) {
    settings.summarize_model = settings.eventbase_model;
}
if (!settings.summarize_provider && settings.eventbase_provider) {
    settings.summarize_provider = settings.eventbase_provider;
}
if (!settings.summarize_openrouter_api_key && settings.eventbase_openrouter_api_key) {
    settings.summarize_openrouter_api_key = settings.eventbase_openrouter_api_key;
}
// Repeat for vLLM url/key if those fields exist.
// Old keys can be left in storage (harmless) or deleted — either is fine.
```

This guarantees no user loses their EventBase extraction config when they update.

**Defaults block in [index.js:159-161](index.js#L159-L161):** Once the migration is in place and the extractor stops reading these keys, the `eventbase_provider` / `eventbase_model` / `eventbase_openrouter_api_key` default entries can also be deleted (next pass — not blocking for the GUI cleanup).

**Updated EventBase tab:** After removing the LLM override section, the EventBase tab keeps only its retrieval/extraction-behavior settings (window size, overlap, importance thresholds, max events per window, temperature, top_k, re-rank weights, etc.) — i.e. the things that genuinely belong to EventBase, not LLM transport config.

---

## 10. Scoping pitfalls — read before moving DOM nodes

> Past moves have broken visibility / event handlers / show-hide logic. The patterns below are the specific traps in this codebase. Anyone implementing sections 1, 2, 7, 8, or 9 should re-read this section first.

### 10.1. The `data-vecthare-tab` attribute is a global selector — never nest it

The tab switcher at [ui-manager.js:1454-1455](ui/ui-manager.js#L1454-L1455) does:

```js
$('[data-vecthare-tab]', '#vecthare_settings').removeClass('vecthare-tab-active');
$(`[data-vecthare-tab="${tab}"]`, '#vecthare_settings').addClass('vecthare-tab-active');
```

This is an **unscoped descendant selector**. It matches any element under `#vecthare_settings`, at any depth, with `data-vecthare-tab`.

**Implication for section 8 (merge Summarize into Core):** When you cut the `<div class="vecthare-card" data-vecthare-tab="summarize">…</div>` block and paste it inside the Core card, you **must remove the `data-vecthare-tab="summarize"` attribute** — or that inner block will be hidden whenever the user clicks "Core" (because the click hides everything not matching `core`, and this nested div doesn't match).

Safe pattern: paste only the *body content* of the Summarize card, not the wrapper that carries `data-vecthare-tab`. Or change the wrapper to a plain `<div class="vecthare-subsection">` with no tab attribute.

### 10.2. Default-active classes live in HTML, not in JS

[ui-manager.js:57](ui/ui-manager.js#L57) — `class="vecthare-tab-btn active"` on the Core button.
[ui-manager.js:71](ui/ui-manager.js#L71) — `class="vecthare-card vecthare-tab-active"` on the Core card.

Section 7 changes the default tab to Action. Both classes must move:

- `active` from the Core *button* → Action *button*
- `vecthare-tab-active` from the Core *card* → Action *card* ([ui-manager.js:792](ui/ui-manager.js#L792))

If you only change one, you'll get the wrong tab highlighted on first open vs. the wrong card visible.

### 10.3. Conditional show/hide helpers reference exact element IDs

Two analogous helpers exist:

- **EventBase provider show/hide** — `_showHideEventBaseProviderRows()` at [ui-manager.js:2947-2955](ui/ui-manager.js#L2947-L2955), called at [line 2974](ui/ui-manager.js#L2974). Toggles `#vecthare_eventbase_vllm_row` and `#vecthare_eventbase_openrouter_key_row`. Section 9 **deletes these rows** — also delete the helper and its caller.
- **Summarize provider show/hide** — `updateSummarizeUI()` at [ui-manager.js:~2006](ui/ui-manager.js#L2006), wired at [lines 2008-2016](ui/ui-manager.js#L2008-L2016). Toggles `#vecthare_summarize_vllm_url_row` and key visibility based on `summarize_provider`. Section 8 **moves the rows into Core** — keep this helper intact, it follows the rows automatically as long as DOM IDs are preserved.

Orphaned `$('#missing_id')` in helpers don't throw — jQuery silently binds to an empty set. So leftover helpers won't crash but will mask later refactors. Always delete the helper *with* its DOM.

The hybrid-search show/hide at [ui-manager.js:2344-2352](ui/ui-manager.js#L2344-L2352) is **unrelated** (toggles RRF vs weighted hybrid options) and is **not affected** by this reorg — leave it alone.

### 10.4. `bindSettingsEvents` is one big closure — don't orphan handlers

All event bindings live inside [`bindSettingsEvents` at line 1922](ui/ui-manager.js#L1922). When you delete the Summarize tab DOM (section 8 merges it; the wrapper goes away) or the EventBase override fields (section 9), you must also delete the corresponding `$('#vecthare_summarize_*').on(...)` and `$('#vecthare_eventbase_provider/_model/_openrouter_api_key').on(...)` blocks.

Orphaned `$('#missing_id').on('change', …)` calls don't error — jQuery silently binds to an empty set — so this kind of cruft is invisible until someone tries to extend the UI later.

### 10.5. ID stability is the contract — keep IDs even when DOM moves

`bindSettingsEvents` selects every control by `#vecthare_<setting_key>`. As long as you preserve the IDs while moving HTML between cards, all event bindings continue to work. **Do not rename any input ID** during this reorganization — even if it would read more naturally under its new tab. ID renames belong in a separate pass with its own migration.

### 10.6. The default-tab markup vs. the click handler are not symmetric

The click handler at [ui-manager.js:1448-1456](ui/ui-manager.js#L1448-L1456) handles tab switches at runtime. But the *initial* visible tab is determined purely by which card has `vecthare-tab-active` baked into its HTML. There is no JS that re-reads the URL hash, localStorage, or any "preferred default" logic.

So changing the default tab (section 7) is a 2-line HTML edit — and the only test that catches a mistake is "open the panel fresh and look." Add a manual verification step to the implementation checklist.

### 10.7. CSS selectors keyed off `data-vecthare-tab="weight"` keep working after rename

Section 1 keeps the slug `weight` and only changes the visible label. Verified the CSS layer: there are no `[data-vecthare-tab="weight"]` selectors in [ui-manager.js](ui/ui-manager.js) outside the tab switcher itself. Safe to rename the label without touching CSS.

But: if anyone in the future *also* changes the slug, they need to grep CSS files (`ui/*.css` if any) for the old slug and the JS for hardcoded references. Slug stability is the easier contract — keep it.

### 10.8. Implementation checklist (manual verification after the move)

After implementing any of sections 1, 7, 8, 9:

1. Open the settings panel **fresh** (reload the page) — confirm the intended default tab is highlighted *and* its card is visible.
2. Click each tab in order — confirm only that one card is visible at a time.
3. Specifically click **Core** and scroll through — confirm no orphan summarize-block is hidden inside it (tests rule 10.1).
4. Open browser devtools console — confirm no warnings about missing element IDs or duplicate IDs.
5. Change a setting in each moved control — refresh — confirm the value persisted (tests rule 10.5: ID stability preserved the binding).
6. For section 9 specifically: with EventBase override fields removed, set a model in the *Core* summarization section, run an EventBase extraction, confirm it uses that model.

---

## 11. Tab-level descriptions and copy fixes

Each path-scoped tab (ChunkBase, EventBase) should open with a one-line description listing the *content types* its settings apply to. Today these tabs have no top-level intro — only per-card subtitles. Without a tab-level header, users can't tell at a glance whether a tab is relevant to their content.

### 11.1. ChunkBase tab — add intro description

The Weight tab is currently a single card starting at [ui-manager.js:545](ui/ui-manager.js#L545). After section 1 (rename) + section 2 (move chunk-only settings in), it will hold multiple cards. Add a small intro element **above the first card** inside the `data-vecthare-tab="weight"` container (or, if multiple cards now share that tab, add a header element with `data-vecthare-tab="weight"` so it shows/hides with the rest of the tab).

**Text:**

> Settings on this tab apply to chunk-based content: **Lorebook / World Info**, **Character Cards**, **URLs / web pages**, **custom documents**, **wiki pages**, and **YouTube transcripts**. Chat history is handled separately under EventBase.

Suggested DOM (mirrors the existing `.vecthare-card-subtitle` styling):

```html
<div class="vecthare-tab-intro" data-vecthare-tab="weight">
    <p class="vecthare-card-subtitle">Settings on this tab apply to chunk-based content:
       <b>Lorebook / World Info</b>, <b>Character Cards</b>, <b>URLs / web pages</b>,
       <b>custom documents</b>, <b>wiki pages</b>, and <b>YouTube transcripts</b>.
       Chat history is handled separately under EventBase.</p>
</div>
```

**Scoping note (rule 10.1):** the wrapper carries `data-vecthare-tab="weight"` so it shows/hides with the tab. Place it **as a sibling of the cards**, not nested inside one — otherwise it'll be hidden when the parent card is processed.

### 11.2. EventBase tab — replace existing subtitle

EventBase tab subtitle today ([ui-manager.js:872](ui/ui-manager.js#L872)):

> AI-extracted structured story events — stored in Qdrant for semantic retrieval

This describes the *mechanism* but not the *content scope*. Replace with content-scope copy that mirrors §11.1, optionally keeping the mechanism note as a second line.

**Replacement text:**

> Settings on this tab apply to chat content: **Current Chat history** and **uploaded Archive Chat history (.jsonl)**. AI-extracted structured events are stored for semantic retrieval.

Edit target: [ui-manager.js:872](ui/ui-manager.js#L872) — single `<p class="vecthare-card-subtitle">` line replacement. No DOM structure change needed; the existing subtitle is already inside the EventBase card so scoping is fine.

### 11.3. Summarize subtitle copy fix

Current ([ui-manager.js:729](ui/ui-manager.js#L729)):

> Condense each message to a 3-5 sentence summary before embedding

The actual prompt produces longer outputs depending on input length. Change to:

> Condense each message to a 2-8 dense sentence summary before embedding

Edit target: [ui-manager.js:729](ui/ui-manager.js#L729) — single string replacement.

**Note:** This subtitle moves with the Summarize card when section 8 merges it into Core. Apply the copy fix at the same time as the merge — don't do it twice (once at the old location and again at the new). Either:
- Edit the string in place, then move the card; or
- Move the card first, then edit the string at its new location.

Both are fine — just don't leave a stale "3-5 sentence" copy somewhere after the merge lands.

### 11.4. Tab-level descriptions for the remaining tabs

The Core, AutoSync, RAG, WorldInfo, and Action tabs also lack tab-level intros. Each of their cards has a subtitle, but a user landing on a tab fresh has no one-line summary of "what does this tab control." Add a short description on each.

For each, follow the same DOM pattern as §11.1 — a `<div class="vecthare-tab-intro" data-vecthare-tab="<slug>">` placed as a **sibling** of the cards in that tab, with a single `<p class="vecthare-card-subtitle">` inside.

**Suggested copy:**

| Tab | Slug | Suggested intro text |
|---|---|---|
| **Action** | `action` | Run vectorization, sync chat with collections, browse the database, and run diagnostics. Operates on whatever path is currently active (Chunk or EventBase). |
| **Core** | `core` | Embedding provider, summarization LLM, API rate limiting, and shared retrieval parameters. Settings here apply to **both** chunk-based content and EventBase chat history. |
| **AutoSync** | `autosync` | Configure automatic synchronization between the active chat and its vector collection. Per-chat toggle, behavior on new messages, and conflict resolution. |
| **RAG** | `rag` | Retrieval-Augmented Generation injection settings — XML tag wrapping, prompt template, injection depth and position. Applies to retrieved results from any path. |
| **WorldInfo** | `worldinfo` | Semantic World Info / Lorebook activation — uses vector similarity instead of keyword matching to decide which entries to inject. Operates on chunk-based lorebook collections. |

**Implementation note:** All five share the same scoping rule from §10.1. The wrapper element must have `data-vecthare-tab="<slug>"` so it shows/hides with the tab, and must sit **as a sibling** of the cards inside the parent container — not nested inside any card. Multiple sibling elements can share the same `data-vecthare-tab` value safely; the tab switcher hides/shows them as a group.

---

## 12. Implementation reference (for the AI worker doing the move)

This section is the line-level cheat sheet. Every move below references actual line ranges in the current source. Verify with `grep` before cutting — the file may have shifted by the time you act.

### 12.1. DOM ID vs storage-key mismatches — the highest-priority landmine

Several controls have **non-matching** DOM IDs and storage keys. The bind code in `bindSettingsEvents` bridges them. **Do not "normalize" these names during the reorg** — that's a separate refactor that requires migration. List of known mismatches:

| Storage key | DOM ID | Where bridged |
|---|---|---|
| `summarize_openrouter_api_key` | `vecthare_summarize_openrouter_apikey` | [ui-manager.js:2061-2082](ui/ui-manager.js#L2061-L2082) |
| `summarize_vllm_api_key` | `vecthare_summarize_vllm_apikey` | nearby in same block |
| `query` | `vecthare_query_depth` | [ui-manager.js:2407-2417](ui/ui-manager.js#L2407-L2417) — note bind reads/writes `settings.query`, not `settings.query_depth` |
| `top_k` | `vecthare_topk` | look near the Top K input handler |
| `eventbase_openrouter_api_key` | `vecthare_eventbase_openrouter_api_key` | [ui-manager.js:2984-2988](ui/ui-manager.js#L2984-L2988) — these match, but section 9 deletes both |

When moving a control with a mismatched name, **cut the entire `<input>` / `<select>` / `<label>` HTML block as one unit** (DOM ID stays). The bind code that bridges to the storage key stays put in `bindSettingsEvents` and continues to work because IDs are preserved.

### 12.2. Line ranges — Core tab settings being moved to ChunkBase (section 2)

Cut these HTML blocks from the Core card (Core card body runs [ui-manager.js:71-542](ui/ui-manager.js#L71-L542)) and paste into the ChunkBase tab according to the §4 grouping. The Core card closes at [line 541-542](ui/ui-manager.js#L541-L542); insert ChunkBase content between [line 542](ui/ui-manager.js#L542) and the existing Temporal Weighting card start at [line 545](ui/ui-manager.js#L545).

| Setting | HTML lines to cut | Bind-event lines to leave in place (IDs preserved) |
|---|---|---|
| `insert_batch_size` | [ui-manager.js:367-371](ui/ui-manager.js#L367-L371) | [3251-3260](ui/ui-manager.js#L3251-L3260) |
| `min_chat_length` | [ui-manager.js:373-377](ui/ui-manager.js#L373-L377) (verify end) | [3263-3269](ui/ui-manager.js#L3263-L3269) |
| `score_threshold` | [ui-manager.js:379-383](ui/ui-manager.js#L379-L383) (verify end) | [2263-2273](ui/ui-manager.js#L2263-L2273) |
| `cjk_tokenizer_mode` (full bordered container) | [ui-manager.js:469-481](ui/ui-manager.js#L469-L481) | [2514-2520](ui/ui-manager.js#L2514-L2520) |
| `custom_stopwords` (full bordered container) | [ui-manager.js:483-492](ui/ui-manager.js#L483-L492) | [2505-2510](ui/ui-manager.js#L2505-L2510) |
| `query` (label `Query Depth`) | [ui-manager.js:494-498](ui/ui-manager.js#L494-L498) | [2407-2417](ui/ui-manager.js#L2407-L2417) |
| `top_k` (Top K input row) | [ui-manager.js:506-510](ui/ui-manager.js#L506-L510) | look for `vecthare_topk` |

**Stays in Core** (do NOT move):

| Setting | HTML lines | Notes |
|---|---|---|
| `rate_limit_calls` / `rate_limit_interval` | [ui-manager.js:345-365](ui/ui-manager.js#L345-L365) | API Rate Limiting block |
| `deduplication_depth` | [ui-manager.js:500-504](ui/ui-manager.js#L500-L504) | Sandwiched between `query` (move) and `top_k` (move). After cutting those neighbors, this stays. |
| Embedding provider, source, model, OpenRouter key, etc. | [ui-manager.js:~80-343](ui/ui-manager.js#L80-L343) | Don't touch |

### 12.3. Section 7 — exact tab-nav rewrite

Replace [ui-manager.js:55-68](ui/ui-manager.js#L55-L68):

**Before:**
```html
<div class="vecthare-tabs">
    <div class="vecthare-tab-nav-row">
        <button class="vecthare-tab-btn active" data-tab="core">Core</button>
        <button class="vecthare-tab-btn" data-tab="weight">Weight</button>
        <button class="vecthare-tab-btn" data-tab="rag">RAG</button>
        <button class="vecthare-tab-btn" data-tab="worldinfo">WorldInfo</button>
    </div>
    <div class="vecthare-tab-nav-row">
        <button class="vecthare-tab-btn" data-tab="autosync">AutoSync</button>
        <button class="vecthare-tab-btn" data-tab="summarize">Summarize</button>
        <button class="vecthare-tab-btn" data-tab="action">Action</button>
        <button class="vecthare-tab-btn" data-tab="eventbase">EventBase</button>
    </div>
</div>
```

**After:**
```html
<div class="vecthare-tabs">
    <div class="vecthare-tab-nav-row">
        <button class="vecthare-tab-btn active" data-tab="action">Action</button>
        <button class="vecthare-tab-btn" data-tab="core">Core</button>
        <button class="vecthare-tab-btn" data-tab="eventbase">EventBase</button>
        <button class="vecthare-tab-btn" data-tab="weight">ChunkBase</button>
    </div>
    <div class="vecthare-tab-nav-row">
        <button class="vecthare-tab-btn" data-tab="autosync">AutoSync</button>
        <button class="vecthare-tab-btn" data-tab="worldinfo">WorldInfo</button>
        <button class="vecthare-tab-btn" data-tab="rag">RAG</button>
    </div>
</div>
```

Then move `vecthare-tab-active` from the Core card div at [line 71](ui/ui-manager.js#L71) to the Action card div at [line 792](ui/ui-manager.js#L792):

- [line 71](ui/ui-manager.js#L71): `<div class="vecthare-card vecthare-tab-active" data-vecthare-tab="core">` → `<div class="vecthare-card" data-vecthare-tab="core">`
- [line 792](ui/ui-manager.js#L792): `<div class="vecthare-card" data-vecthare-tab="action">` → `<div class="vecthare-card vecthare-tab-active" data-vecthare-tab="action">`

### 12.4. Section 8 — Summarize → Core merge specifics

**Source:** Cut the entire Summarize card at [ui-manager.js:721-789](ui/ui-manager.js#L721-L789). It is `<div class="vecthare-card" data-vecthare-tab="summarize"> ... </div>`.

**Destination:** Insert as a sub-section at the **bottom of the Core card body**, before the Core card's closing `</div>` at [line 541-542](ui/ui-manager.js#L541-L542). Specifically: after the existing Injection Depth block ([line 539](ui/ui-manager.js#L539)) and before [line 541](ui/ui-manager.js#L541) `</div>` that closes the card body.

**DOM transformation when pasting** (per §10.1):

- Strip the outer wrapper `<div class="vecthare-card" data-vecthare-tab="summarize">` and its closing `</div>`.
- Replace the wrapper with `<div class="vecthare-subsection" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--grey30);">` (or any subdivider that visually separates it inside the Core card). Do **not** apply `data-vecthare-tab="..."` to the new wrapper.
- Keep the inner `<div class="vecthare-card-header">` / `<div class="vecthare-card-body">` blocks intact — they're cosmetic and don't reference `data-vecthare-tab`.

**Bind code:** The Summarize bind block at [ui-manager.js:~2006-2089](ui/ui-manager.js#L2006-L2089) (provider dropdown, model, prompt, OpenRouter key, vLLM URL, vLLM key, `updateSummarizeUI` helper) **stays in `bindSettingsEvents` unchanged**. All IDs are preserved by the move, so the existing handlers continue to bind correctly.

**Tab nav:** The `<button data-tab="summarize">` at the old [line 64](ui/ui-manager.js#L64) is removed entirely by §7's tab-nav rewrite (above). No separate edit needed.

### 12.5. Section 9 — EventBase override removal specifics

**HTML to delete:** [ui-manager.js:883-908](ui/ui-manager.js#L883-L908) — the entire block from `<!-- Provider -->` comment through the `<div id="vecthare_eventbase_vllm_row">` close. Stop at [line 910](ui/ui-manager.js#L910) `<hr>` — keep the `<hr>` and the Extraction settings block at [line 912+](ui/ui-manager.js#L912) intact.

**Bind code to delete:** [ui-manager.js:2947-2998](ui/ui-manager.js#L2947-L2998) approximately — the `_showHideEventBaseProviderRows` helper and the `.on()` handlers for `#vecthare_eventbase_provider`, `#vecthare_eventbase_model`, `#vecthare_eventbase_openrouter_api_key`, `#vecthare_eventbase_vllm_url`, `#vecthare_eventbase_vllm_api_key`. Verify the end-of-block carefully so you don't delete handlers for other EventBase settings (window size, importance thresholds, etc., which **stay**).

**Extractor code edits** ([core/eventbase-extractor.js](core/eventbase-extractor.js)):

- [line 44-51](core/eventbase-extractor.js#L44-L51) `_getOpenRouterApiKey()` currently checks `settings.eventbase_openrouter_api_key` first then `settings.summarize_openrouter_api_key`. Drop the first check — go straight to `summarize_openrouter_api_key`, then ST secrets.
- [line 314, 367](core/eventbase-extractor.js#L314) — `settings.eventbase_model` → `settings.summarize_model`. Update the error message strings to refer to "Core summarization settings" instead of "EventBase settings".
- [line 446](core/eventbase-extractor.js#L446) — `settings.eventbase_provider` → `settings.summarize_provider`.
- Search the file for any remaining `settings.eventbase_vllm_*` reads and replace with `settings.summarize_vllm_*`.

**Migration insertion point** ([index.js](index.js)): The settings init runs at [line 328-348](index.js#L328-L348). Add the migration block from §9 **immediately after [line 348](index.js#L348)** (after `migrateOldEnabledKeys()` returns), before the `console.log` at [line 348](index.js#L348). Wrap in a one-time guard if you want to be paranoid:

```js
// Migrate legacy EventBase LLM overrides → unified Core summarize settings (one-time)
const ebs = extension_settings.vecthareplus;
if (!ebs.summarize_model && ebs.eventbase_model) ebs.summarize_model = ebs.eventbase_model;
if (!ebs.summarize_provider && ebs.eventbase_provider) ebs.summarize_provider = ebs.eventbase_provider;
if (!ebs.summarize_openrouter_api_key && ebs.eventbase_openrouter_api_key) {
    ebs.summarize_openrouter_api_key = ebs.eventbase_openrouter_api_key;
}
if (!ebs.summarize_vllm_url && ebs.eventbase_vllm_url) ebs.summarize_vllm_url = ebs.eventbase_vllm_url;
if (!ebs.summarize_vllm_api_key && ebs.eventbase_vllm_api_key) {
    ebs.summarize_vllm_api_key = ebs.eventbase_vllm_api_key;
}
```

(Operates on `extension_settings.vecthareplus` directly, since `settings` is a derived merge at this point.)

**Defaults block in [index.js:159-161](index.js#L159-L161):** Leave the `eventbase_provider` / `eventbase_model` / `eventbase_openrouter_api_key` defaults in place for now — they're harmless and ensure the migration on a brand-new install does no work. Removal is a separate cleanup pass.

### 12.6. Files touched — complete summary

| File | Changes |
|---|---|
| [ui/ui-manager.js](ui/ui-manager.js) | Tab-nav rewrite (§7); rename label Weight→ChunkBase (§1); move 7 setting blocks Core→ChunkBase (§2); merge Summarize card into Core body (§8); delete EventBase LLM override block + bind handlers (§9); update 3 subtitles (§11.1, §11.2, §11.3); add 6 tab-intro elements (§11.1, §11.4) |
| [core/eventbase-extractor.js](core/eventbase-extractor.js) | Replace `eventbase_*` LLM key reads with `summarize_*` (§9) |
| [index.js](index.js) | Insert one-time migration block at line ~349 (§9) |

No other files require edits. `extension_settings.vecthareplus` storage shape is unchanged — settings are either in the same place or migrated on load.

### 12.7. Recommended implementation order

To minimize the chance of half-broken intermediate states:

1. **§11.3 first** (1-line copy fix) — easiest, no risk.
2. **§1** (rename Weight → ChunkBase label) — 1-line, low risk.
3. **§2** (move 7 chunk-only settings into ChunkBase tab) — biggest HTML move; verify after with §10.8 checklist before continuing.
4. **§11.1 and §11.2** (add ChunkBase intro, update EventBase subtitle) — small additive changes.
5. **§8** (merge Summarize into Core) — DOM move + scoping carefully.
6. **§9** (remove EventBase LLM overrides + extractor edits + migration) — most risky; split into "remove UI" → "rewire extractor" → "add migration" sub-steps and test in between.
7. **§7** (tab reorder + default-tab swap) — purely cosmetic but changes first impression; do last so it's the only thing affecting the screenshot you might use to verify the rest.
8. **§11.4** (add intros to remaining 5 tabs) — additive, can be batched after everything else lands.

After each step run the §10.8 manual checklist. Do not continue if a step leaves the panel broken.

---
#### Phase 2

> **Scope reminder — what each path actually owns.**
> - **EventBase** (chat path) is the **exclusive** retrieval path for **Current Chat history** and **uploaded Archive Chat history (.jsonl)**. Legacy chunking for chat is no longer supported — the `eventbase_enabled` toggle was removed in the prior session and chat content is hard-routed through EventBase ingestion + retrieval.
> - **ChunkBase** is used **only** for non-chat content: **Lorebook / World Info**, **Character Cards**, **URLs / web pages**, **custom documents**, **wiki pages**, and **YouTube transcripts**. ChunkBase never sees chat history of any kind.
>
> Therefore in the matrix below, "ChunkBase + Standard (A1)" means *non-chat content using Standard backend with BM25 mode*, and "EventBase + Standard (A1)" means *chat content using Standard backend with BM25 mode*. The settings under discussion apply at the `queryCollection()` layer, which is shared by both paths but invoked on different content classes.

> **Goal of Phase 2.** Phase 1 placed the entire **"Hybrid Search & BM25"** block (Keyword Scoring Method, Query Keyword Budget, BM25 k1/b, Fusion Method, RRF K) inside the **ChunkBase** tab and the **Prefer Native Backend Hybrid** toggle inside the **EventBase** tab. That placement is wrong: when [`queryCollection()`](core/core-vector-api.js) routes through Standard backend it reads `keyword_scoring_method`, `bm25_k1`, `bm25_b`, `hybrid_fusion_method`, `hybrid_rrf_k`, and `hybrid_native_prefer` regardless of whether the caller is the chunk path or the EventBase path ([eventbase-retrieval.js:118](core/eventbase-retrieval.js#L118), [eventbase-retrieval.js:291](core/eventbase-retrieval.js#L291) read these directly). So most of these settings are **shared across both paths and belong in Core**. Only `hybrid_keyword_level` (the **Query Keyword Budget** dropdown) is genuinely chunk-only — it is read solely by [core-vector-api.js:961](core/core-vector-api.js#L961) and [hybrid-search.js:419](core/hybrid-search.js#L419), both on the chunk hot path. EventBase ignores it.
>
> Phase 2 also adds the missing **backend-and-method-conditional visibility** layer. Today the existing helper [`updateNativeHybridUI()` at ui-manager.js:2089](ui/ui-manager.js#L2089) hides BM25 params when native hybrid is active, but it does **not** hide Fusion Method / RRF K when the user picks "BM25 (fast re-rank)" mode, and it does not hide Query Keyword Budget when the user picks Hybrid mode. The result is the GUI lies about which knobs are live for the user's current backend × method combination.

---

## 13. Settings usage matrix (the source of truth for Phase 2)

Because content type and path are fully coupled (chat → EventBase, non-chat → ChunkBase) and both paths funnel through the same `queryCollection()` layer, there are only **three behavioral cells** to reason about. The original 6-column table the user shared collapses to a single 3-column table:

| Setting | Storage key | A1 — Standard backend, BM25 mode | A2 — Standard backend, Hybrid mode | A3 — Qdrant native hybrid |
|---|---|---|---|---|
| Keyword Scoring Method | `keyword_scoring_method` | selects A1 path | selects A2 path | ignored (server decides) |
| BM25 k1 | `bm25_k1` | used | used | server-internal |
| BM25 b | `bm25_b` | used | used | server-internal |
| Query Keyword Budget | `hybrid_keyword_level` | **used (only here)** | not used | not used |
| Fusion Method | `hybrid_fusion_method` | not used | used | passed to server |
| RRF K | `hybrid_rrf_k` | not used | used | passed to server |
| Prefer Native Backend Hybrid | `hybrid_native_prefer` | n/a | n/a | toggles A3 vs falls back to A2 client-side |

**Path independence.** None of the rows above behave differently for chat (EventBase) vs non-chat (ChunkBase) — the path determines *which collections are queried*, not *how scoring runs inside* `queryCollection()`. So Phase 2 reasons in terms of A1/A2/A3 only and treats the EventBase/ChunkBase split as orthogonal.

**Why `hybrid_keyword_level` is the lone tab-bound exception.** It is read inside the chunk-path post-processor at [core-vector-api.js:961](core/core-vector-api.js#L961) and inside [hybrid-search.js:419](core/hybrid-search.js#L419), neither of which the EventBase retrieval pipeline ever invokes. EventBase calls `queryCollection()` directly and re-ranks with its own importance/persist/recency formula in [eventbase-retrieval.js](core/eventbase-retrieval.js), bypassing the chunk re-rank entirely. So this single setting genuinely belongs to the chunk (non-chat) tab.

**The "Qdrant + native off" edge case** (backend = qdrant, `hybrid_native_prefer = false`) is intentionally omitted from the visibility rules. When `nativeActive` is false the code already falls back through the Standard path, and the existing helper [updateNativeHybridUI at ui-manager.js:2103](ui/ui-manager.js#L2103) keys BM25 visibility off `nativeActive`, so the rules below preserve current behavior in that edge case.

---

## 14. Placement decisions — overriding Phase 1

Phase 1's earlier sections placed the BM25/hybrid block in the wrong tabs. Phase 2 supersedes those placements:

| Setting | Phase 1 placement | **Phase 2 final placement** | Reason |
|---|---|---|---|
| Keyword Scoring Method (`keyword_scoring_method`) | ChunkBase | **Core** | Read by both paths via `queryCollection()` |
| BM25 k1 (`bm25_k1`) | ChunkBase | **Core** | Read by both paths |
| BM25 b (`bm25_b`) | ChunkBase | **Core** | Read by both paths |
| Fusion Method (`hybrid_fusion_method`) | ChunkBase | **Core** | Read by both paths |
| Vector / Text weights (`hybrid_vector_weight`, `hybrid_text_weight`) | ChunkBase | **Core** | Same as Fusion Method (sub-controls) |
| RRF K (`hybrid_rrf_k`) | ChunkBase | **Core** | Read by both paths |
| Prefer Native Backend Hybrid (`hybrid_native_prefer`) | EventBase tab (Phase 1 last move) | **Core** | Backend-level routing toggle — applies to both paths |
| **Query Keyword Budget (`hybrid_keyword_level`)** | ChunkBase | **ChunkBase** (stays) | Only chunk path reads it ([core-vector-api.js:961](core/core-vector-api.js#L961), [hybrid-search.js:419](core/hybrid-search.js#L419)) |

Net effect after Phase 2:
- The "Hybrid Search & BM25" block currently at [ui-manager.js:546-624](ui/ui-manager.js#L546-L624) (inside the ChunkBase Hybrid Search & BM25 sub-section) moves **back into the Core card**, except for the Query Keyword Budget control which stays in ChunkBase.
- The "Prefer Native Backend Hybrid" `<div id="vecthare_native_prefer_section">` block at [ui-manager.js:945-952](ui/ui-manager.js#L945-L952) moves out of the EventBase card and into the Core card, alongside the rest of the hybrid block.

---

## 15. Visibility rules (replaces today's partial helper)

The expanded `updateNativeHybridUI()` must derive four flags and apply them across both Core and ChunkBase tabs:

```js
const backend       = settings.vector_backend || 'standard';
const method        = settings.keyword_scoring_method || 'bm25';
const preferNative  = settings.hybrid_native_prefer !== false;
const supportsNative = backend === 'qdrant';
const nativeActive  = supportsNative && preferNative;        // A3
const isHybridMode  = !nativeActive && method === 'hybrid';  // A2 (or Qdrant+prefer=false fallback)
const isBM25Mode    = !nativeActive && method === 'bm25';    // A1
```

| DOM element | Visibility expression | Tab after Phase 2 |
|---|---|---|
| `#vecthare_native_prefer_section` | `supportsNative` | Core |
| `#vecthare_keyword_method_section` (Keyword Scoring Method dropdown wrapper, **without** keyword budget — see §16.2) | `!nativeActive` | Core |
| `#vecthare_native_hybrid_info` (the static "Native hybrid active" hint) | `nativeActive` | Core |
| `#vecthare_bm25_params` | `!nativeActive` | Core |
| `#vecthare_hybrid_params` (parent of Fusion Method / RRF K / weights) | `isHybridMode \|\| nativeActive` | Core |
| `#vecthare_hybrid_keyword_budget_wrapper` (new — wraps Query Keyword Budget only) | `isBM25Mode` | **ChunkBase** |

The last row is the one that crosses tabs: a control rendered in ChunkBase whose visibility is driven by Core-tab settings. This works because the helper is global (runs on every settings panel render and on every change to `vector_backend`, `keyword_scoring_method`, or `hybrid_native_prefer`).

The existing inner toggle for `#vecthare_hybrid_weights` vs `#vecthare_hybrid_rrf_settings` based on `hybrid_fusion_method` ([ui-manager.js:2330-2338](ui/ui-manager.js#L2330-L2338)) is unaffected and stays inside `#vecthare_hybrid_params`.

---

## 16. HTML moves — exact line-level steps

### 16.1. Move the shared block out of ChunkBase, back into Core

**Source (cut):** [ui-manager.js:546-623](ui/ui-manager.js#L546-L623) — the entire `<!-- Hybrid Search & BM25 -->` section currently inside the ChunkBase card body. This block contains:
- The `<p class="vecthare-section-label">Hybrid Search & BM25</p>` header
- `<div id="vecthare_keyword_method_section">` (Keyword Scoring Method **plus** Query Keyword Budget — split below)
- `<div id="vecthare_native_hybrid_info">`
- `<div id="vecthare_bm25_params">`
- The outer wrapper containing `<div id="vecthare_hybrid_params">`

**Destination:** Insert the cut block as a sub-section near the bottom of the Core card body, after the API Rate Limiting block and before the Core card closes. Suggested anchor: between [ui-manager.js:365](ui/ui-manager.js#L365) (end of rate limiting) and the next existing setting.

The DOM IDs and event-handler bindings at [ui-manager.js:2275-2390](ui/ui-manager.js#L2275-L2390) are preserved by ID — no JS changes needed for the move itself (rule §10.5: ID stability).

### 16.2. Split out the Query Keyword Budget so only it stays in ChunkBase

The current `<div id="vecthare_keyword_method_section">` ([ui-manager.js:550-569](ui/ui-manager.js#L550-L569)) bundles two controls inside one wrapper: the Keyword Scoring Method dropdown **and** the Query Keyword Budget dropdown. They need different homes after Phase 2 — the method dropdown goes to Core, the budget dropdown stays in ChunkBase.

**Refactor:** Replace the single bundled wrapper with two siblings:

```html
<!-- Goes to Core (renamed for clarity, ID kept for backward compat with helper) -->
<div id="vecthare_keyword_method_section" style="margin-top: 8px;">
    <label><small>Keyword Scoring Method</small></label>
    <select id="vecthare_keyword_scoring_method" class="vecthare-select"> ... </select>
    <small class="vecthare_hint">BM25 re-ranks the vector top-K candidates. Hybrid expands the vector candidate window, scores those candidates with BM25, then fuses both signals.</small>
</div>

<!-- Goes to ChunkBase (new wrapper, new ID for the new visibility rule) -->
<div id="vecthare_hybrid_keyword_budget_wrapper" style="margin-top: 8px;">
    <label><small>Query Keyword Budget</small></label>
    <select id="vecthare_hybrid_keyword_level" class="vecthare-select"> ... </select>
    <small class="vecthare_hint">Max keywords extracted from your query for BM25 scoring (CJK priority; +10 English overflow when CJK fills budget). Used only when Standard backend + BM25 mode is active.</small>
</div>
```

The select element IDs (`vecthare_keyword_scoring_method`, `vecthare_hybrid_keyword_level`) **must not change** — both have bind handlers that depend on those IDs ([ui-manager.js:2275](ui/ui-manager.js#L2275), [ui-manager.js:2285](ui/ui-manager.js#L2285)).

### 16.3. Move the Prefer Native toggle out of EventBase, into Core

**Source (cut):** [ui-manager.js:945-952](ui/ui-manager.js#L945-L952) — the entire `<div id="vecthare_native_prefer_section">` block plus the comment line above it. Currently sits inside the EventBase Retrieval section between Min Importance and Injection Format.

**Destination:** Place it as the **first** element of the new Hybrid Search & BM25 block in Core, above `#vecthare_keyword_method_section`. Rationale: it's the highest-level control (gates whether the user is in A3 or falls back to A2), and `updateNativeHybridUI` keys other visibility off it.

ID stays `vecthare_native_prefer_section` so [`$('#vecthare_native_prefer_section').toggle(...)` at ui-manager.js:2096](ui/ui-manager.js#L2096) keeps working.

### 16.4. Add a "Hybrid Search & BM25" group to ChunkBase containing only the keyword budget

After §16.1 cuts the bundled block out, ChunkBase loses its hybrid section header. Re-add a minimal wrapper inside the ChunkBase card body so the orphan keyword-budget control has a labeled home:

```html
<p class="vecthare-section-label" style="font-weight:600; margin-top:16px; margin-bottom:8px;">Keyword Budget</p>
<small class="vecthare_hint" style="display: block; margin-bottom: 8px;">
  Chunk-path-only setting. Other hybrid/BM25 knobs live under <b>Core → Hybrid Search & BM25</b>.
</small>
<!-- #vecthare_hybrid_keyword_budget_wrapper (from §16.2) is placed here -->
```

Place this just above the existing **Temporal Weighting Defaults** card — keep ChunkBase's section ordering: Keyword Extraction (CJK Tokenizer / Custom Stopwords from Phase 1 §4) → **Keyword Budget** → Temporal Weighting Defaults.

If after the cut the ChunkBase card has no other sub-sections beyond Keyword Budget and Temporal Weighting, that is fine — it correctly reflects that ChunkBase has exactly one chunk-only hybrid setting.

---

## 17. JS changes — expand `updateNativeHybridUI()`

**Location:** [ui-manager.js:2089-2104](ui/ui-manager.js#L2089-L2104).

**Replacement body:**

```js
function updateNativeHybridUI() {
    const backend       = settings.vector_backend || 'standard';
    const method        = settings.keyword_scoring_method || 'bm25';
    const supportsNative = backend === 'qdrant';
    const preferNative  = settings.hybrid_native_prefer !== false;
    const nativeActive  = supportsNative && preferNative;
    const isHybridMode  = !nativeActive && method === 'hybrid';
    const isBM25Mode    = !nativeActive && method === 'bm25';

    // Native-prefer toggle: only when backend supports it
    $('#vecthare_native_prefer_section').toggle(supportsNative);

    // Keyword scoring method dropdown vs static "native active" notice
    $('#vecthare_keyword_method_section').toggle(!nativeActive);
    $('#vecthare_native_hybrid_info').toggle(nativeActive);

    // BM25 k1/b: visible whenever client-side BM25 logic runs (A1 or A2)
    $('#vecthare_bm25_params').toggle(!nativeActive);

    // Fusion Method + RRF K: visible in A2 (hybrid mode) and A3 (passed to server)
    $('#vecthare_hybrid_params').toggle(isHybridMode || nativeActive);

    // Query Keyword Budget (ChunkBase): visible only in A1
    $('#vecthare_hybrid_keyword_budget_wrapper').toggle(isBM25Mode);
}
```

**Wiring:** the helper must run on three additional triggers beyond today's calls:

1. ✅ Already called on backend change at [ui-manager.js:2143](ui/ui-manager.js#L2143).
2. ✅ Already called on `hybrid_native_prefer` change at [ui-manager.js:2386](ui/ui-manager.js#L2386).
3. ✅ Already called on initial load at [ui-manager.js:2390](ui/ui-manager.js#L2390).
4. ➕ **New:** call at the end of the `keyword_scoring_method` change handler at [ui-manager.js:2275-2282](ui/ui-manager.js#L2275-L2282). Insert `updateNativeHybridUI();` immediately after the `console.log(...)` line.

That single added call is what makes Fusion Method / RRF K / Query Keyword Budget react to method switches.

**Cross-tab caveat (rule §10.1 reminder):** `#vecthare_hybrid_keyword_budget_wrapper` lives inside the ChunkBase tab's card. Calling `.toggle(false)` on it sets `display:none` directly on the element. The tab switcher at [ui-manager.js:1454-1455](ui/ui-manager.js#L1454-L1455) toggles `vecthare-tab-active` on the **parent card**, not on the inner element, so a `display:none` set by `updateNativeHybridUI()` survives a tab switch. This is the desired behavior — the wrapper stays hidden when not in BM25 mode regardless of which tab is currently visible.

---

## 18. Settings persistence — no migration needed

All seven storage keys already exist in [index.js:102-127](index.js#L102-L127) defaults. Phase 2 is **purely a DOM and JS visibility refactor** — no key renames, no default changes, no migration. Existing user settings continue to apply.

---

## 19. Updated tab descriptions (Phase 1 §11 follow-up)

The Phase 1 ChunkBase intro at §11.1 listed "chunk-based content: Lorebook / World Info, Character Cards, URLs / web pages, custom documents, wiki pages, and YouTube transcripts." That copy is still correct after Phase 2; **no edit needed**. The single setting remaining in ChunkBase that crosses scope (Query Keyword Budget) is hidden when not in A1 mode anyway.

The Phase 1 Core intro at §11.4 should be updated to mention the new responsibility:

> **Before (Phase 1 §11.4):** Embedding provider, summarization LLM, API rate limiting, and shared retrieval parameters. Settings here apply to **both** chunk-based content and EventBase chat history.
>
> **After (Phase 2):** Embedding provider, summarization LLM, API rate limiting, **hybrid search & BM25 parameters**, and shared retrieval parameters. Settings here apply to **both** chunk-based content and EventBase chat history.

Edit target: the Core row in the Phase 1 §11.4 implementation table.

---

## 20. Verification — six-cell coverage matrix

Run all six combinations after implementing Phase 2 and confirm the visible UI matches the spec. Use browser devtools' element inspector for hidden/`display:none` confirmation, not just visual scan.

| # | Backend | Method | Prefer Native | Visible in Core | Visible in ChunkBase |
|---|---|---|---|---|---|
| 1 | Standard | BM25 | n/a (hidden) | Keyword Scoring Method, BM25 k1, BM25 b | Query Keyword Budget |
| 2 | Standard | Hybrid | n/a (hidden) | Keyword Scoring Method, BM25 k1, BM25 b, Fusion Method, RRF K (or weights) | *(no hybrid controls)* |
| 3 | Qdrant | (irrelevant) | ✓ on | Prefer Native toggle, "Native hybrid active" notice, Fusion Method, RRF K | *(no hybrid controls)* |
| 4 | Qdrant | BM25 | ✗ off | Prefer Native toggle, Keyword Scoring Method, BM25 k1, BM25 b | Query Keyword Budget |
| 5 | Qdrant | Hybrid | ✗ off | Prefer Native toggle, Keyword Scoring Method, BM25 k1, BM25 b, Fusion Method, RRF K | *(no hybrid controls)* |
| 6 | (any) → switch backend live | (any) | (any) | All affected controls re-render correctly without page reload | Same |

**Acceptance criterion:** flipping `vecthare_vector_backend`, `vecthare_keyword_scoring_method`, or `vecthare_hybrid_native_prefer` while the panel is open updates visibility on **both** Core and ChunkBase tabs without requiring a tab switch or panel close/reopen. Open both tabs in turn after each flip to confirm.

---

## 21. Phase 2 implementation order

Recommended sequence to keep intermediate states sane:

1. **§16.2 first** (split the bundled wrapper into two siblings) — this is purely structural; nothing visual changes if both still live in ChunkBase momentarily. Run §10.8 checklist after.
2. **§16.1** (cut the shared block from ChunkBase, paste into Core). After this, the panel will look broken on the Core/ChunkBase tabs until §17 re-runs visibility logic — accept that briefly.
3. **§16.3** (cut Prefer Native toggle from EventBase, paste into Core).
4. **§16.4** (add the small Keyword Budget header back to ChunkBase wrapping the budget control).
5. **§17** (replace `updateNativeHybridUI` body, add the missing call after the method-change handler). Now the panel should work.
6. **§19** (update Core tab intro text).
7. **§20** verification — walk all six matrix rows.

Stop and revert if a step leaves the panel broken in a way the next step doesn't fix immediately.

---

## 22. Files touched in Phase 2

| File | Changes |
|---|---|
| [ui/ui-manager.js](ui/ui-manager.js) | DOM: split keyword_method_section (§16.2); cut hybrid block from ChunkBase + paste into Core (§16.1); cut native-prefer toggle from EventBase + paste into Core (§16.3); add ChunkBase Keyword Budget header (§16.4). JS: expand `updateNativeHybridUI` (§17); wire it to method-change handler. Copy: update Core tab intro (§19). |
| (no other files) | No backend code, no extractor, no defaults, no migrations. |
