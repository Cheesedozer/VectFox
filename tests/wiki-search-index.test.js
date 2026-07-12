/**
 * Unit tests for core/wiki-search-index.js
 *
 * The in-memory index behind the Wiki Library browser. The behaviors that
 * matter: token-prefix search must treat e621 underscore titles and MediaWiki
 * space titles identically; /regex/ queries must reuse the plugin-parity
 * semantics of the scrape-time filter; facet counts must be computed over the
 * filtered-except-that-facet set so chips always show reachable results; and
 * incremental updateDoc must flip a doc into full-text scope when its content
 * arrives mid-scrape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// core/wiki-scraper.js (regexFromString) pulls in core/log.js
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
}));

import { createWikiIndex, tokenize, sizeBucketOf, SIZE_BUCKETS } from '../core/wiki-search-index.js';

const LIB_A = 'fandom:bg3';
const LIB_B = 'e621:e621.net';

function doc(key, title, extra = {}) {
    const [libraryId] = key.split('::');
    return {
        key,
        libraryId,
        title,
        categories: [],
        sizeBytes: 500,
        contentFetched: false,
        plaintext: '',
        ...extra,
    };
}

function seed(index) {
    index.addDocs([
        doc(`${LIB_A}::Astarion`, 'Astarion', { categories: ['Characters', 'Companions'], sizeBytes: 8 * 1024 }),
        doc(`${LIB_A}::Astral Plane`, 'Astral Plane', { categories: ['Locations'], sizeBytes: 2 * 1024 }),
        doc(`${LIB_A}::Gale`, 'Gale', {
            categories: ['Characters', 'Companions'],
            sizeBytes: 30 * 1024,
            contentFetched: true,
            plaintext: 'Gale is a wizard of Waterdeep.',
        }),
        doc(`${LIB_B}::himbofication`, 'himbofication', { categories: ['lore'], sizeBytes: 512, contentFetched: true, plaintext: 'The male equivalent of bimbofication.' }),
        doc(`${LIB_B}::brown_fur`, 'brown_fur', { categories: ['general'], sizeBytes: 100 }),
    ]);
    return index;
}

let index;
beforeEach(() => {
    index = seed(createWikiIndex());
});

describe('tokenize', () => {
    it('splits underscores, spaces, and punctuation alike', () => {
        expect(tokenize('brown_fur')).toEqual(['brown', 'fur']);
        expect(tokenize("Astarion's Quest")).toEqual(['astarion', 's', 'quest']);
    });

    it('keeps Unicode letters and digits', () => {
        expect(tokenize('Fée Éternelle 2')).toEqual(['fée', 'éternelle', '2']);
    });
});

describe('sizeBucketOf', () => {
    it('maps sizes to the four buckets', () => {
        expect(sizeBucketOf(0)).toBe('lt1k');
        expect(sizeBucketOf(1024)).toBe('1to5k');
        expect(sizeBucketOf(6 * 1024)).toBe('5to20k');
        expect(sizeBucketOf(100 * 1024)).toBe('gt20k');
        expect(SIZE_BUCKETS.map(b => b.id)).toEqual(['lt1k', '1to5k', '5to20k', 'gt20k']);
    });
});

describe('title search', () => {
    it('matches by token prefix, case-insensitive', () => {
        const { keys } = index.search({ query: 'astar' });
        expect(keys).toEqual([`${LIB_A}::Astarion`]);
    });

    it('matches underscore-separated e621 tokens', () => {
        const { keys } = index.search({ query: 'fur' });
        expect(keys).toEqual([`${LIB_B}::brown_fur`]);
    });

    it('ANDs multiple terms', () => {
        expect(index.search({ query: 'astral plane' }).keys).toEqual([`${LIB_A}::Astral Plane`]);
        expect(index.search({ query: 'astral gale' }).keys).toEqual([]);
    });

    it('empty query returns everything, title-sorted', () => {
        const { keys, total } = index.search({});
        expect(total).toBe(5);
        expect(keys[0]).toBe(`${LIB_A}::Astarion`);
    });

    it('routes /…/ queries through plugin regex semantics against full titles', () => {
        // Unanchored substring like the scrape filter: matches 'himbofication'
        expect(index.search({ query: '/bimbo|himbo/' }).keys).toEqual([`${LIB_B}::himbofication`]);
        // Case-insensitive flag works
        expect(index.search({ query: '/astarion/i' }).keys).toEqual([`${LIB_A}::Astarion`]);
        // The title+newline quirk is preserved: $ anchors fail
        expect(index.search({ query: '/Gale$/' }).keys).toEqual([]);
    });
});

describe('full-text search', () => {
    it('searches only fetched docs', () => {
        expect(index.search({ query: 'wizard', mode: 'fulltext' }).keys).toEqual([`${LIB_A}::Gale`]);
        // 'brown' appears in an UNFETCHED doc's title only — not in full-text scope
        expect(index.search({ query: 'brown', mode: 'fulltext' }).keys).toEqual([]);
    });

    it('updateDoc flips a doc into full-text scope when content arrives', () => {
        expect(index.search({ query: 'plane of silver', mode: 'fulltext' }).keys).toEqual([]);
        index.updateDoc(doc(`${LIB_A}::Astral Plane`, 'Astral Plane', {
            categories: ['Locations'],
            sizeBytes: 2 * 1024,
            contentFetched: true,
            plaintext: 'A plane of silver mists.',
        }));
        expect(index.search({ query: 'silver mists', mode: 'fulltext' }).keys).toEqual([`${LIB_A}::Astral Plane`]);
        // No duplicate doc was created
        expect(index.size).toBe(5);
        expect(index.search({ query: 'astral' }).keys).toEqual([`${LIB_A}::Astral Plane`]);
    });
});

describe('filters', () => {
    it('filters by library', () => {
        const { keys } = index.search({ libraryIds: [LIB_B] });
        expect(keys).toEqual([`${LIB_B}::brown_fur`, `${LIB_B}::himbofication`]);
    });

    it('filters by category (ANY-of)', () => {
        expect(index.search({ categories: ['Locations'] }).keys).toEqual([`${LIB_A}::Astral Plane`]);
        expect(index.search({ categories: ['Locations', 'lore'] }).total).toBe(2);
    });

    it('filters by size bucket and fetched status', () => {
        expect(index.search({ sizeBuckets: ['gt20k'] }).keys).toEqual([`${LIB_A}::Gale`]);
        expect(index.search({ fetched: true }).total).toBe(2);
        expect(index.search({ fetched: false }).total).toBe(3);
    });

    it('combines query and filters', () => {
        const { keys } = index.search({ query: 'a', categories: ['Characters'] });
        expect(keys).toEqual([`${LIB_A}::Astarion`]);
    });

    it('paginates with limit/offset and reports the unsliced total', () => {
        const page1 = index.search({ limit: 2 });
        const page2 = index.search({ limit: 2, offset: 2 });
        expect(page1.total).toBe(5);
        expect(page1.keys).toHaveLength(2);
        expect(page2.keys).toHaveLength(2);
        expect(page1.keys[0]).not.toBe(page2.keys[0]);
    });
});

describe('facet counts', () => {
    it('counts each facet over the filtered-except-that-facet set', () => {
        const { facets } = index.search({ categories: ['Locations'] });
        // Category counts ignore the category filter itself (all docs count)
        expect(facets.categories).toEqual({
            Characters: 2, Companions: 2, Locations: 1, lore: 1, general: 1,
        });
        // Other facets ARE narrowed by the category filter
        expect(facets.sizeBuckets).toEqual({ '1to5k': 1 });
        expect(facets.fetched).toEqual({ fetched: 0, unfetched: 1 });
        expect(facets.libraries).toEqual({ [LIB_A]: 1 });
    });

    it('narrows facet counts by the query', () => {
        const { facets } = index.search({ query: 'astar' });
        expect(facets.categories).toEqual({ Characters: 1, Companions: 1 });
    });
});

describe('removeLibrary', () => {
    it('drops all docs and postings of the library', () => {
        index.removeLibrary(LIB_B);
        expect(index.size).toBe(3);
        expect(index.search({ query: 'fur' }).keys).toEqual([]);
        expect(index.search({ query: 'bimbofication', mode: 'fulltext' }).keys).toEqual([]);
        // Other library untouched
        expect(index.search({ query: 'astar' }).keys).toEqual([`${LIB_A}::Astarion`]);
    });
});
