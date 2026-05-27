# Plan: Independent Auto-Sync Window + "Inject Last N Turn Summary"

**Status**: Ready to implement. The pre-existing dedup bug (see §9) was fixed via C3 (smart-marker placement) on 2026-05-20 and promoted to prod (`main` at SHA `81e580c`). End-to-end verified against a live chat (full evidence in §9.9). This plan now builds on top of C3:
- **Feature A** (independent auto-sync window): ~70 net new lines. §4.1 embeds the C3 re-stamp hook inline.
- **Feature B** (Inject Last N Turn Summary): ~130 net new lines.
- **§10 C4 evolution**: ~20 net new lines (incl. deleting the warn modal). Continue inherits the proven C3 marker code path, eliminating the asymmetry between "fire-now" and "fire-on-trigger" gap-fill. C4 supersedes C3's "auto-sync silent + Continue warn" split into a fully-silent "both paths use the marker" design.

An implementer can follow the plan top-to-bottom; §9 (bug-fix history) is reference-only and §10 is the final wiring step.

**Author intent**: Two related features, planned together because feature B depends on feature A. Plus a small UI re-home of two existing controls so each tab owns exactly its own concerns.

- **Feature A — Independent auto-sync window size.** The existing `eventbase_window_size` setting today controls *both* the one-off **Vectorize Content** flow and the auto-sync flow. Make a second, completely independent window-size knob owned by the AutoSync tab. After this change, the existing setting only affects one-off vectorization, and the new AutoSync setting only affects auto-sync. They cannot accidentally interfere.

- **Feature B — Inject Last N Turn Summary.** New checkbox + slider on the **AutoSync** tab (lives there, not on the EventBase tab, because the feature is only meaningful when auto-sync is active — without auto-sync the EventBase collection goes stale and the "recent N turns" injection would inject old data). When enabled, the most recent N EventBase events (sorted by `source_window_end` desc) are injected into the prompt every turn, providing word-for-word-ish memory of the last N turns. For the math to make sense ("last 10 turns = last 10 stored events"), the auto-sync window must be exactly 1 turn (2 messages) — so enabling this feature **forces and locks** the AutoSync window slider (sitting right next to it on the same tab) to 1 turn.

- **UI re-home (companion change).** The existing "Window Size (messages)" and "Window Overlap" sliders on the EventBase tab are misplaced after Feature A — they no longer affect auto-sync or retrieval, only the one-off **Vectorize Content** flow for chat history (live chat backfill + chat-history file upload). Move them out of the EventBase tab and into the Vectorize Content panel, visible only when the chat content type is selected. The underlying setting keys (`eventbase_window_size`, `eventbase_window_overlap`) stay the same — only the UI moves, so there's no migration.

**Relationship to `plans/autosync-tab-enhancements.md`**: That earlier plan adds a *fire-frequency gate* still tied to the shared `eventbase_window_size`. This plan changes direction: auto-sync gets its own window setting entirely, so the fire-frequency math from that plan would need to be re-derived against the new setting. The parallel-windows piece of that plan is orthogonal and remains useful regardless. Recommendation: this plan supersedes §1–§3 of `autosync-tab-enhancements.md`; the parallel-windows portion (§4 onward) can still ship independently.

---

## 0. Pre-flight verifications

Before changing code, confirm the surface area is what was read while planning. Line numbers are post-C3 (the bug fix shipped on 2026-05-20 — see §9).

| Verification | Expected |
|---|---|
| `Grep` `eventbase_window_size\|eventbase_window_overlap` across the repo | Reads in workflow: [`core/eventbase-workflow.js:95-96`](core/eventbase-workflow.js#L95-L96) (runEventBaseIngestion) and [`:726-727`](core/eventbase-workflow.js#L726-L727) (isChatFullyVectorized). Writes: [`index.js:179-180`](index.js#L179-L180) (defaults `window_size=2`, `window_overlap=0`). UI slider inputs: [`ui/ui-manager.js:869-876`](ui/ui-manager.js#L869) (lifted in §4.2) with bindings at [`:3413-3414`](ui/ui-manager.js#L3413). One-off vectorize sends them: [`ui/content-vectorizer.js:2598-2599`](ui/content-vectorizer.js#L2598-L2599). If any extra hits appear, audit before changing. |
| `Grep` `runEventBaseIngestion` call sites | 3 callers: auto-sync at [`core/chat-vectorization.js:370`](core/chat-vectorization.js#L370), backfill at [`core/chat-vectorization.js:1572`](core/chat-vectorization.js#L1572), and one-off vectorize at [`ui/content-vectorizer.js:2642`](ui/content-vectorizer.js#L2642). Only the first is "auto-sync"; the other two are user-triggered. |
| `Grep` `findEventBaseCollectionIdsForChat\|stampAutoSyncMarker` | Helpers already exist post-C3 at [`core/eventbase-store.js:321`](core/eventbase-store.js#L321) (stamp) and [`:522`](core/eventbase-store.js#L522) (collection-id resolver). Both will be re-used by the migration hook in §4.1. |
| Verify EventBase event metadata carries `source_window_end` | See [`core/eventbase-store.js:75`](core/eventbase-store.js#L75) — `index` field is set from `source_window_end`, and the full event is spread into `metadata`. Already exposed via `listChunks` (used by §3.1 and by the C3 marker stamper). |
| Verify EventBase prompt tag | [`core/eventbase-workflow.js:31`](core/eventbase-workflow.js#L31) — `EVENTBASE_PROMPT_TAG`. Feature B (§3) uses a **separate** tag (`_eventbase_lastn`) so the two injections don't collide. |

If any check fails, stop and investigate before writing code.

## 0.5 Foundations already in place (post-C3)

When this plan was first written, several pieces of mechanism were proposed as part of Feature A or as separate risk-mitigation work. The C3 bug fix shipped on 2026-05-20 (see §9.5 for details) already delivered them, so the plan now builds on top rather than introducing them. Specifically:

| Mechanism | Status | Where to find it |
|---|---|---|
| Per-chat auto-sync marker storage | ✅ shipped | `extension_settings.vectfox.eventbase_autosync_start_marker` ([`index.js:181-186`](index.js#L181-L186)) |
| `stampAutoSyncMarker(uuid, settings)` — smart-placement helper | ✅ shipped | [`core/eventbase-store.js:321`](core/eventbase-store.js#L321) |
| `getAutoSyncMarker` / `clearAutoSyncMarker` accessors | ✅ shipped | [`core/eventbase-store.js:286, 296`](core/eventbase-store.js#L286) |
| `getLastUsedWindowSize` / `setLastUsedWindowSize` | ✅ shipped | [`core/eventbase-store.js:367, 377`](core/eventbase-store.js#L367) |
| Marker filter in `runEventBaseIngestion` (auto-sync only) | ✅ shipped | [`core/eventbase-workflow.js:180-192`](core/eventbase-workflow.js#L180-L192) |
| `lastUsedWindowSize` stamp on successful run | ✅ shipped | [`core/eventbase-workflow.js:457-459`](core/eventbase-workflow.js#L457-L459) |
| Stamp on auto-sync enable + clear on disable | ✅ shipped | [`ui/ui-manager.js:2073-2139`](ui/ui-manager.js#L2073-L2139) |
| Vectorization tip cache (`getVectorizationTip`, `setVectorizationTip`, `clearVectorizationTip`, `ensureVectorizationTip`) | ✅ shipped | [`core/eventbase-store.js:47-101`](core/eventbase-store.js#L47) |
| Window-size-change warn modal on Continue path | ✅ shipped | [`ui/content-vectorizer.js:2584-2620`](ui/content-vectorizer.js#L2584-L2620) |

**Practical impact on this plan**: Feature A is now essentially "add a slider, plumb an override, call the existing stamper when the slider changes." See §6 for the post-C3 effort estimate.

---

## 0.6 Pre-implementation fix: vectorization tip persistence

**Do this before starting §1.** It is a self-contained cleanup (~20 lines net) that removes async complexity from a hot code path and makes the "vectorization: N msgs" display correct for all backends.

### Why the current approach is wrong

The 2026-05-26 "auto sync number display fix" commit (SHA `8962838`) added `ensureVectorizationTip` to fix the UI showing the frozen auto-sync start marker instead of the live extraction progress. The fix works by probing the backend via `listChunks` on a cold in-memory cache (after page reload) to recompute `max(source_window_end) + 1`.

**The problem**: the Standard backend's `listChunks` falls back to SillyTavern's native `/api/vector/list` when the similharity plugin is not available. That native endpoint returns **hashes only** — `metadata: {}` for every item. `ensureVectorizationTip` therefore returns `null` for Standard-without-plugin users on every page reload, and the UI silently falls back to the stale marker value. The backend probe also makes `getChatAutoSyncStatus` unnecessarily `async`, which complicates two callers in `ui-manager.js` that were previously simple sync calls.

### What the existing code does (shipped in `8962838`)

| Function | Role |
|---|---|
| `ensureVectorizationTip(chatUUID, collectionId, settings)` at [`:74`](core/eventbase-store.js#L74) | Async. On in-memory cache miss, calls `getBackend(settings)` → `listChunks(collectionId, settings, { limit: 10000 })`, scans items for `max(metadata.source_window_end)`, populates `_vectorizationTipByUuid`, returns the tip. Returns `null` if the backend probe fails or returns no metadata. |
| `getChatAutoSyncStatus(settings)` at [`eventbase-workflow.js:852`](core/eventbase-workflow.js#L852) | Made `async` solely to `await ensureVectorizationTip(...)`. Returns `vectorizationTip` in the status object. |
| `refreshAutoSyncCheckbox` and the auto-sync change handler in `ui-manager.js` | Changed to `await getChatAutoSyncStatus(settings)` (were simple sync calls before `8962838`). |

The in-memory setter (`setVectorizationTip`) is called correctly by the ingestion loop after every successful window — so the display is accurate **during the session**. The backend probe only matters on a **cold reload before the next ingestion fires**.

### The fix: persist the tip in `extension_settings`

The tip is already being written by `setVectorizationTip` after every successful window. If that same call also writes to `extension_settings.vectfox.eventbase_vectorization_tip[chatUUID]`, then `getVectorizationTip` can read it back on a cold reload without any backend involvement — making the whole stack synchronous and backend-agnostic.

### Implementation

**Step 1 — Add the default key to [`index.js`](index.js)** near the existing `eventbase_autosync_start_marker` block:

```js
eventbase_vectorization_tip: {},   // chatUUID → number (max source_window_end + 1)
```

**Step 2 — Rewrite `setVectorizationTip` in [`core/eventbase-store.js:52`](core/eventbase-store.js#L52)** to also persist:

```js
export function setVectorizationTip(chatUUID, tip) {
    if (!chatUUID || typeof tip !== 'number' || !Number.isFinite(tip)) return;
    const current = _vectorizationTipByUuid.get(chatUUID) ?? -1;
    if (tip > current) {
        _vectorizationTipByUuid.set(chatUUID, tip);
        const stored = extension_settings.vectfox;
        if (tip > (stored.eventbase_vectorization_tip?.[chatUUID] ?? -1)) {
            if (!stored.eventbase_vectorization_tip) stored.eventbase_vectorization_tip = {};
            stored.eventbase_vectorization_tip[chatUUID] = tip;
            saveSettingsDebounced();
        }
    }
}
```

**Step 3 — Rewrite `getVectorizationTip` in [`core/eventbase-store.js:47`](core/eventbase-store.js#L47)** to warm the in-memory cache from `extension_settings` on cold read:

```js
export function getVectorizationTip(chatUUID) {
    if (!chatUUID) return undefined;
    const cached = _vectorizationTipByUuid.get(chatUUID);
    if (typeof cached === 'number') return cached;
    const persisted = extension_settings.vectfox?.eventbase_vectorization_tip?.[chatUUID];
    if (typeof persisted === 'number') {
        _vectorizationTipByUuid.set(chatUUID, persisted);
        return persisted;
    }
    return undefined;
}
```

**Step 4 — Delete `ensureVectorizationTip`** ([`core/eventbase-store.js:74`](core/eventbase-store.js#L74)) entirely. It is no longer called by anything after Step 5.

**Step 5 — Revert `getChatAutoSyncStatus` to sync** ([`core/eventbase-workflow.js:852`](core/eventbase-workflow.js#L852)):
- Remove `async` from the function signature.
- Replace `const vectorizationTip = await ensureVectorizationTip(uuid, match.collectionId, settings);` with `const vectorizationTip = getVectorizationTip(uuid);` (import `getVectorizationTip` instead of `ensureVectorizationTip`).

**Step 6 — Revert the two `await` calls in [`ui/ui-manager.js`](ui/ui-manager.js)**:
- [`refreshAutoSyncCheckbox` (~line 1726)](ui/ui-manager.js#L1726): `const status = await getChatAutoSyncStatus(settings);` → `const status = getChatAutoSyncStatus(settings);`
- [Auto-sync change handler (~line 2081)](ui/ui-manager.js#L2081): same one-word revert.

### What this does NOT change

- `clearVectorizationTip` stays — it should also clear `extension_settings.vectfox.eventbase_vectorization_tip[chatUUID]` (add that one line to its body).
- `setVectorizationTip` is already called in the right place (`runEventBaseIngestion` after each successful window). No ingestion-loop changes needed.
- The `vectorizationTip` field in the `getChatAutoSyncStatus` return object stays — callers (`refreshAutoSyncCheckbox`) already consume it.

### Edge case: existing users with no persisted tip

First session after this ships, `getVectorizationTip` returns `undefined` (nothing in `extension_settings` yet) → UI falls back to `markerValue`. This is the exact same behavior as before `8962838` — not a regression. The persisted tip populates correctly on the next ingestion run and is accurate from that point forward.

---

## 1. Storage layer — new settings

Add to `defaultSettings` in [`index.js`](index.js) near the existing `eventbase_window_size` block (line ~179). Group them by which tab will own them, since that's how the user will reason about them:

```js
// --- AUTO-SYNC TAB ---

// Independent auto-sync window size. Owned by the AutoSync tab; has no effect
// on one-off Vectorize Content or on retrieval. Expressed in TURNS (1 turn =
// 2 messages: 1 human reply + 1 AI reply). Internally: messageCount = turns * 2.
// Range 1-20. Default 1 (most reactive, matches the smallest legacy window=2).
eventbase_autosync_window_turns: 1,

// When enabled, the most recent N EventBase events (sorted by source_window_end
// desc) are injected into the prompt at the configured position/depth, every
// turn. Independent of the standard EventBase semantic-retrieval injection.
// Lives on the AutoSync tab because it's only meaningful when auto-sync is
// active (otherwise the EventBase collection goes stale and the "last N turns"
// injection serves stale data).
eventbase_inject_last_n_enabled: false,

// Number of recent turn-summaries to inject. Range 1-30.
// Only meaningful when eventbase_inject_last_n_enabled is true.
eventbase_inject_last_n_count: 10,
```

**No new keys for the moved sliders.** `eventbase_window_size` and `eventbase_window_overlap` keep their existing names and defaults (`2` and `0`). Only their UI surface moves to the Vectorize Content panel — see §4.2. Keeping the keys avoids any migration concern.

**Migration**: none anywhere in this plan. New keys default to safe values; existing keys keep their values and meanings.

---

## 2. Feature A — Independent auto-sync window

### 2.1 Workflow signature change

Edit [`core/eventbase-workflow.js`](core/eventbase-workflow.js) — `runEventBaseIngestion` ([`:59`](core/eventbase-workflow.js#L59)).

Add two new optional params with `undefined` as the default sentinel:

```js
export async function runEventBaseIngestion({
    messages,
    chatUUID,
    settings,
    abortSignal = null,
    progressPlan = null,
    collectionIdOverride = null,
    parallelWindows = 3,
    isAutoSync = false,
    suppressAutoSyncPopup = false,
    // NEW — when provided, overrides settings.eventbase_window_size / overlap.
    // Pass these from the auto-sync caller; leave undefined for one-off callers.
    windowSizeOverride = undefined,
    windowOverlapOverride = undefined,
}) {
```

Replace the block at [`:95-97`](core/eventbase-workflow.js#L95-L97) with:

```js
const windowSize = windowSizeOverride != null
    ? Math.max(2, windowSizeOverride)
    : Math.max(2, settings.eventbase_window_size || 6);
const windowOverlap = windowOverlapOverride != null
    ? Math.max(0, Math.min(windowSize - 1, windowOverlapOverride))
    : Math.max(0, Math.min(windowSize - 1, settings.eventbase_window_overlap ?? 0));
const step = windowSize - windowOverlap;
```

Apply the same change at [`:726-727`](core/eventbase-workflow.js#L726-L727) (the `isChatFullyVectorized` helper). It doesn't currently take an isAutoSync flag so the override params are functionally moot there, but pass them anyway so future callers can use the same signature shape. After editing, grep the file to confirm no other `settings.eventbase_window_size` / `eventbase_window_overlap` reads slip through.

**Why an override param instead of a new settings key read inside the function**: keeps the workflow agnostic about *which* settings key holds the auto-sync window size. The caller decides. Future-proofs against further callers wanting custom windows (e.g. a "deep re-extract" mode).

### 2.2 Auto-sync caller passes the new setting

Edit [`core/chat-vectorization.js`](core/chat-vectorization.js) — the auto-sync invocation at line 371:

```js
const turns = Math.max(1, Math.min(20, settings.eventbase_autosync_window_turns ?? 1));
const result = await runEventBaseIngestion({
    messages,
    chatUUID: uuid,
    settings,
    isAutoSync: true,
    suppressAutoSyncPopup: triggerEvent === 'MESSAGE_SENT',
    windowSizeOverride: turns * 2,
    windowOverlapOverride: 0,  // auto-sync uses no overlap — every turn-pair is independent
});
```

**Decision: zero overlap for auto-sync.** The canonical default overlap is already 0 (and the missing-value fallback was aligned to 0 as a prep step before this plan), so passing `0` here matches what auto-sync would have used anyway. Stating it explicitly serves two purposes: (1) it's defensive against a future change to the one-off default that would otherwise leak into auto-sync, and (2) it documents the hard requirement — overlap > 0 would break the "1 stored event = 1 turn" guarantee Feature B depends on, since neighboring windows would share a message and the dedup logic would produce overlapping events.

### 2.3 Other callers untouched

> **Note**: `rearrangeChat` (the ST generation interceptor in this file) now has a 4th optional `{ dryRun, testMessage }` parameter added for the debug query tester. The auto-sync and backfill callers do not pass it — it defaults to `false` and is a no-op for Feature A.

- [`core/chat-vectorization.js:1572`](core/chat-vectorization.js#L1572) — backfill caller. Do NOT pass `windowSizeOverride`. Backfill respects the EventBase-tab slider, which is the user's intent for a manually-triggered "process my whole chat" action.
- [`ui/content-vectorizer.js:2642`](ui/content-vectorizer.js#L2642) — one-off Vectorize Content. Same: do NOT pass override.

After this change, the EventBase-tab "Window Size (messages)" slider continues to control only those two callers. The AutoSync slider controls only auto-sync. Independence achieved.

### 2.4 Validation invariants

| Invariant | How verified |
|---|---|
| Existing `eventbase_window_size` slider (now in Vectorize Content panel per §4.2) still works for one-off chat backfill. | Open Vectorize Content, set window_size=4, run extraction, confirm `[EventBase] Ingestion: ... (size=4, overlap=0)` log. |
| Auto-sync ignores the Vectorize Content panel's window_size and reads only its own turns setting. | Set Vectorize Content window_size to 6, AutoSync turns to 1, trigger auto-sync via AI reply, confirm log shows `size=2`. |
| Marker re-stamp fires when auto-sync window-turns slider changes. | Move the slider, confirm `[EventBase] AutoSyncMarker stamped: ... marker=N` log line. (Covered by test #6/#7 in §5.) |
| No regression in the quick-exit dedup path. | Trigger auto-sync twice with no new messages between — second run must hit `[EventBase] Quick-exit: last window already extracted`. The `_msgHash` and fingerprint logic doesn't read window_size, so this should just work, but eyeball it. |

---

## 3. Feature B — Inject Last N Turn Summary

### 3.1 New module: `core/eventbase-last-n-injection.js`

A new file, not a modification to existing injection logic. The standard EventBase injection ([`core/eventbase-injection.js`](core/eventbase-injection.js)) is keyed off semantic retrieval — re-using it would conflate two different injection sources. Keep them in different files with different prompt tags so debugging is unambiguous.

**Responsibilities**:
1. Resolve current chat's EventBase collection ID.
2. Fetch all events via backend `listChunks` (request `limit: max(N * 2, 100)` to leave headroom — list is unsorted by index in some backends).
3. Filter to entries with `metadata.eventbase === true` (skip any non-EventBase chunks if collection is shared).
4. Sort descending by `metadata.source_window_end`.
5. Slice top N.
6. Format and inject under a dedicated extension prompt tag.

```js
// core/eventbase-last-n-injection.js
import { setExtensionPrompt } from '../../../../../script.js';
import { getBackend } from '../backends/backend-manager.js';
import { getChatUUID, getRegistryBackend } from './collection-ids.js';
import { findEventBaseCollectionIdsForChat } from './eventbase-store.js';
import { EXTENSION_PROMPT_TAG } from './constants.js';

const LAST_N_PROMPT_TAG = `${EXTENSION_PROMPT_TAG}_eventbase_lastn`;

export async function runLastNTurnInjection(settings) {
    if (!settings?.eventbase_inject_last_n_enabled) {
        setExtensionPrompt(LAST_N_PROMPT_TAG, '', settings.position, settings.depth, false);
        return { injected: 0 };
    }

    const n = Math.max(1, Math.min(30, settings.eventbase_inject_last_n_count ?? 10));
    const uuid = getChatUUID();
    if (!uuid) {
        setExtensionPrompt(LAST_N_PROMPT_TAG, '', settings.position, settings.depth, false);
        return { injected: 0 };
    }

    const backend = getRegistryBackend(settings?.vector_backend);
    const candidates = findEventBaseCollectionIdsForChat(uuid, backend);
    if (!candidates.length) {
        setExtensionPrompt(LAST_N_PROMPT_TAG, '', settings.position, settings.depth, false);
        return { injected: 0 };
    }

    let backendInstance;
    try {
        backendInstance = await getBackend(settings);
    } catch (err) {
        console.warn('[LastN] Backend init failed — skipping injection:', err.message);
        return { injected: 0, error: err.message };
    }

    let items = [];
    try {
        // Overfetch by 2x or floor of 100 — listChunks order is not guaranteed across backends.
        const limit = Math.max(n * 2, 100);
        const result = await backendInstance.listChunks(candidates[0].collectionId, settings, { limit });
        items = Array.isArray(result?.items) ? result.items : [];
    } catch (err) {
        console.warn('[LastN] listChunks failed — skipping injection:', err.message);
        return { injected: 0, error: err.message };
    }

    const events = items
        .filter(it => it?.metadata?.eventbase === true)
        .sort((a, b) => (b.metadata.source_window_end ?? 0) - (a.metadata.source_window_end ?? 0))
        .slice(0, n);

    if (!events.length) {
        setExtensionPrompt(LAST_N_PROMPT_TAG, '', settings.position, settings.depth, false);
        return { injected: 0 };
    }

    const formatted = _formatLastN(events);
    setExtensionPrompt(LAST_N_PROMPT_TAG, formatted, settings.position, settings.depth, false);
    return { injected: events.length };
}

function _formatLastN(events) {
    // Reverse to chronological order for the LLM (oldest → newest).
    const ordered = [...events].reverse();
    const lines = ordered.map((evt, idx) => {
        const m = evt.metadata || {};
        const summary = _stripEventTypePrefix(evt.text || m.summary || '');
        const order = m.source_window_end ?? '-';
        return `Turn ${idx + 1} (msg ${order}): ${summary}`;
    });
    return [
        '[Recent Turn Memory — last ' + events.length + ' turn(s), chronological order]',
        ...lines,
    ].join('\n');
}

function _stripEventTypePrefix(text) {
    const first = String(text).split('\n')[0];
    const m = first.match(/^\[[^\]]+\]\s*(.*)$/);
    return m ? m[1] : first;
}
```

**Why a separate tag**: `setExtensionPrompt` is keyed by tag — same tag overwrites. The standard EventBase injection uses `EVENTBASE_PROMPT_TAG`; if we reused it, whichever path ran last would silently clobber the other. The dedicated `_eventbase_lastn` tag makes the two payloads stack cleanly and lets the user disable one without affecting the other.

### 3.2 Hook point — when does it run?

Add a call from the same orchestration point that runs `runEventBaseRetrieval`. Find that caller via `Grep runEventBaseRetrieval` and invoke `runLastNTurnInjection(settings)` immediately after it, in parallel via `Promise.all` since the two have no dependency on each other.

The call must happen every prompt-generation cycle — same cadence as retrieval — so the injected content stays current as new events get extracted.

Skip the call entirely when `eventbase_inject_last_n_enabled === false` (cheap early-exit inside `runLastNTurnInjection` already handles this, but a caller-side check saves the import cost on the hot path).

### 3.3 Insufficient-data behavior

Per user spec ("inject whatever exists"):
- If 0 events: `setExtensionPrompt(tag, '', ...)` — clears any stale injection.
- If 1 to N-1 events: inject all of them, no padding, no fallback to raw chat text. The injection header reflects the actual count (`last 4 turn(s)` not `last 10 turn(s)`).

No warning toast. The user understands the chat is young.

### 3.4 Legacy-event handling

Per user spec ("use them as-is, count each as 1"):
- An event extracted earlier with `windowSize=6` still counts as 1 in the sort/slice. `source_window_end` is the only ranking signal.
- This means "last 10 turns" in a chat with mixed old/new events may actually cover more than 20 messages of history. That's acceptable per spec — the feature degrades to "approximately last N events" gracefully.

No migration, no warning, no special-casing.

---

## 4. GUI changes

### 4.0 Overview — who owns what after this change

| Tab | Owns | Why |
|---|---|---|
| AutoSync | New "Auto-sync window (turns)" slider; new "Inject Last N Turn Summary" checkbox + count slider; existing auto-sync checkboxes (popup, progress modal) | Everything that depends on auto-sync being active lives in one place. The inject feature is meaningless without auto-sync, and the lock between the inject checkbox and the window slider is now intra-tab (no cross-tab UI state to coordinate). |
| EventBase | All other existing EventBase retrieval / extraction prompt / model controls (unchanged) | Things that affect EventBase extraction or retrieval regardless of auto-sync state |
| Vectorize Content (panel, chat type) | The moved "Window Size (messages)" + "Window Overlap" sliders | These controls only affect one-off chat-history vectorization now, so they belong with the other one-off vectorize controls |

This is purely a UI re-organization for the moved sliders — same setting keys, same defaults, same behavior, different home.

### 4.1 AutoSync tab — new window-size slider

Location: [`ui/ui-manager.js`](ui/ui-manager.js), within the AutoSync tab card. The tab's content starts near line 742 (the `eventbase_autosync_popup` checkbox is the visual anchor). Insert the new slider **above** the existing checkboxes so the rhythm controls cluster together.

```html
<div class="vectfox-form-group">
    <label class="vectfox-label">
        Auto-sync window: <span id="VectFox_eventbase_autosync_window_turns_val">1</span> turn(s)
        <span class="VectFox_hint_inline" id="VectFox_autosync_window_msg_equiv">(= 2 messages)</span>
    </label>
    <input type="range" id="VectFox_eventbase_autosync_window_turns"
           min="1" max="20" step="1" class="vectfox-range" />
    <small class="VectFox_hint">
        Independent of the EventBase tab's Window Size. 1 turn = 2 messages
        (1 human reply + 1 AI reply). Auto-sync fires after every N turns
        of new chat. Locked to 1 while "Inject Last N Turn Summary" is on.
    </small>
</div>
```

Binding — note the re-stamp hook on value change. This is the **single migration hook** that ties this plan back to the C3 mechanism (§9.8): when the auto-sync window changes, re-stamp the per-chat marker so the new window size doesn't appear to need a re-extraction storm.

```js
$('#VectFox_eventbase_autosync_window_turns').on('input', async function() {
    const val = parseInt(this.value, 10) || 1;
    const prev = extension_settings.vectfox.eventbase_autosync_window_turns;
    extension_settings.vectfox.eventbase_autosync_window_turns = val;
    $('#VectFox_eventbase_autosync_window_turns_val').text(val);
    $('#VectFox_autosync_window_msg_equiv').text(`(= ${val * 2} messages)`);
    saveSettingsDebounced();

    // C3 migration hook — re-stamp the marker so the new window size starts
    // "from the current high-water mark" instead of triggering a backfill storm.
    // No-op when value didn't actually change (input event fires on every drag tick).
    if (prev !== val) {
        try {
            const { stampAutoSyncMarker } = await import('../core/eventbase-store.js');
            const { getChatUUID } = await import('../core/collection-ids.js');
            const uuid = getChatUUID();
            if (uuid) await stampAutoSyncMarker(uuid, extension_settings.vectfox);
        } catch (err) {
            console.warn('[VectFox] Failed to re-stamp marker on window-size change:', err?.message || err);
        }
    }
});
```

Initial value population: in the existing settings-load function (search for where other autosync settings are restored), add `$('#VectFox_eventbase_autosync_window_turns').val(settings.eventbase_autosync_window_turns ?? 1).trigger('input');` to fire the binding once to refresh the label. The re-stamp hook **does not fire on load** in this case: `defaultSettings` already seeded `eventbase_autosync_window_turns`, so by the time the binding runs, `prev === val` and the `if (prev !== val)` guard skips the re-stamp. Re-stamping only triggers on real user-driven changes, which is what we want.

### 4.2 Vectorize Content panel — re-home Window Size / Window Overlap (chat type only)

**Delete** the existing markup from [`ui/ui-manager.js`](ui/ui-manager.js) at [`:869-876`](ui/ui-manager.js#L869-L876) — the EventBase-tab "Extraction" section that holds the Window Size and Window Overlap sliders. Also delete the `_bindEventBaseRange` lines for those two sliders at [`:3413-3414`](ui/ui-manager.js#L3413-L3414).

**Add** equivalent controls inside the Vectorize Content panel ([`ui/content-vectorizer.js`](ui/content-vectorizer.js)), positioned next to the existing Parallel Windows slider (the existing pattern at line 245 shows the visibility model: the row's `id` lets the type-switcher show/hide it). Both new rows should be shown only for chat content type (`chat`), the same gating already used for Parallel Windows.

```html
<!-- Window Size - EventBase/chat only (moved from EventBase tab) -->
<div class="vectfox-cv-slider-row" id="vectfox_cv_window_size_row" style="display:none;">
    <label>
        Window Size
        <span class="vectfox-cv-value" id="vectfox_cv_window_size_val">2</span> messages
    </label>
    <input type="range" id="vectfox_cv_window_size"
           min="2" max="20" step="1" value="2">
    <div class="vectfox-cv-slider-hints">
        <span>2 (granular)</span>
        <span>20 (coarse)</span>
    </div>
</div>

<!-- Window Overlap - EventBase/chat only (moved from EventBase tab) -->
<div class="vectfox-cv-slider-row" id="vectfox_cv_window_overlap_row" style="display:none;">
    <label>
        Window Overlap
        <span class="vectfox-cv-value" id="vectfox_cv_window_overlap_val">0</span>
    </label>
    <input type="range" id="vectfox_cv_window_overlap"
           min="0" max="5" step="1" value="0">
    <div class="vectfox-cv-slider-hints">
        <span>0 (none)</span>
        <span>5 (high)</span>
    </div>
</div>
```

Bind to the **same** setting keys (`eventbase_window_size`, `eventbase_window_overlap`) so no migration is needed:

```js
$('#vectfox_cv_window_size').on('input', function() {
    const val = parseInt(this.value, 10) || 2;
    extension_settings.vectfox.eventbase_window_size = val;
    $('#vectfox_cv_window_size_val').text(val);
    saveSettingsDebounced();
});
$('#vectfox_cv_window_overlap').on('input', function() {
    const val = parseInt(this.value, 10) || 0;
    extension_settings.vectfox.eventbase_window_overlap = val;
    $('#vectfox_cv_window_overlap_val').text(val);
    saveSettingsDebounced();
});
```

Show/hide gating: locate the existing logic that toggles `#vectfox_cv_parallel_row` visibility based on selected content type. Add the new `#vectfox_cv_window_size_row` and `#vectfox_cv_window_overlap_row` to the same toggle so they appear and disappear together. Reference: [`ui/content-vectorizer.js:805`](ui/content-vectorizer.js#L805) already comments that "Chat history now follows EventBase extraction settings" — that comment becomes literally true once the sliders live here.

Initial value population: in the existing settings-load function for the panel, add:
```js
$('#vectfox_cv_window_size').val(settings.eventbase_window_size ?? 2).trigger('input');
$('#vectfox_cv_window_overlap').val(settings.eventbase_window_overlap ?? 0).trigger('input');
```

**Why no new setting keys**: the auto-sync caller will pass its own values via `windowSizeOverride` (§2.2). Every other reader of `eventbase_window_size`/`eventbase_window_overlap` already represents the one-off vectorize path — see the Grep table in §0. Renaming the keys would force migration logic, which violates [`feedback_no_fallback_or_migration.md`](C:\Users\Goten\.claude\projects\h--Github-Dev-VectFox\memory\feedback_no_fallback_or_migration.md). Keep the names; just move the GUI.

### 4.3 AutoSync tab — new injection section

Location: [`ui/ui-manager.js`](ui/ui-manager.js), within the **AutoSync** tab card, immediately **below** the new "Auto-sync window (turns)" slider added in §4.1. Visually clustering inject-checkbox + count-slider directly under the window slider makes the lock relationship obvious (the inject checkbox visibly grays out the slider right above it).

```html
<div class="vectfox-form-group">
    <label class="vectfox-checkbox-label">
        <input type="checkbox" id="VectFox_eventbase_inject_last_n_enabled" />
        <span>Inject Last N Turn Summary</span>
    </label>
    <small class="VectFox_hint">
        Inject the most recent N EventBase summaries into the prompt every turn,
        in addition to semantic retrieval. Enables word-for-word-ish memory of
        the last few turns. <strong>Forces AutoSync window to 1 turn while on.</strong>
    </small>
</div>
<div class="vectfox-form-group" id="VectFox_eventbase_inject_last_n_count_group">
    <label class="vectfox-label">
        Inject last <span id="VectFox_eventbase_inject_last_n_count_val">10</span> turn(s)
    </label>
    <input type="range" id="VectFox_eventbase_inject_last_n_count"
           min="1" max="30" step="1" class="vectfox-range" />
</div>
```

### 4.4 The lock — one-way (inject controls autosync)

Per user spec. Implement as a small UI helper called from both the checkbox binding and the settings-load function (so the lock state is correct on page load too):

```js
function _applyLastNLock() {
    const enabled = !!extension_settings.vectfox.eventbase_inject_last_n_enabled;
    const $slider = $('#VectFox_eventbase_autosync_window_turns');
    if (enabled) {
        // Force to 1 and disable.
        if (extension_settings.vectfox.eventbase_autosync_window_turns !== 1) {
            extension_settings.vectfox.eventbase_autosync_window_turns = 1;
            $slider.val(1).trigger('input');
            saveSettingsDebounced();
        }
        $slider.prop('disabled', true);
        $slider.closest('.vectfox-form-group').find('.VectFox_hint')
            .after('<small class="VectFox_hint VectFox_hint_locked" data-lock="last-n">' +
                   'Locked to 1 turn by "Inject Last N Turn Summary".</small>');
    } else {
        $slider.prop('disabled', false);
        $slider.closest('.vectfox-form-group').find('[data-lock="last-n"]').remove();
    }
}

$('#VectFox_eventbase_inject_last_n_enabled').on('change', function() {
    extension_settings.vectfox.eventbase_inject_last_n_enabled = this.checked;
    saveSettingsDebounced();
    _applyLastNLock();
});

$('#VectFox_eventbase_inject_last_n_count').on('input', function() {
    const val = parseInt(this.value, 10) || 10;
    extension_settings.vectfox.eventbase_inject_last_n_count = val;
    $('#VectFox_eventbase_inject_last_n_count_val').text(val);
    saveSettingsDebounced();
});
```

Call `_applyLastNLock()` once at the end of the settings-load function so the lock survives a page reload.

**Why one-way and not two-way**: per user spec, but the rationale: two-way means moving the autosync slider could silently flip a feature off, which is a UX surprise. One-way means the lock direction is obvious — the checkbox owns the slider's state, not vice versa.

### 4.5 Same-tab placement notes

With the inject controls moved to the AutoSync tab (§4.3), the lock relationship is now intra-tab — no cross-tab DOM coordination needed. Three concrete consequences:

1. **The locked-window hint is visible at the same time as the inject checkbox** — when the user checks the box, the slider immediately above it grays out and the "Locked to 1 turn" hint appears in the same viewport. No tab-switch surprise.

2. **The locked hint text** can simply say "Locked to 1 turn by checkbox below" instead of naming the feature explicitly, since the checkbox is right there. (Keeping the full feature name is also fine; either is unambiguous.)

3. **`_applyLastNLock()` still runs at the same two moments** — on settings load (so the lock state is correct after a page reload) and on checkbox change. The implementation in §4.4 needs no changes for this move; it queries by element ID, which doesn't care which tab the elements live on.

---

## 5. Testing checklist

Run through each, in order. The **C3** column flags tests where the bug-fix mechanism participates — those need close attention since their behavior depends on a correct re-stamp hook (§4.1) or a marker stamped at the right value.

| # | Setup | Action | Expected | C3 |
|---|---|---|---|---|
| 1 | Fresh install, both features off | Open AutoSync tab | Three new controls visible (turns slider defaults to 1, inject checkbox unchecked, count slider defaults to 10) and the existing Window Size / Window Overlap sliders are **gone** from the EventBase tab | |
| 2 | Same | Open Vectorize Content panel for chat type | The moved Window Size / Window Overlap sliders appear here; default to 2 / 0 | |
| 3 | One-off Vectorize Content panel: window=4 overlap=0; AutoSync slider: turns=3 | Run one-off Vectorize Content on chat | Log: `Ingestion: ... → ... windows (size=4, overlap=0)`. Does not consult AutoSync slider. | |
| 4 | Same | Trigger auto-sync via AI reply | Log shows `size=6, overlap=0` (3 turns × 2). Confirms the two settings are fully independent. | |
| 5 | Fresh chat, AutoSync turns=1, autosync ON, inject checkbox OFF | Send 5 user/AI turn pairs | 5 events appear, each `source_window_end` = 2, 4, 6, 8, 10. Marker stamped at chat length on enable, then unchanged. | ✓ |
| 6 | Chat with existing events at window=2 (e.g. 100 events covering messages 0-199), autosync OFF, turns slider at 1 | Enable autosync, then **move turns slider to 5** | Console shows `AutoSyncMarker stamped: ... marker=200` on enable, then a **second** stamp after the slider move (re-stamp hook). Next AI reply does NOT trigger a 100-window re-extraction — only the windows past the new marker get processed. | ✓ critical |
| 7 | Same chat, autosync turns=5, inject checkbox OFF | Enable inject checkbox (count=3) | Turns slider snaps to 1 + grays out, "Locked to 1 turn" hint appears. **Marker is re-stamped** (slider change fires the hook). Next AI reply processes only the new tail, NOT a full re-extraction at window=2. | ✓ critical |
| 8 | Same chat (now has fresh events at window=2 from #7), inject ON, count=3 | Trigger one more AI reply | Prompt inspector shows "Recent Turn Memory — last 3 turn(s)" with the newest 3 events sorted by `source_window_end` desc, chronologically rendered | |
| 9 | Inject ON, count=10, only 3 events exist | Trigger generation | Injection shows "last 3 turn(s)" — no padding, no error | |
| 10 | Inject ON, no chat open | Trigger generation | No injection (early-exit), no console error | |
| 11 | Inject ON, then uncheck | Turns slider on AutoSync tab | Slider re-enabled, no leftover lock hint. Retains value 1 (since the lock forced it). | |
| 12 | Two chats: Chat A has 20 events with inject ON; switch to Chat B (fresh, no events) | Generate in Chat B | Injection is empty for B (no events yet), no leakage from A | |
| 13 | Switch backend Qdrant ↔ Standard with inject ON | Generate | Both backends return last N events; injected format identical | |
| 14 | Enable EventBase debug logging | Trigger generation | Single log line per fire (`[LastN] Injected N events…`), no spam | |
| U1 | Fresh chat, no events | Open Vectorize Content, click Continue at window=2 | Full extract (no marker stamped, no filter applied). Behavior identical to today's fresh-chat extract. **No modal** — the old window-size-change modal is gone. | ✓ (§10) |
| U2 | Chat with 680 events at window=4 (`source_window_end` max = 2115), chat at 2126, autosync OFF | Set Vectorize Content window=2, click Continue | **No modal**. Console: `AutoSyncMarker stamped: marker=2116`, then `AutoSync marker filter: 1063 → 5 windows (marker=2116)` (filter fires because `respectCoverageMarker=true` even though `isAutoSync=false`). 5 LLM calls. Collection ends with 680 window=4 + 5 window=2 events. | ✓ (§10) critical |
| U3 | Same as U2 but Vectorize Content window=4 (unchanged) | Click Continue | Same outcome via marker filter: 2 windows past marker (msgs 2116-2119, 2120-2123) extracted. Equivalent net effect to today's fingerprint-cache path. | ✓ (§10) |
| U4 | Chat with events; marker previously stamped at 1000 from prior autosync | Click Continue at chat=2000 | Marker re-stamped at fresh `max + 1` (probably > 1000). Continue gap-fills from new boundary. Next autosync fire sees advanced marker — no double work. | ✓ (§10) |

**Critical tests are #6, #7, U2** — they exercise the marker mechanism under the exact conditions where the pre-C3 code would have triggered a re-extraction storm. If any fails, the user pays the cost they explicitly came here to avoid.

If any test fails, do **not** ship — root-cause first. #4 (independence), #6 & #7 (autosync re-stamp), U2 & U3 (Continue unification), and #13 (backend parity) are the spec-defining tests.

---

## 6. Files touched (summary)

Post-C3 effort estimate. The C3 mechanism (marker, smart placement) is already shipped — see §0.5. This plan adds the UI surface that exercises it, plus the §10 unification of Continue with autosync's marker path.

| File | Change | Effort |
|---|---|---|
| [`index.js:181`](index.js#L181) | +3 default settings keys (`eventbase_autosync_window_turns`, `eventbase_inject_last_n_enabled`, `eventbase_inject_last_n_count`) next to the existing C3 marker/window-size keys | ~3 lines, trivial |
| [`core/eventbase-workflow.js:59`](core/eventbase-workflow.js#L59) | (§2) Add `windowSizeOverride` / `windowOverlapOverride` params to `runEventBaseIngestion` signature; thread through to the size/overlap derivation at [`:95-97`](core/eventbase-workflow.js#L95-L97). Same change at [`isChatFullyVectorized:725-727`](core/eventbase-workflow.js#L725). (§10) Add `respectCoverageMarker = false` param; change gate at [`:170`](core/eventbase-workflow.js#L170) from `if (isAutoSync)` to `if (isAutoSync \|\| respectCoverageMarker)` | ~12 lines, trivial |
| [`core/chat-vectorization.js:371`](core/chat-vectorization.js#L371) | Auto-sync caller passes the new overrides derived from `eventbase_autosync_window_turns * 2` | ~3 lines, trivial |
| [`core/eventbase-last-n-injection.js`](core/eventbase-last-n-injection.js) | **NEW** — Feature B logic (`runLastNTurnInjection` reads stored events via existing `listChunks`, sorts by `source_window_end`, formats, calls `setExtensionPrompt`) | ~80 lines, the meat of Feature B |
| Caller of `runEventBaseRetrieval` (locate via Grep — same file as the EventBase retrieval orchestration in `eventbase-workflow.js`) | Invoke `runLastNTurnInjection(settings)` alongside retrieval; gate with `if (settings.eventbase_inject_last_n_enabled)` for cheap early-exit | ~5 lines |
| [`ui/ui-manager.js`](ui/ui-manager.js) | **Delete** EventBase-tab Window Size / Window Overlap sliders at [`:869-876`](ui/ui-manager.js#L869) and their bindings at [`:3413-3414`](ui/ui-manager.js#L3413). **Add** to AutoSync tab: turns slider (with re-stamp hook per §4.1), inject checkbox + count slider, `_applyLastNLock` helper, load-time bindings. | ~70 lines net (after deletes), modest |
| [`ui/content-vectorizer.js`](ui/content-vectorizer.js) | (§4.2) **Add** Window Size / Window Overlap slider rows next to the existing Parallel Windows row at [`:245`](ui/content-vectorizer.js#L245). Bind to existing setting keys. Add to chat-type visibility toggle. (§10) Add empty-collection check in `_runEventBaseBackfill`; call `stampAutoSyncMarker` and pass `respectCoverageMarker: true` when non-empty. **Delete** window-size-change warn modal at [`:2584-2620`](ui/content-vectorizer.js#L2584) — no longer needed. | ~20 lines net (35 added + 30 deleted), small |

**Net new lines**: roughly **180** (≈90 Feature A + Continue-unification, ≈130 Feature B, minus ~30 deleted modal). No setting-key renames, no migrations, no new mechanism — the C3 fix did the foundational work, and §10 reuses it for Continue.

---

## 7. Out of scope (deliberately)

- **Re-extracting old events at 1-turn granularity** when the user enables the checkbox. Per spec: legacy events count as-is.
- **Mixing raw chat text with summaries** when fewer than N events exist. Per spec: inject whatever's there.
- **Two-way lock** (slider unchecks the checkbox). Per spec: one-way.
- **Per-collection inject-last-N override**. Single global setting for now.
- **Token-budget cap on the injection block**. N is the only knob; if 30 long summaries blow past the prompt limit, that's the user's responsibility. Could be added later if needed.
- **The fire-frequency gate from `autosync-tab-enhancements.md`**. Not built here — that plan's parallel-windows section can still ship; the fire-frequency section needs to be re-thought against the new independent window.
- **A user-driven "re-extract entire chat" button**. After §10 deletes the warn modal, there's no in-app affordance for the rare case of wanting to re-process a chat from scratch at a new window size. The supported workaround is: Database Browser → Delete the collection → click Continue on the now-empty collection. Two clicks, no surprises. If this turns out to be a common request later, a "Re-extract from scratch" option in the Vectorize Content panel can be added — but defer until there's evidence of demand.

---

## 8. Risk / blast radius

| Risk | Likelihood | Mitigation |
|---|---|---|
| Override param plumbing breaks one-off vectorize | Very low | Defaults preserve existing behavior; only auto-sync caller passes overrides. Override params land as `undefined` on the other two call sites and the `!= null` guard makes them no-ops. |
| Continue's gap-fill (post-§10 unification) misbehaves in some edge case | Very low | Continue now calls the same marker code path that autosync has been running in production since 2026-05-20 (`main` @ `81e580c`) and was verified end-to-end (§9.9). Continue inherits the proven behavior. Empty-collection fallback preserves today's full-extract path bit-for-bit. |
| Two injections (semantic + last-N) double up on the same recent events | Medium | Acceptable — the standard retrieval has its own recent-context skip ([`index.js:100`](index.js#L100) comment). The last-N injection is intentionally redundant by design ("word-for-word memory"). |
| Slider lock confuses users ("why can't I move this?") | Medium | The locked hint explicitly names the feature responsible. Acceptable UX cost for the simpler one-way model. |
| `listChunks` returns more than the configured `limit` somewhere | Low | Sort + slice happens client-side anyway; over-return is harmless, under-return is handled (Feature B injects whatever exists). |
| User has 1000+ events at window=2, enables Inject Last N → autosync window forced to 1 → potential re-extraction storm | **NEUTRALIZED** by C3 (§9) | The re-stamp hook in §4.1 fires on the silent slider change; smart marker placement skips backfill. Verified end-to-end during the C3 test session (see §9.9). |
| Override params get passed but `eventbase_autosync_window_turns` not seeded in defaultSettings → `undefined * 2 = NaN` | Low | The auto-sync caller derives `turns = Math.max(1, Math.min(20, settings.eventbase_autosync_window_turns ?? 1))` — `??` rescues missing values, clamp bounds bad ones. |

**Removed from previous risk list**: "Lock helper races with tab switch" — since the lock is now intra-tab (both controls on AutoSync tab per the user's direction in earlier discussion), there's no cross-tab race to worry about.

Per [`feedback_no_fallback_or_migration.md`](C:\Users\Goten\.claude\projects\h--Github-Dev-VectFox\memory\feedback_no_fallback_or_migration.md): no migration logic added anywhere. New settings keys default cleanly; legacy events count as-is in the new feature (and C3 already ensures legacy events aren't re-processed).

---

## 9. Pre-existing dedup bug — discovered, fixed, verified (this session)

**Discovered**: 2026-05-19 while debugging a user-reported "auto-sync keeps running and not stopping" against the Dev branch. The bug pre-dated this plan but would have been triggered at scale by Feature B's window lock, so it was a hard blocker.

**Fixed**: 2026-05-20 on the Dev branch via the C3 design with smart marker placement. End-to-end verified against the user's live chat (1350 pre-existing events + 5 user replies + window-size change from 2→4). The bug-fix change set is currently uncommitted on Dev; will be committed and promoted to prod before this plan starts.

This section is kept as a permanent record so future readers understand why the marker mechanism exists and how to extend it for the plan (§9.8).

### 9.1 The bug

The window-extraction dedup cache in [`core/eventbase-store.js:329`](core/eventbase-store.js#L329) fingerprints each window by **the exact set of message hashes inside that window**:

```js
export function windowFingerprint(sourceHashes) {
    return [...sourceHashes].map(String).sort().join(',');
}
```

That fingerprint is window-size-dependent. If a chat had its events extracted at `windowSize=2`, the cache holds fingerprints like `hash(m0)+hash(m1)`, `hash(m2)+hash(m3)`, .... Switching to `windowSize=4` makes the workflow build *new* fingerprints like `hash(m0)+hash(m1)+hash(m2)+hash(m3)`, which **never match** any stored 2-msg fingerprint. The dedup check therefore returns false for every window, and the workflow re-extracts the entire chat from scratch — silently, with no warning, costing the user the full LLM bill again and bloating the collection with duplicate-coverage events.

### 9.2 Real-world impact observed

User changed window size from `2` to `4` on a chat with ~1350 existing events (extracted at window=2), then enabled auto-sync. Captured log line from that buggy run (subsequently overwritten — preserved here as evidence):

```
[EventBase] Ingestion: 2117 messages → 529 windows (size=4, overlap=0)
```

Neither `Fast-forward: skipped N already-extracted window(s)` nor `Quick-exit: last window already extracted` ever fired — confirming 100% cache miss. All 529 windows would be re-extracted. Collection grew from 1350 → 1423 chunks by the time the user noticed (~11% into the re-extraction), with another ~7-8 minutes of LLM calls remaining and an expected final count of ~1950-2350 chunks of overlapping-coverage events.

### 9.3 Why this is a blocker for the present plan

This plan introduces a UI lock that **forces** `eventbase_autosync_window_turns = 1` (window=2 messages) when the user enables "Inject Last N Turn Summary". Any user whose existing events were extracted at a different window size will hit the exact same bug the moment they enable the new checkbox — and worse, because the lock is silent the user won't know they triggered a re-extraction. On the example chat above:
- Enable inject feature → lock to window=2 → next message → 2117 / 2 = 1058 windows of re-extraction → ~17 minutes of LLM spend → collection bloats to ~3000+ duplicate-coverage events.

This violates the user's spec for Feature B ("legacy events count as-is, no re-extraction") because the underlying dedup mechanism can't honor that — it has no concept of "this message is covered by some event"; it only knows about exact-window-membership fingerprints.

### 9.4 Candidate fixes considered

| Option | Approach | Effort | Honors "use as-is" spec? | Notes |
|---|---|---|---|---|
| **A. Window-size-agnostic dedup** | Replace per-window fingerprints with **per-message coverage tracking**. Cache stores `Set<messageHash>` of every message that any event covers. A new window is "already extracted" if every message in it is covered. | High — touches dedup logic, persisted cache format, and migration of existing fingerprint-based caches | **Yes** | Real fix; future-proof against any window-size or overlap change. Most code surface. Handles internal gaps too. |
| **B. Detect + warn modal** | Before starting an extraction run, compare the in-memory cache against the proposed window plan. If non-empty but no fingerprints match, show a blocking modal asking to re-extract or cancel. | Low | **Partially** — only if user picks "skip" | Doesn't fix root cause, just makes cost visible. |
| **C. Skip-backfill marker on enable** | When auto-sync flips ON, stamp a per-chat marker representing "everything before this message is considered covered (or not, by user's choice — we don't backfill it)." Auto-sync workflow filters windows by this marker. | Medium | **Yes** | Matches "from now on" mental model. Doesn't touch dedup format. |
| **C1** narrow variant | Marker for auto-sync only; Continue retains today's behavior (no warning, full re-extract on window-size change) | Lowest | Yes for auto-sync; No for Continue | Continue is a loaded gun. |
| **C2** marker-for-both | Marker applies to Continue too. Continue refuses to re-process messages before marker. | Medium | Surprises the user — they explicitly chose Continue to *re*-process. Rejected. |
| **C3** auto-sync silent + Continue warn | Auto-sync uses marker silently. Continue detects window-size change vs `lastUsedWindowSize` and warns before proceeding. | Medium | Yes for auto-sync; warned-yes for Continue | **Shipped 2026-05-20** (`main` @ `81e580c`). Superseded by C4 in §10. |
| **C4** auto-sync silent + Continue silent (same code path) | Auto-sync **and** Continue both use the marker. Continue stamps the marker on the fly when invoked on a non-empty collection, then runs through the same `respectCoverageMarker` gate in the workflow. Empty-collection Continue falls back to today's full extract (the "Continue with nothing to continue from" case). No warn modal — the silent gap-fill *is* the right answer. | Low (built on C3) | **Yes** for both paths | **Planned** — see §10. Removes ~30 lines (the modal) and adds ~20 lines (empty-collection check + `respectCoverageMarker` param). Net code change is *negative*. Single tested mechanism (the C3 marker code path) covers both UX entry points, so there's nothing new to validate from scratch. |

### 9.5 Shipped design — C3 with smart marker placement (2026-05-20)

> **Note**: C3 was the first iteration and is in production today. Subsequent design refinement (§10) evolves C3 into C4 by routing Continue through the same marker path and deleting the warn modal. The bullets below describe what was actually shipped; refer to §10 for the post-evolution behavior.

**Why C3 was chosen at shipping time:** Auto-sync is the "passive / don't surprise me" path → silent marker. Continue is the "explicit action" path → user gets a warning when the action will be expensive, can choose to proceed. Window-size changes during normal usage are rare (chat-lifetime decision); when they happen, the warning was deemed enough.

**Why C4 supersedes it:** in practice, the warning is fatigue, not protection — users click Continue meaning "catch me up," not "re-process my entire chat." The warn modal asks them to make a high-stakes choice they didn't actually want to make. C4 routes Continue through the same gap-fill path that autosync uses, eliminates the modal, and makes Continue's behavior match the verb. See §10 for the full rationale.

**Smart marker placement:** The marker is not stamped naively at `currentChatLength`. Instead it depends on whether the collection already has events:

| Collection state when marker is stamped | Marker value | Behavior |
|---|---|---|
| **Has events** (e.g. user did Continue at window=2, then advanced 10 messages, then enables auto-sync at window=4) | `max(source_window_end across events) + 1` | Backfills the gap between last-covered message and current chat tail at the new window size. No duplicate coverage of messages 0..lastCovered. |
| **Empty** (fresh chat, never extracted) | `currentChatLength` | Auto-sync starts "from now on." Doesn't trigger a full-chat backfill of a long chat that was never vectorized before. |

The naive "stamp at currentChatLength always" design has a real gap: messages between the last existing event coverage and the moment auto-sync gets enabled are orphaned — never covered by anything. Smart placement closes that gap for the common case (the user just got bit by this exact scenario).

**As-shipped change set** (committed to `main` 2026-05-20, SHA `ed40dac` and predecessors):

| Concern | Where it landed | Notes |
|---|---|---|
| Settings keys | [`index.js:181-192`](index.js#L181-L192) | `eventbase_autosync_start_marker: {}` (per-chat marker) and `eventbase_last_used_window_size: {}` (per-chat record). Plain map shapes, default `{}`. No migration. |
| Marker helpers | [`core/eventbase-store.js:200-318`](core/eventbase-store.js#L200-L318) | New "AutoSync start-marker" section above the existing window-fingerprint cache. Exports: `getAutoSyncMarker`, `clearAutoSyncMarker`, `stampAutoSyncMarker`, `getLastUsedWindowSize`, `setLastUsedWindowSize`. The async `stampAutoSyncMarker` uses `findEventBaseCollectionIdsForChat` + backend `listChunks({limit: 10000})` to compute `max(source_window_end)`. Overfetch limit covers realistic per-chat EventBase volumes; can be raised if a collection ever crosses ~10k events. |
| Workflow window filter | [`core/eventbase-workflow.js:163-182`](core/eventbase-workflow.js#L163-L182) | Filter applied only when `isAutoSync`. Single log line: `[EventBase] AutoSync marker filter: <before> → <after> windows (marker=N)` — fires both on debug and when the count changed (so the user sees the filter at work without enabling debug logging). |
| Workflow `lastUsedWindowSize` tracking | [`core/eventbase-workflow.js:370-376`](core/eventbase-workflow.js#L370-L376) | Stamped only when `windowsProcessed > 0` — pure quick-exit/no-op runs don't overwrite it. Prevents drift if a stale trigger fires between window-size changes. |
| Stamp on auto-sync enable | [`ui/ui-manager.js:2063-2103`](ui/ui-manager.js#L2063-L2103) | Stamp runs immediately after `setCollectionAutoSync(lockKey, true)`. Mirror `clearAutoSyncMarker(uuid)` on disable so re-enabling later recomputes against fresh collection state. Both wrapped in try/catch — failure logs a warning but does not block the enable. |
| Continue warn modal | [`ui/content-vectorizer.js:2584-2620`](ui/content-vectorizer.js#L2584-L2620) | Fires only for live-chat sources (not archive uploads, since archive UUIDs have no prior history). Shows old vs new window size + estimated LLM-call count. User picks Proceed or Cancel; no third option (intentional — keeps the modal simple). **Note**: this modal becomes obsolete and is deleted as part of §10 (Continue unification with autosync's marker path), which makes the warning unnecessary by making Continue silently do the right thing. |

### 9.6 Test cases the bug fix must pass

Status legend: ✅ = verified on Dev against the user's live chat (see §9.9 for evidence). ⏳ = not yet exercised but should be smoke-tested before prod promote.

| # | Setup | Action | Expected | Status |
|---|---|---|---|---|
| B1 | Empty chat with N messages, no events extracted | Enable auto-sync | Marker = chat length (N). Next AI reply extracts only window(s) at message ≥N. No N/2-window backfill. | ⏳ |
| B2 | Chat with N messages, M events at window=2 (covers messages 0..endIdx), user advances K messages → chat at N+K, auto-sync OFF | Change to window=4, enable auto-sync | Marker = endIdx+1. Auto-sync at window=4 processes windows starting from endIdx+1 — the K new messages get backfilled at window=4. No re-extraction of messages 0..endIdx. | ✅ (real-world: 530 → 1 window filter, see §9.9) |
| B3 | Chat with N messages, auto-sync ON, window=2 | User sends + AI replies × 5 | Each AI reply extracts exactly the new window(s). Marker is not re-stamped during normal operation. | ✅ (real-world: steady-state quick-exit + fast-forward observed) |
| B4 | Chat with N messages, auto-sync ON, mid-flight | Reload page | Marker survives reload (stored in extension_settings, debounced save). Resumes from marker, not from message 0. | ⏳ |
| B5 | Chat with N messages, M events at window=2 | Use one-off Vectorize Content → Continue at window=4 | **Obsolete after §10**: the warn modal is deleted. New expected behavior: no modal; Continue silently gap-fills at window=4 starting from `max(source_window_end) + 1`. See test U2 in §5 for the post-§10 version of this scenario. | ⏳ (post-§10) |
| B6 | Chat with N messages, M events at window=2, marker at endIdx+1 | User toggles auto-sync OFF then ON again | Marker re-stamped at `max(source_window_end) + 1` (which may have advanced if Continue ran in between). No re-extraction of historical messages. | ⏳ |

### 9.7 Open / known limitations

1. **Internal gaps**: If a user deliberately deletes some events for messages 500-600 while keeping 0-499 and 601-999, C3 won't fill that gap on enable (marker stamps at 1000). User would need to use Continue to fill it. Acceptable — fixing this needs Option A.

2. **Cross-chat marker scope**: Marker is keyed by chat UUID, matches how the rest of EventBase state is scoped.

3. **`showAutoSyncConfirmModal`** at [`ui/ui-manager.js:1838`](ui/ui-manager.js#L1838): consider adding a "Backfill historical messages too" opt-in checkbox here (default OFF). When ON, skip the marker stamp so the user gets the full backfill they explicitly requested. Out of scope for the minimum fix; nice-to-have.

4. **Marker visibility**: probably worth a small UI note ("Auto-sync coverage: from message N onward") near the auto-sync checkbox so users understand what's being processed. Out of scope for the minimum fix; nice-to-have.

### 9.8 Migration cost when this plan ships (status: ✅ already promoted to prod)

C3 was promoted to prod on 2026-05-20. Integrating with this plan requires **one binding hook** in `ui/ui-manager.js`: when the new `eventbase_autosync_window_turns` slider value changes, re-stamp the marker so the new window size doesn't appear to need a re-extraction.

The hook is fully written out inline as part of §4.1's binding code — implementers should just follow §4.1 and the migration happens naturally. The hook re-uses helpers (`stampAutoSyncMarker` from [`core/eventbase-store.js:321`](core/eventbase-store.js#L321), `getChatUUID` from [`core/collection-ids.js`](core/collection-ids.js)) that already exist on prod, so the migration is a pure addition with no new mechanism.

That's the entire migration. The plan's UI lock (which silently changes `eventbase_autosync_window_turns` to 1 when "Inject Last N" is enabled) triggers this binding, which re-stamps the marker to `max(source_window_end) + 1`, which prevents the re-extraction storm. No other plan changes needed — `windowSizeOverride` plumbing stays, the rest of §1-§8 is unaffected.

### 9.9 Real-world verification — evidence from the 2026-05-20 session

The bug fix was verified end-to-end against the user's actual live chat (Qdrant backend, ~1350 pre-existing events from a window=2 extraction, switched to window=4, 5 turns of new content). Logs captured at `Doc/log.txt` after each test phase.

**Phase 1 — Marker stamps correctly with smart placement (B2 test case):**

Log line at auto-sync-enable click:
```
eventbase-store.js:289 [EventBase] AutoSyncMarker stamped:
    uuid=67d28099-…, marker=2116 (maxEnd=2115, chatLength=2121, candidates=3)
```
- `maxEnd=2115` — highest `source_window_end` across the 1350 existing events
- `marker = maxEnd + 1 = 2116` — first uncovered message (smart placement, not naive chat-tail)
- Confirms the empty-vs-non-empty branching works as designed

**Phase 2 — Marker filter prevents re-extraction storm (B2 test case):**

First auto-sync trigger after enable:
```
eventbase-workflow.js:177 [EventBase] AutoSync marker filter: 530 → 1 windows (marker=2116)
eventbase-workflow.js:183 [EventBase] Ingestion: 2121 messages → 1 windows (size=4, overlap=0)
…
chat-vectorization.js:381 [AutoSync] runEventBaseIngestion result:
    {eventsExtracted: 1, windowsProcessed: 1, windowsSkipped: 0}
```
- **530 → 1 windows**: marker filter dropped 529 stale-coverage windows
- 1 LLM call instead of 530. Pre-fix, the original test run extracted ~59 windows before the user noticed and aborted — pointing toward an eventual 529-window full re-extraction.
- Time saved per first-fire: ~17 minutes of OpenRouter spend

**Phase 3 — Steady-state dedup remains intact (B3 test case):**

Next MESSAGE_SENT trigger (1 message later, partial window=4 tail):
```
eventbase-workflow.js:130 [EventBase] Quick-exit: last window already extracted, nothing new
{eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0}
```

Subsequent MESSAGE_RECEIVED (window now complete):
```
eventbase-workflow.js:177 [EventBase] AutoSync marker filter: 531 → 2 windows (marker=2116)
eventbase-workflow.js:222 [EventBase] Fast-forward: skipped 1 already-extracted window(s), starting at window 1
{eventsExtracted: 1, windowsProcessed: 1, windowsSkipped: 1}
```
- Marker filter correctly identified 2 windows past the marker (newly-extracted 2116-2119 plus brand-new 2120-2123)
- Fast-forward correctly skipped the already-done 2116-2119 via in-session fingerprint cache
- Only the new window (2120-2123) ran the LLM
- The four-layer defense (marker → quick-exit → fast-forward → per-window check) all played correctly

**Conclusion**: the design and the implementation match. The bug fix is safe to commit and promote.

---

## 10. C4 — Unify Continue with autosync's marker mechanism

This section describes the C4 evolution of the C3 design (see §9.4 / §9.5). C3 shipped with Continue still using its own fingerprint-cache path and a warn modal for window-size changes; C4 routes Continue through the same marker path autosync uses and deletes the modal.

### 10.1 The asymmetry that motivates this

After C3 shipped, autosync and Continue have **different** gap-fill semantics:

| | Autosync | Continue (today) |
|---|---|---|
| Trigger | Chat events (MESSAGE_SENT, etc.) | User clicks button |
| Marker filter | Used | **Skipped** (gated on `isAutoSync` at [`core/eventbase-workflow.js:170`](core/eventbase-workflow.js#L170)) |
| Behavior when window size changed | Silent gap-fill at new size, ~5 LLM calls | Full re-extract storm, ~1063 LLM calls, modal warns |

The asymmetry was originally framed as "autosync is passive, Continue is explicit." But the word "Continue" implies *"keep going from where I left off"* — exactly the gap-fill semantics autosync already has. Forcing the user through a modal-driven full re-extract when they meant "catch up to current" doesn't match the verb.

### 10.2 Design — Continue calls into the same proven path

Route Continue through the marker-based gap-fill mechanism that's already in production. The C3 verification (§9.9) covers both code paths after this change because they share the same workflow logic.

**The rule**:

- Empty collection → full extract (Continue with nothing to continue from means "extract from scratch"). Unchanged from today.
- Non-empty collection → marker-based gap-fill at current window size. Replaces today's fingerprint-cache-only path.

Same code path covers both window-size-matches and window-size-changes — because the marker is window-size-agnostic (it's just a message index).

### 10.3 Implementation

| # | File | Change |
|---|---|---|
| 1 | [`core/eventbase-workflow.js:59`](core/eventbase-workflow.js#L59) | Add `respectCoverageMarker = false` to `runEventBaseIngestion` signature. |
| 2 | [`core/eventbase-workflow.js:170`](core/eventbase-workflow.js#L170) | Change gate from `if (isAutoSync)` to `if (isAutoSync || respectCoverageMarker)`. One-line change. |
| 3 | [`ui/content-vectorizer.js`](ui/content-vectorizer.js) `_runEventBaseBackfill` | Before calling `runEventBaseIngestion`: check `getSavedHashes` for the chat's EventBase collection. If non-empty, call `stampAutoSyncMarker(uuid, settings)` and pass `respectCoverageMarker: true`. If empty, no change (today's full-extract path). |
| 4 | [`ui/content-vectorizer.js:2584-2620`](ui/content-vectorizer.js#L2584-L2620) | **Delete** the window-size-change warn modal entirely. No longer needed — Continue silently does the right thing. Also delete the `getLastUsedWindowSize` import that became unused. |

### 10.4 Code sketch

```js
// In _runEventBaseBackfill, after chatUUID resolved, before runEventBaseIngestion call:

let respectMarker = false;
if (source?.type !== 'file' && chatUUID) {
    const { findEventBaseCollectionIdsForChat, stampAutoSyncMarker } = await import('../core/eventbase-store.js');
    const { getRegistryBackend } = await import('../core/collection-ids.js');
    const backend = getRegistryBackend(settings?.vector_backend);
    const candidates = findEventBaseCollectionIdsForChat(chatUUID, backend);
    if (candidates.length > 0) {
        try {
            const { getSavedHashes } = await import('../core/core-vector-api.js');
            const hashes = await getSavedHashes(candidates[0].collectionId, settings);
            if (Array.isArray(hashes) && hashes.length > 0) {
                // Non-empty collection — use marker-based gap-fill (same as autosync)
                await stampAutoSyncMarker(chatUUID, settings);
                respectMarker = true;
            }
        } catch (err) {
            console.warn('[VectFox Continue] Failed to detect collection state — falling back to full extract:', err?.message || err);
        }
    }
}

// Then in the runEventBaseIngestion call, add:
//   respectCoverageMarker: respectMarker,
```

Net code change: ~15 lines added in `_runEventBaseBackfill`, ~1 line changed in workflow, ~30 lines deleted (the modal). **Net: smaller file.**

### 10.5 Observable behavior

| Click sequence | Today | Post-unification |
|---|---|---|
| Vectorize fresh empty chat | Full extract (correct) | Full extract (unchanged) |
| Reply 5 turns, click Continue at same window size | Fingerprint cache catches done windows, new ones extracted (correct) | Marker filter skips done windows, new ones extracted (same outcome, different mechanism) |
| Change window size, click Continue | Modal fires → if proceed, ~1063 LLM calls + duplicate-coverage events | Silent gap-fill at new size, ~5 LLM calls, mixed-granularity collection (matches user spec from earlier session) |
| Enable autosync after a Continue session | Marker may or may not exist depending on Continue's re-stamp behavior (currently doesn't re-stamp) | Marker already advanced to current high-water mark (Continue re-stamped on its way through). Next autosync fire correctly resumes from there. |

### 10.6 Why this is safe to ship

- The marker code path is **already in production** as of 2026-05-20 (`main` SHA `81e580c`) and was verified end-to-end (§9.9). Continue now reuses that exact code, so it inherits the same proven behavior. No new mechanism to test from scratch.
- The empty-collection fallback preserves today's "vectorize fresh chat" behavior bit-for-bit.
- The deleted modal removes a high-stakes UX choice the user didn't actually want to make.
- No existing autosync behavior changes — autosync still passes `isAutoSync: true`, gets the same marker filter as before.

### 10.7 Test cases for this unification

Add to §5 (these are net-new):

| # | Setup | Action | Expected |
|---|---|---|---|
| U1 | Fresh chat, no events | Open Vectorize Content, click Continue at window=2 | Full extract (no marker stamped, no filter applied). Behavior identical to today's fresh-chat extract. |
| U2 | Chat with 680 events at window=4 (`source_window_end` max = 2115), chat at 2126, autosync OFF | Set Vectorize Content window=2, click Continue | **No modal**. Console: `AutoSyncMarker stamped: marker=2116`, then `AutoSync marker filter: 1063 → 5 windows (marker=2116)` (marker filter log fires even though `isAutoSync=false`, because `respectCoverageMarker=true`). 5 LLM calls. Collection now has 680 window=4 + 5 window=2 events. |
| U3 | Same as U2, but Vectorize Content window=4 (unchanged) | Click Continue | Same outcome: marker stamps, 2 windows past marker complete (msgs 2116-2119, 2120-2123), 2 extracted. Equivalent to today's fingerprint-cache-only path. |
| U4 | Chat with events, marker previously stamped at 1000 (from prior autosync) | Click Continue at chat=2000 | Marker re-stamped at fresh max+1 (probably > 1000). Continue gap-fills from new boundary. Next autosync fire sees the advanced marker — no double work. |
| U5 | Existing behavior: `startFromMessage` field set | Click Continue | Slicing happens before workflow; marker filter still applies on the sliced array's start indices (which are 0-based on the slice, not chat-absolute — known limitation, same as today). Document in §9.7 if not already. |

### 10.8 What this lets us delete from the rest of the plan

- §9.6 test case **B5** referenced the modal — that test goes away. Continue now silently gap-fills regardless of window-size change.
- The "Continue warn modal" line in the §0.5 Foundations table can be marked as "shipped, then removed" once §10 lands.
- §8 Risk row "Override param plumbing breaks one-off vectorize" gets weaker still — Continue now shares the marker code path that autosync has been running in production for a day.

### 10.9 Migration / backward-compat notes

- No setting key changes. `eventbase_last_used_window_size` keeps getting written (still useful for future tooling), but no longer drives any modal.
- Users currently relying on the old "Continue re-extracts everything" behavior get the new "Continue gap-fills" behavior with no warning. Since the old behavior was almost certainly accidental (people clicked Continue expecting to catch up, not to re-process), this is a UX improvement, not a regression.
- If a future user *does* want to re-process the entire chat at a new window size, the path is: purge the collection (Database Browser → Delete), then click Continue on the empty collection at the desired window size. Two clicks, no surprises.
