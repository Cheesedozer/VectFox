# Changelog

## Unreleased

### Fixes

- **Database Browser: "Manage Locks" works again.** Opening the lock dialog
  threw `getCollectionCharacterLocks is not defined` (its import was dropped in
  the unused-import cleanup) and showed "Failed to open lock dialog".
- **Database Browser: the Documents filter shows documents.** Vectorized
  documents (including Auto-Reformat output) are typed `document`, which the
  filter didn't accept, so only "All Types" listed them. The Chats filter now
  also includes uploaded chat archives.
- **Database Browser: documents and character cards are listed for every
  persona.** They are retrieved through their character lock whoever created
  them, but the browser hid them unless the persona that created them was
  active. Chat memories and lorebooks, which retrieval does limit to their own
  persona, still need **👥 Show all**.

### New

- **Re-vectorize (Qdrant collections).** A button on each Qdrant collection
  card re-embeds every chunk with the current embedding settings, in place:
  same collection ID, chunk text, locks and settings. Use it after changing
  the embedding model (the vector size may change) or if a Qdrant upgrade ever
  requires it. Chunks and their old vectors are read first; if embedding
  fails the old vectors are written back.
- **Auto-Reformat: Whole Document in One Response** (ChunkBase → Auto-Reformat,
  off by default). Sends the whole document in one call with the model's own
  output limit (Batch Size and Max Output Tokens don't apply), tries it a
  second time if it fails, and falls back to batches after that, when the
  reply is cut off, or when the document can't fit the model's context/output
  limit (checked against OpenRouter's model list, allowing ~3 tokens of
  entries per source token plus room for thinking). The linking pass is
  skipped after a whole-document call. Whether it helps depends on the model.
  On a 31k-character world bible, Claude Haiku 5.5 on medium effort kept 99%
  of the source's facts in one reply with no duplicate entries ($0.015, 93 s);
  Gemini 3.5 Flash Lite and 3.8 Flash summarized to ~88% (Flash Lite in
  batches: 98%).
- **Auto-Reformat: Reasoning Effort** (Model default / Low / Medium / High).
  Sent as SillyTavern's `reasoning_effort`, which its proxy maps to the
  provider (OpenRouter's `reasoning.effort`). Thinking counts against the
  output limit, so with an effort set each batch gets the model's full output
  limit (or Max Output Tokens plus a thinking reserve when the limit is
  unknown) and at least a 5-minute timeout; without this, Gemini 3.8 Flash on
  high had 7 of 12 batches cut off at 16k tokens.

### Performance

- **Full-collection metadata is now cached.** `getSavedHashes(..., includeMetadata=true)`
  previously re-downloaded the ENTIRE collection (hashes + full metadata for
  every chunk) on every call — and `rearrangeChat` could call it twice in one
  message retrieval (summary-chunk expansion, then force-link resolution) any
  time summarization or force-links are in use. Now cached per collection for
  the session, invalidated on insert/delete/purge/purgeAll and on chunk edits
  (Database Browser's chunk-visualizer save), so the cache never serves stale
  data. Biggest win for large collections with summarization enabled, where
  this sat directly on the per-message retrieval path.
- **Stop-word Set is no longer rebuilt per chunk.** Bulk content vectorization
  (documents, wiki scrapes, large lorebooks) rebuilt the full locale-union
  stop-word Set from scratch for every single chunk during keyword extraction.
  The locale-derived portion (mode-dependent, not settings-dependent) is now
  memoized per CJK tokenizer mode; only the small custom-stopwords/macro
  overlay is still computed fresh per call, since it can legitimately vary
  with the active character/persona.
- **Cleaning regexes are no longer recompiled per call.** `cleanText()` (run
  per lorebook entry, character field, document/wiki page, and chat message)
  recompiled every enabled cleaning pattern's RegExp and rebuilt the active-
  pattern list from settings on every call. Both are now cached — regexes by
  a content-addressed key (pattern+flags) that self-invalidates on edit, and
  the active-pattern list keyed to the settings object's identity so it stays
  correct across any way the cleaning settings can change.

### Auto-Reformat depth-loss fixes

Multi-subsection topics could lose most of their content: the model would
collapse a named entity's section (e.g. an organization profiled across four
subsections) into one short entry covering only the first subsection, and
dense enumerations (term lists, named laws, prices, statistics) were being
summarized away. Verified against a real document where 22 of 53 sampled
source facts were missing from the vectorized output.

- **Extraction prompt:** new completeness contract — every fact, figure,
  named law, and list item must land in exactly one entry's body; enumerations
  are reproduced item-by-item, never compressed to "terms such as…"; bodies
  have no length limit. Entity sections with substantial subsections now
  produce per-subsection sub-entries (`"<Entity>: <Subsection>"`, linked
  `subtopic of`), same as concept topics already did. A third few-shot example
  demonstrates full-fidelity extraction (the previous two examples' 2–3
  sentence bodies were anchoring the model's output length).
- **New: Coverage Repair Pass** (on by default, toggle in ChunkBase →
  Auto-Reformat): after each batch, a deterministic check verifies the
  source's distinctive facts (figures, quoted terms, proper-noun phrases,
  rare words) actually appear in the extracted entries. Under-captured
  sections get ONE follow-up LLM call listing exactly what was missed; if
  coverage is still low afterwards, a warning names the affected sections in
  the review screen. Extra LLM calls are spent only when loss is detected.
- **Duplicate merge is now lossless:** when the same entity is extracted from
  multiple document sections, the merged body keeps the longer version and
  appends the other's non-duplicate paragraphs/sentences — previously the
  shorter body was discarded wholesale, losing any facts only it carried.
- **Grounding guard understands sub-entry names:** compound names like
  `"Male Sympathizers: Demographic Composition"` are verified per component
  instead of being false-flagged as hallucinations.
- Default `reformat_max_output_tokens` raised 8000 → 16000 — full-fidelity
  bodies need output headroom, and large-context models (e.g. Grok 4.3) have
  no provider-side output cap; the extension's own cap was the binding limit.
  Existing installs keep their saved value — raise it manually to benefit.

### Auto-Reformat cache fixes

- **Fixed:** deleting vectorized content from the database no longer leaves the
  Auto-Reformat "freeze" behind — previously a later Auto-Reformat run on the
  same source would "instantly complete" claiming saved content even though its
  vectors were gone. Cache entries now track which collections they were
  vectorized into and are invalidated when the last of those collections is
  deleted (single delete, bulk delete, lorebook reindex, and purge-all).
- Auto-Reformat on already-reformatted content now asks: **Reuse saved result**
  (instant, free) / **Re-run fresh** (invokes the LLM again) / Cancel — instead
  of silently reusing.

### Database Browser

- New **👥 Show all** toggle beside the search box: shows collections created
  by every persona, not just the current one (the backend always stored them
  all; the browser view was persona-scoped). Display-only — foreign collections
  stay inactive for your chats. Cards show a 👤 owner badge, destructive
  actions on another persona's collection warn first, and the toggle resets on
  each open. Also widens the Bulk and Search tabs while enabled. The
  undocumented `superadmin: true` settings flag still bypasses the filter
  permanently and now renders the toggle locked-on.

## 4.0.0 — Wiki Library

A ground-up rework of how wiki scraping, filtering, and selection work. The
old flow was atomic and lossy: results lived only in memory, the sole steering
tool was a title regex, and pressing Cancel discarded every page already
retrieved. All of that is gone.

### Persistent scrape library

- Every retrieved page is saved to a browser-side IndexedDB library the
  moment its batch lands — stops, cancels, quota exhaustion, crashes, and
  reloads no longer lose work.
- Page records now carry metadata: canonical URL, wiki categories, size, and
  last-modified timestamp (captured during enumeration at near-zero cost via
  MediaWiki generators).
- Interrupted scrapes checkpoint (MediaWiki `continue` blob / e621 id cursor)
  and can be resumed instead of restarted.

### Titles-first scraping

- **Index Titles** enumerates a whole wiki's titles + metadata in seconds
  without downloading content; content is fetched on demand for the pages
  you select.
- **Fetch Everything** keeps the old full-scrape behavior, now persistent
  and resumable. e621 shows a cost estimate before its full corpus walk.
- **Stop & Keep** and **Cancel** are now separate buttons with honest
  semantics; a live results panel streams titles and counts as they land.

### Wiki Library browser

- New modal (wiki section → Wiki Library): search titles by token prefix or
  `/regex/` (same semantics as the scrape filter), full-text search over
  fetched pages, and facet filters for category, size bucket, and fetched
  status with live counts.
- Bulk select-all-filtered, per-page and bulk basket/add/fetch actions,
  200-row windowed rendering for large wikis.
- e621 exact-title quick lookup: one request, no walk.
- Storage tab: per-wiki size/coverage cards, resume, cascade delete, and a
  browser storage usage bar.

### Cross-wiki selection basket

- Collect pages from any number of wikis into a persistent basket and use it
  as the vectorization / Auto-Reformat source (new "Selection basket" source
  mode in the wiki section).
- Basket materialization is deterministic (sorted by wiki + title), so the
  same selection always produces the same content hash regardless of the
  order pages were added.
- Auto-Reformat results accepted for a basket are pinned to the exact page
  selection: changing the basket shows a warning with re-run/discard options,
  and Vectorize confirms before falling back to mechanical chunking on any
  stale reformat instead of doing so silently.

### Scraper internals

- New incremental primitives in `core/wiki-scraper.js` (metadata
  enumeration via `generator=allpages&prop=categories|info`, batch-streamed
  content fetches, resumable e621 walk, server-side e621 title search) —
  the legacy one-shot API is unchanged and remains the degraded-mode path
  when IndexedDB is unavailable.
- Plugin-fallback results (CORS-blocked wikis) now land in the library too.

### Housekeeping

- Version aligned to 4.0.0 across manifest and file headers; added this
  changelog.

## Earlier versions

See the git commit history for changes prior to 4.0.0.
