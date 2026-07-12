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
 * @param {string} options.wikiType - 'fandom' or 'mediawiki'
 * @param {string} options.url - Wiki URL, base URL, or (fandom) bare wiki id
 * @param {string} [options.filter] - Regex string applied to page titles
 * @param {Function} [options.onProgress] - Called with {phase, done, total}
 * @param {AbortSignal} [options.signal] - Abort the scrape
 * @returns {Promise<Array<{title: string, content: string}>>} Plaintext pages
 * @throws {WikiScrapeError}
 */
export async function scrapeWiki({ wikiType, url, filter, onProgress, signal } = {}) {
    try {
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
