/**
 * Unit tests for core/chunk-assembly.js: the keyword tail, joining the stored
 * parts of a split Auto-Reformat entry, repeated text, and the overall cap.
 * Pure module, no ST globals.
 */

import { describe, it, expect } from 'vitest';
import { stripKeywordTail, splitEntryKey, joinStoredParts, joinSplitEntries, dropRepeatedChunks, capChunks } from '../core/chunk-assembly.js';
import { buildStoredText } from '../core/reformat-schema.js';

// ---------------------------------------------------------------------------
// Helpers: store an entry the way ui/content-vectorizer.js does on Accept
// ---------------------------------------------------------------------------

const ENTRY = {
    entry_type: 'organization',
    name: 'Ironclad Agency',
    aliases: ['the Agency'],
    affiliation: 'Hero Council',
    relationships: [{ target: 'New York City', type: 'is based in' }],
    keywords: ['hero agency'],
    hidden: false,
};
const BODIES = [
    'Ironclad Agency is a hero agency founded in 1987.',
    'Its lead hero is Bulwark, who joined in 2003.',
    'The agency\'s motto is "We hold the line."',
];

/** The chunks one split entry is stored as, with the Qdrant keyword tail. */
function storedParts(entry = ENTRY, bodies = BODIES, extra = {}) {
    return bodies.map((body, i) => {
        const metadata = { ...entry, strategy: 'llm_reformat', reformatRunId: 'run1', subChunkIndex: i, subChunkTotal: bodies.length, ...extra };
        return {
            text: `${buildStoredText({ ...entry, body }, { part: i, total: bodies.length })} [KEYWORDS: ironclad agency hero agency]`,
            metadata,
        };
    });
}
const asChunk = (part, score, hash, collectionId = 'col') => ({ hash, score, collectionId, text: stripKeywordTail(part.text), metadata: part.metadata });

describe('stripKeywordTail', () => {
    it('removes the tail Qdrant ingestion appends', () => {
        expect(stripKeywordTail('Bulwark leads the agency. [KEYWORDS: bulwark agency]')).toBe('Bulwark leads the agency.');
    });

    it('leaves text without a tail, and brackets that are not at the end, alone', () => {
        expect(stripKeywordTail('Bulwark leads the agency.')).toBe('Bulwark leads the agency.');
        expect(stripKeywordTail('See [KEYWORDS: x] for the list of terms.')).toBe('See [KEYWORDS: x] for the list of terms.');
        expect(stripKeywordTail('[Hidden truth, not public knowledge]\nShe is dying.')).toBe('[Hidden truth, not public knowledge]\nShe is dying.');
    });

    it('passes non-strings through', () => {
        expect(stripKeywordTail(undefined)).toBeUndefined();
        expect(stripKeywordTail(null)).toBeNull();
    });
});

describe('splitEntryKey', () => {
    it('is shared by the parts of one entry and differs between entries', () => {
        const [a, b] = storedParts();
        expect(splitEntryKey(a.metadata, 'col')).toBe(splitEntryKey(b.metadata, 'col'));
        expect(splitEntryKey(a.metadata, 'col')).not.toBe(splitEntryKey(a.metadata, 'other'));
        expect(splitEntryKey({ ...a.metadata, hidden: true }, 'col')).not.toBe(splitEntryKey(a.metadata, 'col'));
        expect(splitEntryKey({ ...a.metadata, reformatRunId: 'run2' }, 'col')).not.toBe(splitEntryKey(a.metadata, 'col'));
    });

    it('is null for whole entries and for chunks that are not Auto-Reformat entries', () => {
        expect(splitEntryKey({ strategy: 'llm_reformat', name: 'Bulwark', subChunkTotal: 1 })).toBeNull();
        expect(splitEntryKey({ strategy: 'llm_reformat', name: 'Bulwark' })).toBeNull();
        expect(splitEntryKey({ strategy: 'adaptive', name: 'x', subChunkTotal: 3 })).toBeNull();
        expect(splitEntryKey(undefined)).toBeNull();
    });
});

describe('joinStoredParts', () => {
    it('rebuilds the entry exactly as it would have been stored whole', () => {
        const whole = buildStoredText({ ...ENTRY, body: BODIES.join('\n\n') });
        expect(joinStoredParts(storedParts())).toBe(whole);
        // name once, no "part N of M", relationships last, no keyword tail
        expect(whole.match(/Ironclad Agency \(organization\)/g)).toHaveLength(1);
        expect(whole).not.toMatch(/part \d of \d|KEYWORDS/);
        expect(whole.endsWith('Ironclad Agency belongs to Hero Council. Ironclad Agency is based in New York City.')).toBe(true);
    });

    it('orders parts by their index whatever order they arrive in, using each once', () => {
        const [p0, p1, p2] = storedParts();
        expect(joinStoredParts([p2, p0, p1, p1])).toBe(joinStoredParts([p0, p1, p2]));
    });

    it('keeps the hidden-truth tag once', () => {
        const hidden = { ...ENTRY, name: 'Bulwark: Hidden truth', hidden: true, affiliation: '', relationships: [] };
        const text = joinStoredParts(storedParts(hidden, ['Her metal form is killing her.', 'She has two years left.']));
        expect(text).toBe('Bulwark: Hidden truth (organization)\n[Hidden truth, not public knowledge]\nHer metal form is killing her.\n\nShe has two years left.');
    });

    it('uses a part as it is when its text was edited out of shape', () => {
        const parts = storedParts();
        parts[1] = { ...parts[1], text: 'Hand-edited second part.' };
        expect(joinStoredParts(parts)).toContain('founded in 1987.\n\nHand-edited second part.\n\nThe agency\'s motto');
    });

    it('joins whatever parts are available', () => {
        const [, p1, p2] = storedParts();
        const text = joinStoredParts([p1, p2]);
        expect(text.startsWith('Ironclad Agency (organization)\nIts lead hero is Bulwark')).toBe(true);
        expect(joinStoredParts([])).toBe('');
    });
});

describe('joinSplitEntries', () => {
    const parts = storedParts();
    const other = { hash: 'z', score: 0.6, collectionId: 'col', text: 'An unrelated chunk.', metadata: { strategy: 'adaptive' } };

    it('replaces a retrieved part with the whole entry read from the collection', () => {
        const retrieved = [asChunk(parts[2], 0.8, 'h2'), other];
        const { chunks, joined } = joinSplitEntries(retrieved, () => parts);

        expect(chunks).toHaveLength(2);
        expect(chunks[0].text).toBe(buildStoredText({ ...ENTRY, body: BODIES.join('\n\n') }));
        expect(chunks[0]).toMatchObject({ hash: 'h2', score: 0.8, joinedParts: 3 });
        expect(chunks[1]).toBe(other);
        expect(joined).toEqual([{ hash: 'h2', parts: 3, absorbed: [] }]);
    });

    it('collapses several retrieved parts of one entry into the best-scoring one', () => {
        const retrieved = [asChunk(parts[1], 0.9, 'h1'), other, asChunk(parts[0], 0.5, 'h0')];
        const { chunks, joined } = joinSplitEntries(retrieved, () => parts);

        expect(chunks.map(c => c.hash)).toEqual(['h1', 'z']);
        expect(joined).toEqual([{ hash: 'h1', parts: 3, absorbed: ['h0'] }]);
    });

    it('joins the retrieved parts on their own when the collection cannot be read', () => {
        const retrieved = [asChunk(parts[0], 0.9, 'h0'), asChunk(parts[2], 0.7, 'h2')];
        const { chunks } = joinSplitEntries(retrieved, () => null);

        expect(chunks).toHaveLength(1);
        expect(chunks[0].text).toContain('founded in 1987.\n\nThe agency\'s motto');
        expect(chunks[0].joinedParts).toBe(2);
    });

    it('leaves a lone part alone when its siblings cannot be read', () => {
        const lone = asChunk(parts[1], 0.9, 'h1');
        const { chunks, joined } = joinSplitEntries([lone], () => []);
        expect(chunks).toEqual([lone]);
        expect(joined).toEqual([]);
    });

    it('keeps the parts of different entries and collections apart', () => {
        const second = storedParts({ ...ENTRY, name: 'Solaris' }, ['Solaris is a trainee.', 'She can fly.']);
        const asked = [];
        const { chunks } = joinSplitEntries(
            [asChunk(parts[0], 0.9, 'a'), asChunk(second[1], 0.8, 'b'), asChunk(parts[1], 0.7, 'c', 'col2')],
            (key) => { asked.push(key); return key.includes('Solaris') ? second : parts; },
        );
        expect(chunks.map(c => c.hash)).toEqual(['a', 'b', 'c']);
        expect(chunks[1].text).toContain('Solaris is a trainee.\n\nShe can fly.');
        expect(new Set(asked).size).toBe(3);
    });

    it('returns the same list when nothing is split', () => {
        const list = [other];
        expect(joinSplitEntries(list).chunks).toBe(list);
    });
});

describe('dropRepeatedChunks', () => {
    it('keeps the first chunk with a given text and drops later copies', () => {
        const a = { hash: 1, score: 0.9, text: 'The Gestapo  conducts investigations.' };
        const b = { hash: 2, score: 0.8, text: 'Something else.' };
        const c = { hash: 3, score: 0.7, text: 'the gestapo conducts\ninvestigations.' };
        expect(dropRepeatedChunks([a, b, c])).toEqual({ kept: [a, b], dropped: [c] });
    });

    it('never drops chunks that have no text', () => {
        const a = { hash: 1, text: '' };
        const b = { hash: 2 };
        expect(dropRepeatedChunks([a, b]).kept).toEqual([a, b]);
    });
});

describe('capChunks', () => {
    const chunks = [
        { hash: 'a', score: 1.0 }, { hash: 'b', score: 0.4 }, { hash: 'c', score: 0.9 }, { hash: 'd', score: 0.4 },
    ];

    it('keeps the best-scoring chunks in their existing order', () => {
        const { kept, dropped } = capChunks(chunks, 3);
        expect(kept.map(c => c.hash)).toEqual(['a', 'b', 'c']); // b beats d on position
        expect(dropped.map(c => c.hash)).toEqual(['d']);
    });

    it('does nothing when under the limit or when the limit is off', () => {
        expect(capChunks(chunks, 10).kept).toBe(chunks);
        expect(capChunks(chunks, 0)).toEqual({ kept: chunks, dropped: [] });
        expect(capChunks(chunks, undefined).kept).toBe(chunks);
    });
});
