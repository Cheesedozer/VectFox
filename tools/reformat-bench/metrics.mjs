// Scoring: per-paragraph fact recall (the extension's own coverage measure,
// over the whole document minus author-note sections) and duplicate counts.
import { computeBatchCoverage, normalizeForMatch } from '../../core/reformat-schema.js';
import { embed, cosine } from './embed.mjs';

const AUTHOR_NOTE = /^(?:settings|canon log|provisional|intentional contradictions|open questions|change ?log|to-?do(?: list)?|author'?s? notes?)$/i;

/** Document text without author-note sections (they are skipped by design). */
export function scorableText(doc) {
    const out = [];
    let skipLevel = 0;
    for (const line of doc.split('\n')) {
        const h = line.match(/^(#{1,6})\s+(.+)$/);
        if (h) {
            const level = h[1].length;
            if (skipLevel && level <= skipLevel) skipLevel = 0;
            if (!skipLevel && AUTHOR_NOTE.test(h[2].trim())) skipLevel = level;
        }
        if (!skipLevel) out.push(line);
    }
    return out.join('\n');
}

export function factRecall(doc, records) {
    const units = computeBatchCoverage(scorableText(doc), records, 1.01);
    // threshold > 1 returns every scored unit with its coverage
    const mean = units.reduce((s, u) => s + u.coverage, 0) / (units.length || 1);
    const low = units.filter(u => u.coverage < 0.7).map(u => ({ title: u.title, coverage: +u.coverage.toFixed(2), missing: u.missingFacts.slice(0, 8) }));
    return { units: units.length, mean, low };
}

function nameKeys(r) {
    return [r.name, ...(r.aliases || [])].map(n => normalizeForMatch(n)).filter(Boolean);
}

/** Near-duplicate candidates: one name contained in another as whole words, or high embedding similarity. */
export async function nearDuplicates(records, { simThreshold = 0.86, model = 'openai/text-embedding-3-small' } = {}) {
    const texts = records.map(r => `${r.name}${r.aliases?.length ? ` (${r.aliases.join(', ')})` : ''}: ${String(r.body).slice(0, 600)}`);
    const vecs = await embed(texts, model);
    const pairs = [];
    for (let i = 0; i < records.length; i++) {
        for (let j = i + 1; j < records.length; j++) {
            const a = records[i], b = records[j];
            if (Boolean(a.hidden) !== Boolean(b.hidden)) continue;
            const sim = cosine(vecs[i], vecs[j]);
            let contained = false;
            for (const ka of nameKeys(a)) for (const kb of nameKeys(b)) {
                if (ka === kb || ` ${kb} `.includes(` ${ka} `) || ` ${ka} `.includes(` ${kb} `)) contained = true;
            }
            // "X: Part" sub-entries legitimately contain their parent's name.
            const sub = a.name.includes(':') || b.name.includes(':');
            if (sim >= simThreshold || (contained && !sub)) pairs.push({ i, j, a: a.name, b: b.name, sim: +sim.toFixed(3), contained });
        }
    }
    return pairs.sort((x, y) => y.sim - x.sim);
}
