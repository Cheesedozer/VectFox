// End-to-end: SillyBunny/SillyTavern + VectFox roster-mode Auto-Reformat ->
// Qdrant Cloud, driven in headless Chromium. Expects a running server with
// VectFox under public/scripts/extensions/third-party/VectFox, the
// Similharity plugin, and VectFox's settings pre-seeded in
// data/default-user/settings.json (firstRun: false — the welcome dialog
// otherwise keeps settings from saving): vector_backend 'qdrant',
// qdrant_use_cloud, qdrant_url, source/openrouter_model for embeddings,
// reformat_model and reformat_roster: true.
// Keys come from env (OPENROUTER_API_KEY, QDRANT_API_KEY); they are written
// to the server's secrets. Delete the collection it creates afterwards.
// usage: node e2e-sillybunny.mjs <doc.md> <screenshot dir>
import { chromium } from '../../node_modules/playwright/index.mjs';
const [docPath, outDir] = process.argv.slice(2);
const BASE = process.env.SILLYTAVERN_URL || 'http://127.0.0.1:4444';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const logs = [];
page.on('console', m => { const t = m.text(); if (/Auto-Reformat|VectFox|Qdrant|similharity/i.test(t)) logs.push(`[${m.type()}] ${t}`); });
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
const step = s => console.log(`[e2e] ${new Date().toISOString().slice(11, 19)} ${s}`);

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.extensionSettings?.vectfox, null, { timeout: 120000 });
step('app loaded, VectFox settings present');

await page.evaluate(async ({ or, qk }) => {
    const ctx = window.SillyTavern.getContext();
    const headers = ctx.getRequestHeaders();
    for (const [key, value] of [['api_key_openrouter', or], ['api_key_qdrant', qk]]) {
        const r = await fetch('/api/secrets/write', { method: 'POST', headers, body: JSON.stringify({ key, value }) });
        if (!r.ok) throw new Error(`secret ${key}: ${r.status}`);
    }
}, { or: process.env.OPENROUTER_API_KEY, qk: process.env.QDRANT_API_KEY });
step('secrets written (settings pre-seeded in settings.json); reloading');

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.extensionSettings?.vectfox?.reformat_roster === true, null, { timeout: 120000 });
await page.waitForTimeout(8000);
step('reloaded with roster mode on; UI checkbox checked = ' + await page.evaluate(() => document.querySelector('#VectFox_reformat_roster')?.checked));

// first-run popups from other extensions (Quick Image Gen's setup wizard) cover the page
await page.evaluate(() => document.querySelectorAll('#qig-setup-wizard, .qig-popup').forEach(e => e.remove()));
await page.evaluate(async () => {
    const m = await import('/scripts/extensions/third-party/VectFox/ui/content-vectorizer.js');
    m.openContentVectorizer('document');
});
await page.waitForSelector('#vectfox_cv_doc_file_input', { state: 'attached', timeout: 30000 });
await page.setInputFiles('#vectfox_cv_doc_file_input', docPath);
await page.waitForSelector('#vectfox_cv_reformat_run', { state: 'visible', timeout: 30000 });
await page.screenshot({ path: `${outDir}/1-loaded.png` });
step('document loaded; running Auto-Reformat');

await page.evaluate(() => document.querySelectorAll('#qig-setup-wizard, .qig-popup').forEach(e => e.remove()));
await page.click('#vectfox_cv_reformat_run');
let lastLabel = '';
const t0 = Date.now();
while (!(await page.$('#vectfox_rr_modal'))) {
    // a source accepted before asks "reuse the saved result?" — take a fresh run
    const rerun = page.getByText('Re-run fresh (uses LLM)');
    if (await rerun.isVisible().catch(() => false)) { step('saved result found; choosing Re-run fresh'); await rerun.click(); }
    const label = await page.evaluate(() => document.querySelector('.vectfox-cv-loading')?.textContent?.trim() || document.querySelector('.vectfox-cv-error')?.textContent?.trim() || '');
    if (label && label !== lastLabel) { step(label); lastLabel = label; }
    if (/failed|no entries/i.test(label)) throw new Error(label);
    if (Date.now() - t0 > 20 * 60000) throw new Error('timeout waiting for review modal');
    await page.waitForTimeout(2000);
}
const count = await page.textContent('#vectfox_rr_count');
const warnings = await page.evaluate(() => [...document.querySelectorAll('#vectfox_rr_modal .vectfox-rr-warning, #vectfox_rr_modal [class*="warning"] li')].map(e => e.textContent.trim()).slice(0, 10));
step(`review modal: ${count} entries in ${Math.round((Date.now() - t0) / 1000)}s; warnings: ${JSON.stringify(warnings)}`);
await page.screenshot({ path: `${outDir}/2-review.png` });
await page.click('#vectfox_rr_accept');
await page.waitForTimeout(3000);
await page.screenshot({ path: `${outDir}/3-accepted.png` });
step('accepted; vectorizing');

await page.click('#vectfox_cv_vectorize');
const t1 = Date.now();
let done = false;
while (!done) {
    const toasts = await page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')].map(t => t.textContent.trim()));
    for (const t of toasts) if (!logs.includes(`[toast] ${t}`)) { logs.push(`[toast] ${t}`); step(`toast: ${t.slice(0, 200)}`); }
    if (toasts.some(t => /Vectorized \d+ chunks/.test(t))) done = true;
    if (toasts.some(t => /failed|error/i.test(t) && !/If you already vectorized/.test(t))) { await page.screenshot({ path: `${outDir}/4-error.png` }); throw new Error(`vectorize error: ${toasts.join(' | ')}`); }
    if (Date.now() - t1 > 15 * 60000) throw new Error('timeout vectorizing');
    await page.waitForTimeout(2000);
}
await page.screenshot({ path: `${outDir}/4-done.png` });
step(`vectorized in ${Math.round((Date.now() - t1) / 1000)}s`);
const fs = await import('node:fs');
fs.writeFileSync(`${outDir}/console.log`, logs.join('\n'));
await browser.close();
