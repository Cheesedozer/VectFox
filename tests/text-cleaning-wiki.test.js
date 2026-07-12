/**
 * Unit tests for the Wiki Export Noise builtin cleaning pattern group.
 * Fixtures are taken verbatim from a real HTML-scraped e621 wiki export —
 * post-score number runs, repeated site announcement banners, "Read More"
 * truncation fragments, hidden-post notices, and navigation lines — and the
 * assertions verify that actual wiki prose (tag definitions) survives.
 * Mirrors tests/text-cleaning-fatbody.test.js.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ chat: [] })),
}));
vi.mock('../../../../utils.js', () => ({
    uuidv4: vi.fn(() => 'test-uuid'),
}));
vi.mock('../core/log.js', () => ({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { extension_settings } from '../../../../extensions.js';
import {
    BUILTIN_PATTERNS,
    CLEANING_PRESETS,
    getCleaningSettings,
    cleanText,
} from '../core/text-cleaning.js';

const WIKI_IDS = Object.keys(BUILTIN_PATTERNS).filter(id => id.startsWith('strip_wiki_'));

/** Activate exactly the Wiki Export Noise preset for a test. */
function useWikiNoisePreset() {
    extension_settings.vectfox.cleaning = {
        selectedPreset: 'wiki_noise',
        customPatterns: [],
        enabledBuiltins: [],
    };
}

beforeEach(() => {
    extension_settings.vectfox = {};
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('wiki pattern group: registration', () => {
    it('ships all expected strip_wiki_* builtins and every pattern compiles', () => {
        expect(WIKI_IDS.length).toBe(8);
        for (const id of WIKI_IDS) {
            const p = BUILTIN_PATTERNS[id];
            expect(p.builtin).toBe(true);
            expect(() => new RegExp(p.pattern, p.flags || 'g')).not.toThrow();
        }
    });

    it('wiki_noise preset exists and includes the whole group', () => {
        const preset = CLEANING_PRESETS.wiki_noise;
        expect(preset).toBeDefined();
        for (const id of WIKI_IDS) {
            expect(preset.patterns).toContain(id);
        }
    });

    it('wiki patterns are NOT in the default enabled set', () => {
        const settings = getCleaningSettings(); // builds defaults
        for (const id of WIKI_IDS) {
            expect(settings.enabledBuiltins).not.toContain(id);
        }
        // sanity: standard patterns still default-enabled
        expect(settings.enabledBuiltins).toContain('strip_font_tags');
        expect(settings.enabledBuiltins).not.toContain('strip_all_html');
    });
});

// ---------------------------------------------------------------------------
// Cleaning behavior — fixtures verbatim from the e621 export
// ---------------------------------------------------------------------------

describe('wiki pattern group: cleaning behavior', () => {
    it('strips post-score triplet runs but keeps real prose around them', () => {
        useWikiNoisePreset();
        const text = [
            'A character or animal, that has a body covered in fur that is the color brown, ether fully or partially.',
            '',
            ' 0 0 S  1 0 S  6 7 E  0 0 Q  4 1 S  1 0 Q  0 2 Q  4 8 E  65 108 E  2 5 Q  15 21 E  1.3k 2.8k E',
        ].join('\n');
        const cleaned = cleanText(text);
        expect(cleaned).toContain('body covered in fur');
        expect(cleaned).not.toMatch(/\d+ \d+ [SQE]\s+\d+ \d+ [SQE]/);
        expect(cleaned).not.toContain('65 108 E');
    });

    it('a single score-like triplet inside prose survives (repetition minimum)', () => {
        useWikiNoisePreset();
        const decoy = 'She rolled 3 8 E in the dice game and laughed.';
        expect(cleanText(decoy)).toContain('rolled 3 8 E in the dice game');
    });

    it('strips compact score runs like "2529E  99192E"', () => {
        useWikiNoisePreset();
        const text = 'Description Artwork (c) Alexa Neon  2529E  99192E  6151298E  2849E  2861E  61135E';
        const cleaned = cleanText(text);
        expect(cleaned).not.toContain('2529E');
        expect(cleaned).not.toContain('61135E');
    });

    it('strips the repeated site announcement banner', () => {
        useWikiNoisePreset();
        const banner = [
            '**10 June** Have you heard? There\'s a fantastech new way to scoop images from Bluesky! Download our userscript from the [Sites and Sources](https://e621.net/wiki_pages/show_or_new?title=howto%3Asites_and_sources) page. Also happy Pride Month! **14 May** Hey there! We have some juicy new updates for you! Here are the highlights:',
            '',
            '* Users now have the ability to crop any post on the site to use as an avatar (now also fixed on mobile)',
            '* Staff assigned custom titles',
            '* We\'ve added a post deletion appeal system',
            '',
            '##### **Important: We are changing the API response format. This will eventually break 3rd party apps!** If you are a nerd, read the details [here](https://e621.net/forum_topics/63849)',
            '',
            'Read the full changelog [here](https://e621.net/forum_topics/13631?page=4#forum_post_493234) We still have a Discord server, [come talk to us](https://e621.net/static/discord)! Want to advertise on e621? [Click here!](https://e621.net/help/advertising) Are you an artist uploading your own art to e621? [Get verified now!](https://e621.net/help/staff#verification)',
            '',
            'The process of transforming into an individual dumb brute or stud.',
        ].join('\n');
        const cleaned = cleanText(banner);
        expect(cleaned).not.toContain('Have you heard');
        expect(cleaned).not.toContain('Discord server');
        expect(cleaned).not.toContain('Get verified now');
        expect(cleaned).toContain('The process of transforming into an individual dumb brute or stud.');
    });

    it('strips leftover promo lines when the banner is cut off mid-way', () => {
        useWikiNoisePreset();
        const text = [
            'Real lore sentence stays.',
            'Read the full changelog [here](https://e621.net/forum_topics/13631)',
            'Want to advertise on e621? [Click here!](https://e621.net/help/advertising)',
        ].join('\n');
        const cleaned = cleanText(text);
        expect(cleaned).toContain('Real lore sentence stays.');
        expect(cleaned).not.toContain('changelog');
        expect(cleaned).not.toContain('advertise');
    });

    it('strips "N post(s) hidden" notices including the trailing learn-more link', () => {
        useWikiNoisePreset();
        const text = 'Fur Coloration matters. 3 post(s) on this page were hidden because you need to be logged in to view them. [(learn more)](https://e621.net/help/global_blacklist)';
        const cleaned = cleanText(text);
        expect(cleaned).toContain('Fur Coloration matters.');
        expect(cleaned).not.toContain('hidden');
        expect(cleaned).not.toContain('learn more');
    });

    it('strips Read More truncation fragments with and without the ellipsis prefix', () => {
        useWikiNoisePreset();
        const text = [
            '* \\[... [Read More](https://e621.net/wiki_pages/3515)',
            'This tag also applies to objects that resemble characters. [Read More](https://e621.net/wiki_pages/12286)',
        ].join('\n');
        const cleaned = cleanText(text);
        expect(cleaned).toContain('objects that resemble characters.');
        expect(cleaned).not.toContain('Read More');
    });

    it('strips search/layout navigation lines', () => {
        useWikiNoisePreset();
        const text = [
            '### Advanced Options',
            '',
            'Rating Safe Questionable Explicit Order Default Score Hot Favorites',
            '',
            '### Layout Settings',
            '',
            'Card Size Small Medium Large Hover Text Short Long None Description Despite how it looks',
            'Posts [\\[search help\\]](https://e621.net/help/cheatsheet)',
            '',
            'A decorative ribbon positioned on top of a character\'s head.',
        ].join('\n');
        const cleaned = cleanText(text);
        expect(cleaned).not.toContain('Advanced Options');
        expect(cleaned).not.toContain('Rating Safe Questionable Explicit');
        expect(cleaned).not.toContain('Card Size');
        expect(cleaned).not.toContain('search help');
        expect(cleaned).toContain('A decorative ribbon positioned on top');
    });

    it('strips italicized bare-URL echo lines under page headers', () => {
        useWikiNoisePreset();
        const text = [
            '# [brown fur \\- e621](https://e621.net/posts?tags=brown_fur)',
            '',
            '[*https://e621.net/posts?tags=brown\\_fur*](https://e621.net/posts?tags=brown_fur)',
            '',
            '### brown fur',
        ].join('\n');
        const cleaned = cleanText(text);
        // the markdown page header (the title) survives; the URL echo goes
        expect(cleaned).toContain('# [brown fur');
        expect(cleaned).not.toContain('[*https://e621.net');
    });

    it('real tag-wiki prose passes through the whole preset untouched', () => {
        useWikiNoisePreset();
        const himbofication = 'The process of transforming into an individual dumb brute or stud, perfectly happy to be fuck anyone and/or workout and perform physical tasks mindlessly. Alternatively, the male equivalent of bimbofication - rather than a male character becoming feminine or a female character becoming stereotypically hyperfeminine, an individual becoming ubermasculine and/or hypersexual in body, outfit, behavior, or all of the above.';
        expect(cleanText(himbofication)).toContain(himbofication);
    });
});
