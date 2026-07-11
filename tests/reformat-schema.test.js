/**
 * Unit tests for core/reformat-schema.js
 *
 * Covers the Auto-Reformat schema validator, hallucination guardrail
 * (computeNameVerification), and prompt builder. Pure module, no ST globals
 * — no mocking required (same convention as glossary-extractor.test.js).
 */

import { describe, it, expect } from 'vitest';
import {
    REFORMAT_ENTRY_TYPES,
    validateReformattedChunk,
    computeNameVerification,
    computeKeywordVerification,
    buildReformatPrompt,
    buildRelationalClause,
} from '../core/reformat-schema.js';

describe('validateReformattedChunk', () => {
    it('accepts a well-formed record and normalizes array fields', () => {
        const { ok, errors, chunk } = validateReformattedChunk({
            entry_type: 'character',
            name: '  Bulwark  ',
            aliases: ['Eleanor Graves', 'Eleanor Graves', '  '],
            affiliation: 'Ironclad Agency',
            traits: ['Transformation-type Spark'],
            relationships: [],
            keywords: [{ text: 'Ironclad', importance: 6 }, { text: 'Fortress', importance: 9 }],
            body: 'Bulwark is the lead hero of Ironclad Agency.',
        });

        expect(ok).toBe(true);
        expect(errors).toEqual([]);
        expect(chunk).toEqual({
            entry_type: 'character',
            name: 'Bulwark',
            aliases: ['Eleanor Graves'], // deduped + trimmed + empties dropped
            affiliation: 'Ironclad Agency',
            traits: ['Transformation-type Spark'],
            relationships: [],
            keywords: [{ text: 'Ironclad', importance: 6 }, { text: 'Fortress', importance: 9 }],
            body: 'Bulwark is the lead hero of Ironclad Agency.',
        });
    });

    it('accepts legacy plain-string keywords and defaults their importance to 5', () => {
        const { chunk } = validateReformattedChunk({
            entry_type: 'concept', name: 'X', body: 'Y',
            keywords: ['legacy term'],
        });
        expect(chunk.keywords).toEqual([{ text: 'legacy term', importance: 5 }]);
    });

    it('clamps out-of-range keyword importance to 1-10 and rounds fractional values', () => {
        const { chunk } = validateReformattedChunk({
            entry_type: 'concept', name: 'X', body: 'Y',
            keywords: [
                { text: 'too high', importance: 99 },
                { text: 'too low', importance: -5 },
                { text: 'fractional', importance: 6.7 },
                { text: 'not a number', importance: 'high' },
            ],
        });
        expect(chunk.keywords).toEqual([
            { text: 'too high', importance: 10 },
            { text: 'too low', importance: 1 },
            { text: 'fractional', importance: 7 },
            { text: 'not a number', importance: 5 },
        ]);
    });

    it('dedupes keywords by case-insensitive text, keeping the first occurrence', () => {
        const { chunk } = validateReformattedChunk({
            entry_type: 'concept', name: 'X', body: 'Y',
            keywords: [{ text: 'Fortress', importance: 9 }, { text: 'FORTRESS', importance: 2 }],
        });
        expect(chunk.keywords).toEqual([{ text: 'Fortress', importance: 9 }]);
    });

    it('rejects a non-object input', () => {
        const { ok, errors } = validateReformattedChunk('not an object');
        expect(ok).toBe(false);
        expect(errors[0]).toMatch(/not an object/);
    });

    it('rejects a record with no name', () => {
        const { ok, errors } = validateReformattedChunk({ entry_type: 'concept', body: 'Some lore.' });
        expect(ok).toBe(false);
        expect(errors).toEqual(['name is empty or missing']);
    });

    it('rejects a record with no body', () => {
        const { ok, errors } = validateReformattedChunk({ entry_type: 'concept', name: 'Spark Classification' });
        expect(ok).toBe(false);
        expect(errors).toEqual(['body is empty or missing']);
    });

    it('coerces an unknown entry_type to "other" and reports it', () => {
        const { ok, errors, chunk } = validateReformattedChunk({
            entry_type: 'villain_org', // not in vocabulary
            name: 'The Daughters of the Awakening',
            body: 'A female supremacist paramilitary organization.',
        });

        expect(ok).toBe(true);
        expect(chunk.entry_type).toBe('other');
        expect(errors.some(e => /not in vocabulary/.test(e))).toBe(true);
    });

    it('every declared entry_type round-trips without coercion', () => {
        for (const entry_type of REFORMAT_ENTRY_TYPES) {
            const { ok, errors, chunk } = validateReformattedChunk({ entry_type, name: 'X', body: 'Y' });
            expect(ok).toBe(true);
            expect(chunk.entry_type).toBe(entry_type);
            expect(errors).toEqual([]);
        }
    });

    it('defaults affiliation to an empty string when missing', () => {
        const { chunk } = validateReformattedChunk({ entry_type: 'concept', name: 'X', body: 'Y' });
        expect(chunk.affiliation).toBe('');
        expect(chunk.aliases).toEqual([]);
        expect(chunk.traits).toEqual([]);
        expect(chunk.relationships).toEqual([]);
        expect(chunk.keywords).toEqual([]);
    });

    it('coerces a relationship object into readable text instead of "[object Object]", and reports it', () => {
        const { ok, errors, chunk } = validateReformattedChunk({
            entry_type: 'organization',
            name: 'Empire of the Rising Sun',
            body: 'A militant feline aristocracy allied with the Reich.',
            relationships: [{ target: 'The Reich', type: 'alliance' }],
        });

        expect(ok).toBe(true);
        expect(chunk.relationships).toEqual(['The Reich — alliance']);
        expect(chunk.relationships.join(' ')).not.toContain('[object Object]');
        expect(errors.some(e => /relationships.*object/.test(e))).toBe(true);
    });

    it('falls back to JSON.stringify for a relationship object with no recognizable keys', () => {
        const { chunk, errors } = validateReformattedChunk({
            entry_type: 'organization',
            name: 'X',
            body: 'Y',
            relationships: [{ unrecognizedKey: 'value' }],
        });

        expect(chunk.relationships).toEqual(['{"unrecognizedKey":"value"}']);
        expect(errors.some(e => /relationships.*object/.test(e))).toBe(true);
    });

    it('applies the same object-coercion safety net to aliases and traits', () => {
        const { chunk, errors } = validateReformattedChunk({
            entry_type: 'character',
            name: 'X',
            body: 'Y',
            aliases: [{ name: 'The Masked One' }],
            traits: [{ description: 'Superhuman strength' }],
        });

        expect(chunk.aliases).toEqual(['The Masked One']);
        expect(chunk.traits).toEqual(['Superhuman strength']);
        expect(errors.some(e => /aliases.*object/.test(e))).toBe(true);
        expect(errors.some(e => /traits.*object/.test(e))).toBe(true);
    });

    it('does not report a coercion warning for well-formed plain-string arrays', () => {
        const { errors } = validateReformattedChunk({
            entry_type: 'character',
            name: 'X',
            body: 'Y',
            relationships: ['Leader of the Inner Circle'],
        });
        expect(errors).toEqual([]);
    });
});

describe('computeNameVerification', () => {
    const source = 'Bulwark (Eleanor Graves) leads Ironclad Agency. Her Spark is called Fortress.';

    it('grounds a name that appears verbatim in the source', () => {
        const [result] = computeNameVerification([{ name: 'Bulwark', aliases: [] }], source);
        expect(result.nameGrounded).toBe(true);
        expect(result.ungroundedAliases).toEqual([]);
    });

    it('grounds a name regardless of case/punctuation differences', () => {
        const [result] = computeNameVerification([{ name: 'ELEANOR, GRAVES' }], source);
        expect(result.nameGrounded).toBe(true);
    });

    it('flags a name that does not appear anywhere in the source', () => {
        const [result] = computeNameVerification([{ name: 'Solaris', aliases: [] }], source);
        expect(result.nameGrounded).toBe(false);
    });

    it('flags only the ungrounded aliases, not the grounded ones', () => {
        const [result] = computeNameVerification(
            [{ name: 'Bulwark', aliases: ['Eleanor Graves', 'Steel Maiden'] }],
            source,
        );
        expect(result.nameGrounded).toBe(true);
        expect(result.ungroundedAliases).toEqual(['Steel Maiden']);
    });

    it('treats every chunk as grounded when sourceText is empty (nothing to check against)', () => {
        const result = computeNameVerification([{ name: 'Anyone' }], '');
        expect(result).toEqual([{ nameGrounded: true, ungroundedAliases: [] }]);
    });

    it('returns an empty array for non-array input', () => {
        expect(computeNameVerification(null, source)).toEqual([]);
    });
});

describe('computeKeywordVerification', () => {
    const source = 'Bulwark (Eleanor Graves) leads Ironclad Agency. Her Spark is called Fortress.';

    it('grounds a keyword that appears verbatim in the source', () => {
        const [result] = computeKeywordVerification([{ keywords: [{ text: 'Fortress', importance: 9 }] }], source);
        expect(result.ungroundedKeywords).toEqual([]);
    });

    it('flags a keyword that does not appear anywhere in the source', () => {
        const [result] = computeKeywordVerification(
            [{ keywords: [{ text: 'betrayal', importance: 6 }] }],
            source,
        );
        expect(result.ungroundedKeywords).toEqual(['betrayal']);
    });

    it('flags only the ungrounded keywords, not the grounded ones', () => {
        const [result] = computeKeywordVerification(
            [{ keywords: [{ text: 'Fortress', importance: 9 }, { text: 'betrayal', importance: 3 }] }],
            source,
        );
        expect(result.ungroundedKeywords).toEqual(['betrayal']);
    });

    it('accepts legacy plain-string keywords', () => {
        const [result] = computeKeywordVerification([{ keywords: ['Fortress', 'betrayal'] }], source);
        expect(result.ungroundedKeywords).toEqual(['betrayal']);
    });

    it('treats every chunk as grounded when sourceText is empty (nothing to check against)', () => {
        const result = computeKeywordVerification([{ keywords: [{ text: 'anything', importance: 5 }] }], '');
        expect(result).toEqual([{ ungroundedKeywords: [] }]);
    });

    it('returns an empty array for non-array input', () => {
        expect(computeKeywordVerification(null, source)).toEqual([]);
    });

    it('uses a softer default threshold than computeNameVerification', () => {
        // "Iron Agency" is a near-miss for "Ironclad Agency" in the source
        // (similarity ~0.73) — grounded under the keyword threshold (0.7)
        // but not under the stricter name threshold (0.8), demonstrating
        // keywords get more slack than names/aliases.
        const keyword = 'Iron Agency';
        const [keywordResult] = computeKeywordVerification([{ keywords: [{ text: keyword, importance: 5 }] }], source);
        const [nameResult] = computeNameVerification([{ name: keyword, aliases: [] }], source);

        expect(keywordResult.ungroundedKeywords).toEqual([]);
        expect(nameResult.nameGrounded).toBe(false);
    });
});

describe('buildReformatPrompt', () => {
    it('substitutes {{text}} into the default template', () => {
        const prompt = buildReformatPrompt('SOME SOURCE TEXT HERE');
        expect(prompt).toContain('SOME SOURCE TEXT HERE');
        expect(prompt).toContain('entry_type');
        expect(prompt).not.toContain('{{text}}');
    });

    it('has no continuation note when batchContext is not provided', () => {
        const prompt = buildReformatPrompt('body text');
        expect(prompt).not.toMatch(/continuation of section/i);
    });

    it('injects a continuation note listing already-extracted names', () => {
        const prompt = buildReformatPrompt('more text', {
            batchContext: { sectionTitle: 'Notable US Hero Agencies', alreadyExtractedNames: ['Columbia', 'Bulwark'] },
        });
        expect(prompt).toMatch(/continuation of section "Notable US Hero Agencies"/);
        expect(prompt).toContain('Columbia, Bulwark');
        expect(prompt).toMatch(/Do NOT re-emit them/);
    });

    it('shows "(none yet)" when the continuation has no prior names', () => {
        const prompt = buildReformatPrompt('more text', {
            batchContext: { sectionTitle: 'The Daughters of the Awakening', alreadyExtractedNames: [] },
        });
        expect(prompt).toContain('(none yet)');
    });

    it('uses a customPrompt override instead of the default template', () => {
        const prompt = buildReformatPrompt('MY TEXT', { customPrompt: 'Custom instructions.\n\n{{text}}' });
        expect(prompt).toBe('Custom instructions.\n\nMY TEXT');
    });
});

describe('buildRelationalClause', () => {
    it('returns empty string when both affiliation and relationships are empty', () => {
        expect(buildRelationalClause('', [])).toBe('');
        expect(buildRelationalClause('', undefined)).toBe('');
        expect(buildRelationalClause(undefined, undefined)).toBe('');
    });

    it('includes only the affiliation clause when relationships is empty', () => {
        expect(buildRelationalClause('The Reich', [])).toBe(' Affiliated with The Reich.');
    });

    it('includes only the relationships clause when affiliation is empty', () => {
        expect(buildRelationalClause('', ['Leader of the Inner Circle'])).toBe(' Related: Leader of the Inner Circle.');
    });

    it('joins multiple relationships with semicolons', () => {
        expect(buildRelationalClause('', ['Schutzstaffel (parent organization)', 'Reports to Oberkatze']))
            .toBe(' Related: Schutzstaffel (parent organization); Reports to Oberkatze.');
    });

    it('combines affiliation and relationships in one trailer', () => {
        expect(buildRelationalClause('Reich', ['Leader of the Inner Circle']))
            .toBe(' Affiliated with Reich. Related: Leader of the Inner Circle.');
    });

    it('trims whitespace and drops blank relationship entries', () => {
        expect(buildRelationalClause('  Reich  ', ['  ', 'Leader of the Inner Circle  ', '']))
            .toBe(' Affiliated with Reich. Related: Leader of the Inner Circle.');
    });

    it('is appendable directly onto a body string with a single leading space', () => {
        const clause = buildRelationalClause('Reich', ['Leader of the Inner Circle']);
        const body = 'Oberkatze rose to power through the movement.';
        expect(body + clause).toBe('Oberkatze rose to power through the movement. Affiliated with Reich. Related: Leader of the Inner Circle.');
    });
});
