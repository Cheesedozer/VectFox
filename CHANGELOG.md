# Changelog

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
