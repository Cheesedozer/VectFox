/**
 * Unit tests for core/reformat-schema.js
 *
 * Covers the Auto-Reformat validator, stored-text builder, grounding and
 * coverage guardrails, and prompt builders. Pure module, no ST globals.
 */

import { describe, it, expect } from 'vitest';
import {
    REFORMAT_ENTRY_TYPES,
    HIDDEN_TRUTH_TAG,
    validateReformattedChunk,
    computeNameVerification,
    computeKeywordVerification,
    buildReformatPrompt,
    buildRepairPrompt,
    buildRosterPrompt,
    buildStoredText,
    buildLinkingPrompt,
    computeBatchCoverage,
} from '../core/reformat-schema.js';

describe('validateReformattedChunk', () => {
    it('accepts a well-formed record and normalizes array fields', () => {
        const { ok, errors, chunk } = validateReformattedChunk({
            entry_type: 'character',
            name: '  Bulwark  ',
            aliases: ['Eleanor Graves', 'Eleanor Graves', '  ', 'bulwark'],
            affiliation: 'Ironclad Agency',
            relationships: [],
            keywords: ['Ironclad', 'Fortress', 'fortress'],
            hidden: false,
            body: 'Bulwark is the lead hero of Ironclad Agency.',
        });

        expect(ok).toBe(true);
        expect(errors).toEqual([]);
        expect(chunk).toEqual({
            entry_type: 'character',
            name: 'Bulwark',
            aliases: ['Eleanor Graves'], // deduped, trimmed, empties and the name itself dropped
            affiliation: 'Ironclad Agency',
            relationships: [],
            keywords: ['Ironclad', 'Fortress'],
            hidden: false,
            body: 'Bulwark is the lead hero of Ironclad Agency.',
        });
    });

    it('drops fields that are no longer part of the schema (traits)', () => {
        const { chunk } = validateReformattedChunk({ entry_type: 'concept', name: 'X', body: 'Y', traits: ['old'] });
        expect(chunk).not.toHaveProperty('traits');
    });

    it('accepts legacy {text, importance} keywords as plain strings without a coercion note', () => {
        const { chunk, errors } = validateReformattedChunk({
            entry_type: 'concept', name: 'X', body: 'Y',
            keywords: [{ text: 'legacy term', importance: 9 }, 'plain'],
        });
        expect(chunk.keywords).toEqual(['legacy term', 'plain']);
        expect(errors).toEqual([]);
    });

    it('reads hidden as a boolean, accepting the string "true"', () => {
        const base = { entry_type: 'concept', name: 'X', body: 'Y' };
        expect(validateReformattedChunk({ ...base, hidden: true }).chunk.hidden).toBe(true);
        expect(validateReformattedChunk({ ...base, hidden: 'true' }).chunk.hidden).toBe(true);
        expect(validateReformattedChunk({ ...base, hidden: 'no' }).chunk.hidden).toBe(false);
        expect(validateReformattedChunk(base).chunk.hidden).toBe(false);
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

    it('defaults optional fields when missing', () => {
        const { chunk } = validateReformattedChunk({ entry_type: 'concept', name: 'X', body: 'Y' });
        expect(chunk.affiliation).toBe('');
        expect(chunk.aliases).toEqual([]);
        expect(chunk.relationships).toEqual([]);
        expect(chunk.keywords).toEqual([]);
        expect(chunk.hidden).toBe(false);
    });

    it('accepts canonical {target, type} relationships without warnings and never produces "[object Object]"', () => {
        const { ok, errors, chunk } = validateReformattedChunk({
            entry_type: 'organization',
            name: 'Empire of the Rising Sun',
            body: 'A militant feline aristocracy allied with the Reich.',
            relationships: [{ target: 'The Reich', type: 'alliance' }],
        });

        expect(ok).toBe(true);
        expect(chunk.relationships).toEqual([{ target: 'The Reich', type: 'alliance' }]);
        expect(JSON.stringify(chunk.relationships)).not.toContain('[object Object]');
        expect(errors).toEqual([]);
    });

    it('coerces a legacy plain-string relationship to {target, type:""} and reports the reshaping', () => {
        const { chunk, errors } = validateReformattedChunk({
            entry_type: 'organization',
            name: 'Waffen-SS',
            body: 'Y',
            relationships: ['Schutzstaffel (parent organization)'],
        });

        // Parentheticals are deliberately NOT parsed out of strings — parens
        // legitimately appear in entity names.
        expect(chunk.relationships).toEqual([{ target: 'Schutzstaffel (parent organization)', type: '' }]);
        expect(errors.some(e => /relationships.*reshaping/.test(e))).toBe(true);
    });

    it('accepts alternate object keys (name/relation) for relationships and reports the reshaping', () => {
        const { chunk, errors } = validateReformattedChunk({
            entry_type: 'organization',
            name: 'X',
            body: 'Y',
            relationships: [{ name: 'Reich', relation: 'ally' }],
        });

        expect(chunk.relationships).toEqual([{ target: 'Reich', type: 'ally' }]);
        expect(errors.some(e => /relationships.*reshaping/.test(e))).toBe(true);
    });

    it('dedupes relationships by case-insensitive target+type and drops items with no resolvable target', () => {
        const { chunk, errors } = validateReformattedChunk({
            entry_type: 'organization',
            name: 'X',
            body: 'Y',
            relationships: [
                { target: 'Reich', type: 'ally' },
                { target: 'reich', type: 'ALLY' },
                { unrecognizedKey: 'value' },
            ],
        });

        expect(chunk.relationships).toEqual([{ target: 'Reich', type: 'ally' }]);
        expect(errors.some(e => /relationships.*no resolvable target/.test(e))).toBe(true);
    });

    it('applies the object-coercion safety net to aliases and keywords', () => {
        const { chunk, errors } = validateReformattedChunk({
            entry_type: 'character',
            name: 'X',
            body: 'Y',
            aliases: [{ name: 'The Masked One' }],
            keywords: [{ description: 'Superhuman strength' }],
        });

        expect(chunk.aliases).toEqual(['The Masked One']);
        expect(chunk.keywords).toEqual(['Superhuman strength']);
        expect(errors.some(e => /aliases.*object/.test(e))).toBe(true);
        expect(errors.some(e => /keywords.*object/.test(e))).toBe(true);
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

    it('grounds a compound sub-entry name when each component is grounded', () => {
        const subSource = '# Male Sympathizers\n\n## Demographic Composition\n\nSympathizers draw from specific segments.';
        const [result] = computeNameVerification(
            [{ name: 'Male Sympathizers: Demographic Composition', aliases: [] }],
            subSource,
        );
        expect(result.nameGrounded).toBe(true);
    });

    it('flags a compound name when one component is ungrounded', () => {
        const subSource = '# Male Sympathizers\n\nSome text with no such subsection.';
        const [result] = computeNameVerification(
            [{ name: 'Male Sympathizers: Demographic Composition', aliases: [] }],
            subSource,
        );
        expect(result.nameGrounded).toBe(false);
    });

    it('does not split intra-name hyphens as compound separators', () => {
        const [result] = computeNameVerification(
            [{ name: 'Jean-Luc', aliases: [] }],
            'Captain Jean-Luc commands the vessel.',
        );
        expect(result.nameGrounded).toBe(true);
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

describe('roster mode prompts', () => {
    const item = { id: 3, name: 'Zeus', aliases: ['Jupiter'], entry_type: 'character', hidden: false, scope: 'The king of the gods.', sources: ['B1'] };

    it('gives the roster step its numbered sections, the names so far and the mentioned items', () => {
        const prompt = buildRosterPrompt(
            [{ id: 'B4', headingPath: 'Myths › Zeus', text: 'Zeus rules the gods.' }],
            { part: 2, totalParts: 5, names: 'Zeus | Jupiter', mentioned: [item] },
        );
        expect(prompt).toContain('PART 2 OF 5');
        expect(prompt).toContain('[B4] Myths › Zeus\nZeus rules the gods.');
        expect(prompt).toContain('ROSTER SO FAR (name | aliases):\nZeus | Jupiter');
        expect(prompt).toContain('#3 Zeus [aliases: Jupiter] (character) — The king of the gods. Sources so far: B1');
        expect(prompt).toContain('"op": "update"');
    });

    it('adds the roster note to an extraction prompt and asks continuations to add under the same name', () => {
        const prompt = buildReformatPrompt('Jupiter had a temple.', {
            batchContext: { sectionTitle: 'Rome', alreadyExtractedNames: ['Zeus'] },
            roster: { covered: [item], names: 'Zeus | Jupiter' },
        });
        expect(prompt).toContain('write its entry under the roster name exactly');
        expect(prompt).toContain('Do not create a "<Roster name>: <Part>" entry that is not on the roster');
        expect(prompt).toContain('Roster items this TEXT is expected to describe:\n#3 Zeus [aliases: Jupiter]');
        expect(prompt).toContain('All roster names (name | aliases):\nZeus | Jupiter');
        expect(prompt).toContain('Write what this part adds to an entry under the same name');
        expect(prompt).not.toContain('Do not repeat them; extract only what this part adds.');
    });

    it('carries the roster note into a repair prompt', () => {
        const prompt = buildRepairPrompt([{ title: 'Rome', text: 'Jupiter had a temple.', missingFacts: ['temple'] }], {
            roster: { covered: [item], names: 'Zeus | Jupiter' },
        });
        expect(prompt).toContain('Roster items this TEXT is expected to describe:');
    });
});

describe('buildReformatPrompt', () => {
    it('substitutes {{text}} into the default template and leaves no placeholders', () => {
        const prompt = buildReformatPrompt('SOME SOURCE TEXT HERE');
        expect(prompt).toContain('SOME SOURCE TEXT HERE');
        expect(prompt).toContain('entry_type');
        expect(prompt).not.toMatch(/\{\{(text|notes|continuationNote)\}\}/);
    });

    it('has no notes when there is no context to give', () => {
        expect(buildReformatPrompt('body text')).not.toContain('NOTE:');
    });

    it('tells the model where the batch sits in the document', () => {
        const prompt = buildReformatPrompt('x', { headingPath: 'The Settlement › Foundation › Daily life' });
        expect(prompt).toContain('comes from this place in the document: The Settlement › Foundation › Daily life');
    });

    it('adds transcript handling only for YouTube content', () => {
        expect(buildReformatPrompt('x', { contentType: 'youtube' })).toMatch(/NOTE: This TEXT is a video transcript/);
        expect(buildReformatPrompt('x', { contentType: 'document' })).not.toMatch(/NOTE: This TEXT is a video transcript/);
    });

    it('injects a continuation note listing already-extracted names', () => {
        const prompt = buildReformatPrompt('more text', {
            batchContext: { sectionTitle: 'Notable US Hero Agencies', alreadyExtractedNames: ['Columbia', 'Bulwark'] },
        });
        expect(prompt).toMatch(/continues section "Notable US Hero Agencies"/);
        expect(prompt).toContain('Columbia, Bulwark');
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

    it('fills the legacy {{continuationNote}} slot of older custom prompts', () => {
        const prompt = buildReformatPrompt('MY TEXT', {
            customPrompt: 'Custom.\n{{continuationNote}}TEXT: {{text}}',
            headingPath: 'Doc › Part',
        });
        expect(prompt).toMatch(/^Custom\.\nNOTE: This TEXT comes from/);
        expect(prompt).toContain('TEXT: MY TEXT');
    });

    it('appends the text when a custom prompt has no {{text}} slot', () => {
        const prompt = buildReformatPrompt('MY TEXT', { customPrompt: 'Extract entries as JSON.' });
        expect(prompt).toBe('Extract entries as JSON.\n\nTEXT:\nMY TEXT');
    });

    it('puts notes in front of the text when a custom prompt has no notes slot', () => {
        const prompt = buildReformatPrompt('MY TEXT', { customPrompt: 'Go:\n{{text}}', contentType: 'youtube' });
        expect(prompt).toMatch(/^Go:\nNOTE: This TEXT is a video transcript[\s\S]*\n\nMY TEXT$/);
    });

    it('keeps the fact contract and asks for attribution, quotations and hidden entries', () => {
        const prompt = buildReformatPrompt('x');
        expect(prompt).toMatch(/Keep every fact/);
        expect(prompt).toMatch(/quotations word for word/);
        expect(prompt).toMatch(/Keep attribution/);
        expect(prompt).toMatch(/"hidden": true/);
        expect(prompt).toMatch(/Skip sections written for the author/);
    });

    it('no longer asks for traits, importance scores or "subtopic of" links', () => {
        const prompt = buildReformatPrompt('x');
        expect(prompt).not.toMatch(/traits/);
        expect(prompt).not.toMatch(/importance/);
        expect(prompt).not.toMatch(/subtopic of/);
    });
});

describe('buildStoredText', () => {
    const record = {
        entry_type: 'character',
        name: 'Bulwark',
        affiliation: 'Ironclad Agency',
        relationships: [{ target: 'Solaris', type: 'is the mentor of' }, { target: 'Ember Corps', type: '' }, 'Legacy Target'],
        hidden: false,
        body: 'Bulwark turns her skin to metal.',
    };

    it('heads the text with the name and type and writes relationships as sentences', () => {
        expect(buildStoredText(record)).toBe([
            'Bulwark (character)',
            'Bulwark turns her skin to metal.',
            'Bulwark belongs to Ironclad Agency. Bulwark is the mentor of Solaris. Bulwark is connected to Ember Corps. Bulwark is connected to Legacy Target.',
        ].join('\n'));
    });

    it('does not restate the parent of a "<Parent>: <Part>" entry', () => {
        const text = buildStoredText({
            entry_type: 'concept', name: 'Bulwark: Hidden truth', hidden: true, body: 'Her form is killing her.',
            relationships: [{ target: 'Bulwark', type: 'is part of' }, { target: 'Fortress', type: 'concerns' }],
        });
        expect(text).not.toContain('is part of');
        expect(text).toContain('Bulwark: Hidden truth concerns Fortress.');
    });

    it('tags hidden entries', () => {
        const text = buildStoredText({ ...record, hidden: true, affiliation: '', relationships: [] });
        expect(text).toBe(`Bulwark (character)\n${HIDDEN_TRUTH_TAG}\nBulwark turns her skin to metal.`);
    });

    it('numbers the parts of a split entry and states relationships on the first part only', () => {
        const first = buildStoredText(record, { part: 0, total: 3 });
        const second = buildStoredText({ ...record, body: 'More.' }, { part: 1, total: 3 });
        expect(first.split('\n')[0]).toBe('Bulwark (character), part 1 of 3');
        expect(first).toContain('is the mentor of Solaris');
        expect(second).toBe('Bulwark (character), part 2 of 3\nMore.');
    });
});

describe('buildLinkingPrompt', () => {
    const catalog = [
        { name: 'Victory Plaza', entry_type: 'location', aliases: ['Times Square'] },
        { name: 'Capital Punishment in the Reich', entry_type: 'concept', aliases: [] },
    ];

    it('lists every entry by name only, with aliases set apart', () => {
        const prompt = buildLinkingPrompt('Some section text.', catalog);
        expect(prompt).toContain('- Victory Plaza   (also called: Times Square)');
        expect(prompt).toContain('- Capital Punishment in the Reich\n');
        expect(prompt).not.toMatch(/\[(location|concept)\]/);
    });

    it('embeds the batch text and asks for one-direction {source, target, type} links', () => {
        const prompt = buildLinkingPrompt('Executions are held in Victory Plaza.', catalog);
        expect(prompt).toContain('Executions are held in Victory Plaza.');
        expect(prompt).toMatch(/"source":.*"target":.*"type":/s);
        expect(prompt).toMatch(/Give each connection once/);
    });

    it('handles an empty catalog without crashing', () => {
        const prompt = buildLinkingPrompt('Text.', []);
        expect(typeof prompt).toBe('string');
        expect(prompt).toContain('Text.');
    });
});

// ---------------------------------------------------------------------------
// Coverage check (under-extraction guardrail)
// ---------------------------------------------------------------------------

describe('computeBatchCoverage', () => {
    // Mirrors the observed real-world failure: a 4-subsection organization
    // profile where the model's output covered only the first subsection.
    const batchText = [
        '# Male Sympathizers in the Matriarchal Society',
        '',
        '## Definition and Organizational Structure',
        '',
        'Male Sympathizers are a decentralized network of female citizens advocating equality for males. They communicate through encrypted messaging and library book marginalia.',
        '',
        '## Societal Treatment and Legal Consequences',
        '',
        'Visible sympathizers face charges from "promoting gender disorder" (misdemeanor) to "seditious conspiracy" (felony, 5–20 years). The state diagnoses sympathizers with invented conditions such as "reverse gender identity disorder".',
        '',
        '## Social Stigmatization and Pejorative Terms',
        '',
        'The linguistic arsenal includes "male-lover", "gender traitor", "softhead", and youth slang like "moid-simp" and "equality-pilled".',
    ].join('\n');

    const definitionEntry = {
        entry_type: 'organization',
        name: 'Male Sympathizers',
        aliases: [],
        traits: ['decentralized female network'],
        keywords: [{ text: 'sympathizers', importance: 8 }],
        body: 'Male Sympathizers are a decentralized network of female citizens advocating equality for males. They communicate through encrypted messaging and library book marginalia.',
    };

    it('flags sections whose facts did not land in any entry, listing the missing facts', () => {
        const flagged = computeBatchCoverage(batchText, [definitionEntry], 0.5);

        const titles = flagged.map(s => s.title);
        expect(titles).toContain('Societal Treatment and Legal Consequences');
        expect(titles).toContain('Social Stigmatization and Pejorative Terms');
        expect(titles).not.toContain('Definition and Organizational Structure');

        const stigma = flagged.find(s => s.title === 'Social Stigmatization and Pejorative Terms');
        expect(stigma.missingFacts).toContain('male-lover');
        expect(stigma.missingFacts).toContain('gender traitor');
        expect(stigma.coverage).toBeLessThan(0.5);
    });

    it('returns no flags when every section\'s facts are covered', () => {
        const fullEntries = [
            definitionEntry,
            {
                entry_type: 'concept',
                name: 'Male Sympathizers: Societal Treatment and Legal Consequences',
                aliases: [], traits: [], keywords: [],
                body: 'Visible sympathizers face charges from "promoting gender disorder" (a misdemeanor) to "seditious conspiracy" (a felony carrying 5–20 years). The state diagnoses sympathizers with invented conditions such as "reverse gender identity disorder".',
            },
            {
                entry_type: 'concept',
                name: 'Male Sympathizers: Social Stigmatization and Pejorative Terms',
                aliases: [], traits: [], keywords: [],
                body: 'The linguistic arsenal against sympathizers includes "male-lover", "gender traitor", "softhead", and youth slang like "moid-simp" and "equality-pilled".',
            },
        ];
        expect(computeBatchCoverage(batchText, fullEntries, 0.5)).toEqual([]);
    });

    it('skips sections with too few distinctive fact tokens to score', () => {
        expect(computeBatchCoverage('# Hi\n\nShort note.', [], 0.5)).toEqual([]);
    });

    it('treats headerless text as a single section', () => {
        const text = 'The Edict of Coals of 1147 fines offenders 500 crowns, with conviction rates above 90% in the Pyre Courts.';
        const flagged = computeBatchCoverage(text, [], 0.5);
        expect(flagged).toHaveLength(1);
        expect(flagged[0].missingFacts.length).toBeGreaterThan(0);
    });

    it('returns [] for empty or non-string input', () => {
        expect(computeBatchCoverage('', [], 0.5)).toEqual([]);
        expect(computeBatchCoverage(null, [], 0.5)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Repair prompt
// ---------------------------------------------------------------------------
describe('buildRepairPrompt', () => {
    const flagged = [
        {
            title: 'Social Stigmatization and Pejorative Terms',
            text: '## Social Stigmatization and Pejorative Terms\n\nThe arsenal includes "male-lover" and "gender traitor".',
            missingFacts: ['male-lover', 'gender traitor'],
        },
    ];

    it('rides the full extraction template with the repair note and flagged text', () => {
        const prompt = buildRepairPrompt(flagged, { alreadyExtractedNames: ['Male Sympathizers'] });
        expect(prompt).toContain('entry_type');
        expect(prompt).toMatch(/missed some of its content/);
        expect(prompt).toContain('Male Sympathizers');
        expect(prompt).toContain('male-lover; gender traitor');
        expect(prompt).toContain('The arsenal includes "male-lover" and "gender traitor".');
        expect(prompt).not.toMatch(/\{\{(text|notes|continuationNote)\}\}/);
    });

    it('keeps the batch context notes', () => {
        const prompt = buildRepairPrompt(flagged, { headingPath: 'Doc › Section', contentType: 'youtube' });
        expect(prompt).toContain('comes from this place in the document: Doc › Section');
        expect(prompt).toMatch(/NOTE: This TEXT is a video transcript/);
    });

    it('respects a customPrompt override', () => {
        const prompt = buildRepairPrompt(flagged, { customPrompt: 'CUSTOM {{notes}}TEXT: {{text}}' });
        expect(prompt).toMatch(/^CUSTOM NOTE: A previous extraction/);
        expect(prompt).toContain('TEXT: ## Social Stigmatization');
    });

    it('shows "(none)" when nothing was extracted yet', () => {
        const prompt = buildRepairPrompt(flagged, {});
        expect(prompt).toContain('Entries already extracted: (none)');
    });
});
