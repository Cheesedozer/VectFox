// Roster-first Auto-Reformat prototype (ideas 1 + 3 + 5).
//
//   A. Roster:   one call reads the whole document and lists every entry to
//                write (name, aliases, type, scope, where it is described).
//   B. Fill:     calls that each write a slice of the roster's entries, with
//                the whole document and the roster in a cached prefix.
//   C. Leftover: paragraphs the entries under-cover go back to the model as
//                append/create operations against the existing entries.
//   D. Dedupe:   embedding/name-containment candidates judged by the model.
//
// usage: node --import ./register.mjs roster.mjs <doc> <out.json> <model> [effort] [sliceSize] [concurrency]
import fs from 'node:fs';
import { openrouter, usage, summarizeUsage } from './or.mjs';
import { nearDuplicates, scorableText } from './metrics.mjs';
const { validateReformattedChunk, computeBatchCoverage } = await import('../../core/reformat-schema.js');
const { mergeDuplicateEntities, linkSubEntriesToParents } = await import('../../core/reformat-extractor.js');

export const ENTRY_RULES = `An entry is either:
- a named thing: a character, organization, location or item; or
- a topic: a system, law, event, period, custom or other subject that is not one named thing.

Skip sections written for the author or the site rather than about the world: writing settings (voice, tone, options turned on or off), canon logs and lists of established facts, change logs, open questions, to-do lists, tagging rules, upload notes, navigation and site announcements. Their facts are covered where the document states them.

Give every named thing the document describes its own entry, under its own name: people, groups, institutions, places, laws, programs, systems and objects with a proper name. "Describes" means the document says what the thing is: its nature, purpose, members, abilities, appearance or rules. This applies even when the description sits inside a larger section, in a list, or only in bold. A thing that only takes part in events (someone the subject meets, fights or travels with) gets no entry of its own; those events belong in the subject's entries. When a topic section has several parts that are each discussed at length (a paragraph or more), give each part its own entry named "<Section name>: <Part title>". Short parts stay in the section's entry. When a section title is generic (such as "History" or "Abilities"), name its entry after its subject, like "History of <subject>" or "<Subject>: Abilities".

Content from a section the document marks as spoilers, secrets or hidden truths goes in its own entries, named "<Subject>: Hidden truth", where the subject is the thing the secret is about.

One thing, one entry: a thing the document calls by several names (a full name, a short name, an acronym, "the app" and "GAMA") is ONE entry with the other names as aliases.`;

export const BODY_RULES = `Writing the body:
- Keep every fact: names, numbers, dates, prices, rules, definitions, and every list item together with its meaning. Gather the facts about the entry from EVERY place in the document that discusses it, not only its main section.
- Write clear third-person prose. Fix spelling and grammar and replace pronouns with names, but keep the source's own words for names, terms, quotations and specific details.
- Keep quotations word for word, together with who said them.
- Keep attribution. When the document presents something as the claim, belief or official position of a person or group, say whose it is. A claim stays a claim and a fact stays a fact.
- Describe the world, not the document. If a note aimed at editors or the author contains a fact about the world, state the fact and drop the note.
- Hidden entries ("hidden": true) hold the secret; public entries must not reveal it.
- Each roster item has a scope. Put each fact in the most specific entry whose scope covers it. A broader entry may name a narrower one and say in one sentence what it is, but leaves the details to that entry.`;

export const RECORD_SHAPE = `{
  "entry_type": "character" | "organization" | "concept" | "location" | "item" | "other",
  "name": the roster name, exactly,
  "aliases": the roster aliases, plus any other names for this same thing,
  "affiliation": the group this entry belongs to, or "",
  "relationships": for a named thing, [{"target": the name of another roster entry, "type": a short verb phrase that reads as "<name> <type> <target>"}]; for a topic, [],
  "keywords": an array of search terms someone might use to find this entry,
  "hidden": the roster's hidden value,
  "body": the entry's content
}`;

const SYSTEM = `You are converting reference material (a lore document, world bible, wiki export, web page or video transcript) into self-contained entries for an AI roleplay memory system. Each entry is retrieved on its own, so it must make sense without the rest of the document.

The work happens in steps. First a ROSTER lists every entry to write, so that each thing gets exactly one entry. Then the entries are written a few at a time, each with the whole document in view.

${ENTRY_RULES}`;

function docBlock(doc) {
    return `DOCUMENT:\n${doc}`;
}

// ---------------------------------------------------------------------------

export function parseJsonArray(raw) {
    let text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { const v = JSON.parse(text); if (Array.isArray(v)) return v; } catch { /* fall through */ }
    const a = text.indexOf('['), b = text.lastIndexOf(']');
    if (a !== -1 && b > a) {
        try { return JSON.parse(text.slice(a, b + 1)); } catch { /* fall through */ }
    }
    // object stream fallback (truncated arrays)
    const objs = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') { if (depth === 0) start = i; depth++; }
        else if (c === '}') { depth--; if (depth === 0 && start !== -1) { try { objs.push(JSON.parse(text.slice(start, i + 1))); } catch { /* skip */ } start = -1; } }
    }
    if (objs.length) return objs;
    throw new Error(`unparseable reply: ${text.slice(0, 200)}`);
}

export function makeCaller({ model, effort }) {
    return async function call(phase, messages, { maxTokens = 64000 } = {}) {
        const r = await openrouter({
            model,
            messages,
            max_tokens: maxTokens,
            temperature: 0.2,
            ...(effort ? { reasoning: { effort } } : {}),
        }, { phase });
        if (!r.ok) throw new Error(`${phase}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
        const choice = r.data.choices?.[0];
        return { content: choice?.message?.content || '', finish: choice?.finish_reason };
    };
}

/** The cached prefix: instructions + document, optionally + roster. Identical across calls. */
function prefix(doc, rosterText = null) {
    const msgs = [
        { role: 'system', content: [{ type: 'text', text: `${SYSTEM}\n\n${docBlock(doc)}`, cache_control: { type: 'ephemeral' } }] },
    ];
    if (rosterText) {
        msgs.push({ role: 'user', content: [{ type: 'text', text: `ROSTER (every entry to write, numbered):\n${rosterText}`, cache_control: { type: 'ephemeral' } }] });
        msgs.push({ role: 'assistant', content: 'Understood. Tell me which roster entries to write.' });
    }
    return msgs;
}

// ---------------------------------------------------------------------------
// A. Roster

const ROSTER_TASK = `Build the ROSTER for the DOCUMENT above: every entry that should exist, following the rules for what gets an entry. Do not write the entries' content yet.

Read the whole document first. Before adding an item, check whether the same thing already appears under another name; if so, add the name as an alias instead.

Every paragraph of the document (outside skipped author sections) must fall within the scope of at least one roster item.

Output a JSON array, in document order. Each element:
{
  "name": the entry's name, in the source's wording,
  "aliases": other names the document uses for this same thing,
  "entry_type": "character" | "organization" | "concept" | "location" | "item" | "other",
  "hidden": true for a hidden-truth entry, otherwise false,
  "scope": one sentence saying what this entry covers (and, when a neighbouring entry covers part of it, what it leaves to that entry),
  "sources": the titles of every section that says something about it
}

Output only the JSON array.`;

async function buildRoster(call, doc) {
    const { content, finish } = await call('A-roster', [...prefix(doc), { role: 'user', content: ROSTER_TASK }]);
    const items = parseJsonArray(content).filter(x => x && typeof x.name === 'string' && x.name.trim());
    return { items: items.map((x, i) => ({ id: i + 1, ...x })), finish };
}

function rosterText(items) {
    return items.map(x => `#${x.id} ${x.name}${x.aliases?.length ? ` [aliases: ${x.aliases.join('; ')}]` : ''} (${x.entry_type}${x.hidden ? ', hidden' : ''}) — ${x.scope || ''}${x.sources?.length ? ` Sources: ${x.sources.join('; ')}.` : ''}`).join('\n');
}

// ---------------------------------------------------------------------------
// B. Fill

function fillTask(slice) {
    return `Write the entries for roster items ${slice.map(x => `#${x.id}`).join(', ')} — exactly these ${slice.length}, one entry each, in this order, using the roster names. The other roster items are written in other calls: do not write entries for them, and do not copy their details into these entries.

Output a JSON array. Each element has exactly these fields:
${RECORD_SHAPE}

${BODY_RULES}

Output only the JSON array.`;
}

export function validate(rawItems, label, warnings) {
    const out = [];
    for (const raw of rawItems) {
        const v = validateReformattedChunk(raw);
        if (v.ok) out.push(v.chunk);
        else warnings.push(`${label}: dropped item — ${v.errors.join('; ')}`);
    }
    return out;
}

async function fillSlice(call, doc, rText, slice, warnings) {
    const { content, finish } = await call('B-fill', [...prefix(doc, rText), { role: 'user', content: fillTask(slice) }]);
    if (finish === 'length') warnings.push(`fill ${slice[0].id}-${slice.at(-1).id}: truncated`);
    return validate(parseJsonArray(content), `fill ${slice[0].id}`, warnings);
}

export async function parallel(fns, n) {
    const results = new Array(fns.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, fns.length) }, async () => {
        while (next < fns.length) { const i = next++; results[i] = await fns[i](); }
    }));
    return results;
}

// ---------------------------------------------------------------------------
// C. Leftovers

function leftoverTask(flagged, items) {
    const parts = flagged.map((f, i) => `[${i + 1}] Section "${f.title}" — details not found in any entry: ${f.missingFacts.join(' | ')}\n${f.text}`).join('\n\n');
    return `The entries have been written. A check found that these paragraphs' details are missing from them:

${parts}

For each missing detail, decide which roster entry it belongs to and return operations:
- {"op": "append", "name": a roster name exactly, "text": sentences to add to that entry's body, written by the body rules} — use this whenever an existing entry fits;
- {"op": "create", ...an entry with all the fields below} — only for a thing that has no roster entry and deserves one.

Entry fields for "create":
${RECORD_SHAPE}

${BODY_RULES}

Do not restate details that are not in the list above. Output only the JSON array of operations.`;
}

export function applyOps(ops, records, warnings) {
    const byName = new Map(records.map(r => [r.name.toLowerCase(), r]));
    let appended = 0, created = 0;
    for (const op of ops) {
        if (op?.op === 'append') {
            const r = byName.get(String(op.name || '').toLowerCase());
            if (!r) { warnings.push(`leftover: append to unknown "${op.name}"`); continue; }
            r.body = `${r.body.trim()} ${String(op.text || '').trim()}`.trim();
            appended++;
        } else if (op?.op === 'create') {
            const v = validateReformattedChunk(op);
            if (!v.ok) { warnings.push(`leftover create dropped: ${v.errors.join('; ')}`); continue; }
            records.push(v.chunk);
            byName.set(v.chunk.name.toLowerCase(), v.chunk);
            created++;
        }
    }
    return { appended, created };
}

// ---------------------------------------------------------------------------
// D. Dedupe

const JUDGE_TASK = (pairs) => `Below are pairs of entries from a memory system built from one document. For each pair, decide whether the two entries are about the SAME thing (the same person, group, place, object or topic under different names) — then they should be merged. Entries about a thing and one of its parts, members, products or sub-topics are NOT the same.

${pairs.map((p, k) => `Pair ${k + 1}:\nA: ${p.A.name}${p.A.aliases.length ? ` [aliases: ${p.A.aliases.join('; ')}]` : ''} — ${p.A.body.slice(0, 700)}\nB: ${p.B.name}${p.B.aliases.length ? ` [aliases: ${p.B.aliases.join('; ')}]` : ''} — ${p.B.body.slice(0, 700)}`).join('\n\n')}

Output a JSON array with one element per pair, in order: {"pair": number, "same": true|false, "keep": the better name for the merged entry when same, else ""}. Output only the JSON array.`;

export async function judgePairs(call, records, pairs, phase = 'D-dedupe') {
    if (!pairs.length) return [];
    const input = pairs.map(p => ({ A: records[p.i], B: records[p.j], ...p }));
    const verdicts = [];
    for (let k = 0; k < input.length; k += 25) {
        const chunk = input.slice(k, k + 25);
        const { content } = await call(phase, [{ role: 'user', content: JUDGE_TASK(chunk) }], { maxTokens: 8000 });
        const arr = parseJsonArray(content);
        chunk.forEach((p, idx) => {
            const v = arr.find(x => Number(x.pair) === idx + 1) || arr[idx] || {};
            verdicts.push({ a: p.A.name, b: p.B.name, i: p.i, j: p.j, sim: p.sim, same: v.same === true, keep: v.keep || '' });
        });
    }
    return verdicts;
}

export function mergeJudged(records, verdicts) {
    // union-find over records judged the same
    const parent = records.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const keepName = new Map();
    for (const v of verdicts.filter(v => v.same)) {
        const a = find(v.i), b = find(v.j);
        if (a !== b) parent[b] = a;
        if (v.keep) keepName.set(find(v.i), v.keep);
    }
    const groups = new Map();
    records.forEach((r, i) => { const g = find(i); (groups.get(g) || groups.set(g, []).get(g)).push(r); });
    const out = [];
    for (const [g, members] of groups) {
        if (members.length === 1) { out.push(members[0]); continue; }
        const names = [...new Set(members.flatMap(m => [m.name, ...m.aliases]))];
        const keep = keepName.get(g) && names.includes(keepName.get(g)) ? keepName.get(g) : members[0].name;
        // rename every member to the kept name so mergeDuplicateEntities unifies them
        for (const m of members) {
            m.aliases = names.filter(n => n !== keep);
            m.name = keep;
        }
        out.push(...members);
    }
    return mergeDuplicateEntities(out);
}

// ---------------------------------------------------------------------------

export async function rosterReformat({ doc, model, effort = '', sliceSize = 12, concurrency = 4, judgeModel = model, coverageThreshold = 0.5 }) {
    const call = makeCaller({ model, effort });
    const judgeCall = makeCaller({ model: judgeModel, effort: '' });
    const warnings = [];
    const log = (...a) => console.error('[roster]', ...a);

    // A
    const roster = await buildRoster(call, doc);
    log(`roster: ${roster.items.length} items (finish=${roster.finish})`);
    const rText = rosterText(roster.items);

    // B — first slice alone writes the cache, the rest run in parallel
    const slices = [];
    for (let i = 0; i < roster.items.length; i += sliceSize) slices.push(roster.items.slice(i, i + sliceSize));
    const first = await fillSlice(call, doc, rText, slices[0], warnings);
    const rest = await parallel(slices.slice(1).map(s => () => fillSlice(call, doc, rText, s, warnings).catch(e => { warnings.push(String(e.message)); return []; })), concurrency);
    let records = [first, ...rest].flat();
    // roster items no fill call returned
    const written = new Set(records.map(r => r.name.toLowerCase()));
    const missing = roster.items.filter(x => !written.has(x.name.toLowerCase()));
    if (missing.length) {
        log(`fill: ${missing.length} roster item(s) not returned, retrying`);
        const again = await parallel(
            Array.from({ length: Math.ceil(missing.length / sliceSize) }, (_, k) => () => fillSlice(call, doc, rText, missing.slice(k * sliceSize, (k + 1) * sliceSize), warnings).catch(() => [])),
            concurrency,
        );
        records.push(...again.flat());
    }
    const afterFill = records.length;
    log(`fill: ${afterFill} records`);

    // C
    const flagged = computeBatchCoverage(scorableText(doc), records, coverageThreshold);
    let leftover = { flagged: flagged.length, appended: 0, created: 0 };
    if (flagged.length) {
        const { content } = await call('C-leftover', [...prefix(doc, rText), { role: 'user', content: leftoverTask(flagged, roster.items) }]);
        Object.assign(leftover, applyOps(parseJsonArray(content), records, warnings));
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

    return { records, roster: roster.items, warnings, stats: { rosterSize: roster.items.length, afterFill, leftover, afterExact, candidatePairs: pairs.length, verdicts } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [docPath, out, model, effort = '', sliceSize = '12', concurrency = '4'] = process.argv.slice(2);
    const doc = fs.readFileSync(docPath, 'utf8');
    const t0 = Date.now();
    const res = await rosterReformat({ doc, model, effort, sliceSize: +sliceSize, concurrency: +concurrency });
    const wallMs = Date.now() - t0;
    fs.writeFileSync(out, JSON.stringify({ method: 'roster', model, effort, sliceSize: +sliceSize, wallMs, usage: summarizeUsage(), calls: usage, ...res }, null, 2));
    console.log(`roster: ${res.records.length} records in ${(wallMs / 1000).toFixed(0)}s`, summarizeUsage());
}
