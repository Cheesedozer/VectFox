# Archive Chat History — EventBase Ingestion Plan

## Session changes that affect this plan

Three things changed during the session that this plan must account for:

| # | Change | Impact on plan |
|---|---|---|
| 1 | **Activation filter — no more auto-activate** | Archive collections (`vecthare_archiveevent_*`) have no triggers/conditions → they now default to BLOCKED. Phase A gatherer (Step 8) must check `isCollectionEnabled` + `isCollectionLockedToChat` directly instead of routing through `shouldCollectionActivate`. |
| 2 | **Standard pipeline always excludes `vecthare_eventbase_*`** | Same exclusion must be added for `vecthare_archiveevent_*` in `gatherCollectionsToQuery` (Step 9b — new step). |
| 3 | **`getContext` is from `extensions.js` not `script.js`** | `buildArchiveEventCollectionId` (Step 3) must import `getContext` from `../../../../extensions.js`. |

---

## Major pivot from previous draft

Previous draft repurposed the **Document** content type ("Custom Document" → "Archive Chat History") to use EventBase. **That should be reversed.**

- **Document content type stays untouched.** It keeps the chunk-based pipeline. Revert any prior renames/prefix changes that touched Document.
- **Archive chat ingestion uses the existing `Chat → Upload` tab instead.** That tab already has a parser ([`handleChatFileUpload` at ui/content-vectorizer.js:2215](../ui/content-vectorizer.js#L2215)) and produces `sourceData = { type: 'file', messages: [...], ... }`. Today this path falls through to chunk-based ingestion; we change it to route through EventBase.

This is a much smaller change (~120 LOC instead of 280-330) because parsing, UI, and stats are already done.

## Cross-checks performed

1. **`source.type` on Upload tab:** Verified — `handleChatFileUpload` sets `sourceData.type = 'file'` (not `null`). The previous claim "source.type should be null" is incorrect; it's `'file'`. Detection key is therefore `currentContentType === 'chat' && source.type === 'file'`.
2. **EventBase guard at [ui/content-vectorizer.js:2578](../ui/content-vectorizer.js#L2578):** Only fires when `source.type === 'current'`. Uploads explicitly bypass it today.
3. **`_runEventBaseBackfill` at [ui/content-vectorizer.js:2635](../ui/content-vectorizer.js#L2635):** Reads `context.chat` (live). Never reads `sourceData.messages`. Must be generalized.

## charName problem and solution

On the Upload tab, `getContext()?.name2` returns whatever character the user happens to be looking at when they upload — which is unrelated to the archived chat's character. Defaults to `'chat'`, causing the sanitizer to produce duplicate-prone IDs.

SillyTavern exports use a deterministic filename pattern:

```
{characterName} - YYYY-MM-DD@HHhMMmSSs.jsonl
e.g. "異世界學校 - 2025-12-16@09h56m28s.jsonl"
```

**Decision:** parse `characterName` out of the filename.  Check of any special char not suitable for name, remove invalid char, CJK lanaguage should survive.




Then sanitize the same way as `buildEventBaseCollectionId` — `lowercase`, `replace(/[^a-z0-9]+/g, '_')`, trim leading/trailing underscores, cap to 30 chars.

**Trade-off note:** `metadata?.character_name` from line 1 of the jsonl is also available. The user's directive is to use the filename. Filename has the advantage of being human-readable and matching what the user sees in the file browser; metadata has the advantage of surviving filename renames. Sticking with filename per directive.

## Collection ID format

```
vecthare_archiveevent_{backend}_{handle}_{filenameCharName}_{archiveUUID}
```

- `{handle}`: `getContext()?.name1` (current user persona — same as live EventBase). Sanitized identically.
- `{filenameCharName}`: parsed from filename per above. Sanitized identically.
- `{archiveUUID}`: archive's own `chat_metadata.integrity` from line 1 of the jsonl. **Fallback: SHA-1 hash of the raw file content (hex)** when integrity is absent — applies to `.json`/`.txt` uploads (no metadata at all), partial jsonl exports, or any file lacking `chat_metadata.integrity`. This makes re-uploads of the same archive idempotent (same hash → same ID → fingerprint-cache hits → no LLM calls).
- `{backend}`: `normalizeBackendForId(settings.vector_backend)` — same as live EventBase.  (should be either standard or qdrant)

This ID is **independent of the current chat's UUID**. Different archive, different ID. Different chat in ST, same archive uploaded → still same archive collection (because UUID derives from the archive, not the current chat).

**Constant:** add `COLLECTION_PREFIXES.VECTHARE_ARCHIVE_EVENT = 'vecthare_archiveevent_'`. Do **not** rename or remove `VECTHARE_DOCUMENT` — Document stays as-is.

## Reverts to previously-applied work

The following changes (made earlier this session, before this pivot) need to be undone:

| File | Change to revert |
|---|---|
| [core/content-types.js](../core/content-types.js) | Revert `name: 'Archive Chat History'` → `name: 'Custom Document'` (and revert the description). Document is its own thing again. |
| [core/collection-ids.js](../core/collection-ids.js) | Revert `VECTHARE_DOCUMENT: 'vecthare_archivechat_'` → `'vecthare_document_'`. Revert the parseCollectionId comment. |
| [core/chat-vectorization.js](../core/chat-vectorization.js#L778) | Remove the Phase B filter that excludes `VECTHARE_DOCUMENT` collections (Document goes through chunk pipeline = goes through Phase B retrieval). |
| [core/eventbase-workflow.js](../core/eventbase-workflow.js) | Remove `_gatherArchiveChatCollections` and the `additionalCandidates` plumbing. Archive event collections are queried separately under the new prefix instead. |
| [core/eventbase-retrieval.js](../core/eventbase-retrieval.js) | Remove the `additionalCandidates` parameter. |
| [core/collection-loader.js](../core/collection-loader.js#L742) | Revert probe patterns; remove the `VECTHARE_DOCUMENT` extra entry. |

After revert, the codebase is back to the state where Document = chunk + Phase B retrieval, exactly as it was before this work started. Document content type is fully restored to its original "Custom Document" identity — name, prefix, and routing all unchanged from pre-this-session baseline.

## Settings honored from the modal (Chat → Upload tab)

| Modal section | Honored for archive upload? |
|---|---|
| Step 1 — Content type | Forced to `chat`. User picks `Upload` sub-tab. |
| Step 2 — Source | `Upload` tab — file picker, no source-selector dropdown. Accepts `.jsonl`, `.json`, `.txt`. |
| Step 3 — Chunking strategy | ❌ Hidden when `source.type === 'file'` AND eventbase_enabled (chunking irrelevant for EventBase ingestion). |
| Step 4 — Options → Scope | ✅ Honored. |
| Step 4 — Options → Text Cleaning | ✅ Applied to each `mes` before passing to extractor. |
| Step 4 — Options → Keyword Extraction | ✅ Same as live chat. |
| EventBase Extraction tab | ✅ Window/overlap/importance/temperature/etc. — read from EventBase settings. |

## Architecture decisions

1. **Reuse `runEventBaseIngestion` with a `collectionIdOverride` param.** One additional parameter; extraction/storage logic untouched.
2. **Collection ID derived from archive, not current chat.** Allows the same archive to be ingested once regardless of which ST chat the user is viewing.
3. **Window-fingerprint cache key uses the archiveUUID** — not the current chat's UUID. This keeps live and archive ingestion fingerprint sets disjoint, so re-uploading an archive re-uses its own cache without colliding with live extraction state.
4. **Retrieval:** archive event collections must be discovered and queried in Phase A. Add a separate gatherer (`_gatherArchiveEventCollections`) that scans for any `vecthare_archiveevent_{backend}_{currentHandle}_*` collections and queries them alongside the live EventBase collection. Locking semantics (collection-active toggle) decide whether a particular archive is in the retrieval set for the current chat.
5. **Decisions confirmed in conversation:**
   - Strip scaffolding tags? **No — Text Cleaning handles it.**
   - Speaker prefix format? **`"NAME: mes\n\n"`** when assembling window text.
   - Skip empty messages? **Yes** (after `mes.trim()`, drop empties and `is_system === true`).
   - Restrict file extension to `.jsonl`? **No — all chat upload formats (`.jsonl`, `.json`, `.txt`) route to EventBase** when `eventbase_enabled` is on. Reasoning: an archived chat is still a chat regardless of file format. Files without `chat_metadata.integrity` use the SHA-1 fallback for `archiveUUID`. `metadata?.character_name` (when present in `.json`) feeds the filename-charName slot if filename parsing yields nothing useful.
   - Remove the Paste Text tab for the document type? **N/A** — Document type is untouched.

## Implementation steps

### Step 1 — Revert prior Document/archive-chat changes

Per the table above. After this step the repo is at "pre-archive-work" baseline for everything except `Doc/dev_helper.md` and the sample fixture.

### Step 2 — Filename parser helper

File: [`ui/content-vectorizer.js`](../ui/content-vectorizer.js) (or extracted to a small helper module in `core/` if reused elsewhere — for now, inline)

```js
function extractCharNameFromArchiveFilename(filename) {
    const stem = filename.replace(/\.(jsonl|json|txt)$/i, '');
    const m = stem.match(/^(.*?)\s+-\s+\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s$/);
    return (m ? m[1] : stem).trim();
}
```

### Step 3 — Collection ID builder

File: [`core/collection-ids.js`](../core/collection-ids.js)

- Add `COLLECTION_PREFIXES.VECTHARE_ARCHIVE_EVENT = 'vecthare_archiveevent_'`. Do **not** touch `VECTHARE_DOCUMENT`.
- Add new builder:

**Import note (session change):** `getContext` must be imported from `../../../../extensions.js`, NOT from `../../../../../script.js`. `script.js` does not export `getContext`.

```js
export function buildArchiveEventCollectionId({ filenameCharName, archiveUUID, backend }) {
    if (!archiveUUID) return null;

    const context = getContext(); // from extensions.js
    const sanitizedHandle = (context?.name1 || 'user')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 30) || 'user';

    const sanitizedChar = (filenameCharName || 'archive')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 30) || 'archive';

    const normalizedBackend = normalizeBackendForId(backend);
    if (normalizedBackend) {
        return `${COLLECTION_PREFIXES.VECTHARE_ARCHIVE_EVENT}${normalizedBackend}_${sanitizedHandle}_${sanitizedChar}_${archiveUUID}`;
    }
    return `${COLLECTION_PREFIXES.VECTHARE_ARCHIVE_EVENT}${sanitizedHandle}_${sanitizedChar}_${archiveUUID}`;
}
```

- Extend `parseCollectionId` to recognize `VECTHARE_ARCHIVE_EVENT` prefix and return a new `COLLECTION_TYPES.ARCHIVE_EVENT` (add this constant) with `scope: COLLECTION_SCOPES.GLOBAL`.

### Step 4 — Capture archive UUID in the upload handler

File: [`ui/content-vectorizer.js`](../ui/content-vectorizer.js#L2215)

In `handleChatFileUpload`, capture `chat_metadata.integrity` (jsonl only — `.json`/`.txt` won't have it) and a SHA-1 fallback. Make the handler `async` so it can `await` the SubtleCrypto digest:

```js
async function sha1Hex(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// inside reader.onload (now async):
const archiveUUID = metadata?.chat_metadata?.integrity || await sha1Hex(content);
const filenameCharName = extractCharNameFromArchiveFilename(file.name)
    || metadata?.character_name
    || 'archive';

sourceData = {
    type: 'file',
    filename: file.name,
    content: messages,
    messages: messages,
    metadata: metadata,
    archiveUUID,                // never null — always integrity OR sha1 hash
    filenameCharName,
    characterName: characterName,  // existing — unchanged
};
```

Console-warn (not toastr) when integrity is absent so we know which archives fell back to hash. Same archive uploaded twice → same hash → same collection → fingerprint dedup → no LLM calls.

### Step 5 — Route Chat-Upload to EventBase

File: [`ui/content-vectorizer.js`](../ui/content-vectorizer.js)

Modify the guard at line 2578 (and the symmetric guard in `startVectorization` ~line 2746) so it also fires for file uploads:

```js
if (currentContentType === 'chat' &&
    (source.type === 'current' || source.type === 'file')) {
    const globalSettings = extension_settings.vecthareplus || {};
    if (globalSettings.eventbase_enabled) {
        return _runEventBaseBackfill();
    }
    // ... existing chunk fallback for source.type === 'current'
}
```

When `eventbase_enabled` is false and `source.type === 'file'`, fall through to the existing chunk path (current behavior — preserved).

### Step 6 — Generalize `_runEventBaseBackfill` to accept upload source

File: [`ui/content-vectorizer.js`](../ui/content-vectorizer.js#L2635)

Today the function reads `context.chat`. Generalize:

```js
async function _runEventBaseBackfill() {
    // ...
    const source = getSourceData();
    let messages, chatUUID, collectionIdOverride = null;

    if (source?.type === 'file') {
        // Archive upload route — works for .jsonl / .json / .txt
        if (!source.messages?.length) {
            toastr.warning('Archive contains no usable messages', 'EventBase');
            return;
        }
        // archiveUUID is guaranteed non-null (integrity OR sha1 fallback set in upload handler)
        messages = source.messages;
        chatUUID = source.archiveUUID;
        collectionIdOverride = buildArchiveEventCollectionId({
            filenameCharName: source.filenameCharName,
            archiveUUID: source.archiveUUID,
            backend: settings.vector_backend,
        });
    } else {
        // Existing live-chat path — unchanged
        if (!Array.isArray(context.chat) || context.chat.length === 0) {
            toastr.warning('No chat messages to process', 'EventBase');
            return;
        }
        messages = context.chat.filter(m => !m.is_system);
        chatUUID = getChatUUID();
        // collectionIdOverride stays null → ingestion uses live EventBase ID
    }

    // start-from slicing only applies to live chat — skip for archive
    if (source?.type !== 'file' && startFromMessage > 1) { /* existing slice logic */ }

    const result = await runEventBaseIngestion({
        messages,
        chatUUID,
        settings,
        abortSignal: activeVectorizeAbortController.signal,
        progressPlan,
        collectionIdOverride,   // NEW — null for live, set for archive
    });
    // ... rest unchanged
}
```

### Step 7 — `runEventBaseIngestion` accepts override

File: [`core/eventbase-workflow.js`](../core/eventbase-workflow.js)

```js
export async function runEventBaseIngestion({
    messages, chatUUID, settings,
    abortSignal = null, progressPlan = null,
    collectionIdOverride = null,   // NEW
}) {
    // ...
    const collectionId = collectionIdOverride || buildEventBaseCollectionId(uuid, backend);
    // window-fingerprint cache still keyed by chatUUID (which for archives is archiveUUID)
}
```

All other logic (windowing, extraction, dedup, insertion) unchanged.

### Step 8 — Phase A retrieval discovers archive event collections

File: [`core/eventbase-workflow.js`](../core/eventbase-workflow.js)

Add a sibling to the live `vecthare_eventbase_*` discovery: scan registered collections for `vecthare_archiveevent_{backend}_{currentHandle}_*` and include their events in the retrieval candidate set.

**Activation gate (updated — session change):** The activation filter (`shouldCollectionActivate`) no longer auto-activates collections that have no triggers and no conditions. Archive collections have neither by default, so they would be blocked. The Phase A gatherer must **not** route these through `shouldCollectionActivate`. Instead, check directly:
1. `isCollectionEnabled(registryKey)` — respects the DB Browser Pause button (global disable).
2. `isCollectionLockedToChat(collectionId, currentChatId)` — respects the "Active for current chat" checkbox.

Only include the archive collection if both pass. This means users must explicitly check "Active for current chat" on each archive collection card to include it in retrieval for a given chat. Document this in the UI (tooltip or hint on the collection card).

This is symmetric with the live EventBase retrieval — same re-ranker, same scoring. No `_chunkToEventCandidate` needed because the storage is already event-shaped.

### Step 9 — UI hide chunking section when archive-EventBase route is active

File: [`ui/content-vectorizer.js`](../ui/content-vectorizer.js)

When `currentContentType === 'chat'`, `source.type === 'file'`, and `eventbase_enabled === true`, hide Step 3 (Chunking strategy). Preserve everything else (Scope, Text Cleaning, Keyword Extraction, EventBase Extraction tab).

### Step 9b — Exclude `vecthare_archiveevent_*` from standard pipeline

File: [`core/chat-vectorization.js`](../core/chat-vectorization.js) → `gatherCollectionsToQuery`

**Session change:** `vecthare_eventbase_*` is now always excluded from the standard (chunk) pipeline. Add the same exclusion for `vecthare_archiveevent_*`. Archive event collections are owned by Phase A (EventBase pipeline) — the standard pipeline must never touch them.

```js
if (collectionId?.startsWith(COLLECTION_PREFIXES.VECTHARE_EVENTBASE) ||
    collectionId?.startsWith(COLLECTION_PREFIXES.VECTHARE_ARCHIVE_EVENT)) {
    continue;
}
```

### Step 10 — Tests

- `tests/archive-filename-parser.test.js`:
  - Standard ST export filename → correct char name
  - Unicode names (Chinese/Japanese/Cyrillic) → preserved
  - Filename without date suffix → returns full stem
  - `.json` and `.txt` extensions → stripped
- `tests/archive-event-collection-id.test.js`:
  - Builder produces expected ID with all parts (integrity-UUID case)
  - Builder produces expected ID with SHA-1 hash UUID (fallback case)
  - Backend variations
- `tests/archive-event-ingestion.test.js`:
  - Mock `runEventBaseIngestion` and verify upload path passes correct override + messages
  - `.jsonl` with integrity → uses integrity as UUID
  - `.json` without integrity → uses SHA-1 hash as UUID
  - `.txt` upload → uses SHA-1 hash as UUID
  - Same `.jsonl` uploaded twice → same collection ID → no duplicate LLM calls

### Step 11 — Update `Doc/dev_helper.md`

Pre-existing fix (independent):
- §5 title: "EventBase Window Dedup — chat_metadata Fingerprint Cache" → "EventBase Window Dedup — extension_settings Fingerprint Cache"

Additions:
- §3 (or wherever collection-ID taxonomy lives): add row for `vecthare_archiveevent_*`.
- §5: paragraph noting archive ingestion uses the **archive's own UUID** as the cache key (not current chat's UUID), and that re-uploading is idempotent due to fingerprint dedup.
- New §X "Archive Chat History — Two paths":
  - Path A: `Chat → Upload` tab + EventBase enabled → `vecthare_archiveevent_*` (event-shaped). New, this work.
  - Path B: `Document` content type → `vecthare_document_*` (chunk-shaped). Untouched.
  - Brief note: future cleanup may consolidate these, but for now they coexist.

## Out of scope (follow-ups)

- Auto-locking newly vectorized archive collections to the current chat (manual toggle for now).
- Importing `chat_metadata.timedWorldInfo`, persona/character context from archive header.
- Multi-file batch import.
- Consolidating Document and Archive Event paths (decision deferred — Document stays in case it has a use case we're missing).

## Estimated size

~120 LOC across 6 file edits + 3 small test files + dev_helper update. ~2 hours including verification.

## Step summary

1. Revert prior Document-related changes
2. Filename parser helper
3. `VECTHARE_ARCHIVE_EVENT` prefix + `buildArchiveEventCollectionId` builder
4. Capture archive UUID + filenameCharName in upload handler
5. Route Chat-Upload (`source.type === 'file'`) to EventBase guard
6. Generalize `_runEventBaseBackfill` for upload source
7. `runEventBaseIngestion` accepts `collectionIdOverride`
8. Phase A retrieval discovers `vecthare_archiveevent_*` collections
9. UI hides chunking section on archive-EventBase route
10. Tests
11. `Doc/dev_helper.md` updates

## Resolved decisions (locked in)

- **Document naming:** revert "Custom Document" / `vecthare_document_` to original. Document is its own thing again, fully untouched.
- **Missing `chat_metadata.integrity`:** SHA-1 of raw file content (hex) as `archiveUUID` fallback. Console-warn so we know which archives fell back.
- **File-extension scope:** all chat upload formats (`.jsonl`, `.json`, `.txt`) route to EventBase when `eventbase_enabled` is on. An archived chat is still a chat regardless of file format.