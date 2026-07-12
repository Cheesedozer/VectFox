/**
 * Unit tests for core/wiki-scraper.js
 *
 * The built-in browser wiki scraper must (a) speak the MediaWiki Action API
 * correctly (pagination, batching, rate limits) and (b) reproduce the
 * SillyTavern-Fandom-Scraper plugin's output exactly, including its quirks
 * (regexFromString invalid-flag fallback, title+'\n' filter matching,
 * first-occurrence-only string replaces). Mocks fetch — same convention as
 * reformat-extractor.test.js.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// core/log.js reads extension_settings for verbosity/domain gating
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
}));

import {
    scrapeWiki,
    scrapeE621,
    resolveE621Base,
    dtextToPlaintext,
    discoverApiEndpoint,
    buildApiCandidates,
    regexFromString,
    getFandomId,
    wikiToText,
    shouldFallbackToPlugin,
    WikiScrapeError,
    WIKI_SCRAPER_TIMINGS,
    enumeratePagesWithMetadata,
    fetchPageContents,
    enumerateE621Pages,
    searchE621ByTitle,
    E621_CATEGORY_NAMES,
} from '../core/wiki-scraper.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body, { status = 200, headers = {} } = {}) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => lower[name.toLowerCase()] ?? null },
        json: async () => body,
    };
}

const SITEINFO = { query: { general: { sitename: 'Test Wiki' } } };

/**
 * Fetch mock speaking enough of the MediaWiki Action API for the scraper:
 * siteinfo probe, allpages enumeration (with continuation), revisions content.
 *
 * @param {string[][]} titlePages - allpages results, one array per continuation page
 * @param {Function} contentFor - title -> wikitext (return undefined to mark missing)
 */
function installApiMock(titlePages, contentFor = title => `Content of ${title}.`) {
    const fetchMock = vi.fn(async (url) => {
        const params = new URL(url).searchParams;

        if (params.get('meta') === 'siteinfo') {
            return jsonResponse(SITEINFO);
        }

        if (params.get('list') === 'allpages') {
            const index = params.get('apcontinue') ? Number(params.get('apcontinue')) : 0;
            const body = {
                query: { allpages: titlePages[index].map((title, i) => ({ pageid: index * 1000 + i, ns: 0, title })) },
            };
            if (index + 1 < titlePages.length) {
                body.continue = { apcontinue: String(index + 1), continue: '-||' };
            }
            return jsonResponse(body);
        }

        if (params.get('prop') === 'revisions') {
            const titles = params.get('titles').split('|');
            const pages = {};
            titles.forEach((title, i) => {
                const wikitext = contentFor(title);
                pages[wikitext === undefined ? `-${i + 1}` : String(i + 1)] = wikitext === undefined
                    ? { ns: 0, title, missing: '' }
                    : { pageid: i + 1, ns: 0, title, revisions: [{ slots: { main: { contentmodel: 'wikitext', '*': wikitext } } }] };
            });
            return jsonResponse({ query: { pages } });
        }

        throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

beforeEach(() => {
    vi.restoreAllMocks();
    // Zero out politeness delays so tests run instantly; short discovery timeout
    Object.assign(WIKI_SCRAPER_TIMINGS, {
        enumDelayMs: 0,
        batchDelayMs: 0,
        rateLimitDefaultMs: 0,
        rateLimitMaxDelayMs: 0,
        discoverTimeoutMs: 1000,
        e621DelayMs: 0,
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Ported plugin helpers — parity with SillyTavern-Fandom-Scraper
// ---------------------------------------------------------------------------

describe('regexFromString', () => {
    it('parses a bare pattern with no flags', () => {
        const re = regexFromString('Astarion|Gale');
        expect(re).toBeInstanceOf(RegExp);
        expect(re.source).toBe('Astarion|Gale');
        expect(re.flags).toBe('');
    });

    it('parses /pattern/flags form', () => {
        const re = regexFromString('/gale/i');
        expect(re.source).toBe('gale');
        expect(re.flags).toBe('i');
        expect(re.test('Gale')).toBe(true);
    });

    it('falls back to RegExp(fullInput, "i") on invalid flags (plugin quirk)', () => {
        const re = regexFromString('/foo/zz');
        expect(re).toBeInstanceOf(RegExp);
        expect(re.flags).toBe('i');
        // The full input, slashes included, becomes the pattern
        expect(re.test('/foo/zz')).toBe(true);
    });

    it('returns undefined on unparseable input', () => {
        expect(regexFromString('')).toBeUndefined();
        expect(regexFromString('(')).toBeUndefined();
        expect(regexFromString(undefined)).toBeUndefined();
    });
});

describe('getFandomId', () => {
    it('extracts the subdomain from a full URL', () => {
        expect(getFandomId('https://fallout.fandom.com/wiki/Fallout')).toBe('fallout');
    });

    it('passes a bare id through, trimmed', () => {
        expect(getFandomId('  fallout  ')).toBe('fallout');
    });
});

describe('buildApiCandidates', () => {
    it('builds the fandom endpoint from a bare id, full URL, or schemeless host', () => {
        const expected = ['https://fallout.fandom.com/api.php'];
        expect(buildApiCandidates('fandom', 'fallout')).toEqual(expected);
        expect(buildApiCandidates('fandom', 'https://fallout.fandom.com/wiki/Fallout')).toEqual(expected);
        expect(buildApiCandidates('fandom', 'fallout.fandom.com')).toEqual(expected);
    });

    it('tries /api.php then /w/api.php for a bare mediawiki origin', () => {
        expect(buildApiCandidates('mediawiki', 'https://example.com')).toEqual([
            'https://example.com/api.php',
            'https://example.com/w/api.php',
        ]);
    });

    it('strips article paths and prepends https:// when missing', () => {
        expect(buildApiCandidates('mediawiki', 'example.com/wiki/Main_Page')).toEqual([
            'https://example.com/api.php',
            'https://example.com/w/api.php',
        ]);
    });

    it('prefers a script-path prefix from the URL, deduplicated', () => {
        expect(buildApiCandidates('mediawiki', 'https://example.com/w/index.php')).toEqual([
            'https://example.com/w/index.php/api.php',
            'https://example.com/api.php',
            'https://example.com/w/api.php',
        ]);
        expect(buildApiCandidates('mediawiki', 'https://example.com/w/')).toEqual([
            'https://example.com/w/api.php',
            'https://example.com/api.php',
        ]);
    });

    it('uses a pasted api.php URL as the first candidate', () => {
        expect(buildApiCandidates('mediawiki', 'https://example.com/w/api.php')[0])
            .toBe('https://example.com/w/api.php');
    });

    it('throws an api-coded error on empty or invalid input', () => {
        expect(() => buildApiCandidates('mediawiki', '  ')).toThrowError(WikiScrapeError);
        try {
            buildApiCandidates('mediawiki', '');
        } catch (e) {
            expect(e.code).toBe('api');
        }
    });
});

describe('wikiToText', () => {
    it('converts links, bold, headers, and templates like the plugin', () => {
        const text = wikiToText("'''Bold''' [[Page|alt text]] [[Plain Link]] {{Infobox|key=value}} == Header ==");
        expect(text).not.toContain("'''");
        expect(text).toContain('alt text');
        expect(text).toContain('Plain Link');
        expect(text).not.toContain('{{');
        expect(text).not.toContain('==');
    });

    it('removes Category: lines', () => {
        const text = wikiToText('Real content\nCategory:Characters\nMore content');
        expect(text).toContain('Real content');
        expect(text).toContain('More content');
        expect(text).not.toContain('Category:');
    });

    it('decodes double-encoded entities via the second decode pass', () => {
        // &amp;#39; -> first decode -> &#39; -> second decode -> '
        expect(wikiToText('It&amp;#39;s here')).toBe("It's here");
    });

    it('strips residual HTML tags', () => {
        expect(wikiToText('before <span class="x">inside</span> after')).toBe('before inside after');
    });

    it('keeps the first-occurrence-only replaces first-occurrence-only (plugin parity)', () => {
        // Two empty bracket pairs: the plugin only removes the first one
        expect(wikiToText('a () b () c')).toBe('a  b () c');
    });
});

describe('shouldFallbackToPlugin', () => {
    it('is true only for network and api errors', () => {
        expect(shouldFallbackToPlugin(new WikiScrapeError('network', 'x'))).toBe(true);
        expect(shouldFallbackToPlugin(new WikiScrapeError('api', 'x'))).toBe(true);
        expect(shouldFallbackToPlugin(new WikiScrapeError('rate-limited', 'x'))).toBe(false);
        expect(shouldFallbackToPlugin(new WikiScrapeError('not-found', 'x'))).toBe(false);
        expect(shouldFallbackToPlugin(new WikiScrapeError('aborted', 'x'))).toBe(false);
        expect(shouldFallbackToPlugin(new Error('generic'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Endpoint discovery
// ---------------------------------------------------------------------------

describe('discoverApiEndpoint', () => {
    it('falls through candidates in order and returns the first valid API', async () => {
        const fetchMock = vi.fn(async (url) => {
            if (url.startsWith('https://example.com/api.php')) {
                return jsonResponse('Not found', { status: 404 });
            }
            return jsonResponse(SITEINFO);
        });
        vi.stubGlobal('fetch', fetchMock);

        const apiUrl = await discoverApiEndpoint('mediawiki', 'https://example.com');
        expect(apiUrl).toBe('https://example.com/w/api.php');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('classifies as network when every candidate fetch throws (CORS/DNS)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        await expect(discoverApiEndpoint('mediawiki', 'https://example.com'))
            .rejects.toMatchObject({ code: 'network' });
    });

    it('classifies as api when the host responds but no candidate is a MediaWiki API', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('nope', { status: 404 })));
        await expect(discoverApiEndpoint('mediawiki', 'https://example.com'))
            .rejects.toMatchObject({ code: 'api' });
    });

    it('throws aborted when the signal is already aborted', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(SITEINFO)));
        const controller = new AbortController();
        controller.abort();
        await expect(discoverApiEndpoint('fandom', 'fallout', { signal: controller.signal }))
            .rejects.toMatchObject({ code: 'aborted' });
    });
});

// ---------------------------------------------------------------------------
// Full scrape orchestration
// ---------------------------------------------------------------------------

describe('scrapeWiki', () => {
    it('paginates allpages with apcontinue and requests non-redirect main-namespace pages', async () => {
        const fetchMock = installApiMock([['Alpha', 'Beta'], ['Gamma']]);

        const pages = await scrapeWiki({ wikiType: 'fandom', url: 'testwiki' });

        expect(pages.map(p => p.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
        expect(pages[0].content).toBe('Content of Alpha.');

        const allpagesCalls = fetchMock.mock.calls.map(c => c[0]).filter(u => u.includes('list=allpages'));
        expect(allpagesCalls).toHaveLength(2);
        expect(allpagesCalls[0]).toContain('apfilterredir=nonredirects');
        expect(allpagesCalls[0]).toContain('apnamespace=0');
        expect(allpagesCalls[0]).toContain('origin=*');
        expect(allpagesCalls[1]).toContain('apcontinue=1');
    });

    it('applies the title filter with plugin semantics (matched against title + newline)', async () => {
        installApiMock([['Alpha', 'Beta', 'Alphabet']]);

        const pages = await scrapeWiki({ wikiType: 'fandom', url: 'testwiki', filter: 'Alpha' });
        expect(pages.map(p => p.title)).toEqual(['Alpha', 'Alphabet']);

        // Plugin quirk: '$' anchors fail against exact titles because a
        // newline is appended before matching — preserved for parity.
        await expect(scrapeWiki({ wikiType: 'fandom', url: 'testwiki', filter: 'Alpha$' }))
            .rejects.toMatchObject({ code: 'not-found' });
    });

    it('fetches content in batches of 50 titles joined with %7C', async () => {
        const titles = Array.from({ length: 120 }, (_, i) => `Page ${i + 1}`);
        const fetchMock = installApiMock([titles]);
        const progress = [];

        const pages = await scrapeWiki({
            wikiType: 'fandom',
            url: 'testwiki',
            onProgress: e => { if (e.phase === 'content') progress.push(e.done); },
        });

        expect(pages).toHaveLength(120);
        const revisionCalls = fetchMock.mock.calls.map(c => c[0]).filter(u => u.includes('prop=revisions'));
        expect(revisionCalls).toHaveLength(3);
        const firstBatchTitles = new URL(revisionCalls[0]).searchParams.get('titles').split('|');
        expect(firstBatchTitles).toHaveLength(50);
        expect(revisionCalls[0]).toContain('%7C');
        expect(progress).toEqual([50, 100, 120]);
    });

    it('skips missing pages and pages that convert to empty content', async () => {
        installApiMock([['Kept', 'Missing', 'Empty']], (title) => {
            if (title === 'Missing') return undefined;
            if (title === 'Empty') return '{{OnlyATemplate}}';
            return `Content of ${title}.`;
        });

        const pages = await scrapeWiki({ wikiType: 'fandom', url: 'testwiki' });
        expect(pages.map(p => p.title)).toEqual(['Kept']);
    });

    it('follows the normalized-title mapping in revision responses', async () => {
        const fetchMock = vi.fn(async (url) => {
            const params = new URL(url).searchParams;
            if (params.get('meta') === 'siteinfo') return jsonResponse(SITEINFO);
            if (params.get('list') === 'allpages') {
                return jsonResponse({ query: { allpages: [{ pageid: 1, ns: 0, title: 'foo bar' }] } });
            }
            return jsonResponse({
                query: {
                    normalized: [{ from: 'foo bar', to: 'Foo bar' }],
                    pages: { 1: { pageid: 1, ns: 0, title: 'Foo bar', revisions: [{ slots: { main: { '*': 'Normalized content.' } } }] } },
                },
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        const pages = await scrapeWiki({ wikiType: 'fandom', url: 'testwiki' });
        expect(pages).toEqual([{ title: 'Foo bar', content: 'Normalized content.' }]);
    });

    it('retries after a 429 honoring Retry-After, then succeeds', async () => {
        let rateLimitedOnce = false;
        const fetchMock = vi.fn(async (url) => {
            const params = new URL(url).searchParams;
            if (params.get('meta') === 'siteinfo') return jsonResponse(SITEINFO);
            if (params.get('list') === 'allpages') {
                if (!rateLimitedOnce) {
                    rateLimitedOnce = true;
                    return jsonResponse('slow down', { status: 429, headers: { 'Retry-After': '0' } });
                }
                return jsonResponse({ query: { allpages: [{ pageid: 1, ns: 0, title: 'Alpha' }] } });
            }
            return jsonResponse({
                query: { pages: { 1: { pageid: 1, ns: 0, title: 'Alpha', revisions: [{ slots: { main: { '*': 'Alpha content.' } } }] } } },
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        const pages = await scrapeWiki({ wikiType: 'fandom', url: 'testwiki' });
        expect(pages).toHaveLength(1);
        const allpagesCalls = fetchMock.mock.calls.map(c => c[0]).filter(u => u.includes('list=allpages'));
        expect(allpagesCalls).toHaveLength(2);
    });

    it('gives up with rate-limited after persistent 429s (no plugin fallback)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('slow down', { status: 429, headers: { 'Retry-After': '0' } })));

        let caught;
        try {
            await scrapeWiki({ wikiType: 'fandom', url: 'testwiki' });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(WikiScrapeError);
        expect(caught.code).toBe('rate-limited');
        expect(shouldFallbackToPlugin(caught)).toBe(false);
    });

    it('reports not-found when the wiki has no pages', async () => {
        installApiMock([[]]);
        await expect(scrapeWiki({ wikiType: 'fandom', url: 'testwiki' }))
            .rejects.toMatchObject({ code: 'not-found' });
    });

    it('maps unexpected network failures to fallback-eligible network errors', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

        let caught;
        try {
            await scrapeWiki({ wikiType: 'fandom', url: 'testwiki' });
        } catch (e) {
            caught = e;
        }
        expect(caught.code).toBe('network');
        expect(shouldFallbackToPlugin(caught)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// e621 adapter
// ---------------------------------------------------------------------------

describe('resolveE621Base', () => {
    it('defaults empty input to e621.net', () => {
        expect(resolveE621Base('')).toBe('https://e621.net');
        expect(resolveE621Base('   ')).toBe('https://e621.net');
        expect(resolveE621Base(undefined)).toBe('https://e621.net');
    });

    it('accepts bare hosts, full URLs, and the e926 mirror (normalizing to https)', () => {
        expect(resolveE621Base('e621.net')).toBe('https://e621.net');
        expect(resolveE621Base('http://e621.net/wiki_pages?title=x')).toBe('https://e621.net');
        expect(resolveE621Base('https://www.e926.net/')).toBe('https://e926.net');
    });

    it('rejects non-e621 hosts with an api-coded error', () => {
        expect(() => resolveE621Base('https://danbooru.donmai.us'))
            .toThrowError(expect.objectContaining({ code: 'api' }));
    });
});

describe('dtextToPlaintext', () => {
    it.each([
        ['wiki link', 'see [[feminization]] for more', 'see feminization for more'],
        ['piped wiki link', 'look [[skimpy|skimpily]] dressed', 'look skimpily dressed'],
        ['tag search link', 'try {{bimbofication footwear|these posts}}', 'try these posts'],
        ['bare tag search', 'try {{bimbofication}}', 'try bimbofication'],
        ['external quoted link', 'from "the guide":https://e621.net/help/tags today', 'from the guide today'],
        ['bracketed quoted link', 'from "the guide":[https://e621.net/help/tags] today', 'from the guide today'],
        ['inline formatting', '[b]Note:[/b] [i]hyperfeminine[/i] and [u]hypersexual[/u]', 'Note: hyperfeminine and hypersexual'],
        ['color tags', '[color=pink]bright[/color] hues', 'bright hues'],
        ['thumb removed, post kept', 'thumb #1802283 relates to post #12345', 'relates to post #12345'],
    ])('converts %s', (_label, input, expected) => {
        expect(dtextToPlaintext(input)).toBe(expected);
    });

    it('converts h-headers (including anchored) to markdown headers', () => {
        const input = 'h2.Related tags\nSome text.\nh4#seealso. See also\nMore text.';
        expect(dtextToPlaintext(input)).toBe('## Related tags\nSome text.\n#### See also\nMore text.');
    });

    it('strips quote/code/section blocks keeping inner text and section titles', () => {
        const input = '[quote]Someone said this.[/quote]\n[section,expanded=History]The tag dates to 2012.[/section]\n[code]raw[/code]';
        const out = dtextToPlaintext(input);
        expect(out).toContain('Someone said this.');
        expect(out).toContain('History');
        expect(out).toContain('The tag dates to 2012.');
        expect(out).toContain('raw');
        expect(out).not.toMatch(/\[\/?(?:quote|section|code)/i);
    });

    it('collapses runs of 3+ newlines left by removed markup', () => {
        expect(dtextToPlaintext('thumb #1 thumb #2\n\n\n\nActual text.')).toBe('Actual text.');
    });
});

describe('scrapeE621', () => {
    /**
     * Fetch mock speaking /wiki_pages.json with Danbooru b<id> cursor
     * pagination. `batches` is an array of item arrays: the first serves the
     * cursorless request, each next serves the following cursor request.
     */
    function installE621Mock(batches, { emptyShape = [] } = {}) {
        let call = 0;
        const fetchMock = vi.fn(async (url) => {
            const parsed = new URL(url);
            expect(parsed.pathname).toBe('/wiki_pages.json');
            expect(parsed.searchParams.get('limit')).toBe('320');
            const batch = batches[call] ?? emptyShape;
            call++;
            return jsonResponse(batch);
        });
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }

    function page(id, title, body, extra = {}) {
        return { id, title, body, is_deleted: false, ...extra };
    }

    it('fetches pages, converts DText, and returns {title, content}', async () => {
        installE621Mock([[
            page(100, 'himbofication', 'The male equivalent of [[bimbofication]].'),
            page(99, 'brown_fur', 'thumb #123 Fur that is [i]brown[/i].'),
        ]]);

        const pages = await scrapeE621({ url: '' });
        expect(pages).toEqual([
            { title: 'himbofication', content: 'The male equivalent of bimbofication.' },
            { title: 'brown_fur', content: 'Fur that is brown.' },
        ]);
    });

    it('paginates with b<lowest-id> cursors and stops on a short batch', async () => {
        const batch1 = Array.from({ length: 320 }, (_, i) => page(1000 - i, `tag_${1000 - i}`, `Body ${i}.`));
        const batch2 = [page(500, 'tag_500', 'Last body.')];
        const fetchMock = installE621Mock([batch1, batch2]);

        const pages = await scrapeE621({ url: '' });
        expect(pages).toHaveLength(321);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        const firstUrl = new URL(fetchMock.mock.calls[0][0]);
        const secondUrl = new URL(fetchMock.mock.calls[1][0]);
        // Even the first request must be in b-cursor mode: a cursorless request
        // uses the site's default (recently-updated) ordering, which silently
        // breaks id-based pagination.
        expect(firstUrl.searchParams.get('page')).toBe('b2147483647');
        expect(secondUrl.searchParams.get('page')).toBe('b681'); // lowest id of batch 1
    });

    it('handles the {"wiki_pages": []} empty-result shape', async () => {
        const full = Array.from({ length: 320 }, (_, i) => page(400 - i, `tag_${400 - i}`, 'Body.'));
        let call = 0;
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(call++ === 0 ? full : { wiki_pages: [] })));

        const pages = await scrapeE621({ url: '' });
        expect(pages).toHaveLength(320);
    });

    it('skips deleted and empty-bodied pages', async () => {
        installE621Mock([[
            page(10, 'kept', 'Real content.'),
            page(9, 'deleted_page', 'Content.', { is_deleted: true }),
            page(8, 'empty_page', '   '),
            page(7, '', 'No title.'),
        ]]);

        const pages = await scrapeE621({ url: '' });
        expect(pages).toEqual([{ title: 'kept', content: 'Real content.' }]);
    });

    it('applies the regex title filter with the shared title+newline semantics', async () => {
        installE621Mock([[
            page(3, 'bimbofication', 'A.'),
            page(2, 'himbofication', 'B.'),
            page(1, 'brown_fur', 'C.'),
        ]]);

        const pages = await scrapeE621({ url: '', filter: 'bimbo|himbo' });
        expect(pages.map(p => p.title)).toEqual(['bimbofication', 'himbofication']);
    });

    it('reports titles-phase progress with the accepted page count', async () => {
        installE621Mock([[page(1, 'only_tag', 'Body.')]]);
        const progress = [];
        await scrapeE621({ url: '', onProgress: p => progress.push(p) });
        expect(progress).toEqual([{ phase: 'titles', done: 1, total: null }]);
    });

    it('honors 429 rate limiting via the shared retry helper', async () => {
        let call = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            if (call++ === 0) {
                return jsonResponse('slow down', { status: 429, headers: { 'Retry-After': '0' } });
            }
            return jsonResponse([page(1, 'recovered', 'Body.')]);
        }));

        const pages = await scrapeE621({ url: '' });
        expect(pages).toEqual([{ title: 'recovered', content: 'Body.' }]);
    });

    it('throws not-found when nothing matches the filter', async () => {
        installE621Mock([[page(1, 'brown_fur', 'Body.')]]);
        await expect(scrapeE621({ url: '', filter: 'nonexistent_tag' }))
            .rejects.toMatchObject({ code: 'not-found' });
    });

    it('aborts via the caller signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(scrapeE621({ url: '', signal: controller.signal }))
            .rejects.toMatchObject({ code: 'aborted' });
    });

    it('is routed through scrapeWiki via wikiType e621 (no MediaWiki discovery, no plugin fallback)', async () => {
        const fetchMock = installE621Mock([[page(1, 'himbofication', 'The male equivalent of [[bimbofication]].')]]);

        const pages = await scrapeWiki({ wikiType: 'e621', url: '' });
        expect(pages).toEqual([{ title: 'himbofication', content: 'The male equivalent of bimbofication.' }]);
        // no siteinfo/allpages probing happened — straight to wiki_pages.json
        expect(fetchMock.mock.calls.every(c => c[0].includes('/wiki_pages.json'))).toBe(true);
    });

    it('rejects non-e621 hosts without plugin fallback eligibility', async () => {
        let caught;
        try {
            await scrapeWiki({ wikiType: 'e621', url: 'https://danbooru.donmai.us' });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(WikiScrapeError);
        expect(caught.code).toBe('api');
    });
});

// ---------------------------------------------------------------------------
// Wiki Library primitives
// ---------------------------------------------------------------------------

describe('enumeratePagesWithMetadata', () => {
    const API = 'https://testwiki.fandom.com/api.php';

    function gpage(pageid, title, { categories, length = 100, touched = '2024-01-01T00:00:00Z' } = {}) {
        const page = { pageid, ns: 0, title, length, touched, fullurl: `https://x/wiki/${title}` };
        if (categories) {
            page.categories = categories.map(c => ({ ns: 14, title: `Category:${c}` }));
        }
        return page;
    }

    /**
     * Generator-mode API mock with an interleaved continuation schedule:
     * window 1 needs a clcontinue round before its categories are complete,
     * then gapcontinue advances to window 2, which finishes enumeration.
     */
    function installGeneratorMock() {
        const fetchMock = vi.fn(async (url) => {
            const params = new URL(url).searchParams;
            expect(params.get('generator')).toBe('allpages');
            expect(params.get('prop')).toBe('categories|info');

            if (params.get('clcontinue')) {
                // Second round of window 1: same pages, Beta's categories arrive
                return jsonResponse({
                    continue: { gapcontinue: 'Gamma', continue: 'gapcontinue||' },
                    query: { pages: {
                        1: gpage(1, 'Alpha'),
                        2: gpage(2, 'Beta', { categories: ['Locations'] }),
                    } },
                });
            }
            if (params.get('gapcontinue') === 'Gamma') {
                // Window 2: final window, no further continuation
                return jsonResponse({
                    query: { pages: { 3: gpage(3, 'Gamma', { categories: ['Characters'], length: 55 }) } },
                });
            }
            // First request of window 1: Alpha's categories, Beta's pending
            return jsonResponse({
                continue: { clcontinue: '2|Locations', continue: '||' },
                query: { pages: {
                    1: gpage(1, 'Alpha', { categories: ['Characters', 'Companions'] }),
                    2: gpage(2, 'Beta'),
                } },
            });
        });
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }

    it('merges interleaved clcontinue rounds and flushes each window exactly once', async () => {
        installGeneratorMock();
        const batches = [];

        const result = await enumeratePagesWithMetadata(API, {
            onBatch: (records, checkpoint) => { batches.push({ records, checkpoint }); },
        });

        expect(result).toEqual({ count: 3, continue: null, stopped: false });
        expect(batches).toHaveLength(2);

        // Window 1: both pages, categories merged across rounds, no duplicates
        const titles1 = batches[0].records.map(r => r.title);
        expect(titles1).toEqual(['Alpha', 'Beta']);
        expect(batches[0].records[0].categories).toEqual(['Characters', 'Companions']);
        expect(batches[0].records[1].categories).toEqual(['Locations']);
        expect(batches[0].checkpoint).toEqual({
            continue: { gapcontinue: 'Gamma', continue: 'gapcontinue||' },
            complete: false,
        });

        // Window 2: final flush signals completion
        expect(batches[1].records.map(r => r.title)).toEqual(['Gamma']);
        expect(batches[1].checkpoint).toEqual({ continue: null, complete: true });

        // Metadata mapping: category prefix stripped, size/touched/url captured
        const gamma = batches[1].records[0];
        expect(gamma.sizeBytes).toBe(55);
        expect(gamma.touched).toBe(Date.parse('2024-01-01T00:00:00Z'));
        expect(gamma.url).toBe('https://x/wiki/Gamma');
    });

    it('echoes the entire continue blob back as request parameters', async () => {
        const fetchMock = installGeneratorMock();
        await enumeratePagesWithMetadata(API, {});

        const urls = fetchMock.mock.calls.map(c => new URL(c[0]));
        expect(urls).toHaveLength(3);
        // Round 2 carries both keys of window 1's continue blob
        expect(urls[1].searchParams.get('clcontinue')).toBe('2|Locations');
        expect(urls[1].searchParams.get('continue')).toBe('||');
        // Round 3 carries window 2's blob
        expect(urls[2].searchParams.get('gapcontinue')).toBe('Gamma');
        expect(urls[2].searchParams.get('clcontinue')).toBeNull();
    });

    it('resumes from a persisted continue blob', async () => {
        const fetchMock = installGeneratorMock();
        const batches = [];

        const result = await enumeratePagesWithMetadata(API, {
            resumeContinue: { gapcontinue: 'Gamma', continue: 'gapcontinue||' },
            onBatch: (records) => { batches.push(records); },
        });

        expect(result.count).toBe(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('gapcontinue')).toBe('Gamma');
        expect(batches[0].map(r => r.title)).toEqual(['Gamma']);
    });

    it('stop-token between windows returns a resumable checkpoint without re-emitting', async () => {
        installGeneratorMock();
        const stopToken = { stopped: false };
        const batches = [];

        const result = await enumeratePagesWithMetadata(API, {
            stopToken,
            onBatch: (records, checkpoint) => {
                batches.push({ records, checkpoint });
                stopToken.stopped = true; // stop after the first flushed window
            },
        });

        expect(result.stopped).toBe(true);
        expect(result.count).toBe(2);
        expect(result.continue).toEqual({ gapcontinue: 'Gamma', continue: 'gapcontinue||' });
        // Only window 1 was emitted; the empty stop-flush is suppressed
        expect(batches).toHaveLength(1);
    });

    it('stop-token mid-window flushes the partial window with a restart checkpoint', async () => {
        const stopToken = { stopped: false };
        const fetchMock = vi.fn(async () => {
            stopToken.stopped = true; // flip after the first response lands
            return jsonResponse({
                continue: { clcontinue: '2|Locations', continue: '||' },
                query: { pages: { 1: gpage(1, 'Alpha', { categories: ['Characters'] }), 2: gpage(2, 'Beta') } },
            });
        });
        vi.stubGlobal('fetch', fetchMock);
        const batches = [];

        const result = await enumeratePagesWithMetadata('https://x/api.php', {
            stopToken,
            onBatch: (records, checkpoint) => { batches.push({ records, checkpoint }); },
        });

        expect(result).toMatchObject({ count: 2, continue: null, stopped: true });
        expect(batches).toHaveLength(1);
        // Partial window emitted (Beta's categories incomplete), checkpoint
        // restarts the window — NOT marked complete despite continue: null
        expect(batches[0].records.map(r => r.title)).toEqual(['Alpha', 'Beta']);
        expect(batches[0].checkpoint).toEqual({ continue: null, complete: false });
    });

    it('applies the title filter with plugin semantics', async () => {
        installGeneratorMock();
        const batches = [];
        await enumeratePagesWithMetadata(API, {
            filter: 'Alpha|Gamma',
            onBatch: (records) => { batches.push(...records); },
        });
        expect(batches.map(r => r.title)).toEqual(['Alpha', 'Gamma']);
    });

    it('throws an api error on rawcontinue (pre-1.26) responses', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
            'query-continue': { allpages: { gapcontinue: 'X' } },
            query: { pages: {} },
        })));
        await expect(enumeratePagesWithMetadata('https://x/api.php', {}))
            .rejects.toMatchObject({ code: 'api' });
    });

    it('throws an api error when the API reports one (e.g. stale badcontinue)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
            error: { code: 'badcontinue', info: 'Invalid continue param' },
        })));
        await expect(enumeratePagesWithMetadata('https://x/api.php', { resumeContinue: { gapcontinue: 'stale' } }))
            .rejects.toMatchObject({ code: 'api' });
    });

    it('hard-cancels via the signal', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ query: { pages: {} } })));
        const controller = new AbortController();
        controller.abort();
        await expect(enumeratePagesWithMetadata('https://x/api.php', { signal: controller.signal }))
            .rejects.toMatchObject({ code: 'aborted' });
    });
});

describe('fetchPageContents', () => {
    function installRevisionsMock() {
        const fetchMock = vi.fn(async (url) => {
            const titles = new URL(url).searchParams.get('titles').split('|');
            const pages = {};
            titles.forEach((title, i) => {
                pages[String(i + 1)] = {
                    pageid: i + 1, ns: 0, title,
                    revisions: [{ slots: { main: { '*': `'''${title}''' body` } } }],
                };
            });
            return jsonResponse({ query: { pages } });
        });
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }

    it('emits each 50-title batch with wikitext and converted plaintext', async () => {
        const fetchMock = installRevisionsMock();
        const titles = Array.from({ length: 120 }, (_, i) => `Page ${i + 1}`);
        const batches = [];
        const progress = [];

        const result = await fetchPageContents('https://x/api.php', titles, {
            onBatch: (pages) => { batches.push(pages.length); },
            onProgress: (p) => progress.push(p.done),
        });

        expect(result.stopped).toBe(false);
        expect(result.remainingTitles).toEqual([]);
        expect(result.pages).toHaveLength(120);
        expect(batches).toEqual([50, 50, 20]);
        expect(progress).toEqual([50, 100, 120]);
        expect(fetchMock).toHaveBeenCalledTimes(3);

        expect(result.pages[0].content).toBe("'''Page 1''' body");
        expect(result.pages[0].plaintext).toBe('Page 1 body');
    });

    it('stop-token between batches returns fetched pages plus the remaining titles', async () => {
        installRevisionsMock();
        const titles = Array.from({ length: 120 }, (_, i) => `Page ${i + 1}`);
        const stopToken = { stopped: false };

        const result = await fetchPageContents('https://x/api.php', titles, {
            stopToken,
            onBatch: () => { stopToken.stopped = true; },
        });

        expect(result.stopped).toBe(true);
        expect(result.pages).toHaveLength(50);
        expect(result.remainingTitles).toHaveLength(70);
        expect(result.remainingTitles[0]).toBe('Page 51');
    });

    it('hard-cancels via the signal', async () => {
        installRevisionsMock();
        const controller = new AbortController();
        controller.abort();
        await expect(fetchPageContents('https://x/api.php', ['Alpha'], { signal: controller.signal }))
            .rejects.toMatchObject({ code: 'aborted' });
    });
});

describe('enumerateE621Pages', () => {
    function e6page(id, title, body, extra = {}) {
        return { id, title, body, is_deleted: false, updated_at: '2024-06-01T00:00:00Z', category_id: 0, ...extra };
    }

    function installE621Mock(batches) {
        let call = 0;
        const fetchMock = vi.fn(async () => jsonResponse(batches[call++] ?? []));
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }

    it('emits per-response batches with content, plaintext, and mapped categories', async () => {
        installE621Mock([[
            e6page(100, 'himbofication', 'See [[bimbofication]].', { category_id: 0 }),
            e6page(99, 'renamon', 'A digimon.', { category_id: 4 }),
            e6page(98, 'sergal', 'A species.', { category_id: 5 }),
            e6page(97, 'weird_tag', 'Unknown category.', { category_id: 42 }),
        ]]);
        const batches = [];

        const result = await enumerateE621Pages({
            url: '',
            onBatch: (records, cursor) => { batches.push({ records, cursor }); },
        });

        expect(result).toMatchObject({ count: 4, done: true, stopped: false });
        expect(batches).toHaveLength(1);
        expect(batches[0].cursor).toBe(97);

        const records = batches[0].records;
        expect(records[0]).toMatchObject({
            title: 'himbofication',
            content: 'See [[bimbofication]].',
            plaintext: 'See bimbofication.',
            categories: ['general'],
            contentFetched: true,
            touched: Date.parse('2024-06-01T00:00:00Z'),
        });
        expect(records[1].categories).toEqual(['character']);
        expect(records[2].categories).toEqual(['species']);
        expect(records[3].categories).toEqual(['other']);
    });

    it('reads the category id from the misnamed category_name key when category_id is absent', async () => {
        installE621Mock([[
            { id: 1, title: 'lore_tag', body: 'Lore body.', is_deleted: false, category_name: 8 },
        ]]);
        const batches = [];
        await enumerateE621Pages({ url: '', onBatch: (records) => batches.push(...records) });
        expect(batches[0].categories).toEqual(['lore']);
    });

    it('keeps the category as a literal name when category_name is a non-numeric string, instead of dropping it', async () => {
        installE621Mock([[
            { id: 1, title: 'weird_tag', body: 'Body.', is_deleted: false, category_name: 'artist' },
        ]]);
        const batches = [];
        await enumerateE621Pages({ url: '', onBatch: (records) => batches.push(...records) });
        expect(batches[0].categories).toEqual(['artist']);
    });

    it('resumes from a persisted cursor', async () => {
        const fetchMock = installE621Mock([[e6page(400, 'tag_400', 'Body.')]]);
        await enumerateE621Pages({ url: '', resumeCursor: 500 });
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('page')).toBe('b500');
    });

    it('stop-token returns the cursor for resume without marking done', async () => {
        const full = Array.from({ length: 320 }, (_, i) => e6page(1000 - i, `tag_${1000 - i}`, 'Body.'));
        installE621Mock([full, [e6page(500, 'tag_500', 'Body.')]]);
        const stopToken = { stopped: false };

        const result = await enumerateE621Pages({
            url: '',
            stopToken,
            onBatch: () => { stopToken.stopped = true; },
        });

        expect(result.stopped).toBe(true);
        expect(result.done).toBe(false);
        expect(result.count).toBe(320);
        expect(result.cursor).toBe(681);
    });

    it('skips deleted and empty items but still advances the cursor past them', async () => {
        installE621Mock([[
            e6page(10, 'kept', 'Real.'),
            e6page(9, 'gone', 'X.', { is_deleted: true }),
            e6page(8, '', 'No title.'),
        ]]);
        const batches = [];
        const result = await enumerateE621Pages({ url: '', onBatch: (records, cursor) => batches.push({ records, cursor }) });
        expect(result.count).toBe(1);
        expect(batches[0].records.map(r => r.title)).toEqual(['kept']);
        expect(batches[0].cursor).toBe(8);
    });
});

describe('searchE621ByTitle', () => {
    it('queries search[title] with limit 10 and maps records', async () => {
        const fetchMock = vi.fn(async () => jsonResponse([
            { id: 5, title: 'bimbo', body: 'The page literally titled bimbo.', is_deleted: false, category_id: 0 },
        ]));
        vi.stubGlobal('fetch', fetchMock);

        const records = await searchE621ByTitle('', 'bimbo');
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ title: 'bimbo', contentFetched: true });

        const url = new URL(fetchMock.mock.calls[0][0]);
        expect(url.pathname).toBe('/wiki_pages.json');
        expect(url.searchParams.get('search[title]')).toBe('bimbo');
        expect(url.searchParams.get('limit')).toBe('10');
    });

    it('returns [] for a blank title without making a request', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        expect(await searchE621ByTitle('', '   ')).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('handles the {"wiki_pages": []} empty shape and filters deleted items', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ wiki_pages: [
            { id: 1, title: 'gone', body: 'X.', is_deleted: true },
        ] })));
        expect(await searchE621ByTitle('', 'gone')).toEqual([]);
    });

    it('rejects non-e621 hosts', async () => {
        await expect(searchE621ByTitle('https://danbooru.donmai.us', 'tag'))
            .rejects.toMatchObject({ code: 'api' });
    });
});

describe('E621_CATEGORY_NAMES', () => {
    it('covers the e621 taxonomy', () => {
        expect(E621_CATEGORY_NAMES[1]).toBe('artist');
        expect(E621_CATEGORY_NAMES[4]).toBe('character');
        expect(E621_CATEGORY_NAMES[8]).toBe('lore');
    });
});
