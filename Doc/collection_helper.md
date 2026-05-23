# Collections, Locks & Backend Routing — Canonical APIs

Single document covering everything related to collections: lock state, listing, registry-key construction, **backend routing for queries**, and the UI checkboxes that mirror lock state. Every piece reads from the same in-memory source of truth and writes back through a small, scope-aware set of helpers.

**Why this document is long:** collection routing has historically been the #1 source of silent-wrong-answer bugs in VectFox. Locks land in the wrong storage bucket. Queries hit the wrong backend. Persona ownership stamps don't match. Every bug had the same root cause: someone reimplemented a helper inline instead of importing it. This doc is the *one* place that lists the canonical entry points so future authors (human or AI) stop reinventing them.

Updated 2026-05-23 — added `resolveBackendForCollection`, refreshed line refs, removed stale content. Split out of `dev_helper.md §14` because it had grown too long to live inline.

## ⚠️ Canonical APIs — USE THESE, DO NOT REIMPLEMENT

**Read this before writing any code that touches a collection.** These functions are the *only* entry points new code should call for collection listing, lock state, registry-key construction, and **per-collection backend routing**. They bundle backend disambiguation, persona/handle ownership, superadmin checks, and storage-key normalization. Re-implementing the logic inline gets it wrong almost every time — the failure mode is silent: locks land in the wrong storage bucket, queries hit the wrong backend, the UI shows nothing changed.

| Function | File:Line | Use when |
|---|---|---|
| **`getCollectionListing(settings)`** | [collection-loader.js:180](../core/collection-loader.js#L180) | You need to iterate every collection (rendering a list, finding matches by pattern, computing aggregate state). |
| **`getLock(collectionId, options)`** | [collection-metadata.js:793](../core/collection-metadata.js#L793) | You need lock state for *one* collection (badge, tooltip, checkbox state, "is this active right now?"). |
| **`setLock(collectionId, action, options)`** | [collection-metadata.js:839](../core/collection-metadata.js#L839) | You need to *mutate* lock state for *one* collection (user clicks lock / unlock / clear). |
| **`buildRegistryKey(collectionId, settings)`** | [collection-ids.js:169](../core/collection-ids.js#L169) | You only have a bare collection ID and need to convert it to the canonical `"backend:id"` storage key (for any metadata read/write). Never hand-roll `` `${backend}:${collectionId}` `` — use this instead. |
| **`resolveBackendForCollection(input)`** | [collection-ids.js:207](../core/collection-ids.js#L207) | You have an ID (either registry-key or bare) and need to pick the right backend instance for it (query, delete, list, etc.). Returns `{ backend, collectionId }` where `collectionId` is the bare form. Replaces hand-rolled `parseRegistryKey(...).backend ?? settings.vector_backend` chains. |

### `resolveBackendForCollection(input)` — pick the right backend for a collection

```js
import { resolveBackendForCollection } from './collection-ids.js';

const { backend, collectionId } = resolveBackendForCollection('qdrant:vf_lorebook_qdrant_rabbit_artificrealm_1779...');
// → { backend: 'qdrant', collectionId: 'vf_lorebook_qdrant_rabbit_artificrealm_1779...' }

const { backend: b2, collectionId: c2 } = resolveBackendForCollection('vf_eventbase_vectra_rabbit_your_wives_uuid');
// → { backend: 'vectra', collectionId: 'vf_eventbase_vectra_rabbit_your_wives_uuid' }
// (no `backend:` prefix on the input → detected from the ID's second segment)
```

Resolution order:
1. **Registry-key prefix wins** (`qdrant:` / `vectra:` / `standard:`). Canonical post-2026-05-23 form. Most call sites have this.
2. **Detect from ID structure** (`vf_<kind>_<backend>_…`). Catches legacy bare entries from before the registry-key convention and any place that still passes bare IDs.
3. **`{ backend: null, collectionId: bareForm }`** when both fail. Caller chooses whether to fall through to `settings.vector_backend`, throw, or warn.

**Always use this for routing.** The returned `collectionId` is the BARE form — backend methods (`StandardBackend.queryCollection`, `QdrantBackend.deleteVectorItems`, plugin REST endpoints) expect bare IDs and route on the `backend` field returned here.

**Why this matters:** before this helper landed, `queryCollection` in `core-vector-api.js` used `parseRegistryKey(id).backend ?? settings.vector_backend`. For mixed-backend users (rabbit had a standard EventBase locked + a qdrant EventBase locked at the same time, common after persona switches or cross-backend imports) this silently queried *all* collections through the user's default backend. Standard collections got queried through Qdrant → wrong physical location → 0 results. Qdrant collections got queried through Standard → wrong API path → 0 results. The retrieval pipeline returned other collections' content because *those* happened to be on the default backend. This is the bug that TEST 013 finally caught.

### `getCollectionListing(settings)` — listing iterator

```js
const entries = getCollectionListing(settings);
// entries: Array<{ registryKey, collectionId, backend, meta, isOwn, isActive }>
```

Built-in checks:
- Reads the registry, parses each `backend:id` key.
- `isOwn`: superadmin override OR `meta.creatorHandle` matches current persona handle OR (legacy) bare-ID substring contains current handle.
- `isActive`: calls `isCollectionActiveForContext(registryKey, …)` internally — already keyed correctly.
- Call this **once** per render and reuse the array. Do not call `isCollectionActiveForContext` in a per-card loop.

### `getLock(collectionId, options)` — single-collection read

```js
const lock = getLock(collection.registryKey || collection.id, {
    chatId: getCurrentChatId(),
    characterId: getContext()?.characterId,
    settings,
});
// lock: null  (caller unauthorized — not superadmin, not owner)
//     | { storageKey, scope, chatLocks, characterLocks, isLocked, isActiveHere, canModify }
```

Built-in checks:
- Authorization: `null` return when current persona is not superadmin AND doesn't own the collection. Use `options.ignoreAuth: true` for headless/system code (import flow, registry registration).
- Scope-aware `isActiveHere`: checks the right list (chat vs character) based on `meta.scope`.
- `canModify` flag: lets the UI grey out the lock button rather than letting the click silently fail.

**Storage-key convention:** callers must pass the registry-key form (`backend:id`). On a `collection` object from `findCollectionByKey` or `getCollectionListing`, use `collection.registryKey || collection.id`. **No silent fallback to bare ID** — passing the wrong form gives wrong-state reads, not errors.

### `setLock(collectionId, action, options)` — single-collection mutation

```js
const result = setLock(collection.registryKey || collection.id, {
    kind: 'chat',           // 'chat' | 'character'
    op: 'add',              // 'add' | 'remove' | 'clear'
    target: getCurrentChatId(),  // chatId or characterId; ignored when op='clear'
}, { settings });
// result: { success: true } | { success: false, reason: 'unauthorized' | 'invalid kind' | ... }
```

Built-in checks:
- Same authorization gate as `getLock`. Denied mutations log a warning and return `{success:false, reason:'unauthorized'}` — caller must check the result.
- Routes to the right primitive (`setCollectionLock` / `removeCollectionLock` / `clearCollectionLock` / character variants) based on `action.kind`.
- Updates the reverse index (`chat_lock_index`) atomically with the forward write.

### What NOT to do

These patterns will look correct but produce broken state:

| Wrong | Right |
|---|---|
| `isCollectionActiveForContext(collection.id, …)` | `isCollectionActiveForContext(collection.registryKey \|\| collection.id, …)` — or use `getLock` |
| `setCollectionLock(collection.id, chatId)` | `setLock(collection.registryKey \|\| collection.id, { kind: 'chat', op: 'add', target: chatId }, { settings })` |
| Iterating the registry + checking `creatorHandle.toLowerCase() === handle` inline | `getCollectionListing(settings).filter(e => e.isOwn)` |
| Iterating collections + calling `isCollectionActiveForContext` per card | `getCollectionListing` once → use `entry.isActive` |
| Reading `extension_settings.vectfox.collections[bare_id]` directly | `getCollectionMeta(registryKey)` (storage now keyed by `backend:id`) |
| Auto-resolving bare ID → registry-key by scanning the registry | Caller passes the canonical form; the auto-resolve scan was removed deliberately because it masked wrong-form callers |
| `isCollectionAutoSyncEnabled(collectionId)` — bare ID — silently returns `false` even when the UI shows checked (UI writes via registryKey, this reads from a *different bucket*) — root cause of the 2026-05-17 auto-sync regression | `isCollectionAutoSyncEnabled(registryKey)` — same form the UI + every write path uses |
| `` `${getRegistryBackend(settings.vector_backend)}:${collectionId}` `` hand-rolled at every call site (drift bait — one site forgets and the bug above surfaces) | `buildRegistryKey(collectionId, settings)` |
| `shouldCollectionActivate(collectionId, context)` with bare `collectionId` — its internal `getCollectionMeta` and `isCollectionLockedToChat` calls both read from `extension_settings.vectfox.collections[id]`, which is keyed by `backend:id` form. Passing bare ID returns empty defaults; lock checks always return `false`, so every collection looks unlocked and nothing activates correctly. Root cause of the 2026-05-20 semantic WI lorebook scope bug. | `shouldCollectionActivate(entry.registryKey, context)` where `entry` comes from `getCollectionListing(settings)` |
| `queryCollection(collection.collectionId, ...)` — passing the bare ID. `queryCollection`'s `parseRegistryKey` returns `backend=null`, then it falls back to `settings.vector_backend` (the user's *default* backend). On mixed-backend setups this silently queries the wrong backend → 0 results, or worse, returns content from a *different* collection that happens to be on the default backend. Root cause of the 2026-05-23 EventBase cross-backend retrieval bug (TEST 013). | `queryCollection(collection.registryKey, ...)` — the registry-key form lets `resolveBackendForCollection` pick the right backend per-collection. |
| `liveCollectionIds: lockedLiveCollections.map(c => c.collectionId)` — destructuring `.collectionId` off a `_gatherLockedEventBaseCollections` result. The object has BOTH `.collectionId` (bare) and `.registryKey` (canonical) — picking the wrong one cascades the bare-ID bug down to every consumer (retrieveEvents, retrieveEventsWithAgent). | `liveCollectionIds: lockedLiveCollections.map(c => c.registryKey)` — same pattern, right field. |
| `parseRegistryKey(id).backend ?? 'qdrant'` (or `?? settings.vector_backend`) hand-rolled — silently misroutes bare IDs that *do* have a detectable backend in the ID structure. | `resolveBackendForCollection(id)` — tries registry-key prefix first, then ID-structure detection, then returns `null` so the caller knows resolution failed. |

### Older primitives — when you might still need them

`setCollectionLock`, `removeCollectionLock`, `clearCollectionLock`, `setCollectionCharacterLock`, etc. ([collection-metadata.js:488+](../core/collection-metadata.js#L488)) are the raw write primitives without authorization. The facade routes to these. **Only call them directly from inside `setLock` or from system code that already enforces auth at a higher layer** (`registerCollection`'s creatorHandle stamping is the canonical example). Application code, UI handlers, and anything user-triggered should go through `setLock`.

## Pause/Resume button — `enabled` flag

Separate concern from locks. It's a hard kill switch — when `false`, the collection is blocked from any activation regardless of locks, triggers, or scope.

- **UI:** Play/pause icon on each collection card in the Database Browser
- **Write:** `setCollectionEnabled(collection.registryKey || collection.id, false)` → stores `{ enabled: false }` under `extension_settings.vectfox.collections[registryKey]`
- **Read:** `isCollectionEnabled(registryKey)` in `core/collection-metadata.js` — pass the registry-key form, not bare ID
- **Default:** `true` (enabled) when no metadata exists
- **All collections use the same key form** — `backend:id`. EventBase collections are registered as `${registryBackend}:${collectionId}` in `eventbase-store.js`, not as plain IDs. The `data-collection-key` attribute on every card is always `collection.registryKey || collection.id`.

## Async runtime activation — `shouldCollectionActivate`

Used by any code path that must decide at runtime whether a collection is currently in scope, respecting triggers, advanced conditions, and manual locks. The semantic WI lorebook search path (`world-info-integration.js`) is the canonical example.

**Must receive the registry-key form.** Internally calls `getCollectionMeta(id)` and `isCollectionLockedToChat(id, chatId)`, both of which read from `extension_settings.vectfox.collections[id]` — keyed by `backend:id`. Passing a bare collection ID silently gets empty defaults and lock checks always return `false`.

**Canonical pattern:**

```js
import { getCollectionListing } from './collection-loader.js';
import { shouldCollectionActivate } from './collection-metadata.js';

const listing = getCollectionListing(settings);
const currentChatId = getCurrentChatId() ? String(getCurrentChatId()) : null;
const currentCharacterId = getContext().characterId != null ? String(getContext().characterId) : null;
const context = { currentChatId, currentCharacterId };

for (const entry of listing) {
    if (!entry.collectionId.startsWith('vf_lorebook_')) continue;
    if (entry.meta.enabled === false) continue;                           // paused
    if (!(await shouldCollectionActivate(entry.registryKey, context))) continue;  // out of scope
    // entry.registryKey is correct for all subsequent getCollectionMeta calls
}
```

Priority chain inside `shouldCollectionActivate`:
```
1. enabled=false          → BLOCKED (pause button)
2. Activation Triggers    → ACTIVE if any keyword matches recent messages
3. Advanced Conditions    → ACTIVE if condition passes
4. Chat lock match        → ACTIVE if currentChatId is in lockedToChatIds
5. Character lock match   → ACTIVE if currentCharacterId is in lockedToCharacterIds
6. Nothing matched        → BLOCKED
```

**Important:** trigger/condition gates are intentional for semantic WI — a lorebook with keyword triggers should activate even without a manual chat lock. A lorebook with no triggers and no lock is out of scope and will not be searched.

## ⚠️ Embedding model resolution — `getModelFromSettings`

Sibling principle to the lock facade — same "use the one helper, never reimplement inline" rule, different domain. Lives in this doc because the model is part of the **storage-key contract** for every collection: vectra partitions chunks by model on disk, so insert and query must agree on the model value or the read silently misses.

The settings object stores the embedding model under **provider-specific** field names: `openrouter_model`, `ollama_model`, `vllm_model`, `cohere_model`, etc. There is **no flat `settings.model`** — that key is always empty/undefined. Code that reads `settings.model` directly silently produces the wrong value (empty string) without throwing.

**Always use** [`getModelFromSettings(settings, fallback?)`](../core/providers.js#L99) from `core/providers.js`:

```js
import { getModelFromSettings } from './providers.js';

const model = getModelFromSettings(settings);              // → 'qwen/qwen3-embedding-8b' for openrouter
const modelOrNull = getModelFromSettings(settings, null);  // null when provider has no model field
```

It internally calls `getModelField(settings.source)` to look up the right field name, then reads that field.

### Why this matters

Every site that sends a `model` to the plugin API (`chunks/insert`, `chunks/list`, `chunks/query`, `get-embedding`) is part of the **storage-key contract**. Inserts under `model='qwen/qwen3-embedding-8b'` must be queried under the same `model` value or the plugin's per-model partitioning silently returns 0 results. This bug surfaced as "vectra returns 0 results while qdrant works" — qdrant doesn't partition by model field, so it masked the bug; vectra exposed it.

### What NOT to do

| Wrong | Right |
|---|---|
| `model: settings.model` (flat key — always empty) | `model: getModelFromSettings(settings)` |
| `settings.model \|\| ''` | `getModelFromSettings(settings)` |
| `settings[getModelField(settings.source)] \|\| null` (one-liner with manual fallback) | `getModelFromSettings(settings, null)` |
| `const modelField = getModelField(s.source); s[modelField] \|\| ''` (4-line inline expansion) | `getModelFromSettings(settings)` |
| Defining a local `getModelFromSettings` private helper (this happened 3 times before consolidation) | Import the canonical one |

### When to use `getModelField` directly instead

`getModelField(source)` returns the **field name** (a string like `'openrouter_model'`) or `null`. Use it only when you need the *name* itself for a validation check or display:

```js
// Validation: does the user need to configure a model for the current provider?
const modelField = getModelField(settings.source);
if (config.requiresModel && modelField && !settings[modelField]) {
    return { error: 'Model not configured' };
}
```

If you just need the value, `getModelFromSettings(settings)` is shorter and harder to misuse.

## Lock-state read tiers — which layer to call

Three tiers exist. Call the highest tier that covers your use case:

| Tier | Function | Use when |
|---|---|---|
| **API (preferred)** | `getLock(registryKey, opts)` | One collection — UI badge, checkbox, tooltip. Returns `isActiveHere`, `canModify`, `chatLocks`, etc. Bundles auth check. |
| **API (preferred)** | `getCollectionListing(settings)` | All collections — render loop, aggregate state. Use `entry.isActive` — no per-card calls needed. |
| **Underlying** | `isCollectionActiveForContext(registryKey, { chatId, characterId })` | Called internally by both API functions. Do not call per-card in a loop — use `getCollectionListing` instead. Still correct when you have exactly one collection and no auth check is needed (e.g. runtime activation in `world-info-integration.js`). |
| **Raw** | `setCollectionLock` / `removeCollectionLock` etc. | Internal only — called by `setLock` facade. Do not call from application code. |

`isCollectionActiveForContext` returns `true` based on the collection's scope:
- `scope='chat'` → `chatId` is in `lockedToChatIds`
- `scope='character'` → `characterId` is in `lockedToCharacterIds`
- anything else → `false` (no global scope; legacy `global` was migrated to `character` — see below)

## Scope migration — global is gone

`scope='global'` is no longer a valid choice. The Vectorize Content modal exposes only `Character` (default) and `This Chat`. Existing global collections are auto-migrated **once**, on first read by `loadAllCollections`:

```
storedMeta.scope === 'global'  →  setCollectionMeta(writeKey, { scope: 'character' })
```

After migration completes, no code anywhere checks for `'global'`. The only remaining reference is the migration block itself in `core/collection-loader.js`. Do not reintroduce `scope === 'global'` branches elsewhere.

A migrated collection has no character lock by default — it stops auto-activating until the user re-checks "Active for current chat" in Collection Settings (which then calls `setCollectionCharacterLock(currentCharacterId)`).

## DB Browser — lock badge in the listing

In `ui/database-browser.js`, the main render loop calls `getCollectionListing(settings)` once and iterates its entries. Each entry carries `entry.isActive` (pre-computed by `getCollectionListing` via `isCollectionActiveForContext(registryKey, ...)` internally). The badge renderer receives the entry and reads `entry.isActive` — there is no per-card `isCollectionActiveForContext` call in the loop. The badge displays a scope-appropriate tooltip:
- `scope='chat'` → "Active for current chat" (with chat-count suffix if locked to multiple chats)
- `scope='character'` → "Active for current chat (locked to current character)"

A fallback `isCollectionActiveForContext` call survives in the badge helper for callers that pass a raw collection ID instead of an entry — this is internal plumbing, not the intended pattern.

## DB Browser → Collection Settings → "Active for current chat" checkbox

In `ui/database-browser.js`:

| Function | Role |
|---|---|
| `openActivationEditor` | Computes `state.alwaysActive` via `isCollectionActiveForContext` |
| `renderActivationEditor` | Sets `prop('checked', state.alwaysActive)` |
| `refreshActivationLockButton` | Re-syncs checkbox after Manage Locks dialog — same helper |
| `saveActivation` | Mutates locks on Save based on scope |

**`saveActivation` lock mutation:**

```
scope='chat'      + checked   →  setCollectionLock(state.collectionId, currentChatId)
scope='chat'      + unchecked →  removeCollectionLock(state.collectionId, currentChatId)
scope='character' + checked   →  setCollectionCharacterLock(state.collectionId, currentCharacterId)
scope='character' + unchecked →  removeCollectionCharacterLock(state.collectionId, currentCharacterId)
```

`state.collectionId` is the registry-key form (`backend:id`) — set when `openActivationEditor` is called with `collection.registryKey || collection.id`. Key form is correct. **Note:** these calls use the raw primitives directly rather than the `setLock` facade. They bypass the auth check that `setLock` performs, which is acceptable here because `saveActivation` is only reachable by the collection owner. Migration to `setLock` is a known pending cleanup.

Each call only touches the lock for the **current** chat/character. Other chats or characters that have this collection locked keep their entries intact — `removeCollectionLock` filters by id, doesn't wipe the list.

## WI Panel — "Enable Semantic WI Activation" checkbox

In `ui/ui-manager.js`.

**`refreshWIStatus`** (auto-sync from events) fires on:
- WorldInfo tab click
- After lorebook vectorization completes
- `vectfox:collections-updated` custom event
- `CHAT_CHANGED` event
- Initial load

It computes `activeIds` by filtering own-persona lorebooks (creatorHandle stamp) through `isCollectionActiveForContext`, then drives the checkbox + status via an inline `_setWIEnabled(bool)` helper:

| Result | Checkbox | LED | Status |
|---|---|---|---|
| 0 lorebooks (this persona) | ❎ | 🟡 | "No lorebooks vectorized — vectorize one first" |
| 0 active | ❎ | 🟡 | "Lorebook vectorized but not active for this chat — lock it…" |
| ≥1 active | ✅ | 🟢 | "Active for this chat: <names>" |

**Critical:** `_setWIEnabled` calls `prop('checked', enabled)` directly. It does **not** call `.trigger('change')`. This is load-bearing — see "Manual vs auto-sync paths" below.

**Manual change handler** (user clicks the checkbox):

| Action | Behaviour |
|---|---|
| ✓ Check + no own lorebooks | Uncheck, redirect to Content Vectorizer (`'lorebook'`) |
| ✓ Check + no active | Uncheck, redirect to DB Browser |
| ✓ Check + ≥1 active | Persist `enabled_world_info=true`, show settings panel |
| ✗ Uncheck | For each currently-active own lorebook, remove the lock making it active (chat or character per scope). Dispatch `vectfox:collections-updated`. Persist `enabled_world_info=false`. |

## Chat Auto-Sync — "Enable Auto-Sync" checkbox

**Key-form parity is load-bearing.** Four sites read or write the per-collection autoSync flag: `refreshAutoSyncCheckbox` (UI mirror), `getChatAutoSyncStatus` (state evaluator), the change handler (writer), and `synchronizeChat` (the engine that actually fires extraction). All four must use the **registry-key form** (`backend:id`) — built via `buildRegistryKey(collectionId, settings)` or pulled from `entry.registryKey`. The 2026-05-17 regression where the popup never fired and extraction never ran was a single site (`synchronizeChat`) reading with the bare collection ID while everyone else wrote with the registry key. The flag was saved correctly; the reader looked in the wrong bucket and saw `undefined`.

State evaluator: **`getChatAutoSyncStatus(settings)`** in `core/eventbase-workflow.js`. Pure in-memory — no backend probe. Returns one of:

```
{ state: 'no-chat' }
{ state: 'no-collection' }
{ state: 'partial',          collectionId, registryKey }
{ state: 'fully-vectorized', collectionId, registryKey }
```

Match logic: walks the registry, picks the first eventbase entry whose ID matches the current chat's UUID via `buildChatSearchPatterns` + `matchesPatterns` (substring on UUID). This handles legacy ID formats and character renames — the UUID is the stable identifier.

"Fully vectorized" is determined by `isChatFullyVectorized(messages, settings, chatUUID)`, which checks whether the last possible window for the current message count is already in `eventbase_extracted_windows[uuid]`. No DB query, just an O(1) Set lookup.

**`refreshAutoSyncCheckbox(settings)`** fires on:
- AutoSync tab click
- `CHAT_CHANGED` event
- Initial load
- `vectfox:collections-updated` custom event
- `vectfox:eventbase-synced` custom event (after an ingestion run completes)

Resolution table:

| State | autoSync flag | Lock | Checkbox | LED | Status |
|---|---|---|---|---|---|
| `no-chat` | — | — | ❎ | 🟡 | "No chat loaded" |
| `no-collection` | — | — | ❎ | 🟡 | "Not initialized — vectorize chat first" |
| has-collection | false OR no lock | — | ❎ | ⚪ | "Auto-sync inactive" |
| `partial` | true | locked | ✅ | 🟡 | "Locked — will sync to latest history on next auto-sync trigger" |
| `fully-vectorized` | true | locked | ✅ | 🟢 | "Ready — fully synced" |

**Change handler** (user clicks):

| Action | Behaviour |
|---|---|
| ✓ Check + no-chat | Toast warn, uncheck |
| ✓ Check + no-collection | Open Content Vectorizer (`'chat'`) |
| ✓ Check + partial | `setCollectionLock(registryKey, chatId)` + `setCollectionAutoSync(registryKey, true)` + toast "will catch up" |
| ✓ Check + fully-vectorized | `setCollectionLock(registryKey, chatId)` + `setCollectionAutoSync(registryKey, true)` + toast "fully synced" |
| ✗ Uncheck | `setCollectionAutoSync(registryKey, false)` + `removeCollectionLock(registryKey, chatId)` |

`registryKey` here is `status.registryKey` from `getChatAutoSyncStatus` — the canonical `"backend:id"` form. All four metadata read paths (this table, `refreshAutoSyncCheckbox`, `synchronizeChat`, `getChatAutoSyncStatus`) use the same form. After mutation, dispatches `vectfox:collections-updated` and re-runs `refreshAutoSyncCheckbox` so the LED updates.

## Manual vs auto-sync paths

UI elements that mirror lock state are pulled in two ways. The distinction matters because the manual paths have side effects.

| Trigger | Calls `.trigger('change')` | Lock mutation? |
|---|---|---|
| User clicks WI checkbox | (browser-native) | **Yes** — change handler removes/checks locks |
| User clicks Auto-Sync checkbox | (browser-native) | **Yes** — change handler removes/sets chat lock |
| User clicks "Active for current chat" in Collection Settings | (via Save button) | **Yes** — `saveActivation` mutates |
| `refreshWIStatus` auto-uncheck | **No** — `_setWIEnabled` uses `prop()` only | **No** — pure UI mirror |
| `refreshAutoSyncCheckbox` auto-state | **No** — direct `prop()` | **No** — pure UI mirror |
| `refreshActivationLockButton` after Manage Locks | **No** — direct `prop()` | **No** — re-reads state set by the dialog |

**Rule:** auto-sync paths must never invoke the change handler. Otherwise, opening the WI panel could trigger lock removal as a side effect of the UI sync.

## Custom events

| Event | Fired by | Listeners |
|---|---|---|
| `vectfox:collections-updated` | `saveActivation`, WI uncheck handler, Auto-Sync change handler | `refreshWIStatus`, `refreshAutoSyncCheckbox` |
| `vectfox:eventbase-synced` | `runEventBaseIngestion` at end of run | `refreshAutoSyncCheckbox` |

Plus ST's `CHAT_CHANGED` — same two refresh handlers re-run.

## Runtime activation chain (`shouldCollectionActivate`)

The runtime priority list in `core/collection-metadata.js`:

```
1. Pause button (enabled=false)          → BLOCKED
2. Activation Triggers match             → ACTIVE
3. Advanced Conditions pass              → ACTIVE
4. Chat lock match (currentChatId)       → ACTIVE
4. Character lock match (currentCharId)  → ACTIVE
5. Nothing matched                       → BLOCKED
```

There is **no global-scope priority**. That branch (formerly "priority 1.5") was removed when global was unwired. If you find yourself adding a `meta.scope === 'global'` check anywhere, stop — the migration handles legacy data, and there is no path that should produce a new `'global'` value.

## Key files

| File | Role |
|---|---|
| `core/collection-ids.js` | `buildRegistryKey`, `parseRegistryKey`, `resolveBackendForCollection`, `getBackendFromCollectionId`, `remapCollectionIdToBackend`, `normalizeBackendForId`, `KNOWN_BACKEND_LABELS` |
| `core/collection-metadata.js` | `isCollectionActiveForContext`, `setCollectionLock`, `removeCollectionLock`, `setCollectionCharacterLock`, `removeCollectionCharacterLock`, `setCollectionAutoSync`, `shouldCollectionActivate`, `getLock`, `setLock` |
| `core/collection-loader.js` | Migration (`scope='global'` → `'character'`), `loadAllCollections`, `getCollectionListing` |
| `core/core-vector-api.js` | `queryCollection` — the canonical per-collection-backend routing entry point |
| `core/eventbase-workflow.js` | `getChatAutoSyncStatus`, `isChatFullyVectorized`, dispatches `vectfox:eventbase-synced` |
| `core/content-vectorization.js` | Default `scope='character'`, no `'global'` fallback |
| `ui/database-browser.js` | Listing lock badge, `openActivationEditor`, `renderActivationEditor`, `refreshActivationLockButton`, `saveActivation` |
| `ui/ui-manager.js` | `refreshWIStatus` + `_setWIEnabled`, `refreshAutoSyncCheckbox`, WI checkbox handler, Auto-Sync checkbox handler, event listeners |
| `ui/content-vectorizer.js` | Scope picker without global, post-vectorization `refreshWIStatus` call |

## Things you should NOT do

- Don't call `.trigger('change')` from any refresh/auto-sync path. Use `prop('checked', x)` directly and persist settings inline.
- Don't probe the backend for checkbox state. Every state evaluator (`isCollectionActiveForContext`, `getChatAutoSyncStatus`) uses in-memory data only.
- Don't add `scope === 'global'` checks. The only legitimate reference is the one-time migration block in `loadAllCollections`.
- Don't duplicate `isCollectionActiveForContext` logic inline. If you need it in a new place, import it.
- Don't write directly to `lockedToChatIds` / `lockedToCharacterIds`. Use the `setCollectionLock` / `removeCollectionLock` / `setCollectionCharacterLock` / `removeCollectionCharacterLock` helpers — they maintain the `chat_lock_index` reverse map too.
- Don't pass bare collection IDs to `queryCollection` (in `core/core-vector-api.js`). The function routes by backend prefix internally via `resolveBackendForCollection`. Bare IDs work *only* when the backend can be detected from the ID structure — registry-key form is the canonical input.
- Don't hand-roll backend detection (`id.includes('_qdrant_') ? 'qdrant' : 'standard'`). Use `resolveBackendForCollection(id)` — it returns the bare collectionId you'll need for the backend call anyway.
