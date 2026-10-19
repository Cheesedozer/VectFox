// LLM-judged recall: every source paragraph is checked against ALL entries
// (cached prefix); the judge lists the paragraph's facts no entry states.
// usage: node --import ./register.mjs semantic.mjs <doc> <run.json>...
import fs from 'node:fs';
import { openrouter } from './or.mjs';
import { scorableText } from './metrics.mjs';
const { buildStoredText } = await import('../../core/reformat-schema.js');

const JUDGE = 'anthropic/claude-haiku-5.5';
const PER_CALL = 20;

function paragraphs(doc) {
    const out = [];
    let section = '';
    for (const block of scorableText(doc).split(/\n\s*\n/)) {
        const t = block.trim();
        if (!t) continue;
        const h = t.match(/^#{1,6}\s+(.+)$/m);
        if (h && t.split('\n').length === 1) { section = h[1]; continue; }
        if (t.replace(/^#{1,6}.*$/gm, '').trim().length < 40) continue;
        out.push({ section, text: t });
    }
    return out;
}

function parse(raw) {
    const t = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/, '');
    return JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
}

const [docPath, ...runs] = process.argv.slice(2);
const paras = paragraphs(fs.readFileSync(docPath, 'utf8'));
const rows = [];
for (const path of runs) {
    const run = JSON.parse(fs.readFileSync(path, 'utf8'));
    const entries = run.records.map((r, i) => `[E${i + 1}] ${buildStoredText(r)}`).join('\n\n');
    const sys = `You audit a memory system built from a document. Below are ALL of its entries.\n\nENTRIES:\n${entries}`;
    const results = [];
    const calls = [];
    for (let k = 0; k < paras.length; k += PER_CALL) {
        const batch = paras.slice(k, k + PER_CALL);
        const task = `For each SOURCE paragraph below, list the facts it states that NO entry above states (a fact counts as present if any entry says the same thing, in any wording; minor wording or ordering differences do not matter). A fact is a specific detail: a name, number, date, rule, claim with its owner, quotation, list item, or relation. Also give the total number of facts in the paragraph.

${batch.map((p, i) => `SOURCE ${i + 1} (section "${p.section}"):\n${p.text}`).join('\n\n')}

Output a JSON array, one element per SOURCE in order: {"source": number, "facts": total facts in the paragraph, "missing": ["each missing fact, briefly"]}. Output only the JSON array.`;
        calls.push(openrouter({
            model: JUDGE, temperature: 0, max_tokens: 16000,
            messages: [
                { role: 'system', content: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }] },
                { role: 'user', content: task },
            ],
        }, { phase: 'semantic' }).then(r => {
            const arr = parse(r.data?.choices?.[0]?.message?.content || '[]');
            batch.forEach((p, i) => {
                const v = arr.find(x => Number(x.source) === i + 1) || arr[i] || { facts: 0, missing: [] };
                results.push({ section: p.section, para: p.text.slice(0, 80), facts: +v.facts || 0, missing: v.missing || [] });
            });
        }));
        if (k === 0) await calls[0]; // warm the cache
    }
    await Promise.all(calls);
    const facts = results.reduce((s, r) => s + r.facts, 0);
    const missing = results.reduce((s, r) => s + r.missing.length, 0);
    const row = {
        run: path.split('/').pop().replace('.json', ''),
        paragraphs: results.length,
        factsJudged: facts,
        missingFacts: missing,
        semanticRecall: +(100 * (1 - missing / (facts || 1))).toFixed(1),
        parasMissingSomething: results.filter(r => r.missing.length).length,
    };
    rows.push(row);
    fs.writeFileSync(path.replace('.json', '.semantic.json'), JSON.stringify({ ...row, results: results.filter(r => r.missing.length) }, null, 2));
    console.error(row);
}
console.table(rows);
