// Retrieval-based judged recall, for documents too large to show every entry
// to the judge: a fixed sample of source paragraphs is each checked against
// its top-K entries by embedding similarity — roughly what retrieval would
// hand the roleplay model.
// usage: node --import ./register.mjs semantic-rag.mjs <doc> <sampleSize> <run.json>...
import fs from 'node:fs';
import { openrouter } from './or.mjs';
import { embed, cosine } from './embed.mjs';
import { scorableText } from './metrics.mjs';
const { buildStoredText } = await import('../../core/reformat-schema.js');
const { expandOversizedChunk } = await import('../../core/reformat-extractor.js');
// What the extension stores: records over reformat_max_body_chars (default
// 2000) are split at Accept time, each piece headed by the entry's name.
const MAX_BODY_CHARS = 2000;

const JUDGE = 'anthropic/claude-haiku-5.5';
const TOP_K = 8;
const PER_CALL = 8;
const CONCURRENCY = 8;
const NAV = /link|see-also|see also|related|listed as|spoilers. section|agreed not to open|hinted in|cross-reference/i;

function samplePars(doc, n) {
    const paras = [];
    let section = '';
    for (const block of scorableText(doc).split(/\n\s*\n/)) {
        const t = block.trim();
        const h = t.match(/^#{1,6}\s+(.+)$/);
        if (h && !t.includes('\n')) { section = h[1]; continue; }
        if (t.length >= 200) paras.push({ section, text: t.slice(0, 2500) });
    }
    // deterministic spread across the document
    if (paras.length <= n) return paras;
    const step = paras.length / n;
    return Array.from({ length: n }, (_, i) => paras[Math.floor(i * step)]);
}

function parse(raw) {
    const t = String(raw);
    return JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
}

async function pool(fns, n) {
    let next = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (next < fns.length) await fns[next++](); }));
}

const [docPath, sampleSize, ...runs] = process.argv.slice(2);
const paras = samplePars(fs.readFileSync(docPath, 'utf8'), +sampleSize);
const paraVecs = await embed(paras.map(p => p.text));
const rows = [];
for (const path of runs) {
    const run = JSON.parse(fs.readFileSync(path, 'utf8'));
    const texts = [];
    for (const r of run.records) {
        const parts = await expandOversizedChunk(r, MAX_BODY_CHARS);
        parts.forEach((p, i) => texts.push(buildStoredText(p, { part: i, total: parts.length })));
    }
    const vecs = await embed(texts.map(t => t.slice(0, 7000)));
    const results = [];
    const batches = [];
    for (let k = 0; k < paras.length; k += PER_CALL) batches.push(paras.slice(k, k + PER_CALL).map((p, i) => ({ p, v: paraVecs[k + i] })));
    await pool(batches.map(batch => async () => {
        const blocks = batch.map(({ p, v }, i) => {
            const top = vecs.map((ev, j) => [cosine(v, ev), j]).sort((a, b) => b[0] - a[0]).slice(0, TOP_K);
            return `=== SOURCE ${i + 1} (section "${p.section}"):\n${p.text}\n\nRETRIEVED ENTRIES FOR SOURCE ${i + 1}:\n${top.map(([, j]) => texts[j].slice(0, 6000)).join('\n---\n')}`;
        }).join('\n\n');
        const task = `Each SOURCE paragraph below comes with the entries a memory system retrieved for it. For each SOURCE, list the facts it states that NONE of its retrieved entries states (a fact counts as present if an entry says the same thing in any wording). A fact is a specific detail: a name, number, rule, event, claim with its owner, quotation, list item, or relation. Also give the total number of facts in the paragraph.

${blocks}

Output a JSON array, one element per SOURCE in order: {"source": number, "facts": total facts in the paragraph, "missing": ["each missing fact, briefly"]}. Output only the JSON array.`;
        const r = await openrouter({ model: JUDGE, temperature: 0, max_tokens: 16000, messages: [{ role: 'user', content: task }] }, { phase: 'semantic-rag' });
        let arr = [];
        try { arr = parse(r.data?.choices?.[0]?.message?.content || '[]'); } catch { console.error('unparseable judge reply'); }
        batch.forEach(({ p }, i) => {
            const v = arr.find(x => Number(x.source) === i + 1) || arr[i] || { facts: 0, missing: [] };
            const missing = (v.missing || []).filter(m => !NAV.test(m));
            results.push({ section: p.section, para: p.text.slice(0, 80), facts: +v.facts || 0, missing });
        });
    }), CONCURRENCY);
    const facts = results.reduce((s, r) => s + r.facts, 0);
    const missing = results.reduce((s, r) => s + r.missing.length, 0);
    const row = {
        run: path.split('/').pop().replace('.json', ''),
        storedPieces: texts.length,
        paragraphs: results.length,
        factsJudged: facts,
        missingFacts: missing,
        retrievedRecall: +(100 * (1 - missing / (facts || 1))).toFixed(1),
        parasMissingSomething: results.filter(r => r.missing.length).length,
    };
    rows.push(row);
    fs.writeFileSync(path.replace('.json', '.rag.json'), JSON.stringify({ ...row, results: results.filter(r => r.missing.length) }, null, 2));
    console.error(row);
}
console.table(rows);
