// Scores finished runs the same way: fact recall, exact + judged near-duplicates, cost, time.
// usage: node --import ./register.mjs evaluate.mjs <doc> <run.json>...
import fs from 'node:fs';
import { factRecall, nearDuplicates } from './metrics.mjs';
import { openrouter } from './or.mjs';
const { judgePairs } = await import('./roster.mjs');
const { mergeDuplicateEntities } = await import('../../core/reformat-extractor.js');

const JUDGE = 'anthropic/claude-haiku-5.5';
const judgeCall = async (phase, messages, { maxTokens }) => {
    const r = await openrouter({ model: JUDGE, messages, max_tokens: maxTokens, temperature: 0 }, { phase: 'eval' });
    return { content: r.data?.choices?.[0]?.message?.content || '' };
};

const [docPath, ...runs] = process.argv.slice(2);
const doc = fs.readFileSync(docPath, 'utf8');
const rows = [];
for (const path of runs) {
    const run = JSON.parse(fs.readFileSync(path, 'utf8'));
    const records = run.records;
    const exactLeft = records.length - mergeDuplicateEntities(structuredClone(records)).length;
    const recall = factRecall(doc, records);
    const pairs = await nearDuplicates(records);
    const verdicts = await judgePairs(judgeCall, records, pairs, 'eval');
    const dups = verdicts.filter(v => v.same);
    const u = Object.values(run.usage).reduce((a, b) => ({
        calls: a.calls + b.calls, prompt: a.prompt + b.prompt, cached: a.cached + b.cached,
        completion: a.completion + b.completion, cost: a.cost + b.cost, truncated: a.truncated + b.truncated,
    }), { calls: 0, prompt: 0, cached: 0, completion: 0, cost: 0, truncated: 0 });
    const row = {
        run: path.split('/').pop().replace('.json', ''),
        records: records.length,
        recall: +(recall.mean * 100).toFixed(1),
        lowParas: recall.low.length,
        exactDupsLeft: exactLeft,
        nearCandidates: pairs.length,
        judgedDups: dups.length,
        calls: u.calls, inTok: u.prompt, cachedTok: u.cached, outTok: u.completion, truncated: u.truncated,
        cost: +u.cost.toFixed(4),
        wallS: Math.round(run.wallMs / 1000),
    };
    rows.push(row);
    fs.writeFileSync(path.replace('.json', '.eval.json'), JSON.stringify({ ...row, lowParagraphs: recall.low, duplicates: dups, candidates: verdicts }, null, 2));
    console.error(row);
}
console.table(rows);
