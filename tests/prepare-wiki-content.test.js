/**
 * Unit tests for prepareWikiContent (core/content-vectorization.js)
 *
 * Focus: wiki-noise stripping is unconditional, not gated behind the user's
 * cleaning preset/custom pattern selection. Uses the real text-cleaning.js
 * (not mocked) so cleanWikiNoise + the user's cleanContentOrNull pipeline
 * both run for real, with default (out-of-the-box) cleaning settings —
 * proving a user who never opens the Text Cleaning panel still gets clean
 * wiki content out of Auto-Reformat / Vectorize.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({})),
}));
vi.mock('../../../../../script.js', () => ({
    getCurrentChatId: vi.fn(() => 'chat123'),
}));
vi.mock('../../../../utils.js', () => ({
    getStringHash: vi.fn((s) => `hash_${String(s).length}`),
}));
vi.mock('../core/log.js', () => ({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), lifecycle: vi.fn() },
}));
vi.mock('../core/core-vector-api.js', () => ({
    insertVectorItems: vi.fn(),
    purgeVectorIndex: vi.fn(),
    getSavedHashes: vi.fn(),
}));
vi.mock('../core/collection-metadata.js', () => ({
    setCollectionMeta: vi.fn(),
    setCollectionLock: vi.fn(),
    setCollectionCharacterLock: vi.fn(),
    saveChunkMetadata: vi.fn(),
}));
vi.mock('../core/collection-loader.js', () => ({
    registerCollection: vi.fn(),
}));
vi.mock('../backends/backend-manager.js', () => ({
    getBackend: vi.fn(),
}));
vi.mock('../core/collection-ids.js', () => ({
    buildLorebookCollectionId: vi.fn(),
    buildCharacterCollectionId: vi.fn(),
    buildDocumentCollectionId: vi.fn(),
    COLLECTION_PREFIXES: {},
    buildRegistryKey: vi.fn(),
    getBackendFromCollectionId: vi.fn(),
}));
vi.mock('../core/lorebook-content-preparer.js', () => ({
    prepareLorebookContent: vi.fn(),
}));
vi.mock('../core/glossary-extractor.js', () => ({
    extractGlossary: vi.fn(),
    injectGlossary: vi.fn(),
}));
vi.mock('../core/reformat-store.js', () => ({
    getReformatCache: vi.fn(() => null),
}));
vi.mock('../ui/progress-tracker.js', () => ({
    progressTracker: { start: vi.fn(), update: vi.fn(), finish: vi.fn() },
}));
vi.mock('../core/keyword-boost.js', () => ({
    extractLorebookKeywords: vi.fn(() => []),
    extractTextKeywords: vi.fn(() => []),
    extractChatKeywords: vi.fn(() => []),
    extractBM25Keywords: vi.fn(() => []),
    EXTRACTION_LEVELS: {},
    DEFAULT_EXTRACTION_LEVEL: 'balanced',
    DEFAULT_BASE_WEIGHT: 1.5,
    dedupeKeywordsByStem: vi.fn((kws) => kws),
}));

import { extension_settings } from '../../../../extensions.js';
import { prepareWikiContent } from '../core/content-vectorization.js';

beforeEach(() => {
    // Default, out-of-the-box cleaning settings — the wiki_noise preset is
    // NOT selected. This is the exact state a user who has never opened the
    // Text Cleaning panel is in.
    extension_settings.vectfox = {};
});

describe('prepareWikiContent — automatic wiki-noise stripping', () => {
    const ANNOUNCEMENT = "**10 June** Have you heard? There's a fantastech new way to scoop images from Bluesky! Get verified now!](https://e621.net/help/staff#verification)";
    const SCORE_RUN = ' 0 0 S  1 0 S  6 7 E  0 0 Q  4 1 S  1 0 Q  0 2 Q  4 8 E  65 108 E  2 5 Q  15 21 E';
    const REAL_PROSE = 'A character or animal that has a body covered in fur that is the color brown, either fully or partially.';

    it('strips announcement banners and score runs from combined wiki text with default cleaning settings (no preset selected)', () => {
        const result = prepareWikiContent(
            { content: [ANNOUNCEMENT, '', REAL_PROSE, '', SCORE_RUN].join('\n'), name: 'brown_fur' },
            { strategy: 'combined' },
        );
        expect(result.text).toContain(REAL_PROSE);
        expect(result.text).not.toContain('Have you heard');
        expect(result.text).not.toContain('verification');
        expect(result.text).not.toMatch(/\d+ \d+ [SQE]\s+\d+ \d+ [SQE]/);
    });

    it('strips wiki noise per-page under per_page strategy with default cleaning settings', () => {
        const result = prepareWikiContent(
            {
                content: 'unused',
                name: 'e621-wiki',
                pages: [
                    { title: 'brown fur', content: [REAL_PROSE, SCORE_RUN].join('\n') },
                    { title: 'himbofication', content: ANNOUNCEMENT + '\nThe process of transforming into an individual dumb brute or stud.' },
                ],
            },
            { strategy: 'per_page' },
        );
        expect(result.text).toHaveLength(2);
        expect(result.text[0].text).toContain(REAL_PROSE);
        expect(result.text[0].text).not.toMatch(/\d+ \d+ [SQE]\s+\d+ \d+ [SQE]/);
        expect(result.text[1].text).toContain('The process of transforming into an individual dumb brute or stud.');
        expect(result.text[1].text).not.toContain('Have you heard');
        // Title header itself is untouched
        expect(result.text[0].text).toContain('# brown fur');
        expect(result.text[0].metadata.pageTitle).toBe('brown fur');
    });

    it('drops a page whose content is entirely wiki noise (empty after cleaning)', () => {
        const result = prepareWikiContent(
            {
                content: 'unused',
                name: 'e621-wiki',
                pages: [
                    { title: 'pure noise', content: ANNOUNCEMENT },
                    { title: 'real page', content: REAL_PROSE },
                ],
            },
            { strategy: 'per_page' },
        );
        expect(result.text).toHaveLength(1);
        expect(result.text[0].metadata.pageTitle).toBe('real page');
    });

    it('does not touch content type outside wiki (sanity: user cleaning settings alone, unaffected by wiki-noise patterns)', () => {
        // Regression guard: cleanWikiNoise is scoped to prepareWikiContent's
        // callers only — verify a normal sentence with an incidental
        // number-triplet (the kind a stat table might contain) survives.
        const result = prepareWikiContent(
            { content: 'She rolled 3 8 E in the dice game and laughed.', name: 'doc' },
            { strategy: 'combined' },
        );
        expect(result.text).toContain('rolled 3 8 E in the dice game');
    });
});
