/**
 * Unit tests for core/reformat-extractor.js
 *
 * Covers the parts that are risky to get wrong and aren't exercised by
 * reformat-schema.test.js: the oversized-section batching/continuation
 * packer, retry-vs-fatal-error provider-call behavior, and the
 * expandOversizedChunk() accept-time fallback. Mocks ST globals + fetch —
 * same convention as chunk-metadata-persistence.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

vi.mock('../core/api-keys.js', () => ({
    getOpenRouterApiKey: () => 'mock-masked-key',
    getCustomApiKey: () => 'mock-masked-key',
}));

// core/log.js reads extension_settings for verbosity/domain gating — mock the
// same way chunk-metadata-persistence.test.js mocks it for collection-metadata.js.
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
}));

import { reformatDocument, expandOversizedChunk, mergeDuplicateEntities, linkSubEntriesToParents, splitToFit } from '../core/reformat-extractor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockChatCompletionResponse(entries, finishReason = 'stop') {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            choices: [{
                message: { content: JSON.stringify(entries) },
                finish_reason: finishReason,
            }],
        }),
    };
}

function extractPrompt(fetchCallArgs) {
    const body = JSON.parse(fetchCallArgs[1].body);
    return body.messages[0].content;
}

function baseSettings(overrides = {}) {
    return {
        summarize_provider: 'openrouter',
        summarize_model: 'test/mock-model',
        reformat_batch_chars: 150,
        reformat_concurrency: 1, // deterministic call ordering for assertions
        reformat_timeout_ms: 5000,
        ...overrides,
    };
}

beforeEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Oversized-section batching
// ---------------------------------------------------------------------------

describe('reformatDocument — batching', () => {
    it('splits an oversized section into continuation batches and threads already-extracted names forward', async () => {
        const doc = [
            '# Intro',
            '',
            'Short intro paragraph.',
            '',
            '## Roster',
            '',
            '***Hero A*** leads a squad. This sentence pads the section well past the tiny test budget so it must split across multiple calls.',
            '',
            '***Hero B*** leads another squad. This sentence pads the section well past the tiny test budget so it must split across multiple calls.',
            '',
            '***Hero C*** leads a third squad. This sentence pads the section well past the tiny test budget so it must split across multiple calls.',
        ].join('\n');

        let callCount = 0;
        const fetchMock = vi.fn(async () => {
            callCount++;
            // Each call "discovers" one new hero — mirrors what a real model would do.
            return mockChatCompletionResponse([
                { entry_type: 'character', name: `Hero-${callCount}`, aliases: [], affiliation: '', relationships: [], keywords: [], body: `Body for call ${callCount}.` },
            ]);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({ text: doc, contentType: 'document', settings: baseSettings() });

        expect(result.chunks.length).toBeGreaterThanOrEqual(2);
        expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

        // At least one call after the first must be a continuation carrying the
        // "already extracted" note — proves the oversized-section splitter fired
        // and threaded prior names forward instead of re-processing from scratch.
        const prompts = fetchMock.mock.calls.map(extractPrompt);
        const continuationPrompts = prompts.filter(p => /continues section "## Roster"/.test(p));
        expect(continuationPrompts.length).toBeGreaterThanOrEqual(1);
        expect(continuationPrompts[0]).toMatch(/already extracted from earlier parts of this section/i);
        // every batch knows where it sits in the document
        expect(continuationPrompts[0]).toContain('comes from this place in the document: Intro › Roster');

        vi.unstubAllGlobals();
    });

    it('runs a short document as a single batch with no continuation note', async () => {
        const doc = '# Topic\n\nOne short paragraph, well under the batch budget.';
        const fetchMock = vi.fn(async () => mockChatCompletionResponse([
            { entry_type: 'concept', name: 'Topic', aliases: [], affiliation: '', relationships: [], keywords: [], body: 'One short paragraph.' },
        ]));
        vi.stubGlobal('fetch', fetchMock);

        const progressCalls = [];
        const result = await reformatDocument({
            text: doc,
            contentType: 'document',
            settings: baseSettings({ reformat_batch_chars: 6000 }),
            onProgress: (done, total, phase) => progressCalls.push([done, total, phase]),
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0].name).toBe('Topic');
        expect(progressCalls).toEqual([[1, 1, 'extract']]);

        vi.unstubAllGlobals();
    });

    it('surfaces a truncated completion (finish_reason=length) as a warning without dropping the whole run', async () => {
        const doc = '# Topic\n\nSome content.';
        const fetchMock = vi.fn(async () => mockChatCompletionResponse(
            [{ entry_type: 'concept', name: 'Topic', aliases: [], affiliation: '', relationships: [], keywords: [], body: 'Some content.' }],
            'length',
        ));
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({ text: doc, contentType: 'document', settings: baseSettings({ reformat_batch_chars: 6000 }) });

        expect(result.chunks).toHaveLength(1);
        expect(result.warnings.some(w => /truncated/i.test(w))).toBe(true);

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// Retry vs. fatal-error behavior
// ---------------------------------------------------------------------------

describe('reformatDocument — provider call resilience', () => {
    it('retries a transient HTTP failure and succeeds on the second attempt', async () => {
        const doc = '# Topic\n\nSome content.';
        let attempt = 0;
        const fetchMock = vi.fn(async () => {
            attempt++;
            if (attempt === 1) {
                return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => 'temporarily down' };
            }
            return mockChatCompletionResponse([
                { entry_type: 'concept', name: 'Topic', aliases: [], affiliation: '', relationships: [], keywords: [], body: 'Some content.' },
            ]);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({
            text: doc,
            contentType: 'document',
            settings: baseSettings({ reformat_batch_chars: 6000 }),
        });

        expect(attempt).toBe(2);
        expect(result.chunks).toHaveLength(1);
        expect(result.batchesFailed).toBe(0);

        vi.unstubAllGlobals();
    });

    it('does not retry and aborts the whole run on missing model config (fatal error)', async () => {
        const doc = '# Topic\n\nSome content.';
        const fetchMock = vi.fn(async () => mockChatCompletionResponse([]));
        vi.stubGlobal('fetch', fetchMock);

        const settings = baseSettings({ reformat_batch_chars: 6000 });
        settings.summarize_model = ''; // no model anywhere → missing_model fatal error

        await expect(
            reformatDocument({ text: doc, contentType: 'document', settings })
        ).rejects.toThrow(/No model configured/);
        expect(fetchMock).not.toHaveBeenCalled();

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// Duplicate-entity merge
// ---------------------------------------------------------------------------

describe('mergeDuplicateEntities', () => {
    const gestapo = (overrides = {}) => ({
        entry_type: 'organization',
        name: 'Gestapo',
        aliases: [],
        affiliation: '',
        relationships: [],
        keywords: [],
        body: 'Base body.',
        _nameGrounded: true,
        _ungroundedAliases: [],
        _ungroundedKeywords: [],
        ...overrides,
    });

    it('merges same-name records of the same entry_type, unioning fields with bodies merged losslessly', () => {
        const merged = mergeDuplicateEntities([
            gestapo({
                affiliation: 'The Reich',
                relationships: [{ target: 'Schutzstaffel', type: 'parent organization' }],
                keywords: ['secret police'],
                body: 'Short body.',
            }),
            gestapo({
                name: 'gestapo', // case-insensitive match
                keywords: ['Secret Police', 'terror'],
                body: 'This is the much longer body describing the Gestapo in detail across the document.',
                _nameGrounded: false,
            }),
            gestapo({
                relationships: [
                    { target: 'Schutzstaffel', type: 'parent organization' }, // duplicate — dropped
                    { target: 'Oberkatze', type: 'answers to' },
                ],
            }),
        ]);

        expect(merged).toHaveLength(1);
        const g = merged[0];
        expect(g.name).toBe('Gestapo'); // first occurrence wins
        expect(g.affiliation).toBe('The Reich'); // first non-empty
        expect(g.relationships).toEqual([
            { target: 'Schutzstaffel', type: 'parent organization' },
            { target: 'Oberkatze', type: 'answers to' },
        ]);
        expect(g.keywords).toEqual(['secret police', 'terror']); // case-insensitive union
        // longer body leads; the shorter bodies' non-duplicate prose survives too
        expect(g.body).toMatch(/^This is the much longer body/);
        expect(g.body).toContain('Short body.');
        expect(g._nameGrounded).toBe(true); // OR across copies
    });

    it('merges bodies losslessly: complementary facts from both copies survive, contained prose is not duplicated', () => {
        const merged = mergeDuplicateEntities([
            gestapo({
                body: 'The Gestapo conducts political investigations across the Reich. It reports directly to Oberkatze.',
            }),
            gestapo({
                body: 'The Gestapo conducts political investigations across the Reich. Its budget of 40 million marks is the largest of any security agency.',
            }),
        ]);

        expect(merged).toHaveLength(1);
        const body = merged[0].body;
        // both unique facts present exactly once
        expect(body).toContain('It reports directly to Oberkatze.');
        expect(body).toContain('budget of 40 million marks');
        // the shared sentence is not duplicated
        expect(body.match(/conducts political investigations/g)).toHaveLength(1);
    });

    it('drops a shorter body entirely when it is already contained in the longer one', () => {
        const longBody = 'The Gestapo conducts political investigations. It operates outside procedural constraints.';
        const merged = mergeDuplicateEntities([
            gestapo({ body: longBody }),
            gestapo({ body: 'The Gestapo conducts political investigations.' }),
        ]);
        expect(merged[0].body).toBe(longBody);
    });

    it('merges via alias bridge and records the divergent name as an alias', () => {
        const merged = mergeDuplicateEntities([
            gestapo({ name: 'IG Tatzen' }),
            gestapo({ name: 'IG Tatzen conglomerate', aliases: ['IG Tatzen'] }),
        ]);

        expect(merged).toHaveLength(1);
        expect(merged[0].name).toBe('IG Tatzen');
        expect(merged[0].aliases).toContain('IG Tatzen conglomerate');
        // the merged record's own name must not appear in its aliases
        expect(merged[0].aliases.map(a => a.toLowerCase())).not.toContain('ig tatzen');
    });

    it('merges same-name records even when the model typed them differently', () => {
        const merged = mergeDuplicateEntities([
            gestapo({ name: 'Gender Identity Card', entry_type: 'item', body: 'Cards are cream for women.' }),
            gestapo({ name: 'Gender Identity Card', entry_type: 'concept', body: 'Cards are gray for men.' }),
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0].entry_type).toBe('item');
        expect(merged[0].body).toContain('gray for men');
    });

    it('does NOT merge records of different entry_types through an alias alone', () => {
        const merged = mergeDuplicateEntities([
            gestapo({ name: 'Texas', entry_type: 'location', aliases: ['Red States'] }),
            gestapo({ name: 'Red States', entry_type: 'concept' }),
        ]);
        expect(merged).toHaveLength(2);
    });

    it('matches names ignoring a leading "the" and a trailing (ACRONYM)', () => {
        const merged = mergeDuplicateEntities([
            gestapo({ name: 'The Gender War', entry_type: 'concept', body: 'Fought from 1974.' }),
            gestapo({ name: 'Gender War', entry_type: 'concept', body: 'Ended in 1978.' }),
            gestapo({ name: 'GARS', entry_type: 'concept', body: 'A registry.' }),
            gestapo({ name: 'Gender Authentication Registry System (GARS)', entry_type: 'organization', body: 'Created in 1983.' }),
        ]);
        expect(merged.map(r => r.name)).toEqual(['The Gender War', 'GARS']);
        expect(merged[1].aliases).toContain('Gender Authentication Registry System (GARS)');
        expect(merged[1].body).toContain('Created in 1983.');
    });

    it('never merges a hidden truth into a public entry', () => {
        const merged = mergeDuplicateEntities([
            gestapo({ name: 'GAMA', body: 'Officially tracks men only.' }),
            gestapo({ name: 'GAMA', hidden: true, body: 'Secretly tracks everyone.' }),
        ]);
        expect(merged).toHaveLength(2);
        expect(merged.map(r => Boolean(r.hidden))).toEqual([false, true]);
    });

    it('folds a "<Section>: <Thing>" record into the entry named <Thing>, keeping the plain name', () => {
        const merged = mergeDuplicateEntities([
            gestapo({ name: 'The Settlement: Texas', entry_type: 'location', body: 'Texas leads the Red States.' }),
            gestapo({ name: 'Texas', entry_type: 'location', body: 'Texas police use force often.' }),
            gestapo({ name: 'Bulwark: Hidden truth', hidden: true, body: 'Her form is killing her.' }),
            gestapo({ name: 'Solaris: Hidden truth', hidden: true, body: 'He fears fire.' }),
        ]);
        expect(merged.map(r => r.name)).toEqual(['Texas', 'Bulwark: Hidden truth', 'Solaris: Hidden truth']);
        expect(merged[0].body).toContain('leads the Red States');
        expect(merged[0].aliases).toContain('The Settlement: Texas');
    });

    it('does not cut sentences at abbreviations such as "Dr." when merging bodies', () => {
        const merged = mergeDuplicateEntities([
            gestapo({ name: 'Theory', entry_type: 'concept', body: 'The theory holds that men cannot mature past fifteen. Its raw data was never published.' }),
            gestapo({ name: 'Theory', entry_type: 'concept', body: 'It began with a 1981 study led by Dr. Ingrid Halvorsen. In Blue States it frames men as impaired.' }),
        ]);
        expect(merged[0].body).toContain('led by Dr. Ingrid Halvorsen.');
        expect(merged[0].body).not.toMatch(/Dr\. In Blue/);
    });

    it('drops a restated sentence but keeps one that adds a new name or number', () => {
        const merged = mergeDuplicateEntities([
            gestapo({ body: 'The Federal Commission on the War Record maintains the official history of the Gender War, though parts of its 1974 archive remain sealed.' }),
            gestapo({ body: 'The Federal Commission on the War Record maintains the official history of the Gender War. The Commission was founded in 1980.' }),
        ]);
        const body = merged[0].body;
        expect(body.match(/maintains the official history/g)).toHaveLength(1);
        expect(body).toContain('founded in 1980');
    });

    it('leaves distinct entities untouched and preserves order', () => {
        const input = [gestapo({ name: 'A' }), gestapo({ name: 'B' }), gestapo({ name: 'C' })];
        const merged = mergeDuplicateEntities(input);
        expect(merged.map(r => r.name)).toEqual(['A', 'B', 'C']);
    });
});

describe('reformatDocument — duplicate merge integration', () => {
    it('collapses the same entity extracted from two batches into one record and surfaces a warning', async () => {
        const doc = [
            '# Security Apparatus',
            '',
            'The Gestapo conducts political investigations. This sentence pads the section well past the tiny test budget so it must split into more than one batch for the test.',
            '',
            '# Legal System',
            '',
            'The Gestapo also appears here with different details entirely. This sentence pads the section well past the tiny test budget so it must split into more than one batch.',
        ].join('\n');

        let callCount = 0;
        const fetchMock = vi.fn(async () => {
            callCount++;
            return mockChatCompletionResponse([
                {
                    entry_type: 'organization', name: 'Gestapo', aliases: [], affiliation: '',
                    relationships: [], keywords: [],
                    body: `Body from call ${callCount} with fact number ${callCount * 100}.`,
                },
            ]);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({ text: doc, contentType: 'document', settings: baseSettings() });

        expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0].body).toContain('fact number 100');
        expect(result.chunks[0].body).toContain('fact number 200');
        expect(result.warnings.some(w => /Merged \d+ duplicate/i.test(w))).toBe(true);

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// Coverage repair pass (under-extraction guardrail)
// ---------------------------------------------------------------------------

describe('reformatDocument — coverage repair pass', () => {
    // Miniature of the observed real-world failure: multi-subsection profile,
    // model output covers only the first subsection.
    const doc = [
        '# Male Sympathizers',
        '',
        '## Definition and Organizational Structure',
        '',
        'Male Sympathizers are a decentralized network of female citizens advocating equality. They communicate through encrypted messaging and library book marginalia.',
        '',
        '## Social Stigmatization and Pejorative Terms',
        '',
        'The linguistic arsenal includes "male-lover", "gender traitor", "softhead", and youth slang like "moid-simp" and "equality-pilled".',
    ].join('\n');

    const thinEntry = {
        entry_type: 'organization', name: 'Male Sympathizers', aliases: [], affiliation: '',
        relationships: [], keywords: [],
        body: 'Male Sympathizers are a decentralized network of female citizens advocating equality. They communicate through encrypted messaging and library book marginalia.',
    };
    const repairEntry = {
        entry_type: 'concept', name: 'Male Sympathizers: Social Stigmatization and Pejorative Terms',
        aliases: [], affiliation: '',
        relationships: [{ target: 'Male Sympathizers', type: 'is part of' }], keywords: [],
        body: 'The linguistic arsenal against sympathizers includes "male-lover", "gender traitor", "softhead", and youth slang like "moid-simp" and "equality-pilled".',
    };

    it('detects an under-captured section, issues one repair call, and appends its entries', async () => {
        const fetchMock = vi.fn(async (url, opts) => {
            const prompt = JSON.parse(opts.body).messages[0].content;
            if (/missed some of its content/.test(prompt)) {
                return mockChatCompletionResponse([repairEntry]);
            }
            return mockChatCompletionResponse([thinEntry]);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({ text: doc, contentType: 'document', settings: baseSettings({ reformat_batch_chars: 6000 }) });

        expect(fetchMock).toHaveBeenCalledTimes(2); // extraction + one repair
        const repairPrompt = fetchMock.mock.calls.map(extractPrompt).find(p => /missed some of its content/.test(p));
        // the repair prompt names what was missed and carries the flagged section text
        expect(repairPrompt).toContain('Social Stigmatization and Pejorative Terms');
        expect(repairPrompt).toContain('male-lover');
        expect(repairPrompt).toContain('Male Sympathizers'); // already-extracted names
        // both the thin entry and the repaired sub-entry reach the caller
        expect(result.chunks.map(c => c.name)).toEqual([
            'Male Sympathizers',
            'Male Sympathizers: Social Stigmatization and Pejorative Terms',
        ]);
        // repair succeeded → no residual under-capture warning
        expect(result.warnings.some(w => /still under-captured/i.test(w))).toBe(false);

        vi.unstubAllGlobals();
    });

    it('warns when coverage is still low after the repair call, without looping', async () => {
        const fetchMock = vi.fn(async () => mockChatCompletionResponse([thinEntry]));
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({ text: doc, contentType: 'document', settings: baseSettings({ reformat_batch_chars: 6000 }) });

        expect(fetchMock).toHaveBeenCalledTimes(2); // exactly one repair attempt, no loop
        expect(result.warnings.some(w => /still under-captured/i.test(w) && /Social Stigmatization/.test(w))).toBe(true);
        expect(result.chunks).toHaveLength(1);

        vi.unstubAllGlobals();
    });

    it('a failed repair call is a non-fatal warning and the original extraction survives', async () => {
        let sawRepair = false;
        const fetchMock = vi.fn(async (url, opts) => {
            const prompt = JSON.parse(opts.body).messages[0].content;
            if (/missed some of its content/.test(prompt)) {
                sawRepair = true;
                return { ok: false, status: 400, statusText: 'bad request', text: async () => 'model rejected prompt' };
            }
            return mockChatCompletionResponse([thinEntry]);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({ text: doc, contentType: 'document', settings: baseSettings({ reformat_batch_chars: 6000 }) });

        expect(sawRepair).toBe(true);
        expect(result.chunks).toHaveLength(1); // extraction output intact
        expect(result.batchesFailed).toBe(0);
        expect(result.warnings.some(w => /repair call/i.test(w) && /failed/i.test(w))).toBe(true);

        vi.unstubAllGlobals();
    });

    it('can be disabled via reformat_enable_repair_pass: false — no coverage calls at all', async () => {
        const fetchMock = vi.fn(async () => mockChatCompletionResponse([thinEntry]));
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({
            text: doc,
            contentType: 'document',
            settings: baseSettings({ reformat_batch_chars: 6000, reformat_enable_repair_pass: false }),
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.chunks).toHaveLength(1);
        expect(result.warnings.some(w => /under-captured/i.test(w))).toBe(false);

        vi.unstubAllGlobals();
    });

    it('spends no repair call when the extraction already covers every section', async () => {
        const fetchMock = vi.fn(async () => mockChatCompletionResponse([thinEntry, repairEntry]));
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({ text: doc, contentType: 'document', settings: baseSettings({ reformat_batch_chars: 6000 }) });

        expect(fetchMock).toHaveBeenCalledTimes(1); // full coverage first try — no repair
        expect(result.chunks).toHaveLength(2);

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// Batching edge cases: header-less text, author notes, sub-entry links
// ---------------------------------------------------------------------------

describe('splitToFit', () => {
    it('splits a single line with no punctuation (a transcript) at spaces', () => {
        const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
        const pieces = splitToFit(words, 200);
        expect(pieces.length).toBeGreaterThan(5);
        expect(pieces.every(p => p.length <= 200)).toBe(true);
        expect(pieces.join(' ')).toBe(words);
    });

    it('prefers line breaks over sentence and word boundaries', () => {
        const text = Array.from({ length: 30 }, (_, i) => `Line ${i} has a few words.`).join('\n');
        const pieces = splitToFit(text, 120);
        expect(pieces.every(p => p.length <= 120)).toBe(true);
        expect(pieces.every(p => p.split('\n').every(l => /^Line \d+ has a few words\.$/.test(l)))).toBe(true);
    });

    it('hard-cuts a run of text with no spaces at all', () => {
        const pieces = splitToFit('一'.repeat(1000), 300);
        expect(pieces.map(p => p.length)).toEqual([300, 300, 300, 100]);
    });
});

describe('reformatDocument — batching of header-less text', () => {
    it('splits a long single-line transcript into many batches with a short continuation title', async () => {
        const transcript = Array.from({ length: 300 }, (_, i) => `so um this is spoken word number ${i}`).join(' ');
        const fetchMock = vi.fn(async () => mockChatCompletionResponse([
            { entry_type: 'concept', name: 'Talk', aliases: [], affiliation: '', relationships: [], keywords: [], body: 'Spoken words.' },
        ]));
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({
            text: transcript,
            contentType: 'youtube',
            settings: baseSettings({ reformat_batch_chars: 1000, reformat_enable_repair_pass: false }),
        });

        expect(result.totalBatches).toBeGreaterThan(5);
        const prompts = fetchMock.mock.calls.map(extractPrompt);
        expect(prompts.every(p => p.length < 9000)).toBe(true);
        expect(prompts[1]).toMatch(/continues section "so um this is spoken word number 0[^"]{0,80}…"/);
        expect(prompts[0]).toMatch(/NOTE: This TEXT is a video transcript/);

        vi.unstubAllGlobals();
    });
});

describe('reformatDocument — author-note sections', () => {
    it('skips Settings / Canon log sections and their subsections, and says so', async () => {
        const doc = [
            '# World',
            '## Settings',
            '- **Voice:** sardonic-unique-marker',
            '## Canon log',
            '### Open questions',
            '- What started the war?',
            '## Setting',
            'The world is a frozen archipelago.',
        ].join('\n');
        const fetchMock = vi.fn(async () => mockChatCompletionResponse([
            { entry_type: 'location', name: 'The archipelago', aliases: [], affiliation: '', relationships: [], keywords: [], body: 'A frozen archipelago.' },
        ]));
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({ text: doc, contentType: 'document', settings: baseSettings({ reformat_batch_chars: 6000 }) });

        const prompt = extractPrompt(fetchMock.mock.calls[0]);
        expect(prompt).toContain('frozen archipelago');
        expect(prompt).not.toContain('sardonic-unique-marker');
        expect(prompt).not.toContain('What started the war?');
        expect(result.warnings).toContain('Skipped author-note section(s): "Settings", "Canon log".');

        vi.unstubAllGlobals();
    });
});

describe('linkSubEntriesToParents', () => {
    it('links "<Parent>: <Part>" entries to an existing parent once', () => {
        const records = [
            { name: 'The Ashen Circle', aliases: [], relationships: [] },
            { name: 'The Ashen Circle: Membership', aliases: [], relationships: [] },
            { name: 'Ashen Circle: Laws', aliases: [], relationships: [{ target: 'The Ashen Circle', type: 'governs' }] },
            { name: 'Nobody: Orphan', aliases: [], relationships: [] },
        ];
        expect(linkSubEntriesToParents(records)).toBe(1);
        expect(records[1].relationships).toEqual([{ target: 'The Ashen Circle', type: 'is part of' }]);
        expect(records[2].relationships).toHaveLength(1);
        expect(records[3].relationships).toEqual([]);
    });

    it('links through an alias, keeping the parent as written in the name', () => {
        const records = [
            { name: 'The United States after the Gender War', aliases: ['The Settlement'], relationships: [] },
            { name: 'The Settlement: Daily life', aliases: [], relationships: [] },
        ];
        linkSubEntriesToParents(records);
        expect(records[1].relationships).toEqual([{ target: 'The Settlement', type: 'is part of' }]);
    });
});

describe('reformatDocument — linking pass name cleanup', () => {
    it('resolves names that carry a copied "[type]" or "also called" annotation and ignores self-links', async () => {
        const doc = '# Law\n\nExecutions are held in Victory Plaza.';
        const fetchMock = vi.fn(async (url, opts) => {
            const prompt = JSON.parse(opts.body).messages[0].content;
            if (prompt.includes('ENTRIES:')) {
                return mockChatCompletionResponse([
                    { source: 'Capital Punishment [concept]', target: 'Victory Plaza (also called: Times Square)', type: 'is carried out in' },
                    { source: 'Victory Plaza', target: 'Times Square', type: 'is' },
                ]);
            }
            return mockChatCompletionResponse([
                { entry_type: 'location', name: 'Victory Plaza', aliases: ['Times Square'], affiliation: '', relationships: [], keywords: [], body: 'An execution venue.' },
                { entry_type: 'concept', name: 'Capital Punishment', aliases: [], affiliation: '', relationships: [], keywords: [], body: 'Applies broadly.' },
            ]);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({
            text: doc,
            contentType: 'document',
            settings: baseSettings({ reformat_batch_chars: 6000, reformat_enable_linking_pass: true }),
        });

        expect(result.chunks.find(c => c.name === 'Capital Punishment').relationships)
            .toEqual([{ target: 'Victory Plaza', type: 'is carried out in' }]);
        expect(result.chunks.find(c => c.name === 'Victory Plaza').relationships).toEqual([]);
        expect(result.warnings.some(w => /Linking pass/.test(w))).toBe(false);

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// Optional cross-batch linking pass
// ---------------------------------------------------------------------------

describe('reformatDocument — linking pass', () => {
    const doc = '# Law\n\nExecutions are held in Victory Plaza as public spectacle.';

    const extractionEntities = [
        {
            entry_type: 'location', name: 'Victory Plaza', aliases: ['Times Square'], affiliation: '',
            relationships: [], keywords: [], body: 'Victory Plaza is an execution venue.',
        },
        {
            entry_type: 'concept', name: 'Capital Punishment', aliases: [], affiliation: '',
            relationships: [], keywords: [], body: 'Capital punishment applies broadly.',
        },
    ];

    it('is off by default — no linking calls, no ENTRIES prompts', async () => {
        const fetchMock = vi.fn(async () => mockChatCompletionResponse(extractionEntities));
        vi.stubGlobal('fetch', fetchMock);

        await reformatDocument({ text: doc, contentType: 'document', settings: baseSettings({ reformat_batch_chars: 6000 }) });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(extractPrompt(fetchMock.mock.calls[0])).not.toContain('ENTRIES:');

        vi.unstubAllGlobals();
    });

    it('when enabled, revisits each batch with the entity catalog and applies resolvable triples (canonicalizing names), dropping unresolvable ones', async () => {
        const fetchMock = vi.fn(async (url, opts) => {
            const prompt = JSON.parse(opts.body).messages[0].content;
            if (prompt.includes('ENTRIES:')) {
                return mockChatCompletionResponse([
                    // resolvable: target given in lowercase + source by alias — both must canonicalize
                    { source: 'capital punishment', target: 'times square', type: 'site of executions' },
                    // duplicate of the above after canonicalization — must not double-apply
                    { source: 'Capital Punishment', target: 'Victory Plaza', type: 'site of executions' },
                    // the inverse of an existing link — skipped, one direction is enough
                    { source: 'Victory Plaza', target: 'Capital Punishment', type: 'hosts' },
                    // unresolvable source — must be dropped, not crash
                    { source: 'Nonexistent Entity', target: 'Victory Plaza', type: 'x' },
                ]);
            }
            return mockChatCompletionResponse(extractionEntities);
        });
        vi.stubGlobal('fetch', fetchMock);

        const progressCalls = [];
        const result = await reformatDocument({
            text: doc,
            contentType: 'document',
            settings: baseSettings({ reformat_batch_chars: 6000, reformat_enable_linking_pass: true }),
            onProgress: (done, total, phase) => progressCalls.push([done, total, phase]),
        });

        // 1 extraction batch + 1 linking batch
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const linkPrompt = fetchMock.mock.calls.map(extractPrompt).find(p => p.includes('ENTRIES:'));
        expect(linkPrompt).toContain('- Victory Plaza   (also called: Times Square)');
        expect(linkPrompt).toContain('- Capital Punishment\n');

        const capital = result.chunks.find(c => c.name === 'Capital Punishment');
        // exactly one relationship applied, with the target canonicalized to the
        // record's real name (not the alias/lowercase form the triple used)
        expect(capital.relationships).toEqual([{ target: 'Victory Plaza', type: 'site of executions' }]);
        expect(result.chunks.find(c => c.name === 'Victory Plaza').relationships).toEqual([]);

        // each phase reports its own 1..totalBatches sequence with a phase tag —
        // a single-batch doc must never surface as "N/2 batches" in the UI
        expect(progressCalls).toEqual([[1, 1, 'extract'], [1, 1, 'link']]);

        vi.unstubAllGlobals();
    });

    it('a failed linking batch is a non-fatal warning and extraction results survive', async () => {
        let linkCall = 0;
        const fetchMock = vi.fn(async (url, opts) => {
            const prompt = JSON.parse(opts.body).messages[0].content;
            if (prompt.includes('ENTRIES:')) {
                linkCall++;
                return { ok: false, status: 500, statusText: 'boom', text: async () => 'server error' };
            }
            return mockChatCompletionResponse(extractionEntities);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await reformatDocument({
            text: doc,
            contentType: 'document',
            settings: baseSettings({ reformat_batch_chars: 6000, reformat_enable_linking_pass: true }),
        });

        expect(linkCall).toBeGreaterThanOrEqual(1);
        expect(result.chunks).toHaveLength(2); // extraction output intact
        expect(result.warnings.some(w => /Linking pass/i.test(w))).toBe(true);

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// Oversized-entity fallback (accept-time)
// ---------------------------------------------------------------------------

describe('expandOversizedChunk', () => {
    it('returns the chunk unchanged when body is within the size ceiling', async () => {
        const chunk = { entry_type: 'character', name: 'Bulwark', body: 'Short body.' };
        const result = await expandOversizedChunk(chunk, 2000);
        expect(result).toEqual([chunk]);
    });

    it('splits an oversized body into multiple physical chunks sharing entity metadata', async () => {
        const longBody = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} with some padding text to grow the body.`).join('\n\n');
        const chunk = { entry_type: 'character', name: 'Bulwark', aliases: ['Eleanor Graves'], body: longBody };

        const result = await expandOversizedChunk(chunk, 200);

        expect(result.length).toBeGreaterThan(1);
        for (const [i, piece] of result.entries()) {
            expect(piece.name).toBe('Bulwark');
            expect(piece.entry_type).toBe('character');
            expect(piece.aliases).toEqual(['Eleanor Graves']);
            expect(piece.subChunkIndex).toBe(i);
            expect(piece.subChunkTotal).toBe(result.length);
            expect(piece.body.length).toBeLessThanOrEqual(longBody.length);
        }
    });
});
