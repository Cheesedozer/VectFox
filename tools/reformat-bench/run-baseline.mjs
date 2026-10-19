// Runs the extension's real reformatDocument (batched or whole-document).
// usage: node --import ./register.mjs run-baseline.mjs <doc> <out.json> <model> <batched|whole> [effort]
import fs from 'node:fs';
import { usage, summarizeUsage, setPhase } from './or.mjs';
const [doc, out, model, mode, effort = ''] = process.argv.slice(2);
const { reformatDocument } = await import('../../core/reformat-extractor.js');
const text = fs.readFileSync(doc, 'utf8');
setPhase(`baseline-${mode}`);
const t0 = Date.now();
const res = await reformatDocument({
    text, contentType: 'document', sourceName: process.env.SOURCE_NAME || 'The Settlement',
    settings: { reformat_concurrency: 8, reformat_model: model, reformat_single_pass: mode === 'whole', reformat_reasoning_effort: effort },
});
const wallMs = Date.now() - t0;
fs.writeFileSync(out, JSON.stringify({ method: `baseline-${mode}`, model, effort, wallMs, mode: res.mode, warnings: res.warnings, usage: summarizeUsage(), calls: usage, records: res.chunks }, null, 2));
console.log(`${res.mode}: ${res.chunks.length} records in ${(wallMs / 1000).toFixed(0)}s`, summarizeUsage());
