/**
 * ============================================================================
 * WIKI SEARCH INDEX
 * ============================================================================
 * In-memory search/facet index over Wiki Library page records. Hand-rolled
 * and dependency-free on purpose: the corpus is at most a few tens of
 * thousands of titles, where a Map-based inverted index answers every query
 * in well under a millisecond — the scale that would justify a vendored
 * search library never materializes in a per-wiki browser extension.
 *
 * Holds tokens and metadata only, never page content: plaintext is tokenized
 * on the way in and discarded (content stays in IndexedDB), so a fully
 * fetched wiki costs megabytes on disk but only token sets in memory.
 *
 * Two query paths, matching the two kinds of user intent:
 *   - plain text  → token-prefix match ("astar" finds "Astarion") — friendly
 *   - /pattern/   → the plugin-parity regex semantics via regexFromString,
 *                   matched against full titles — the power path
 *
 * @module wikiSearchIndex
 */

import { regexFromString } from './wiki-scraper.js';

/** Size facet buckets over the wiki-reported page length. */
export const SIZE_BUCKETS = [
    { id: 'lt1k', label: '<1 KB', min: 0, max: 1024 },
    { id: '1to5k', label: '1–5 KB', min: 1024, max: 5 * 1024 },
    { id: '5to20k', label: '5–20 KB', min: 5 * 1024, max: 20 * 1024 },
    { id: 'gt20k', label: '>20 KB', min: 20 * 1024, max: Infinity },
];

export function sizeBucketOf(sizeBytes) {
    const size = Number(sizeBytes) || 0;
    for (const bucket of SIZE_BUCKETS) {
        if (size >= bucket.min && size < bucket.max) {
            return bucket.id;
        }
    }
    return SIZE_BUCKETS[0].id;
}

/**
 * Splits on anything that isn't a letter or digit (Unicode-aware), so both
 * MediaWiki "Astarion's Quest" and e621 "lowercase_with_underscores" titles
 * tokenize usefully.
 */
export function tokenize(text) {
    return String(text ?? '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

/** True when the query should take the regex path (wrapped in slashes). */
function isRegexQuery(query) {
    return /^\/.+\/[a-z]*$/i.test(query.trim());
}

/**
 * Creates an empty index. Not a class — the closure keeps the internals
 * unreachable, and the instance is a plain object of methods.
 */
export function createWikiIndex() {
    /** @type {Map<string, {key: string, libraryId: string, title: string, titleLower: string, categories: string[], sizeBucket: string, contentFetched: boolean}>} */
    const docs = new Map();
    /** @type {Map<string, Set<string>>} title token → doc keys */
    const titleTokens = new Map();
    /** @type {Map<string, Set<string>>} plaintext token → doc keys (fetched docs only) */
    const textTokens = new Map();
    /** @type {Map<string, {title: string[], text: string[]}>} per-doc token lists for removal */
    const docTokens = new Map();

    function addTokens(map, tokens, key) {
        for (const token of tokens) {
            let set = map.get(token);
            if (!set) {
                set = new Set();
                map.set(token, set);
            }
            set.add(key);
        }
    }

    function removeTokens(map, tokens, key) {
        for (const token of tokens) {
            const set = map.get(token);
            if (set) {
                set.delete(key);
                if (set.size === 0) {
                    map.delete(token);
                }
            }
        }
    }

    function removeDoc(key) {
        const tokens = docTokens.get(key);
        if (tokens) {
            removeTokens(titleTokens, tokens.title, key);
            removeTokens(textTokens, tokens.text, key);
            docTokens.delete(key);
        }
        docs.delete(key);
    }

    function addDoc(record) {
        const key = record.key;
        if (!key) {
            return;
        }
        if (docs.has(key)) {
            removeDoc(key);
        }
        const titleToks = [...new Set(tokenize(record.title))];
        // Only fetched docs contribute to full-text search; the plaintext
        // string itself is NOT retained
        const textToks = record.contentFetched && record.plaintext
            ? [...new Set(tokenize(record.plaintext))]
            : [];
        docs.set(key, {
            key,
            libraryId: record.libraryId ?? '',
            title: record.title ?? '',
            titleLower: String(record.title ?? '').toLowerCase(),
            categories: Array.isArray(record.categories) ? [...record.categories] : [],
            sizeBucket: sizeBucketOf(record.sizeBytes),
            contentFetched: !!record.contentFetched,
        });
        docTokens.set(key, { title: titleToks, text: textToks });
        addTokens(titleTokens, titleToks, key);
        addTokens(textTokens, textToks, key);
    }

    /** Union of posting sets for tokens starting with `term`. */
    function prefixMatches(map, term) {
        const keys = new Set();
        for (const [token, set] of map) {
            if (token.startsWith(term)) {
                for (const key of set) {
                    keys.add(key);
                }
            }
        }
        return keys;
    }

    /**
     * Resolves the query to a candidate key set, or null for "all docs".
     */
    function queryCandidates(query, mode) {
        const trimmed = String(query ?? '').trim();
        if (!trimmed) {
            return null;
        }
        if (isRegexQuery(trimmed)) {
            const regex = regexFromString(trimmed);
            if (!regex) {
                return new Set();
            }
            const keys = new Set();
            for (const doc of docs.values()) {
                // Same title+'\n' semantics as the scrape-time filter
                if (new RegExp(regex).test(doc.title + '\n')) {
                    keys.add(doc.key);
                }
            }
            return keys;
        }
        const terms = tokenize(trimmed);
        if (terms.length === 0) {
            return new Set();
        }
        const map = mode === 'fulltext' ? textTokens : titleTokens;
        let result = null;
        for (const term of terms) {
            const matches = prefixMatches(map, term);
            if (result === null) {
                result = matches;
            } else {
                for (const key of result) {
                    if (!matches.has(key)) {
                        result.delete(key);
                    }
                }
            }
            if (result.size === 0) {
                break;
            }
        }
        return result;
    }

    /**
     * Applies non-query filters to a doc. `skip` names one facet dimension to
     * ignore — used to compute that facet's counts over the
     * filtered-except-itself set, so chip counts always show reachable results.
     */
    function passesFilters(doc, { categories, sizeBuckets, fetched, libraryIds }, skip) {
        if (skip !== 'libraries' && libraryIds?.length && !libraryIds.includes(doc.libraryId)) {
            return false;
        }
        if (skip !== 'categories' && categories?.length
            && !categories.some(c => doc.categories.includes(c))) {
            return false;
        }
        if (skip !== 'sizeBuckets' && sizeBuckets?.length && !sizeBuckets.includes(doc.sizeBucket)) {
            return false;
        }
        if (skip !== 'fetched' && fetched !== undefined && fetched !== null
            && doc.contentFetched !== fetched) {
            return false;
        }
        return true;
    }

    return {
        /** @param {Array<object>} records - Wiki Library page records */
        addDocs(records) {
            for (const record of records ?? []) {
                addDoc(record);
            }
        },

        /** Re-indexes one record (content fetched, metadata refreshed). */
        updateDoc(record) {
            addDoc(record);
        },

        /** Drops every doc belonging to a deleted library. */
        removeLibrary(libraryId) {
            for (const key of [...docs.keys()]) {
                if (docs.get(key).libraryId === libraryId) {
                    removeDoc(key);
                }
            }
        },

        /** Number of indexed docs. */
        get size() {
            return docs.size;
        },

        /**
         * @param {object} [options]
         * @param {string} [options.query] - Plain text (token-prefix) or /regex/
         * @param {('title'|'fulltext')} [options.mode]
         * @param {string[]} [options.categories] - ANY-of filter
         * @param {string[]} [options.sizeBuckets] - ANY-of filter (bucket ids)
         * @param {boolean} [options.fetched] - true/false to filter, omit for all
         * @param {string[]} [options.libraryIds] - ANY-of filter
         * @param {number} [options.limit]
         * @param {number} [options.offset]
         * @returns {{keys: string[], total: number, facets: {categories: Object<string, number>, sizeBuckets: Object<string, number>, fetched: {fetched: number, unfetched: number}, libraries: Object<string, number>}}}
         */
        search({ query = '', mode = 'title', categories, sizeBuckets, fetched, libraryIds, limit, offset = 0 } = {}) {
            const filters = { categories, sizeBuckets, fetched, libraryIds };
            const candidates = queryCandidates(query, mode);
            const pool = [];
            for (const doc of docs.values()) {
                if (candidates !== null && !candidates.has(doc.key)) {
                    continue;
                }
                pool.push(doc);
            }

            const matched = [];
            const facets = {
                categories: {},
                sizeBuckets: {},
                fetched: { fetched: 0, unfetched: 0 },
                libraries: {},
            };
            for (const doc of pool) {
                if (passesFilters(doc, filters, 'categories')) {
                    for (const category of doc.categories) {
                        facets.categories[category] = (facets.categories[category] ?? 0) + 1;
                    }
                }
                if (passesFilters(doc, filters, 'sizeBuckets')) {
                    facets.sizeBuckets[doc.sizeBucket] = (facets.sizeBuckets[doc.sizeBucket] ?? 0) + 1;
                }
                if (passesFilters(doc, filters, 'fetched')) {
                    facets.fetched[doc.contentFetched ? 'fetched' : 'unfetched']++;
                }
                if (passesFilters(doc, filters, 'libraries')) {
                    facets.libraries[doc.libraryId] = (facets.libraries[doc.libraryId] ?? 0) + 1;
                }
                if (passesFilters(doc, filters, null)) {
                    matched.push(doc);
                }
            }

            matched.sort((a, b) => a.titleLower.localeCompare(b.titleLower) || a.key.localeCompare(b.key));
            const total = matched.length;
            const sliced = limit === undefined
                ? matched.slice(offset)
                : matched.slice(offset, offset + limit);
            return { keys: sliced.map(d => d.key), total, facets };
        },
    };
}
