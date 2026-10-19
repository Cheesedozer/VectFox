// Incremental roster (ledger) Auto-Reformat prototype — for documents too
// long for one roster reply, and kept under the 100k-token prompt size where
// Haiku 5.5's long-context pricing starts.
//
//   A. Roster, window by window: the document is cut into windows of
//      numbered sections. Each call sees one window plus the roster so far
//      (every name, and full details for items named in the window) and
//      returns operations: new items, or updates (aliases, sources, scope)
//      to existing ones. Sequential, but each reply stays small.
//   B. Fill: each call writes a slice of roster items from the source
//      sections the roster lists for them. Instructions + the roster's name
//      list are a cached prefix shared by every call.
//   C. Leftovers and D. Dedupe as in roster.mjs.
//
// usage: node --import ./register.mjs roster2.mjs <doc> <out.json> <model> [effort] [concurrency]
import fs from 'node:fs';
import { usage, summarizeUsage } from './or.mjs';
import { nearDuplicates } from './metrics.mjs';
import {
    ENTRY_RULES, RECORD_SHAPE, parseJsonArray, makeCaller, validate, parallel,
    applyOps, judgePairs, mergeJudged,
} from './roster.mjs';
const { computeBatchCoverage, normalizeForMatch } = await import('../../core/reformat-schema.js');
const { mergeDuplicateEntities, linkSubEntriesToParents } = await import('../../core/reformat-extractor.js');

const SECTION_CHARS = 4000;
const WINDOW_CHARS = 60000;
const FILL_SOURCE_CHARS = 120000; // ~30k tokens of source per fill call
const FILL_MAX_ITEMS = 12;
const LEFTOVER_PER_CALL = 20;
const AUTHOR_NOTE = /^(?:settings|canon log|open questions|change ?log|to-?do(?: list)?|author'?s? notes?)$/i;

const SYSTEM = `You are converting reference material (a lore document, world bible, book, wiki export, web page or video transcript) into self-contained entries for an AI roleplay memory system. Each entry is retrieved on its own, so it must make sense without the rest of the document.

The document is long, so the work happens in steps. First a ROSTER is built, part by part, listing every entry to write, so that each thing gets exactly one entry however many places mention it. Then the entries are written a few at a time from the source sections the roster lists for them.

${ENTRY_RULES}`;

const BODY_RULES = `Writing the body:
- Keep every fact the SOURCE SECTIONS give about the entry: names, numbers, dates, rules, definitions, events in order, and every list item together with its meaning. Gather them from every source section, not only the first.
- Write clear third-person prose. Fix spelling and grammar and replace pronouns with names, but keep the source's own words for names, terms, quotations and specific details.
- Keep quotations word for word, together with who said them. Verse may be shortened to the lines that carry facts.
- Keep attribution. When the source presents something as the claim, belief or account of a person, group or author, say whose it is. A claim stays a claim and a fact stays a fact.
- Describe the world, not the document.
- Hidden entries ("hidden": true) hold the secret; public entries must not reveal it.
- Each roster item has a scope. Put each fact in the most specific entry whose scope covers it. A broader entry may name a narrower one and say in one sentence what it is, but leaves the details to that entry.`;

// ---------------------------------------------------------------------------
// Sections and windows

export function buildSections(doc) {
    const sections = [];
    const path = [];
    let skipLevel = 0;
    let buf = [];
    const flush = () => {
        const text = buf.join('\n').trim();
        buf = [];
        if (!text || skipLevel) return;
        const heading = path.filter(Boolean).join(' › ');
        // split long sections at paragraph boundaries
        let piece = '';
        for (const para of text.split(/\n\s*\n/)) {
            if (piece && piece.length + para.length > SECTION_CHARS) { sections.push({ heading, text: piece.trim() }); piece = ''; }
            piece += `${para}\n\n`;
        }
        if (piece.trim()) sections.push({ heading, text: piece.trim() });
    };
    for (const line of doc.split('\n')) {
        const h = line.match(/^(#{1,6})\s+(.+)$/);
        if (h) {
            flush();
            const level = h[1].length;
            if (skipLevel && level <= skipLevel) skipLevel = 0;
            if (!skipLevel && AUTHOR_NOTE.test(h[2].trim())) skipLevel = level;
            path.length = level - 1;
            path[level - 1] = h[2].trim();
            continue;
        }
        buf.push(line);
    }
    flush();
    return sections.map((s, i) => ({ id: `S${i + 1}`, ...s }));
}

function windows(sections) {
    const out = [];
    let cur = [], size = 0;
    for (const s of sections) {
        if (cur.length && size + s.text.length > WINDOW_CHARS) { out.push(cur); cur = []; size = 0; }
        cur.push(s); size += s.text.length;
    }
    if (cur.length) out.push(cur);
    return out;
}

function renderSections(list) {
    return list.map(s => `[${s.id}] ${s.heading}\n${s.text}`).join('\n\n');
}

// ---------------------------------------------------------------------------
// A. Roster, window by window

function namesOf(item) {
    return [item.name, ...(item.aliases || [])].filter(Boolean);
}

function compactRoster(items) {
    return items.map(x => `#${x.id} ${namesOf(x).join(' | ')}${x.hidden ? ' (hidden)' : ''}`).join('\n');
}

function detailedItem(x) {
    return `#${x.id} ${x.name}${x.aliases?.length ? ` [aliases: ${x.aliases.join('; ')}]` : ''} (${x.entry_type}${x.hidden ? ', hidden' : ''}) — ${x.scope || ''} Sources so far: ${x.sources.slice(0, 12).join(', ')}${x.sources.length > 12 ? `, +${x.sources.length - 12} more` : ''}.`;
}

/** Roster items any of whose names appear in the text. */
function itemsMentioned(items, text) {
    const norm = ` ${normalizeForMatch(text)} `;
    return items.filter(x => namesOf(x).some(n => {
        const k = normalizeForMatch(n);
        return k.length >= 3 && norm.includes(` ${k} `);
    }));
}

const ROSTER_STEP_TASK = (k, total) => `Update the ROSTER for PART ${k} of ${total} of the document, shown below as numbered sections.

The roster so far is listed above: every item's names, and details for the items this part mentions by name. Before adding an item, check whether the same thing is already on the roster under any name (including a translation, an epithet, or another culture's name for the same figure); if it is, update that item instead.

Output a JSON array of operations:
- {"op": "new", "name": the entry's name in the source's wording, "aliases": other names the document uses for this same thing, "entry_type": "character" | "organization" | "concept" | "location" | "item" | "other", "hidden": true for a hidden-truth entry, otherwise false, "scope": one sentence saying what the entry covers (and what it leaves to a neighbouring entry), "sources": the ids of the sections in THIS part that say something about it}
- {"op": "update", "id": the roster number, "add_aliases": [new names for it found in this part], "add_sources": [ids of sections in THIS part that say something about it], "scope": a revised scope sentence, only if this part widens what the entry covers}

Every section in this part must appear in the sources of at least one new or updated item. Do not write the entries' content. Output only the JSON array.`;

async function buildRosterIncremental(call, sections, log) {
    const items = [];
    const wins = windows(sections);
    const byId = new Map();
    let truncated = 0;
    for (let k = 0; k < wins.length; k++) {
        const win = wins[k];
        const winText = renderSections(win);
        const mentioned = itemsMentioned(items, winText);
        const winIds = new Set(win.map(s => s.id));
        const messages = [
            { role: 'system', content: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }] },
            {
                role: 'user',
                content: `ROSTER SO FAR (${items.length} items):\n${items.length ? compactRoster(items) : '(empty)'}\n\nDETAILS OF ROSTER ITEMS MENTIONED IN THIS PART:\n${mentioned.length ? mentioned.map(detailedItem).join('\n') : '(none)'}\n\nPART ${k + 1} OF ${wins.length}:\n${winText}\n\n${ROSTER_STEP_TASK(k + 1, wins.length)}`,
            },
        ];
        const { content, finish } = await call('A-roster', messages);
        if (finish === 'length') truncated++;
        let added = 0, updated = 0;
        for (const op of parseJsonArray(content)) {
            const sources = (op.sources || op.add_sources || []).filter(id => winIds.has(id));
            if (op.op === 'update') {
                const x = byId.get(Number(op.id));
                if (!x) continue;
                for (const a of op.add_aliases || []) if (a && !namesOf(x).some(n => n.toLowerCase() === a.toLowerCase())) x.aliases.push(a);
                for (const s of sources) if (!x.sources.includes(s)) x.sources.push(s);
                if (op.scope) x.scope = op.scope;
                updated++;
            } else if (op.op === 'new' && typeof op.name === 'string' && op.name.trim()) {
                const x = {
                    id: items.length + 1,
                    name: op.name.trim(),
                    aliases: Array.isArray(op.aliases) ? op.aliases.filter(a => typeof a === 'string' && a.trim()) : [],
                    entry_type: op.entry_type || 'other',
                    hidden: op.hidden === true,
                    scope: op.scope || '',
                    sources: [...new Set(sources)],
                };
                items.push(x); byId.set(x.id, x); added++;
            }
        }
        // sections nobody claimed go to the item whose sources include the previous section
        const claimed = new Set(items.flatMap(x => x.sources));
        const orphans = win.filter(s => !claimed.has(s.id)).map(s => s.id);
        log(`roster part ${k + 1}/${wins.length}: +${added} new, ${updated} updated, ${mentioned.length} shown in detail, ${orphans.length} unclaimed section(s)${finish === 'length' ? ' TRUNCATED' : ''}`);
    }
    return { items, truncated };
}

// ---------------------------------------------------------------------------
// B. Fill from listed sources

function planSlices(items, sectionById) {
    const sorted = [...items].sort((a, b) => sectionOrder(a) - sectionOrder(b));
    function sectionOrder(x) { return x.sources.length ? Number(x.sources[0].slice(1)) : 1e9; }
    const slices = [];
    let cur = [], srcs = new Set(), size = 0;
    for (const x of sorted) {
        const add = x.sources.filter(s => !srcs.has(s));
        const addSize = add.reduce((n, s) => n + (sectionById.get(s)?.text.length || 0), 0);
        if (cur.length && (cur.length >= FILL_MAX_ITEMS || size + addSize > FILL_SOURCE_CHARS)) {
            slices.push(cur); cur = []; srcs = new Set(); size = 0;
        }
        cur.push(x);
        for (const s of x.sources) if (!srcs.has(s)) { srcs.add(s); size += sectionById.get(s)?.text.length || 0; }
    }
    if (cur.length) slices.push(cur);
    return slices;
}

function sliceSources(slice, sectionById) {
    // An item with very many sources (a major god) is capped so one call fits.
    const ids = new Set();
    let size = 0;
    for (const x of slice) {
        for (const s of x.sources) {
            const len = sectionById.get(s)?.text.length || 0;
            if (ids.has(s)) continue;
            if (size + len > FILL_SOURCE_CHARS * 1.5) break;
            ids.add(s); size += len;
        }
    }
    return [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).map(id => sectionById.get(id)).filter(Boolean);
}

function fillTask(slice) {
    return `Write the entries for roster items ${slice.map(x => `#${x.id}`).join(', ')} — exactly these ${slice.length}, one entry each, in this order, using the roster names:
${slice.map(detailedItem).join('\n')}

Other roster items are written in other calls: do not write entries for them, and do not copy their details into these entries. Use the roster's names when naming other things in relationships.

Output a JSON array. Each element has exactly these fields:
${RECORD_SHAPE}

${BODY_RULES}

Output only the JSON array.`;
}

async function fillSlice(call, prefixMsgs, slice, sectionById, warnings) {
    const sources = sliceSources(slice, sectionById);
    const messages = [...prefixMsgs, { role: 'user', content: `SOURCE SECTIONS:\n${renderSections(sources)}\n\n${fillTask(slice)}` }];
    const { content, finish } = await call('B-fill', messages);
    if (finish === 'length') warnings.push(`fill #${slice[0].id}…: truncated`);
    return validate(parseJsonArray(content), `fill #${slice[0].id}`, warnings);
}

// B'. Fill by source batch: small batches of consecutive sections, each
// writing what it says about the roster items it covers, under their roster
// names. Pieces of one item from different batches are joined by name
// afterwards. Small inputs keep the model from summarizing.

const BATCH_CHARS = 6000;

function sourceBatches(sections) {
    const out = [];
    let cur = [], size = 0;
    for (const s of sections) {
        if (cur.length && size + s.text.length > BATCH_CHARS) { out.push(cur); cur = []; size = 0; }
        cur.push(s); size += s.text.length;
    }
    if (cur.length) out.push(cur);
    return out;
}

function batchFillTask(covered) {
    return `Write what the SOURCE SECTIONS above say about each roster item they cover. Other sections write their own parts of these entries, and all parts of an entry are joined later, so write only what THESE sections say.

Roster items whose sources include these sections:
${covered.length ? covered.map(detailedItem).join('\n') : '(none listed)'}

Write one element per roster item these sections describe. Usually that means the items listed above, plus any other roster item the sections describe. Use the roster name exactly as "name". Only when the sections describe a thing that has no roster item and deserves one, add an element with a new name.

Every fact in the sections must land in one of the elements.

Output a JSON array. Each element has exactly these fields:
${RECORD_SHAPE}

${BODY_RULES.replace('Gather them from every source section, not only the first.', 'Taken together, the elements must contain everything the sections say, so a long section gives long bodies.')}

Output only the JSON array.`;
}

async function fillBatch(call, prefixMsgs, batch, items, warnings) {
    const ids = new Set(batch.map(s => s.id));
    const covered = items.filter(x => x.sources.some(s => ids.has(s)));
    const messages = [...prefixMsgs, { role: 'user', content: `SOURCE SECTIONS:\n${renderSections(batch)}\n\n${batchFillTask(covered)}` }];
    const { content, finish } = await call('B-fill', messages);
    if (finish === 'length') warnings.push(`fill ${batch[0].id}: truncated`);
    return validate(parseJsonArray(content), `fill ${batch[0].id}`, warnings);
}

// ---------------------------------------------------------------------------
// C. Leftovers against the roster

function leftoverTask(flagged) {
    const parts = flagged.map((f, i) => `[${i + 1}] Section "${f.title}" — details not found in any entry: ${f.missingFacts.join(' | ')}\n${f.text}`).join('\n\n');
    return `The entries have been written. A check found that these paragraphs' details are missing from them:

${parts}

For each missing detail, decide which roster entry it belongs to and return operations:
- {"op": "append", "name": a roster name exactly, "text": sentences to add to that entry's body} — use this whenever an existing entry fits;
- {"op": "create", ...an entry with all the fields below} — only for a thing that has no roster entry and deserves one.

Entry fields for "create":
${RECORD_SHAPE}

${BODY_RULES}

Do not restate details that are not in the list above. Output only the JSON array of operations.`;
}

// ---------------------------------------------------------------------------

export async function rosterIncremental({ doc, model, effort = '', concurrency = 8, judgeModel = model, coverageThreshold = 0.5, fillMode = 'items', rosterFrom = null }) {
    const call = makeCaller({ model, effort });
    const judgeCall = makeCaller({ model: judgeModel, effort: '' });
    const warnings = [];
    const log = (...a) => console.error('[roster2]', ...a);

    const sections = buildSections(doc);
    const sectionById = new Map(sections.map(s => [s.id, s]));
    log(`${sections.length} sections, ${windows(sections).length} roster parts`);

    // A
    const roster = rosterFrom
        ? { items: JSON.parse(fs.readFileSync(rosterFrom, 'utf8')).roster, truncated: 0 }
        : await buildRosterIncremental(call, sections, log);
    const items = roster.items;
    log(`roster: ${items.length} items`);

    // B
    const prefixMsgs = [
        { role: 'system', content: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: [{ type: 'text', text: `ROSTER — every entry being written, by number and names:\n${compactRoster(items)}`, cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: 'Understood. Give me the source sections and the roster items to write.' },
    ];
    let records;
    if (fillMode === 'sections') {
        const batches = sourceBatches(sections);
        log(`fill: ${batches.length} source batch call(s)`);
        const first = await fillBatch(call, prefixMsgs, batches[0], items, warnings);
        const rest = await parallel(batches.slice(1).map(b => () => fillBatch(call, prefixMsgs, b, items, warnings).catch(e => { warnings.push(String(e.message)); return []; })), concurrency);
        records = [first, ...rest].flat();
        // pieces of one roster item carry its roster name; pieces that used an
        // alias are renamed to it so the exact merge joins them
        const canonical = new Map();
        for (const x of items) for (const n of namesOf(x)) if (!canonical.has(n.toLowerCase())) canonical.set(n.toLowerCase(), x);
        for (const r of records) {
            const x = canonical.get(r.name.toLowerCase());
            if (x && x.name !== r.name) { r.aliases = [...new Set([...r.aliases, r.name, ...x.aliases])].filter(a => a !== x.name); r.name = x.name; }
        }
        const pieces = records.length;
        records = mergeDuplicateEntities(records);
        const known = new Set(items.map(x => x.name.toLowerCase()));
        log(`fill: ${pieces} pieces joined into ${records.length} records (${records.filter(r => !known.has(r.name.toLowerCase())).length} not on the roster)`);
    } else {
    const slices = planSlices(items, sectionById);
    log(`fill: ${slices.length} call(s)`);
    const first = await fillSlice(call, prefixMsgs, slices[0], sectionById, warnings);
    const rest = await parallel(slices.slice(1).map(s => () => fillSlice(call, prefixMsgs, s, sectionById, warnings).catch(e => { warnings.push(String(e.message)); return []; })), concurrency);
    records = [first, ...rest].flat();
    }
    const written = new Set(records.map(r => r.name.toLowerCase()));
    const missing = fillMode === 'sections' ? [] : items.filter(x => !written.has(x.name.toLowerCase()));
    if (missing.length) {
        log(`fill: ${missing.length} roster item(s) not returned, retrying`);
        const again = await parallel(planSlices(missing, sectionById).map(s => () => fillSlice(call, prefixMsgs, s, sectionById, warnings).catch(() => [])), concurrency);
        records.push(...again.flat());
    }
    const afterFill = records.length;
    log(`fill: ${afterFill} records`);

    // C
    const flagged = computeBatchCoverage(sections.map(s => `## ${s.heading}\n\n${s.text}`).join('\n\n'), records, coverageThreshold);
    const leftover = { flagged: flagged.length, appended: 0, created: 0 };
    const groups = [];
    for (let i = 0; i < flagged.length; i += LEFTOVER_PER_CALL) groups.push(flagged.slice(i, i + LEFTOVER_PER_CALL));
    const opsLists = await parallel(groups.map(g => async () => {
        try {
            const { content } = await call('C-leftover', [...prefixMsgs, { role: 'user', content: leftoverTask(g) }]);
            return parseJsonArray(content);
        } catch (e) { warnings.push(`leftover: ${e.message}`); return []; }
    }), concurrency);
    for (const ops of opsLists) {
        const r = applyOps(ops, records, warnings);
        leftover.appended += r.appended; leftover.created += r.created;
    }
    log(`leftover: ${JSON.stringify(leftover)}`);

    // exact merge, then D
    records = mergeDuplicateEntities(records);
    const afterExact = records.length;
    const pairs = await nearDuplicates(records);
    const verdicts = await judgePairs(judgeCall, records, pairs);
    records = mergeJudged(records, verdicts);
    linkSubEntriesToParents(records);
    log(`dedupe: ${pairs.length} candidate pair(s), ${verdicts.filter(v => v.same).length} judged same → ${records.length} records`);

    return { records, roster: items, warnings, stats: { sections: sections.length, rosterSize: items.length, rosterTruncated: roster.truncated, afterFill, leftover, afterExact, candidatePairs: pairs.length, verdicts } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [docPath, out, model, effort = '', concurrency = '8', fillMode = 'items', rosterFrom = ''] = process.argv.slice(2);
    const doc = fs.readFileSync(docPath, 'utf8');
    const t0 = Date.now();
    const res = await rosterIncremental({ doc, model, effort, concurrency: +concurrency, fillMode, rosterFrom: rosterFrom || null });
    const wallMs = Date.now() - t0;
    fs.writeFileSync(out, JSON.stringify({ method: `roster2-${fillMode}`, model, effort, rosterFrom, wallMs, usage: summarizeUsage(), calls: usage, ...res }, null, 2));
    console.log(`roster2: ${res.records.length} records in ${(wallMs / 1000).toFixed(0)}s`, summarizeUsage());
}
