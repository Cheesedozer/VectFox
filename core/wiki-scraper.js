/**
 * VectFox Built-in Wiki Scraper
 *
 * Scrapes Fandom and MediaWiki wikis directly from the browser via the
 * MediaWiki Action API, which permits anonymous cross-origin requests
 * (`origin=*`). Produces the same `{ title, content }` pages as the
 * SillyTavern-Fandom-Scraper server plugin, so the plugin is no longer
 * required — it remains supported as a fallback for wikis whose API is
 * unreachable from the browser (very old MediaWiki, CORS disabled).
 *
 * The wikitext -> plaintext conversion pipeline is ported from
 * SillyTavern-Fandom-Scraper (AGPL-3.0, (c) Cohee1207 & contributors),
 * preserving its exact output so scraped collections stay compatible.
 *
 * @module wikiScraper
 */

import wikitext2plaintext from './vendor/wikitext2plaintext.js';
import AsyncUtils from '../utils/async-utils.js';
import StringUtils from '../utils/string-utils.js';
import { log } from './log.js';

const BATCH_SIZE = 50;              // titles per revisions request (anon API max)
const RATE_LIMIT_MAX_ATTEMPTS = 4;
const MAX_URL_LENGTH = 6000;        // stay under CDN/proxy URL limits

/**
 * Timing knobs, read at call time (mutable so tests can zero them out).
 */
export const WIKI_SCRAPER_TIMINGS = {
    enumDelayMs: 250,           // pause between allpages continuation requests
    batchDelayMs: 350,          // pause between content batches
    rateLimitDefaultMs: 5000,   // backoff when 429 has no usable Retry-After
    rateLimitMaxDelayMs: 30000, // cap on Retry-After honoring
    discoverTimeoutMs: 10000,   // per-candidate endpoint discovery timeout
    e621DelayMs: 1100,          // pause between e621 requests (site asks ≤1 req/s)
};

/**
 * Error raised by the scraper, tagged with a machine-readable code:
 * - 'network'      fetch failed (CORS block, DNS, offline) — plugin fallback may help
 * - 'api'          host reachable but no valid MediaWiki API — plugin fallback may help
 * - 'rate-limited' wiki kept returning 429 past retries — plugin would hit the same limits
 * - 'not-found'    enumeration succeeded but zero pages matched — user input problem
 * - 'aborted'      the caller's AbortSignal fired
 */
export class WikiScrapeError extends Error {
    constructor(code, message, { cause } = {}) {
        super(message);
        this.name = 'WikiScrapeError';
        this.code = code;
        if (cause) this.cause = cause;
    }
}

/** Internal marker for non-ok HTTP responses (classified as 'api' errors). */
class ApiHttpError extends Error {
    constructor(status, url) {
        super(`HTTP ${status} from ${url}`);
        this.name = 'ApiHttpError';
        this.status = status;
    }
}

/**
 * Whether the external Fandom Scraper server plugin could plausibly succeed
 * where the built-in scraper failed.
 *
 * @param {Error} error - Error thrown by scrapeWiki
 * @returns {boolean} True if the plugin fallback should be attempted
 */
export function shouldFallbackToPlugin(error) {
    return error instanceof WikiScrapeError && (error.code === 'network' || error.code === 'api');
}

/**
 * Instantiates a regular expression from a string.
 * Faithful port of the plugin's regexFromString (including the quirk that
 * a pattern with invalid flags falls back to RegExp(fullInput, 'i')).
 * @copyright Originally from: https://github.com/IonicaBizau/regex-parser.js/blob/master/lib/index.js
 *
 * @param {string} input - The input string
 * @returns {RegExp|undefined} The regular expression, or undefined if unparseable
 */
export function regexFromString(input) {
    try {
        const match = input?.match(/(\/?)(.+)\1([a-z]*)/i);

        if (!match) {
            return;
        }

        // Invalid flags
        if (match[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(match[3])) {
            const defaultFlags = 'i';
            return RegExp(input, defaultFlags);
        }

        return new RegExp(match[2], match[3]);
    } catch {
        return;
    }
}

/**
 * Extracts the Fandom wiki id (subdomain) from a URL, passing bare ids through.
 * Faithful port of the plugin's getFandomId.
 *
 * @param {string} fandom - Fandom URL or bare wiki id
 * @returns {string} The wiki id
 */
export function getFandomId(fandom) {
    try {
        fandom = fandom.trim();
        const url = new URL(fandom);
        const hostname = url.hostname;
        const parts = hostname.split('.');
        const fandomId = parts[0];

        if (!fandomId) {
            return fandom;
        }

        return fandomId;
    } catch {
        return fandom;
    }
}

/**
 * Converts a wikitext page body to plain text.
 * Faithful port of the plugin's wikiToText — same steps, same order. The
 * single-occurrence string replaces are first-match-only upstream too; they
 * are kept that way deliberately for output parity.
 *
 * @param {string} wiki - Raw wikitext
 * @returns {string} Plain text
 */
export function wikiToText(wiki) {
    const parser = new wikitext2plaintext();
    let rawContent = parser.parse(wiki);

    // Remove extra spaces between brackets
    rawContent = rawContent.replace(/\(\s+/g, '(');
    // Remove empty brackets, non-breaking spaces and spaces before commas
    rawContent = rawContent.replace('()', '').replace('\u00a0', ' ').replace(' , ', ', ');
    // Decode HTML entities (second pass — parse() already decoded once)
    rawContent = StringUtils.decodeHtmlEntities(rawContent);

    // Remove lines starting with 'Category:'
    rawContent = rawContent.split('\n').filter(line => !line.startsWith('Category:')).join('\n');
    // Remove HTML tags (leave only text)
    rawContent = rawContent.replace(/<[^>]*>/g, '');

    return rawContent;
}

/**
 * Builds candidate api.php URLs for a wiki, most specific first.
 *
 * @param {string} wikiType - 'fandom' or 'mediawiki'
 * @param {string} input - Wiki URL, base URL, or (for fandom) bare wiki id
 * @returns {string[]} Candidate API endpoint URLs
 */
export function buildApiCandidates(wikiType, input) {
    const trimmed = String(input ?? '').trim();
    if (!trimmed) {
        throw new WikiScrapeError('api', 'No wiki URL or ID provided');
    }

    if (wikiType === 'fandom') {
        let id = getFandomId(trimmed);
        if (id.includes('.')) {
            // Schemeless URL like "fallout.fandom.com" — retry with a scheme
            id = getFandomId(`https://${id}`);
        }
        return [`https://${id}.fandom.com/api.php`];
    }

    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url;
    try {
        url = new URL(withScheme);
    } catch {
        throw new WikiScrapeError('api', `Invalid wiki URL: ${input}`);
    }

    const candidates = [];
    let path = url.pathname.replace(/\/+$/, '');

    // User pasted the API endpoint itself
    if (path.endsWith('/api.php')) {
        candidates.push(url.origin + path);
        path = path.slice(0, -'/api.php'.length);
    }

    // Strip a trailing article path ("/wiki/Some_Page") to find the script path
    const wikiIdx = path.indexOf('/wiki/');
    if (wikiIdx >= 0) {
        path = path.slice(0, wikiIdx);
    }
    if (path === '/wiki') {
        path = '';
    }

    if (path && path !== '/') {
        candidates.push(`${url.origin}${path}/api.php`);
    }
    candidates.push(`${url.origin}/api.php`);
    candidates.push(`${url.origin}/w/api.php`);

    return [...new Set(candidates)];
}

/**
 * GET a MediaWiki API URL and parse JSON, retrying on rate limits
 * (HTTP 429 / Retry-After / MediaWiki "ratelimited" error code).
 *
 * @param {string} url - Full request URL
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} Parsed JSON body
 */
async function fetchApiJson(url, { signal } = {}) {
    for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
        const response = await fetch(url, { signal });

        let rateLimited = response.status === 429;
        if (!rateLimited) {
            if (!response.ok) {
                throw new ApiHttpError(response.status, url);
            }
            const data = await response.json();
            if (data?.error?.code !== 'ratelimited') {
                return data;
            }
            rateLimited = true;
        }

        if (attempt === RATE_LIMIT_MAX_ATTEMPTS) {
            break;
        }

        const retryAfter = Number.parseInt(response.headers?.get?.('Retry-After') ?? '', 10);
        const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0
            ? retryAfter * 1000
            : WIKI_SCRAPER_TIMINGS.rateLimitDefaultMs;
        log.verbose(`[WikiScraper] Rate limited, retrying in ${delayMs}ms (attempt ${attempt}/${RATE_LIMIT_MAX_ATTEMPTS})`);
        await AsyncUtils.sleep(Math.min(delayMs, WIKI_SCRAPER_TIMINGS.rateLimitMaxDelayMs));
    }

    throw new WikiScrapeError('rate-limited', 'The wiki is rate-limiting requests — try again in a few minutes.');
}

/**
 * Finds the working api.php endpoint for a wiki by probing candidates
 * with a siteinfo query.
 *
 * @param {string} wikiType - 'fandom' or 'mediawiki'
 * @param {string} input - Wiki URL or id as entered by the user
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} The confirmed api.php URL
 */
export async function discoverApiEndpoint(wikiType, input, { signal } = {}) {
    const candidates = buildApiCandidates(wikiType, input);
    let sawApiInvalid = false;
    let lastError = null;

    for (const apiUrl of candidates) {
        if (signal?.aborted) {
            throw new WikiScrapeError('aborted', 'Wiki scrape cancelled');
        }
        try {
            const data = await AsyncUtils.timeout(
                fetchApiJson(`${apiUrl}?action=query&meta=siteinfo&format=json&origin=*`, { signal }),
                WIKI_SCRAPER_TIMINGS.discoverTimeoutMs,
                'Wiki API discovery timed out',
            );
            if (data?.query?.general) {
                return apiUrl;
            }
            sawApiInvalid = true;
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw new WikiScrapeError('aborted', 'Wiki scrape cancelled');
            }
            if (error instanceof WikiScrapeError && error.code === 'rate-limited') {
                throw error;
            }
            if (error instanceof ApiHttpError || error instanceof SyntaxError) {
                sawApiInvalid = true;
            }
            lastError = error;
            log.verbose(`[WikiScraper] Endpoint candidate failed: ${apiUrl} (${error.message})`);
        }
    }

    throw new WikiScrapeError(
        sawApiInvalid ? 'api' : 'network',
        sawApiInvalid
            ? 'The site is reachable but does not expose a MediaWiki API the browser can use.'
            : `Could not reach the wiki from the browser (network or CORS blocked): ${lastError?.message ?? 'fetch failed'}`,
        { cause: lastError ?? undefined },
    );
}

/**
 * Enumerates all main-namespace, non-redirect page titles, applying the
 * user's title filter with the plugin's exact matching semantics.
 *
 * @param {string} apiUrl - Confirmed api.php URL
 * @param {object} options
 * @param {string} [options.filter] - Regex string tested against titles
 * @param {Function} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string[]>} Page titles
 */
async function enumerateTitles(apiUrl, { filter, onProgress, signal } = {}) {
    const regex = filter ? regexFromString(String(filter)) : undefined;
    const titles = [];
    let apcontinue;

    do {
        const params = new URLSearchParams({
            action: 'query',
            list: 'allpages',
            aplimit: '500',
            apnamespace: '0',
            apfilterredir: 'nonredirects',
            format: 'json',
            origin: '*',
        });
        if (apcontinue) {
            params.set('apcontinue', apcontinue);
        }

        const data = await fetchApiJson(`${apiUrl}?${params}`, { signal });

        for (const page of data?.query?.allpages ?? []) {
            if (!page?.title) {
                continue;
            }
            // Parity with the plugin: regex cloned per test, matched against
            // the title plus a trailing newline (plugin src/index.ts:78-80)
            if (regex && !new RegExp(regex).test(page.title + '\n')) {
                continue;
            }
            titles.push(page.title);
        }

        onProgress?.({ phase: 'titles', done: titles.length, total: null });

        apcontinue = data?.continue?.apcontinue;
        if (apcontinue && WIKI_SCRAPER_TIMINGS.enumDelayMs > 0) {
            await AsyncUtils.sleep(WIKI_SCRAPER_TIMINGS.enumDelayMs);
        }
    } while (apcontinue);

    return titles;
}

/**
 * Fetches raw wikitext for the given titles in batches of 50.
 *
 * @param {string} apiUrl - Confirmed api.php URL
 * @param {string[]} titles - Page titles to fetch
 * @param {object} options
 * @param {Function} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Array<{title: string, content: string}>>} Pages with raw wikitext content
 */
async function fetchContents(apiUrl, titles, { onProgress, signal } = {}) {
    async function fetchBatch(batch) {
        const params = new URLSearchParams({
            action: 'query',
            prop: 'revisions',
            rvprop: 'content',
            rvslots: 'main',
            format: 'json',
            origin: '*',
            titles: batch.join('|'),
        });
        const url = `${apiUrl}?${params}`;

        // Very long titles can push the URL past CDN limits — split the batch
        if (url.length > MAX_URL_LENGTH && batch.length > 1) {
            const mid = Math.ceil(batch.length / 2);
            return [
                ...await fetchBatch(batch.slice(0, mid)),
                ...await fetchBatch(batch.slice(mid)),
            ];
        }

        const data = await fetchApiJson(url, { signal });

        const normalized = new Map((data?.query?.normalized ?? []).map(n => [n.from, n.to]));
        const byTitle = new Map();
        for (const page of Object.values(data?.query?.pages ?? {})) {
            if (!page || 'missing' in page || 'invalid' in page) {
                continue;
            }
            const slot = page.revisions?.[0]?.slots?.main;
            const wikitext = slot?.['*'] ?? slot?.content;
            if (typeof wikitext === 'string') {
                byTitle.set(page.title, wikitext);
            }
        }

        // Preserve enumeration order
        const pages = [];
        for (const title of batch) {
            const resolved = normalized.get(title) ?? title;
            const wikitext = byTitle.get(resolved);
            if (wikitext !== undefined) {
                pages.push({ title: resolved, content: wikitext });
            }
        }
        return pages;
    }

    return AsyncUtils.batch(titles, fetchBatch, {
        batchSize: BATCH_SIZE,
        delay: WIKI_SCRAPER_TIMINGS.batchDelayMs,
        onProgress: (done, total) => onProgress?.({ phase: 'content', done, total }),
    });
}

// ---------------------------------------------------------------------------
// e621 adapter
//
// e621/e926 are Danbooru-lineage boorus, not MediaWiki — endpoint discovery
// correctly fails on them. Their own JSON API (/wiki_pages.json) is CORS-open
// (Access-Control-Allow-Origin: *) and returns clean per-tag wiki bodies in
// DText markup, with none of the post/score/announcement noise an HTML
// scraper would pick up. There is no plugin fallback for this wiki type.
// ---------------------------------------------------------------------------

const E621_PAGE_LIMIT = 320; // API max per request
const E621_ALLOWED_HOSTS = new Set(['e621.net', 'e926.net']);
// Starting cursor above any real wiki-page id. A cursorless request uses the
// site's default ordering (recently-updated, NOT id) — mixing that first page
// with b<id> cursors silently skips most of the wiki (verified live: the
// default first page bottomed out at id ~758 and pagination never saw the
// rest). Passing page=b<sentinel> from the very first request keeps every
// response in sequential id-descending mode.
const E621_MAX_ID_SENTINEL = 2147483647;

/**
 * Resolves user input to an e621-family base URL.
 * Accepts '' (defaults to e621.net), a bare host, or any URL on an allowed
 * host; rejects everything else so this adapter is never pointed at an
 * arbitrary site that happens to expose a lookalike endpoint.
 *
 * @param {string} input - Empty string, host, or URL
 * @returns {string} Base URL, e.g. 'https://e621.net'
 * @throws {WikiScrapeError} code 'api' for non-e621 hosts
 */
export function resolveE621Base(input) {
    const trimmed = String(input ?? '').trim();
    if (!trimmed) {
        return 'https://e621.net';
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let hostname;
    try {
        hostname = new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        throw new WikiScrapeError('api', `Invalid e621 URL: ${input}`);
    }
    if (!E621_ALLOWED_HOSTS.has(hostname)) {
        throw new WikiScrapeError('api', `The e621 wiki type only supports e621.net / e926.net (got "${hostname}"). Use the MediaWiki type for other sites.`);
    }
    return `https://${hostname}`;
}

/**
 * Converts e621 DText markup to plaintext, keeping display text:
 *  - "[[title|display]]" → display; "[[title]]" → title
 *  - "{{tag search|label}}" → label; "{{tag}}" → tag
 *  - '"label":url' / '"label":[url]' external links → label
 *  - line-leading "h1."–"h6." (incl. "h4#anchor.") → markdown "#"–"######"
 *  - inline [b][i][u][s][o][sup][sub][spoiler][color=…] tags stripped, text kept
 *  - [quote]/[section(,expanded)(=Title)]/[code]/[table]/[nodtext] block
 *    markers stripped (a section title, if present, becomes its own line)
 *  - "thumb #12345" removed ("post #12345" is kept — it's a factual reference)
 *  - 3+ consecutive newlines collapsed
 *
 * @param {string} dtext - Raw DText body
 * @returns {string} Plaintext
 */
export function dtextToPlaintext(dtext) {
    let text = String(dtext ?? '').replace(/\r\n/g, '\n');

    // Wiki links and tag-search links, piped form first
    text = text.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2');
    text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');
    text = text.replace(/\{\{([^}|]*)\|([^}]*)\}\}/g, '$2');
    text = text.replace(/\{\{([^}]+)\}\}/g, '$1');

    // External links: "label":https://… , "label":/path , "label":[any url]
    text = text.replace(/"([^"\n]+)":\[[^\]]*\]/g, '$1');
    text = text.replace(/"([^"\n]+)":(?:https?:\/\/|\/)\S+/g, '$1');

    // Headers: h4. / h4#anchor. at line start → markdown
    text = text.replace(/^h([1-6])(?:#[^.\n]*)?\.[ \t]*/gm, (_, n) => `${'#'.repeat(Number(n))} `);

    // Section blocks — keep an expanded/named section's title as its own line
    text = text.replace(/\[section(?:,expanded)?=([^\]]*)\]/gi, '\n$1\n');
    text = text.replace(/\[\/?(?:section(?:,expanded)?|quote|code|table|thead|tbody|tr|th|td|nodtext)\]/gi, '');

    // Inline formatting tags — strip markers, keep text
    text = text.replace(/\[\/?(?:b|i|u|s|o|sup|sub|spoiler)\]/gi, '');
    text = text.replace(/\[color=[^\]]*\]|\[\/color\]/gi, '');

    // Thumbnail references are pure image plumbing; plain "post #N" stays
    text = text.replace(/\bthumb #\d+\b/g, '');

    return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Scrapes e621/e926 tag-wiki pages via /wiki_pages.json.
 *
 * Always walks the full wiki-page corpus via Danbooru sequential ("b<id>")
 * cursor pagination and applies the filter regex client-side — the same
 * unanchored-substring semantics as the MediaWiki path's enumerateTitles.
 * There is a real temptation to short-circuit this using e621's own
 * search[title]=<name> (a fast, reliable EXACT match, verified live), but
 * that changes matching semantics: an unanchored filter like "bimbo|himbo"
 * is meant to substring-match longer titles ("bimbofication"), while
 * search[title] would instead resolve it to the unrelated pages literally
 * titled "bimbo" and "himbo" (both real, distinct e621 pages) — a silent
 * wrong-result regression, not just a perf tradeoff. So this stays a full
 * scan; e621's corpus is large (page ids run past 107,000, so a full scan is
 * 300+ requests and several minutes even at the courtesy rate limit) — the
 * 'titles' progress tick keeps the caller informed while it runs.
 *
 * The numeric `page` param is server-capped at 750 pages in; the cursor form
 * is uncapped and stable under concurrent edits. Starting the cursor at
 * E621_MAX_ID_SENTINEL matters: a cursorless first request uses the site's
 * default ordering (recently-updated, not id), which silently drops most of
 * the corpus once cursors switch to id-based paging (verified live).
 *
 * Bodies arrive in the same response as titles, so unlike the MediaWiki path
 * there is no second content-fetch phase; progress is reported as the
 * 'titles' phase only.
 *
 * @param {object} options
 * @param {string} [options.url] - '' for e621.net, or an e621/e926 URL
 * @param {string} [options.filter] - Regex string applied to page titles
 *        (same semantics as the MediaWiki path — e621 tag titles are
 *        lowercase_with_underscores)
 * @param {Function} [options.onProgress] - Called with {phase, done, total}
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Array<{title: string, content: string}>>} Plaintext pages
 * @throws {WikiScrapeError}
 */
export async function scrapeE621({ url, filter, onProgress, signal } = {}) {
    const base = resolveE621Base(url);
    const regex = filter ? regexFromString(String(filter)) : undefined;
    const pages = [];
    let cursor = E621_MAX_ID_SENTINEL;

    for (;;) {
        if (signal?.aborted) {
            throw new WikiScrapeError('aborted', 'Wiki scrape cancelled');
        }

        const params = new URLSearchParams({
            limit: String(E621_PAGE_LIMIT),
            page: `b${cursor}`,
        });
        const data = await fetchApiJson(`${base}/wiki_pages.json?${params}`, { signal });

        // Bare array normally; Danbooru-lineage APIs answer an empty result
        // set as {"wiki_pages": []}
        const items = Array.isArray(data) ? data
            : Array.isArray(data?.wiki_pages) ? data.wiki_pages : [];
        if (items.length === 0) {
            break;
        }

        let minId = Infinity;
        for (const item of items) {
            const id = Number(item?.id);
            if (Number.isFinite(id) && id < minId) {
                minId = id;
            }
            if (item?.is_deleted) {
                continue;
            }
            const title = typeof item?.title === 'string' ? item.title.trim() : '';
            const body = typeof item?.body === 'string' ? item.body : '';
            if (!title || !body.trim()) {
                continue;
            }
            // Same matching semantics as enumerateTitles (title + trailing newline)
            if (regex && !new RegExp(regex).test(title + '\n')) {
                continue;
            }
            pages.push({ title, content: body });
        }

        onProgress?.({ phase: 'titles', done: pages.length, total: null });

        // No usable cursor or no forward progress → stop rather than loop
        if (!Number.isFinite(minId) || minId >= cursor) {
            break;
        }
        cursor = minId;

        if (items.length < E621_PAGE_LIMIT) {
            break;
        }
        if (WIKI_SCRAPER_TIMINGS.e621DelayMs > 0) {
            await AsyncUtils.sleep(WIKI_SCRAPER_TIMINGS.e621DelayMs);
        }
    }

    const converted = [];
    for (const page of pages) {
        const content = dtextToPlaintext(page.content);
        if (content) {
            converted.push({ title: page.title, content });
        }
    }

    if (converted.length === 0) {
        throw new WikiScrapeError('not-found', filter
            ? 'No e621 wiki pages matched the filter — check the filter regex (e621 titles are lowercase_with_underscores).'
            : 'No e621 wiki pages found.');
    }

    log.lifecycle(`[WikiScraper] Scraped ${converted.length} e621 wiki pages`);
    return converted;
}

/**
 * Maps any thrown error to a WikiScrapeError with the right code.
 */
function toWikiScrapeError(error) {
    if (error instanceof WikiScrapeError) {
        return error;
    }
    if (error?.name === 'AbortError') {
        return new WikiScrapeError('aborted', 'Wiki scrape cancelled');
    }
    if (error instanceof ApiHttpError || error instanceof SyntaxError) {
        return new WikiScrapeError('api', `The wiki API returned an unusable response: ${error.message}`, { cause: error });
    }
    return new WikiScrapeError('network', error?.message || 'Network error while scraping wiki', { cause: error });
}

/**
 * Scrapes a wiki entirely from the browser.
 *
 * @param {object} options
 * @param {string} options.wikiType - 'fandom', 'mediawiki', or 'e621'
 * @param {string} options.url - Wiki URL, base URL, or (fandom) bare wiki id;
 *        may be empty for 'e621' (defaults to e621.net)
 * @param {string} [options.filter] - Regex string applied to page titles
 * @param {Function} [options.onProgress] - Called with {phase, done, total}
 * @param {AbortSignal} [options.signal] - Abort the scrape
 * @returns {Promise<Array<{title: string, content: string}>>} Plaintext pages
 * @throws {WikiScrapeError}
 */
export async function scrapeWiki({ wikiType, url, filter, onProgress, signal } = {}) {
    try {
        if (wikiType === 'e621') {
            return await scrapeE621({ url, filter, onProgress, signal });
        }

        onProgress?.({ phase: 'discover', done: 0, total: null });
        const apiUrl = await discoverApiEndpoint(wikiType, url, { signal });
        log.lifecycle(`[WikiScraper] Scraping via ${apiUrl}`);

        const titles = await enumerateTitles(apiUrl, { filter, onProgress, signal });
        if (titles.length === 0) {
            throw new WikiScrapeError('not-found', filter
                ? 'No pages matched the filter — check the wiki URL and filter regex.'
                : 'No pages found on this wiki — check the URL.');
        }
        log.lifecycle(`[WikiScraper] Found ${titles.length} pages, fetching content`);

        const rawPages = await fetchContents(apiUrl, titles, { onProgress, signal });

        // Parity with the plugin's getPagesFromXml: drop pages whose title or
        // converted content is empty
        const pages = [];
        for (const rawPage of rawPages) {
            const content = wikiToText(rawPage.content);
            if (rawPage.title && content) {
                pages.push({ title: rawPage.title, content });
            }
        }

        if (pages.length === 0) {
            throw new WikiScrapeError('not-found', 'All matched pages were empty after conversion.');
        }

        log.lifecycle(`[WikiScraper] Scraped ${pages.length} pages`);
        return pages;
    } catch (error) {
        throw toWikiScrapeError(error);
    }
}
