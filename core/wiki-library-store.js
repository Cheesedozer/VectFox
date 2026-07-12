/**
 * ============================================================================
 * WIKI LIBRARY STORE
 * ============================================================================
 * IndexedDB persistence for the Wiki Library: every page a scrape retrieves
 * is written here incrementally, so stopping (or crashing, or reloading
 * SillyTavern) never loses work. Deliberately NOT in
 * extension_settings.vectfox — settings.json syncs to the server on every
 * debounced save and is the wrong size class for whole wikis (see the
 * storage-growth note in core/reformat-store.js, which stays in settings
 * because reformat output is small; scraped corpora are not).
 *
 * Object stores (DB `vectfox-wiki-library`, version 1):
 *   libraries  keyPath `id`       one row per wiki, holds scrape checkpoints
 *   pages      keyPath `key`      `${libraryId}::${title}`; content optional
 *   basket     keyPath `pageKey`  the cross-wiki selection basket
 *
 * Writes are transactional per call. Bulk writes (putPages,
 * updatePageContents) read-merge inside one transaction so a re-enumeration
 * can never clobber already-fetched content with an empty metadata record.
 *
 * @module wikiLibraryStore
 */

import { log } from './log.js';

const DB_NAME = 'vectfox-wiki-library';
const DB_VERSION = 1;

/**
 * Error raised by the store, tagged with a machine-readable code:
 * - 'unavailable' IndexedDB missing or unopenable — UI degrades to the
 *                 legacy in-memory scrape flow
 * - 'quota'       browser storage quota exceeded — treated by the service
 *                 as an implicit Stop & Keep
 * - 'storage'     any other IndexedDB failure
 */
export class WikiLibraryError extends Error {
    constructor(code, message, { cause } = {}) {
        super(message);
        this.name = 'WikiLibraryError';
        this.code = code;
        if (cause) this.cause = cause;
    }
}

/** Builds the pages/basket primary key for a page of a library. */
export function pageKey(libraryId, title) {
    return `${libraryId}::${title}`;
}

function toStoreError(error) {
    if (error instanceof WikiLibraryError) {
        return error;
    }
    const name = error?.name ?? '';
    if (name === 'QuotaExceededError') {
        return new WikiLibraryError('quota', 'Browser storage quota exceeded — free space in the Wiki Library storage tab.', { cause: error });
    }
    return new WikiLibraryError('storage', error?.message || 'Wiki library storage error', { cause: error });
}

let dbPromise = null;

function openDb() {
    if (dbPromise) {
        return dbPromise;
    }
    dbPromise = new Promise((resolve, reject) => {
        const idb = globalThis.indexedDB;
        if (!idb) {
            reject(new WikiLibraryError('unavailable', 'IndexedDB is not available in this browser.'));
            return;
        }
        let request;
        try {
            request = idb.open(DB_NAME, DB_VERSION);
        } catch (error) {
            reject(new WikiLibraryError('unavailable', 'IndexedDB could not be opened.', { cause: error }));
            return;
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('libraries')) {
                db.createObjectStore('libraries', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('pages')) {
                const pages = db.createObjectStore('pages', { keyPath: 'key' });
                pages.createIndex('byLibrary', 'libraryId', { unique: false });
                pages.createIndex('byLibraryFetched', ['libraryId', 'contentFetched'], { unique: false });
            }
            if (!db.objectStoreNames.contains('basket')) {
                db.createObjectStore('basket', { keyPath: 'pageKey' });
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            // If another tab upgrades the schema, close so it can proceed;
            // the next call reopens at the new version.
            db.onversionchange = () => {
                db.close();
                dbPromise = null;
            };
            resolve(db);
        };
        request.onerror = () => {
            reject(new WikiLibraryError('unavailable', 'IndexedDB could not be opened.', { cause: request.error }));
        };
    });
    // A failed open must not poison every later call
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
}

/** Promise wrapper for a single IDBRequest. */
function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(toStoreError(request.error));
    });
}

/**
 * Runs `work(stores...)` inside one transaction and resolves with its return
 * value once the transaction commits (so bulk writes are all-or-nothing).
 */
async function withTransaction(storeNames, mode, work) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        let tx;
        try {
            tx = db.transaction(storeNames, mode);
        } catch (error) {
            reject(toStoreError(error));
            return;
        }
        const stores = storeNames.map(name => tx.objectStore(name));
        let result;
        let workError = null;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(toStoreError(workError ?? tx.error));
        tx.onerror = () => { workError = workError ?? tx.error; };
        Promise.resolve(work(...stores))
            .then(value => { result = value; })
            .catch(error => {
                workError = error;
                try { tx.abort(); } catch { /* already aborted */ }
            });
    });
}

/** Whether IndexedDB is usable (cheap, cached probe). */
export async function isStoreAvailable() {
    try {
        await openDb();
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Libraries
// ---------------------------------------------------------------------------

/**
 * @typedef {object} WikiLibrary
 * @property {string} id - `fandom:<id>` / `mediawiki:<host+path>` / `e621:<host>`
 * @property {string} wikiType - 'fandom' | 'mediawiki' | 'e621'
 * @property {string} inputUrl - What the user typed
 * @property {string} apiUrl - Resolved api.php / API base URL
 * @property {string} name - Display name
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} titleCount
 * @property {number} fetchedCount
 * @property {number} bytesApprox - Running sum of stored content+plaintext chars
 * @property {boolean} enumComplete - Title enumeration finished
 * @property {object|number|null} checkpoint - MediaWiki `continue` blob / e621 id cursor
 * @property {('browser'|'plugin')} origin
 * @property {string} lastError
 */

/**
 * Creates or merges a library row. Fields not present in `library` are kept
 * from the stored row; counters start at zero for new rows.
 *
 * @param {Partial<WikiLibrary> & {id: string}} library
 * @returns {Promise<WikiLibrary>}
 */
export async function upsertLibrary(library) {
    if (!library?.id) {
        throw new WikiLibraryError('storage', 'upsertLibrary requires an id');
    }
    return withTransaction(['libraries'], 'readwrite', async (libraries) => {
        const existing = await requestToPromise(libraries.get(library.id));
        const now = Date.now();
        const merged = {
            wikiType: '',
            inputUrl: '',
            apiUrl: '',
            name: '',
            createdAt: now,
            titleCount: 0,
            fetchedCount: 0,
            bytesApprox: 0,
            enumComplete: false,
            checkpoint: null,
            origin: 'browser',
            lastError: '',
            ...(existing ?? {}),
            ...library,
            updatedAt: now,
        };
        libraries.put(merged);
        return merged;
    });
}

/** @returns {Promise<WikiLibrary|null>} */
export async function getLibrary(id) {
    return withTransaction(['libraries'], 'readonly', async (libraries) => {
        return (await requestToPromise(libraries.get(id))) ?? null;
    });
}

/** @returns {Promise<WikiLibrary[]>} All libraries, most recently updated first. */
export async function listLibraries() {
    return withTransaction(['libraries'], 'readonly', async (libraries) => {
        const all = await requestToPromise(libraries.getAll());
        return all.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    });
}

/**
 * Deletes a library and cascades to its pages and basket rows.
 *
 * @param {string} id
 * @returns {Promise<{pagesDeleted: number, basketDeleted: number}>}
 */
export async function deleteLibrary(id) {
    return withTransaction(['libraries', 'pages', 'basket'], 'readwrite', async (libraries, pages, basket) => {
        libraries.delete(id);

        const pageKeys = await requestToPromise(pages.index('byLibrary').getAllKeys(id));
        for (const key of pageKeys) {
            pages.delete(key);
        }

        const basketRows = await requestToPromise(basket.getAll());
        let basketDeleted = 0;
        for (const row of basketRows) {
            if (row.libraryId === id) {
                basket.delete(row.pageKey);
                basketDeleted++;
            }
        }
        return { pagesDeleted: pageKeys.length, basketDeleted };
    });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * @typedef {object} WikiPageRecord
 * @property {string} key - `${libraryId}::${title}`
 * @property {string} libraryId
 * @property {string} title
 * @property {string} url
 * @property {string[]} categories - Category names, no `Category:` prefix
 * @property {number} sizeBytes - Wiki-reported page length
 * @property {number} touched - Last-modified, ms epoch (0 if unknown)
 * @property {number} contentFetched - 0|1 (number so the compound index works)
 * @property {string} content - Raw wikitext/DText ('' until fetched)
 * @property {string} plaintext - Converted plaintext ('' until fetched)
 * @property {number} fetchedAt - ms epoch (0 if never fetched)
 */

function normalizePageRecord(record) {
    const libraryId = String(record.libraryId ?? '');
    const title = String(record.title ?? '');
    return {
        key: record.key ?? pageKey(libraryId, title),
        libraryId,
        title,
        url: String(record.url ?? ''),
        categories: Array.isArray(record.categories) ? record.categories.map(String) : [],
        sizeBytes: Number(record.sizeBytes) || 0,
        touched: Number(record.touched) || 0,
        contentFetched: record.contentFetched ? 1 : 0,
        content: String(record.content ?? ''),
        plaintext: String(record.plaintext ?? ''),
        fetchedAt: Number(record.fetchedAt) || (record.contentFetched ? Date.now() : 0),
    };
}

/**
 * Bulk-inserts/updates page records in one transaction.
 *
 * Read-merge rule: when an incoming record carries NO content but the stored
 * row is already fetched, the stored content/plaintext/fetchedAt survive and
 * only metadata (categories, size, touched, url) is refreshed — so
 * re-enumerating a wiki never clobbers fetched pages. Records that DO carry
 * content (e621 walk, plugin ingest, content fetches) overwrite it.
 *
 * @param {Array<Partial<WikiPageRecord> & {libraryId: string, title: string}>} records
 * @returns {Promise<{added: number, updated: number, bytesDelta: number, fetchedDelta: number}>}
 */
export async function putPages(records) {
    const normalized = records.map(normalizePageRecord).filter(r => r.libraryId && r.title);
    if (normalized.length === 0) {
        return { added: 0, updated: 0, bytesDelta: 0, fetchedDelta: 0 };
    }
    return withTransaction(['pages'], 'readwrite', async (pages) => {
        let added = 0, updated = 0, bytesDelta = 0, fetchedDelta = 0;
        for (const record of normalized) {
            const existing = await requestToPromise(pages.get(record.key));
            let toStore = record;
            if (existing) {
                updated++;
                if (!record.contentFetched && existing.contentFetched) {
                    toStore = {
                        ...record,
                        contentFetched: existing.contentFetched,
                        content: existing.content,
                        plaintext: existing.plaintext,
                        fetchedAt: existing.fetchedAt,
                    };
                }
                bytesDelta += (toStore.content.length + toStore.plaintext.length)
                    - ((existing.content?.length ?? 0) + (existing.plaintext?.length ?? 0));
                fetchedDelta += toStore.contentFetched - (existing.contentFetched ? 1 : 0);
            } else {
                added++;
                bytesDelta += record.content.length + record.plaintext.length;
                fetchedDelta += record.contentFetched;
            }
            pages.put(toStore);
        }
        return { added, updated, bytesDelta, fetchedDelta };
    });
}

/** @returns {Promise<WikiPageRecord|null>} */
export async function getPage(key) {
    return withTransaction(['pages'], 'readonly', async (pages) => {
        return (await requestToPromise(pages.get(key))) ?? null;
    });
}

/**
 * @param {string[]} keys
 * @returns {Promise<WikiPageRecord[]>} Found records, in the order of `keys`
 *          (missing keys are skipped).
 */
export async function getPages(keys) {
    return withTransaction(['pages'], 'readonly', async (pages) => {
        const found = [];
        for (const key of keys) {
            const record = await requestToPromise(pages.get(key));
            if (record) {
                found.push(record);
            }
        }
        return found;
    });
}

/**
 * @param {string} libraryId
 * @param {object} [options]
 * @param {boolean} [options.fetchedOnly]
 * @returns {Promise<WikiPageRecord[]>}
 */
export async function getPagesByLibrary(libraryId, { fetchedOnly = false } = {}) {
    return withTransaction(['pages'], 'readonly', async (pages) => {
        if (fetchedOnly) {
            return requestToPromise(pages.index('byLibraryFetched').getAll([libraryId, 1]));
        }
        return requestToPromise(pages.index('byLibrary').getAll(libraryId));
    });
}

/**
 * Marks pages as fetched and stores their content, in one transaction.
 *
 * @param {Array<{key: string, content: string, plaintext: string}>} updates
 * @returns {Promise<{updated: number, bytesDelta: number, fetchedDelta: number}>}
 */
export async function updatePageContents(updates) {
    if (!updates?.length) {
        return { updated: 0, bytesDelta: 0, fetchedDelta: 0 };
    }
    return withTransaction(['pages'], 'readwrite', async (pages) => {
        let updated = 0, bytesDelta = 0, fetchedDelta = 0;
        const now = Date.now();
        for (const update of updates) {
            const existing = await requestToPromise(pages.get(update.key));
            if (!existing) {
                continue;
            }
            const content = String(update.content ?? '');
            const plaintext = String(update.plaintext ?? '');
            bytesDelta += (content.length + plaintext.length)
                - ((existing.content?.length ?? 0) + (existing.plaintext?.length ?? 0));
            fetchedDelta += 1 - (existing.contentFetched ? 1 : 0);
            pages.put({ ...existing, content, plaintext, contentFetched: 1, fetchedAt: now });
            updated++;
        }
        return { updated, bytesDelta, fetchedDelta };
    });
}

// ---------------------------------------------------------------------------
// Basket
// ---------------------------------------------------------------------------

/**
 * @typedef {object} BasketRow
 * @property {string} pageKey
 * @property {string} libraryId
 * @property {string} title
 * @property {number} addedAt
 */

/**
 * @param {Array<{pageKey: string, libraryId: string, title: string}>} entries
 * @returns {Promise<number>} Number of rows written
 */
export async function basketAdd(entries) {
    if (!entries?.length) {
        return 0;
    }
    return withTransaction(['basket'], 'readwrite', async (basket) => {
        const now = Date.now();
        let written = 0;
        for (const entry of entries) {
            if (!entry?.pageKey) {
                continue;
            }
            const existing = await requestToPromise(basket.get(entry.pageKey));
            basket.put({
                pageKey: entry.pageKey,
                libraryId: entry.libraryId ?? '',
                title: entry.title ?? '',
                addedAt: existing?.addedAt ?? now,
            });
            written++;
        }
        return written;
    });
}

/** @param {string[]} pageKeys */
export async function basketRemove(pageKeys) {
    if (!pageKeys?.length) {
        return;
    }
    return withTransaction(['basket'], 'readwrite', async (basket) => {
        for (const key of pageKeys) {
            basket.delete(key);
        }
    });
}

export async function basketClear() {
    return withTransaction(['basket'], 'readwrite', async (basket) => {
        basket.clear();
    });
}

/**
 * Lists basket rows, lazily pruning entries whose page no longer exists
 * (deleted library, deleted page) so the basket never references ghosts.
 *
 * @returns {Promise<BasketRow[]>} Sorted by (libraryId, title)
 */
export async function basketList() {
    return withTransaction(['basket', 'pages'], 'readwrite', async (basket, pages) => {
        const rows = await requestToPromise(basket.getAll());
        const alive = [];
        for (const row of rows) {
            const page = await requestToPromise(pages.get(row.pageKey));
            if (page) {
                alive.push(row);
            } else {
                basket.delete(row.pageKey);
            }
        }
        alive.sort((a, b) => a.libraryId.localeCompare(b.libraryId) || a.title.localeCompare(b.title));
        return alive;
    });
}

// ---------------------------------------------------------------------------
// Usage / maintenance
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{usage: number|null, quota: number|null, libraries: Array<{id: string, name: string, titleCount: number, fetchedCount: number, bytesApprox: number}>}>}
 */
export async function estimateUsage() {
    let usage = null, quota = null;
    try {
        const estimate = await globalThis.navigator?.storage?.estimate?.();
        if (estimate) {
            usage = estimate.usage ?? null;
            quota = estimate.quota ?? null;
        }
    } catch (error) {
        log.verbose('[WikiLibrary] storage.estimate() failed:', error?.message);
    }
    const libraries = await listLibraries();
    return {
        usage,
        quota,
        libraries: libraries.map(lib => ({
            id: lib.id,
            name: lib.name,
            titleCount: lib.titleCount ?? 0,
            fetchedCount: lib.fetchedCount ?? 0,
            bytesApprox: lib.bytesApprox ?? 0,
        })),
    };
}

/**
 * Test/maintenance helper: closes the connection and deletes the database.
 * @returns {Promise<void>}
 */
export async function _deleteDatabaseForTests() {
    if (dbPromise) {
        try {
            (await dbPromise).close();
        } catch { /* ignore */ }
        dbPromise = null;
    }
    const idb = globalThis.indexedDB;
    if (!idb) {
        return;
    }
    await new Promise((resolve) => {
        const request = idb.deleteDatabase(DB_NAME);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
}
