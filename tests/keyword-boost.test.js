/**
 * Unit tests for keyword-boost.js
 * Tests keyword extraction, weighting, and boosting functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// keyword-boost.js → bm25-scorer.js → core/log.js → ../../../../extensions.js
// (a SillyTavern host path that doesn't resolve under vitest). Mock it.
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ chat: [], characterId: null })),
}));

// Mock the SillyTavern substituteParams function
vi.mock('../../../../../script.js', () => ({
    substituteParams: vi.fn((str) => {
        // Simple mock that replaces common ST macros
        return str
            .replace(/\{\{char\}\}/gi, 'TestCharacter')
            .replace(/\{\{user\}\}/gi, 'TestUser');
    }),
}));

import {
    EXTRACTION_LEVELS,
    DEFAULT_EXTRACTION_LEVEL,
    DEFAULT_BASE_WEIGHT,
    extractLorebookKeywords,
    extractTextKeywords,
    extractTextKeywordsSimple,
    extractChatKeywords,
    extractBM25Keywords,
    getOverfetchAmount,
    keywordStemKey,
    dedupeKeywordsByStem,
} from '../core/keyword-boost.js';

// ============================================================================
// EXTRACTION_LEVELS Configuration Tests
// ============================================================================

describe('EXTRACTION_LEVELS', () => {
    it('should have all expected levels defined', () => {
        expect(EXTRACTION_LEVELS).toHaveProperty('off');
        expect(EXTRACTION_LEVELS).toHaveProperty('minimal');
        expect(EXTRACTION_LEVELS).toHaveProperty('balanced');
        expect(EXTRACTION_LEVELS).toHaveProperty('aggressive');
    });

    it('should have off level disabled', () => {
        expect(EXTRACTION_LEVELS.off.enabled).toBe(false);
    });

    it('should have minimal level configured correctly', () => {
        expect(EXTRACTION_LEVELS.minimal.enabled).toBe(true);
        expect(EXTRACTION_LEVELS.minimal.headerSize).toBe(1500);
        expect(EXTRACTION_LEVELS.minimal.maxKeywords).toBe(5);
        expect(EXTRACTION_LEVELS.minimal.minFrequency).toBe(1);
    });

    it('should have balanced level configured correctly', () => {
        expect(EXTRACTION_LEVELS.balanced.enabled).toBe(true);
        expect(EXTRACTION_LEVELS.balanced.headerSize).toBe(5000);
        expect(EXTRACTION_LEVELS.balanced.maxKeywords).toBe(12);
        expect(EXTRACTION_LEVELS.balanced.minFrequency).toBe(1);
    });

    it('should have aggressive level configured correctly', () => {
        expect(EXTRACTION_LEVELS.aggressive.enabled).toBe(true);
        expect(EXTRACTION_LEVELS.aggressive.headerSize).toBe(null); // Full text
        expect(EXTRACTION_LEVELS.aggressive.maxKeywords).toBe(15);
        expect(EXTRACTION_LEVELS.aggressive.minFrequency).toBe(1);
    });
});

describe('DEFAULT_EXTRACTION_LEVEL', () => {
    it('should be balanced', () => {
        expect(DEFAULT_EXTRACTION_LEVEL).toBe('balanced');
    });
});

describe('DEFAULT_BASE_WEIGHT', () => {
    it('should be 1.5', () => {
        expect(DEFAULT_BASE_WEIGHT).toBe(1.5);
    });
});

// ============================================================================
// extractLorebookKeywords Tests
// ============================================================================

describe('extractLorebookKeywords', () => {
    it('should return empty array for null/undefined entry', () => {
        expect(extractLorebookKeywords(null)).toEqual([]);
        expect(extractLorebookKeywords(undefined)).toEqual([]);
    });

    it('should extract primary keys', () => {
        const entry = {
            key: ['magic', 'wizard', 'spell'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
        expect(keywords).toContain('spell');
    });

    it('should extract secondary keys', () => {
        const entry = {
            key: ['dragon'],
            keysecondary: ['fire', 'scales'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('dragon');
        expect(keywords).toContain('fire');
        expect(keywords).toContain('scales');
    });

    it('should normalize keys to lowercase', () => {
        const entry = {
            key: ['MAGIC', 'Wizard', 'SpElL'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
        expect(keywords).toContain('spell');
    });

    it('should deduplicate keywords', () => {
        const entry = {
            key: ['magic', 'MAGIC', 'Magic'],
            keysecondary: ['magic'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords.filter(k => k === 'magic').length).toBe(1);
    });

    it('should filter out stopwords', () => {
        const entry = {
            key: ['the', 'magic', 'and', 'wizard'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).not.toContain('the');
        expect(keywords).not.toContain('and');
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
    });

    it('should filter out short words (less than 2 chars)', () => {
        const entry = {
            key: ['a', 'b', 'magic'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).not.toContain('a');
        expect(keywords).not.toContain('b');
        expect(keywords).toContain('magic');
    });

    it('should trim whitespace from keys', () => {
        const entry = {
            key: ['  magic  ', '  wizard  '],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
    });

    it('should skip empty or whitespace-only keys', () => {
        const entry = {
            key: ['magic', '', '   ', 'wizard'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords.length).toBe(2);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
    });

    it('should handle non-string keys gracefully', () => {
        const entry = {
            key: ['magic', 123, null, undefined, {}, 'wizard'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
        expect(keywords.length).toBe(2);
    });

    it('should handle custom stopwords from settings', () => {
        const entry = {
            key: ['dragon', 'customword', 'wizard'],
        };
        const settings = {
            custom_stopwords: 'customword, anotherword',
        };
        const keywords = extractLorebookKeywords(entry, settings);
        expect(keywords).not.toContain('customword');
        expect(keywords).toContain('dragon');
        expect(keywords).toContain('wizard');
    });

    it('should process ST macros in custom stopwords', () => {
        const entry = {
            key: ['testcharacter', 'testuser', 'wizard'],
        };
        const settings = {
            custom_stopwords: '{{char}}, {{user}}',
        };
        const keywords = extractLorebookKeywords(entry, settings);
        expect(keywords).not.toContain('testcharacter');
        expect(keywords).not.toContain('testuser');
        expect(keywords).toContain('wizard');
    });
});

// ============================================================================
// extractTextKeywords Tests
// ============================================================================

describe('extractTextKeywords', () => {
    it('should return empty array for null/undefined/empty text', () => {
        expect(extractTextKeywords(null)).toEqual([]);
        expect(extractTextKeywords(undefined)).toEqual([]);
        expect(extractTextKeywords('')).toEqual([]);
    });

    it('should return empty array for non-string input', () => {
        expect(extractTextKeywords(123)).toEqual([]);
        expect(extractTextKeywords({})).toEqual([]);
    });

    it('should return empty array when level is off', () => {
        const text = 'The wizard cast a powerful magic spell on the dragon.';
        const keywords = extractTextKeywords(text, { level: 'off' });
        expect(keywords).toEqual([]);
    });

    it('should extract keywords with default balanced level', () => {
        const text = 'The wizard wizard wizard cast a powerful magic spell on the dragon dragon.';
        const keywords = extractTextKeywords(text);
        expect(keywords.length).toBeGreaterThan(0);
        // Should have text and weight properties
        expect(keywords[0]).toHaveProperty('text');
        expect(keywords[0]).toHaveProperty('weight');
    });

    it('should respect maxKeywords limit for minimal level', () => {
        const text = 'Magic wizard spell dragon phoenix castle kingdom knight warrior princess'.repeat(10);
        const keywords = extractTextKeywords(text, { level: 'minimal' });
        expect(keywords.length).toBeLessThanOrEqual(EXTRACTION_LEVELS.minimal.maxKeywords);
    });

    it('should respect maxKeywords limit for balanced level', () => {
        const text = 'Magic wizard spell dragon phoenix castle kingdom knight warrior princess hero villain'.repeat(20);
        const keywords = extractTextKeywords(text, { level: 'balanced' });
        expect(keywords.length).toBeLessThanOrEqual(EXTRACTION_LEVELS.balanced.maxKeywords);
    });

    it('should respect maxKeywords limit for aggressive level', () => {
        const text = 'Magic wizard spell dragon phoenix castle kingdom knight warrior princess hero villain'.repeat(50);
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        expect(keywords.length).toBeLessThanOrEqual(EXTRACTION_LEVELS.aggressive.maxKeywords);
    });

    it('should filter out stopwords', () => {
        // Use words that are actually in the project stopword set
        // (core/stop-words.js). 'will' is NOT a stopword here, so asserting it
        // gets filtered was always wrong; 'within' is.
        const text = 'The wizard is going to the castle within the dragon lair.';
        const keywords = extractTextKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('the');
        expect(keywordTexts).not.toContain('within');
    });

    it('should assign higher weights to more frequent words', () => {
        const text = 'Dragon dragon dragon dragon dragon. Wizard wizard. Castle.';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });

        const dragonKeyword = keywords.find(k => k.text === 'dragon');
        const wizardKeyword = keywords.find(k => k.text === 'wizard');

        if (dragonKeyword && wizardKeyword) {
            expect(dragonKeyword.weight).toBeGreaterThanOrEqual(wizardKeyword.weight);
        }
    });

    it('should cap weights at MAX_KEYWORD_WEIGHT (3.0)', () => {
        const text = 'Dragon '.repeat(100);
        const keywords = extractTextKeywords(text, { level: 'aggressive' });

        for (const kw of keywords) {
            expect(kw.weight).toBeLessThanOrEqual(3.0);
        }
    });

    it('should use custom baseWeight when provided', () => {
        const text = 'Dragon dragon dragon wizard wizard castle';
        const keywords = extractTextKeywords(text, { level: 'aggressive', baseWeight: 2.0 });

        // Keywords should have weights >= 2.0
        for (const kw of keywords) {
            expect(kw.weight).toBeGreaterThanOrEqual(2.0);
        }
    });

    it('should remove parenthetical citations', () => {
        const text = 'The dragon (Source: Ancient Tome) breathes fire (See page 42).';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('source');
        expect(keywordTexts).not.toContain('ancient');
        expect(keywordTexts).not.toContain('tome');
    });

    it('should remove italicized text', () => {
        const text = 'The dragon *this is an example* breathes *another example* fire.';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('example');
    });

    it('should strip possessive \'s', () => {
        const text = "Strovolos's domain is vast. Strovolos's power is legendary.";
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        // Should have 'strovolos' not 'strovolo'
        expect(keywordTexts.some(t => t.includes('strovolo'))).toBe(true);
    });

    it('should extract compound terms with / or _', () => {
        const text = 'The divine/time god controls time_flow and space_warp.';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts.some(t => t.includes('_'))).toBe(true);
    });

    it('should include frequency count in output', () => {
        const text = 'Dragon dragon dragon wizard';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const dragonKeyword = keywords.find(k => k.text === 'dragon');

        expect(dragonKeyword).toBeDefined();
        expect(dragonKeyword.frequency).toBe(3);
    });

    it('should sort keywords by weight descending', () => {
        const text = 'Dragon dragon dragon dragon. Wizard wizard. Castle.';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });

        for (let i = 1; i < keywords.length; i++) {
            expect(keywords[i - 1].weight).toBeGreaterThanOrEqual(keywords[i].weight);
        }
    });

    it('should preserve proper nouns without stemming', () => {
        const text = 'Gandalf is a powerful wizard. Gandalf casts spells.';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        // 'Gandalf' should be preserved as-is (lowercased)
        expect(keywordTexts).toContain('gandalf');
    });

    it('shows the real surface form, not the stemmer artifact ("abiliti" bug)', () => {
        const text = 'Her abilities were remarkable. His abilities grew each day. Their abilities combined well.';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const texts = keywords.map(k => k.text);
        expect(texts).toContain('abilities');
        expect(texts).not.toContain('abiliti');
    });
});

// ============================================================================
// extractTextKeywordsSimple Tests
// ============================================================================

describe('extractTextKeywordsSimple', () => {
    it('should return array of strings only', () => {
        const text = 'Dragon dragon dragon wizard wizard castle';
        const keywords = extractTextKeywordsSimple(text, { level: 'aggressive' });

        expect(Array.isArray(keywords)).toBe(true);
        for (const kw of keywords) {
            expect(typeof kw).toBe('string');
        }
    });

    it('should return same keywords as extractTextKeywords but as strings', () => {
        const text = 'Dragon dragon dragon wizard wizard castle';
        const weightedKeywords = extractTextKeywords(text, { level: 'aggressive' });
        const simpleKeywords = extractTextKeywordsSimple(text, { level: 'aggressive' });

        expect(simpleKeywords).toEqual(weightedKeywords.map(k => k.text));
    });
});

// ============================================================================
// extractChatKeywords Tests
// ============================================================================

describe('extractChatKeywords', () => {
    it('should return empty array for null/undefined/empty text', () => {
        expect(extractChatKeywords(null)).toEqual([]);
        expect(extractChatKeywords(undefined)).toEqual([]);
        expect(extractChatKeywords('')).toEqual([]);
    });

    it('should return empty array for non-string input', () => {
        expect(extractChatKeywords(123)).toEqual([]);
        expect(extractChatKeywords({})).toEqual([]);
    });

    it('should extract capitalized proper nouns', () => {
        const text = 'I met Gandalf yesterday and he told me about Mordor.';
        const keywords = extractChatKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).toContain('gandalf');
        expect(keywordTexts).toContain('mordor');
    });

    it('should not extract words at sentence start', () => {
        const text = 'Yesterday was great. Today is better.';
        const keywords = extractChatKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        // These are at sentence start so shouldn't be extracted
        expect(keywordTexts).not.toContain('yesterday');
        expect(keywordTexts).not.toContain('today');
    });

    it('should respect maxKeywords limit', () => {
        const text = 'I talked to Gandalf, Frodo, Aragorn, Legolas, Gimli, Boromir, Samwise, Merry, Pippin, and Elrond.';
        const keywords = extractChatKeywords(text, { maxKeywords: 5 });
        expect(keywords.length).toBeLessThanOrEqual(5);
    });

    it('should use default baseWeight of 1.5', () => {
        const text = 'I met Gandalf yesterday.';
        const keywords = extractChatKeywords(text);
        if (keywords.length > 0) {
            expect(keywords[0].weight).toBe(DEFAULT_BASE_WEIGHT);
        }
    });

    it('should use custom baseWeight when provided', () => {
        const text = 'I met Gandalf yesterday.';
        const keywords = extractChatKeywords(text, { baseWeight: 2.5 });
        if (keywords.length > 0) {
            expect(keywords[0].weight).toBe(2.5);
        }
    });

    it('should deduplicate proper nouns', () => {
        const text = 'Gandalf said hello. Then Gandalf left.';
        const keywords = extractChatKeywords(text);
        const gandolfCount = keywords.filter(k => k.text === 'gandalf').length;
        expect(gandolfCount).toBeLessThanOrEqual(1);
    });

    it('should filter out stopwords even if capitalized', () => {
        const text = 'The wizard went to the castle.';
        const keywords = extractChatKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('the');
    });

    it('should extract words after quotes and asterisks', () => {
        const text = '"Hello," said Gandalf. *Gandalf smiled* at Frodo.';
        const keywords = extractChatKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).toContain('gandalf');
    });
});

// ============================================================================
// extractBM25Keywords Tests
// ============================================================================

describe('extractBM25Keywords', () => {
    it('should return empty array for null/undefined/empty text', () => {
        expect(extractBM25Keywords(null)).toEqual([]);
        expect(extractBM25Keywords(undefined)).toEqual([]);
        expect(extractBM25Keywords('')).toEqual([]);
        expect(extractBM25Keywords('   ')).toEqual([]);
    });

    it('should return empty array when level is off', () => {
        const text = 'The wizard cast a powerful magic spell on the dragon.';
        const keywords = extractBM25Keywords(text, { level: 'off' });
        expect(keywords).toEqual([]);
    });

    it('should extract keywords using TF-IDF scoring', () => {
        const text = 'The dragon breathes fire. The dragon is powerful. Dragons are mythical creatures.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        expect(keywords.length).toBeGreaterThan(0);
        expect(keywords[0]).toHaveProperty('text');
        expect(keywords[0]).toHaveProperty('weight');
        expect(keywords[0]).toHaveProperty('tfidf');
    });

    it('should respect header size for minimal level', () => {
        const minimalHeaderSize = EXTRACTION_LEVELS.minimal.headerSize;

        // Keep phoenix strictly inside the minimal header window.
        const headerText = 'The phoenix rises from ashes. Phoenix is majestic. Legendary phoenix soars high. '.repeat(10);

        // Ensure unicorn starts strictly after the minimal header boundary.
        const paddingNeeded = Math.max(0, (minimalHeaderSize - headerText.length) + 50);
        const padding = 'x'.repeat(paddingNeeded);

        // Unicorn text should be outside the minimal scan window.
        const tailText = 'Unicorn gallops through forest. Magical unicorn appears. ' +
            'The unicorn is beautiful. Rare unicorn sighting reported. '.repeat(3);
        const text = headerText + padding + tailText;

        // Verify test setup guarantees unicorn starts after scan boundary.
        expect(headerText.length).toBeLessThan(minimalHeaderSize);
        expect(headerText.length + padding.length).toBeGreaterThan(minimalHeaderSize);

        const keywords = extractBM25Keywords(text, { level: 'minimal' });
        const keywordTexts = keywords.map(k => k.text);

        // Phoenix should be found (inside minimal scan window).
        expect(keywordTexts.some(t => t.includes('phoenix'))).toBe(true);
        // Unicorn should NOT be found (outside minimal scan window).
        expect(keywordTexts.some(t => t.includes('unicorn'))).toBe(false);
    });

    it('should scan full text for aggressive level', () => {
        const prefix = 'Common words here. '.repeat(100);
        const suffix = 'Unique dragon appears once at the end.';
        const text = prefix + suffix;

        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts.some(t => t.includes('dragon') || t.includes('uniqu'))).toBe(true);
    });

    it('should respect maxKeywords limit', () => {
        const text = 'Dragon wizard spell phoenix castle kingdom knight warrior princess hero villain monster creature'.repeat(10);
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        expect(keywords.length).toBeLessThanOrEqual(EXTRACTION_LEVELS.aggressive.maxKeywords);
    });

    it('should filter out stopwords', () => {
        // 'will' is NOT in the project stopword set (core/stop-words.js); 'within'
        // is. Assert on words that are actually treated as stopwords.
        const text = 'The wizard is going to the castle within the dragon lair and tower.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('the');
        expect(keywordTexts).not.toContain('within');
    });

    it('should respect minWordLength option', () => {
        const text = 'A is to be or not be. Dragon wizard.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive', minWordLength: 4 });
        const keywordTexts = keywords.map(k => k.text);
        for (const kw of keywordTexts) {
            expect(kw.length).toBeGreaterThanOrEqual(4);
        }
    });

    it('should boost capitalized words', () => {
        const text = 'gandalf the wizard met GANDALF again. gandalf gandalf gandalf.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        // Should find gandalf with boost
        expect(keywords.some(k => k.text.includes('gandalf'))).toBe(true);
    });

    it('should strip possessive \'s', () => {
        const text = "Strovolos's domain. Strovolos's power. Strovolos's realm.";
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts.some(t => t.includes('strovolo'))).toBe(true);
    });

    it('should include TF-IDF score in output', () => {
        const text = 'Dragon dragon dragon. Wizard wizard. Castle.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });

        for (const kw of keywords) {
            expect(kw).toHaveProperty('tfidf');
            expect(typeof kw.tfidf).toBe('number');
            expect(kw.tfidf).toBeGreaterThan(0);
        }
    });

    it('should sort by TF-IDF score descending', () => {
        const text = 'Dragon dragon dragon dragon. Wizard wizard. Castle.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });

        for (let i = 1; i < keywords.length; i++) {
            expect(keywords[i - 1].tfidf).toBeGreaterThanOrEqual(keywords[i].tfidf);
        }
    });

    it('shows real surface forms for words the stemmer mangles (reproduces "abiliti"/"referenc"/"femal"/"manifestate")', () => {
        const text = 'The character discovered new abilities during training. Her abilities grew stronger ' +
            'with each passing reference to the ancient manifestation. Every reference in the old book ' +
            'praised her abilities. The female mentor recognized the manifestation of power. This female ' +
            'warrior had rare abilities beyond reference.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive', maxKeywords: 15 });
        const texts = keywords.map(k => k.text);
        for (const garbled of ['abiliti', 'referenc', 'femal', 'manifestate']) {
            expect(texts).not.toContain(garbled);
        }
        expect(texts).toContain('abilities');
    });
});

// ============================================================================
// keywordStemKey Tests
// ============================================================================

describe('keywordStemKey', () => {
    it('maps a stem and its real surface form to the same key', () => {
        expect(keywordStemKey('abiliti')).toBe(keywordStemKey('abilities'));
    });

    it('stems multi-word phrases per-token, not as one blob', () => {
        expect(keywordStemKey('fire abilities')).toBe(keywordStemKey('fire abiliti'));
    });

    it('passes CJK text through unchanged', () => {
        expect(keywordStemKey('魔法')).toBe('魔法');
    });

    it('guards empty/non-string input', () => {
        expect(keywordStemKey('')).toBe('');
        expect(keywordStemKey(null)).toBe('');
        expect(keywordStemKey(undefined)).toBe('');
        expect(keywordStemKey('   ')).toBe('');
    });
});

// ============================================================================
// dedupeKeywordsByStem Tests
// ============================================================================

describe('dedupeKeywordsByStem', () => {
    it('collapses a heuristic stem and its LLM-authored real-word duplicate, keeping the higher-weight (real word) entry', () => {
        const deduped = dedupeKeywordsByStem([
            { text: 'abiliti', weight: 1.7 },
            { text: 'abilities', weight: 2.0 },
        ]);
        expect(deduped).toHaveLength(1);
        expect(deduped[0].text).toBe('abilities');
    });

    it('leaves genuinely distinct concepts separate', () => {
        const deduped = dedupeKeywordsByStem([
            { text: 'dragon', weight: 1.5 },
            { text: 'wizard', weight: 1.5 },
        ]);
        expect(deduped).toHaveLength(2);
    });
});

// ============================================================================
// getOverfetchAmount Tests
// ============================================================================

describe('getOverfetchAmount', () => {
    it('should return 2x the requested amount', () => {
        expect(getOverfetchAmount(10)).toBe(20);
        expect(getOverfetchAmount(25)).toBe(50);
    });

    it('should have minimum of 10', () => {
        expect(getOverfetchAmount(1)).toBe(10);
        expect(getOverfetchAmount(3)).toBe(10);
    });

    it('should have maximum of 100', () => {
        expect(getOverfetchAmount(60)).toBe(100);
        expect(getOverfetchAmount(100)).toBe(100);
    });

    it('should handle edge cases', () => {
        expect(getOverfetchAmount(0)).toBe(10); // min 10
        expect(getOverfetchAmount(5)).toBe(10); // 2*5=10
        expect(getOverfetchAmount(50)).toBe(100); // 2*50=100 (max)
    });
});

// ============================================================================
// Edge Cases and Integration Tests
// ============================================================================

describe('Edge Cases', () => {
    it('should handle very long text without crashing', () => {
        const longText = 'Dragon wizard castle knight '.repeat(10000);

        expect(() => extractTextKeywords(longText, { level: 'aggressive' })).not.toThrow();
        expect(() => extractBM25Keywords(longText, { level: 'aggressive' })).not.toThrow();
    });

    it('should handle text with special characters', () => {
        const text = 'The dragon!!! cast a spell??? on the wizard... @#$%^&*()';

        expect(() => extractTextKeywords(text)).not.toThrow();
        expect(() => extractBM25Keywords(text)).not.toThrow();
    });

    it('should handle unicode text', () => {
        const text = 'The dragon 龍 breathes fire 火. The wizard 巫師 casts spells.';

        expect(() => extractTextKeywords(text)).not.toThrow();
        expect(() => extractBM25Keywords(text)).not.toThrow();
    });

    it('should handle text with only stopwords', () => {
        const text = 'The and is are was were been being have has had having do does did doing';

        const keywords1 = extractTextKeywords(text);
        const keywords2 = extractBM25Keywords(text);

        expect(keywords1).toEqual([]);
        expect(keywords2).toEqual([]);
    });

    it('should handle text with only short words', () => {
        const text = 'A b c d e f g h i j k l m n o p';

        const keywords = extractTextKeywords(text);
        expect(keywords).toEqual([]);
    });
});

// ============================================================================
// getCombinedStopwords caching (base Set memoized per CJK mode; correctness
// of the settings/macro-dependent custom-stopwords overlay must survive it)
// ============================================================================

describe('getCombinedStopwords caching (via extractLorebookKeywords)', () => {
    it('does not leak one call\'s custom stopwords into a later call with no custom stopwords', () => {
        const withCustom = extractLorebookKeywords(
            { key: ['dragon', 'leakword'] },
            { custom_stopwords: 'leakword' },
        );
        expect(withCustom).not.toContain('leakword');

        // A subsequent call with NO custom_stopwords must not still filter
        // 'leakword' — that would mean the shared cached base Set was mutated
        // in place by the first call instead of cloned before adding customs.
        const withoutCustom = extractLorebookKeywords(
            { key: ['dragon', 'leakword'] },
            {},
        );
        expect(withoutCustom).toContain('leakword');
    });

    it('does not leak one settings object\'s custom stopwords into a sibling call with different custom stopwords', () => {
        const a = extractLorebookKeywords(
            { key: ['alpha', 'beta'] },
            { custom_stopwords: 'alpha' },
        );
        const b = extractLorebookKeywords(
            { key: ['alpha', 'beta'] },
            { custom_stopwords: 'beta' },
        );
        expect(a).not.toContain('alpha');
        expect(a).toContain('beta'); // 'beta' from A's custom list must not appear
        expect(b).toContain('alpha'); // 'alpha' from B's custom list must not appear
        expect(b).not.toContain('beta');
    });

    it('re-substitutes {{char}}/{{user}} macros on every call rather than caching a stale expansion', () => {
        // Same raw custom_stopwords string, but the active character changes
        // between calls (simulated via the substituteParams mock's fixed
        // TestCharacter/TestUser output vs. a literal word matching that output).
        const settings = { custom_stopwords: '{{char}}' };
        const first = extractLorebookKeywords({ key: ['testcharacter', 'wizard'] }, settings);
        expect(first).not.toContain('testcharacter'); // {{char}} → "TestCharacter" per the mock

        // A second call with a DIFFERENT settings object (no custom_stopwords)
        // must see 'testcharacter' as a normal, non-filtered word — proving
        // the macro expansion from the first call wasn't baked into a shared cache.
        const second = extractLorebookKeywords({ key: ['testcharacter', 'wizard'] }, {});
        expect(second).toContain('testcharacter');
    });

    it('base stopword filtering (no custom words) is unaffected by caching across repeated calls', () => {
        for (let i = 0; i < 3; i++) {
            const keywords = extractLorebookKeywords({ key: ['the', 'dragon', 'and'] }, {});
            expect(keywords).toEqual(['dragon']);
        }
    });
});
