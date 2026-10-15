/**
 * ============================================================================
 * AUTO-REFORMAT SCHEMA
 * ============================================================================
 * Record shape, validator, prompt builders, stored-text builder and the
 * grounding/coverage guardrails for Auto-Reformat (Document/URL/Wiki/YouTube).
 *
 * Pure, no ST dependencies, so it can be unit-tested without mocks.
 *
 * Deliberately independent from core/eventbase-schema.js: a schema change in
 * chat's EventBase pipeline must never affect content reformatting, and vice
 * versa.
 * ============================================================================
 */

import StringUtils from '../utils/string-utils.js';

/**
 * Controlled vocabulary for entry_type; unknown values become 'other'.
 * @type {readonly string[]}
 */
export const REFORMAT_ENTRY_TYPES = Object.freeze([
    'character',
    'organization',
    'concept',
    'location',
    'item',
    'other',
]);

// v3: traits and keyword importance removed, `hidden` added. Tracks field
// shapes only; prompt revisions never bump it.
export const REFORMAT_SCHEMA_VERSION = 3;

/** Line put above a hidden entry's body in the stored text. */
export const HIDDEN_TRUTH_TAG = '[Hidden truth, not public knowledge]';

/**
 * Non-fatal extraction parse error (per-batch; caller should log + skip that
 * batch while continuing with the rest of the document).
 */
export class ReformatExtractionError extends Error {
    /**
     * @param {string} message
     * @param {number} [batchIndex]
     */
    constructor(message, batchIndex = -1) {
        super(message);
        this.name = 'ReformatExtractionError';
        this.batchIndex = batchIndex;
    }
}

/**
 * Fatal configuration/auth error (aborts the entire reformat run).
 */
export class ReformatFatalError extends Error {
    /**
     * @param {string} message
     * @param {string} [code]
     */
    constructor(message, code = 'fatal') {
        super(message);
        this.name = 'ReformatFatalError';
        this.code = code;
    }
}

// ---------------------------------------------------------------------------
// Field coercion
// ---------------------------------------------------------------------------

/**
 * Coerces one array item to a string. Models occasionally emit an object
 * where a string was asked for; pull readable text out of common keys rather
 * than storing "[object Object]".
 * @param {unknown} item
 * @returns {{text: string, wasObjectCoercion: boolean}}
 */
function coerceArrayItem(item) {
    if (typeof item === 'string') return { text: item.trim(), wasObjectCoercion: false };
    if (item && typeof item === 'object' && !Array.isArray(item)) {
        const parts = ['text', 'target', 'name', 'description', 'relation', 'type']
            .map(key => (/** @type {any} */ (item))[key])
            .filter(v => typeof v === 'string' && v.trim());
        if (parts.length > 0) {
            return { text: [...new Set(parts)].join(' — ').trim(), wasObjectCoercion: true };
        }
        try {
            return { text: JSON.stringify(item), wasObjectCoercion: true };
        } catch {
            return { text: '', wasObjectCoercion: true };
        }
    }
    return { text: String(item ?? '').trim(), wasObjectCoercion: false };
}

/**
 * Trims, drops empties and dedupes (case-insensitively) an array of strings.
 * Notes object coercions in `errors` when a fieldName is given.
 * @param {unknown} val
 * @param {string} [fieldName]
 * @param {string[]} [errors]
 * @returns {string[]}
 */
function ensureStringArray(val, fieldName = '', errors = null) {
    if (!Array.isArray(val)) return [];
    let objectCoercions = 0;
    const seen = new Set();
    const out = [];
    for (const item of val) {
        // Keyword objects from the old {text, importance} shape are expected,
        // not a model error.
        const isLegacyKeyword = item && typeof item === 'object' && typeof item.text === 'string';
        const { text, wasObjectCoercion } = isLegacyKeyword
            ? { text: item.text.trim(), wasObjectCoercion: false }
            : coerceArrayItem(item);
        if (wasObjectCoercion) objectCoercions++;
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    if (objectCoercions > 0 && fieldName && errors) {
        errors.push(`${fieldName}: ${objectCoercions} item(s) were objects instead of strings — coerced to text`);
    }
    return out;
}

/**
 * Coerces a raw `relationships` field into deduped {target, type}[].
 * Tolerates bare strings (treated as the target) and the alternate keys
 * `name` (for target) and `relation`/`relationship` (for type).
 * @param {unknown} val
 * @param {string[]} [errors]
 * @returns {{target: string, type: string}[]}
 */
function ensureRelationships(val, errors = null) {
    if (!Array.isArray(val)) return [];
    const seen = new Set();
    const out = [];
    let coercions = 0;
    let dropped = 0;

    for (const item of val) {
        let target = '';
        let type = '';
        let reshaped = false;
        if (typeof item === 'string') {
            target = item.trim();
            reshaped = Boolean(target);
        } else if (item && typeof item === 'object' && !Array.isArray(item)) {
            const obj = /** @type {any} */ (item);
            target = typeof obj.target === 'string' ? obj.target.trim() : '';
            type = typeof obj.type === 'string' ? obj.type.trim() : '';
            if (!target && typeof obj.name === 'string') {
                target = obj.name.trim();
                reshaped = true;
            }
            if (!type) {
                const altType = typeof obj.relation === 'string' ? obj.relation
                    : typeof obj.relationship === 'string' ? obj.relationship : '';
                if (altType.trim()) {
                    type = altType.trim();
                    reshaped = true;
                }
            }
        }
        if (!target) {
            if (item !== null && item !== undefined && item !== '') dropped++;
            continue;
        }
        if (reshaped) coercions++;

        const key = `${target.toLowerCase()}|${type.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ target, type });
    }

    if (coercions > 0 && errors) {
        errors.push(`relationships: ${coercions} item(s) needed reshaping into {target, type} form`);
    }
    if (dropped > 0 && errors) {
        errors.push(`relationships: ${dropped} item(s) had no resolvable target — dropped`);
    }
    return out;
}

/**
 * @param {unknown} val
 * @returns {boolean}
 */
function ensureBoolean(val) {
    return val === true || (typeof val === 'string' && val.trim().toLowerCase() === 'true');
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validates and coerces one LLM-produced entry.
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: string[], chunk?: object }}
 */
export function validateReformattedChunk(raw) {
    const errors = [];

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        const debugInfo = typeof raw === 'string' ? `string "${raw.slice(0, 50)}"` : typeof raw;
        return { ok: false, errors: [`Reformatted chunk is not an object (got ${debugInfo})`] };
    }
    const r = /** @type {any} */ (raw);

    let entry_type = String(r.entry_type ?? '').trim().toLowerCase();
    if (!REFORMAT_ENTRY_TYPES.includes(entry_type)) {
        errors.push(`entry_type "${entry_type}" not in vocabulary — coerced to "other"`);
        entry_type = 'other';
    }

    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) {
        return { ok: false, errors: ['name is empty or missing'] };
    }

    const body = typeof r.body === 'string' ? r.body.trim() : '';
    if (!body) {
        return { ok: false, errors: ['body is empty or missing'] };
    }

    const chunk = {
        entry_type,
        name,
        aliases: ensureStringArray(r.aliases, 'aliases', errors)
            .filter(a => a.toLowerCase() !== name.toLowerCase()),
        affiliation: typeof r.affiliation === 'string' ? r.affiliation.trim() : '',
        relationships: ensureRelationships(r.relationships, errors),
        keywords: ensureStringArray(r.keywords, 'keywords', errors),
        hidden: ensureBoolean(r.hidden),
        body,
    };

    return { ok: true, errors, chunk };
}

// ---------------------------------------------------------------------------
// Stored text
// ---------------------------------------------------------------------------

/**
 * Renders a relationship as a sentence. The prompt asks for a verb phrase
 * that reads as "<name> <type> <target>"; an empty type falls back to a
 * neutral "is connected to".
 * @param {string} name
 * @param {{target: string, type: string}|string} rel
 * @returns {string}
 */
function _relationshipSentence(name, rel) {
    if (typeof rel === 'string') return rel.trim() ? `${name} is connected to ${rel.trim()}.` : '';
    const target = typeof rel?.target === 'string' ? rel.target.trim() : '';
    if (!target) return '';
    const type = typeof rel?.type === 'string' ? rel.type.trim() : '';
    return `${name} ${type || 'is connected to'} ${target}.`;
}

/**
 * Builds the text that is embedded, indexed and injected for one stored
 * piece of an entry. The name and type head every piece (so a split entry's
 * later parts still say what they are about); hidden entries carry
 * HIDDEN_TRUTH_TAG; affiliation and relationships are written as sentences
 * on the first piece only, since they describe the whole entry.
 *
 * @param {object} record - Validated entry (body may be one sub-chunk of it)
 * @param {{part?: number, total?: number}} [position] - 0-based part index and part count
 * @returns {string}
 */
export function buildStoredText(record, { part = 0, total = 1 } = {}) {
    const name = String(record?.name || '').trim();
    const type = String(record?.entry_type || '').trim();
    let header = type ? `${name} (${type})` : name;
    if (total > 1) header += `, part ${part + 1} of ${total}`;

    const lines = [header];
    if (record?.hidden) lines.push(HIDDEN_TRUTH_TAG);
    lines.push(String(record?.body || '').trim());

    if (part === 0) {
        const facts = [];
        const affiliation = typeof record?.affiliation === 'string' ? record.affiliation.trim() : '';
        if (affiliation) facts.push(`${name} belongs to ${affiliation}.`);
        for (const rel of Array.isArray(record?.relationships) ? record.relationships : []) {
            // "<Parent>: <Part>" already names its parent; don't restate it.
            const target = typeof rel === 'string' ? rel : rel?.target;
            if (target && name.toLowerCase().startsWith(`${String(target).trim().toLowerCase()}:`)) continue;
            const sentence = _relationshipSentence(name, rel);
            if (sentence) facts.push(sentence);
        }
        if (facts.length > 0) lines.push(facts.join(' '));
    }
    return lines.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Hallucination guardrail
// ---------------------------------------------------------------------------

const MAX_FUZZY_NAME_WORDS = 6;
const MAX_FUZZY_SOURCE_CHARS = 50000;

/**
 * Strips punctuation and collapses whitespace for loose text comparison.
 * @param {string} s
 * @returns {string}
 */
export function normalizeForMatch(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Checks whether `name` is grounded in `sourceText`: an exact (normalized)
 * substring match, or, for short names on reasonably-sized sources, a
 * word-window Levenshtein similarity of at least `threshold`.
 * @param {string} name
 * @param {string} sourceText
 * @param {number} threshold
 * @returns {boolean}
 */
function isNameGroundedInSource(name, sourceText, threshold) {
    // Compound sub-entry names ("The Ashen Circle: Membership") are grounded
    // when each component is. Split on ":", em/en dashes and spaced hyphens
    // only; intra-name hyphens ("Jean-Luc") must not split.
    const compoundParts = String(name || '').split(/\s*(?::|—|–|\s-\s)\s*/).map(p => p.trim()).filter(Boolean);
    if (compoundParts.length > 1) {
        return compoundParts.every(part => isNameGroundedInSource(part, sourceText, threshold));
    }

    const normName = normalizeForMatch(name);
    if (!normName) return false;
    const normSource = normalizeForMatch(sourceText);
    if (!normSource) return false;

    if (normSource.includes(normName)) return true;

    const nameWords = normName.split(' ');
    if (nameWords.length > MAX_FUZZY_NAME_WORDS || normSource.length > MAX_FUZZY_SOURCE_CHARS) {
        return false;
    }

    const sourceWords = normSource.split(' ');
    let best = 0;
    for (let i = 0; i <= sourceWords.length - nameWords.length; i++) {
        const windowText = sourceWords.slice(i, i + nameWords.length).join(' ');
        const score = StringUtils.similarity(normName, windowText);
        if (score > best) best = score;
        if (best >= threshold) break;
    }
    return best >= threshold;
}

/**
 * Flags entries whose name (or any alias) doesn't fuzzy-match the source
 * text. The review UI shows the result as a warning; nothing is blocked.
 *
 * @param {object[]} chunks - Validated entries
 * @param {string} sourceText - The batch's source text
 * @param {number} [threshold=0.8]
 * @returns {Array<{nameGrounded: boolean, ungroundedAliases: string[]}>} Parallel to `chunks`
 */
export function computeNameVerification(chunks, sourceText, threshold = 0.8) {
    if (!Array.isArray(chunks)) return [];
    if (!sourceText) return chunks.map(() => ({ nameGrounded: true, ungroundedAliases: [] }));

    return chunks.map(chunk => {
        const nameGrounded = isNameGroundedInSource(chunk?.name || '', sourceText, threshold);
        const aliases = Array.isArray(chunk?.aliases) ? chunk.aliases : [];
        const ungroundedAliases = aliases.filter(a => !isNameGroundedInSource(a, sourceText, threshold));
        return { nameGrounded, ungroundedAliases };
    });
}

/**
 * Advisory grounding check for keywords. Keywords may legitimately be
 * inferred ("betrayal" for a scene that never uses the word), so callers show
 * this as a soft note, not a hallucination warning.
 *
 * @param {object[]} chunks - Validated entries
 * @param {string} sourceText
 * @param {number} [threshold=0.7]
 * @returns {Array<{ungroundedKeywords: string[]}>} Parallel to `chunks`
 */
export function computeKeywordVerification(chunks, sourceText, threshold = 0.7) {
    if (!Array.isArray(chunks)) return [];
    if (!sourceText) return chunks.map(() => ({ ungroundedKeywords: [] }));

    return chunks.map(chunk => {
        const keywords = Array.isArray(chunk?.keywords) ? chunk.keywords : [];
        const ungroundedKeywords = keywords
            .map(kw => (typeof kw === 'string' ? kw : kw?.text))
            .filter(Boolean)
            .filter(text => !isNameGroundedInSource(text, sourceText, threshold));
        return { ungroundedKeywords };
    });
}

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

/**
 * Default extraction prompt. {{notes}} carries per-batch context (where the
 * text sits in the document, transcript handling, continuation and repair
 * notes); {{text}} is the batch.
 */
const DEFAULT_REFORMAT_PROMPT = `You are converting reference material (a lore document, world bible, wiki export, web page or video transcript) into self-contained entries for an AI roleplay memory system. Each entry is retrieved on its own, so it must make sense without the rest of the document.

Read the TEXT and split it into entries. An entry is either:
- a named thing: a character, organization, location or item; or
- a topic: a system, law, event, period, custom or other subject that is not one named thing.

Skip sections written for the author or the site rather than about the world: writing settings (voice, tone, options turned on or off), canon logs and lists of established facts, change logs, open questions, to-do lists, tagging rules, upload notes, navigation and site announcements. Their facts are covered where the document states them.

Give every named thing the TEXT describes its own entry, under its own name: people, groups, institutions, places, laws, programs, systems and objects with a proper name. "Describes" means the TEXT says what the thing is: its nature, purpose, members, abilities, appearance or rules. This applies even when the description sits inside a larger section, in a list, or only in bold. For example, a section that describes an ID registry, a tracking app and two agencies gives an entry for each of those four plus one for the section itself, which can mention them by name. A thing that only takes part in events (someone the subject meets, fights or travels with) gets no entry of its own; those events belong in the subject's entries. When a topic section has several parts that are each discussed at length (a paragraph or more), give each part its own entry named "<Section name>: <Part title>". Short parts stay in the section's entry.

Output a JSON array. Each element has exactly these fields:
{
  "entry_type": "character" | "organization" | "concept" | "location" | "item" | "other",
  "name": the entry's name, in the source's wording,
  "aliases": other names for this same thing (a full name, an acronym, a title); never the name of a related group or place,
  "affiliation": the group this entry belongs to, or "",
  "relationships": for a named thing, [{"target": the name of another named thing in the TEXT, "type": a short verb phrase that reads as "<name> <type> <target>", such as "is the mentor of", "is located in" or "enforces"}]; for a topic, [],
  "keywords": an array of search terms someone might use to find this entry,
  "hidden": true for content from a section the document marks as spoilers, secrets or hidden truths, otherwise false,
  "body": the entry's content
}

Writing the body:
- Keep every fact: names, numbers, dates, prices, rules, definitions, and every list item together with its meaning. Taken together, the bodies must contain everything the TEXT says, so a long section gives a long body.
- Write clear third-person prose. Fix spelling and grammar and replace pronouns with names, but keep the source's own words for names, terms, quotations and specific details.
- Keep quotations word for word, together with who said them.
- Keep attribution. When the TEXT presents something as the claim, belief or official position of a person or group, say whose it is ("According to the Daughters of the Victory, ..."). A claim stays a claim and a fact stays a fact.
- Describe the world, not the document. If a note aimed at editors or the author contains a fact about the world, state the fact and drop the note.
- Put hidden content in its own entries with "hidden": true, and keep it out of public entries. Name each one "<Subject>: Hidden truth", where the subject is the thing the secret is about, not the section it appears in.

Example input:
"## Settings
- **Voice:** plain and grim
- **Spoilers:** On

## Ironclad Agency
Based in New York City. **Lead Hero:** Bulwark (Eleanor Graves). Her Spark, Fortress, turns her skin to metal. She mentors Solaris.
Its founder described the agency's motto as "We hold the line."

## Spoilers
Bulwark's metal form is slowly killing her."

Example output (the Settings section is a writing setting for the author, so it is skipped; Solaris is only mentioned, so it gets no entry):
[
  {"entry_type":"organization","name":"Ironclad Agency","aliases":[],"affiliation":"","relationships":[{"target":"New York City","type":"is based in"}],"keywords":["hero agency","New York City","We hold the line"],"hidden":false,"body":"Ironclad Agency is a hero agency based in New York City. Its lead hero is Bulwark. According to its founder, the agency's motto is \\"We hold the line.\\""},
  {"entry_type":"character","name":"Bulwark","aliases":["Eleanor Graves"],"affiliation":"Ironclad Agency","relationships":[{"target":"Ironclad Agency","type":"is the lead hero of"},{"target":"Solaris","type":"is the mentor of"}],"keywords":["Fortress","Spark","metal skin"],"hidden":false,"body":"Bulwark, whose real name is Eleanor Graves, is the lead hero of Ironclad Agency. Her Spark, Fortress, turns her skin to metal. Bulwark mentors Solaris."},
  {"entry_type":"character","name":"Bulwark: Hidden truth","aliases":[],"affiliation":"","relationships":[{"target":"Bulwark","type":"is a secret about"}],"keywords":["Fortress","metal form"],"hidden":true,"body":"Bulwark's metal form is slowly killing her."}
]

{{notes}}TEXT:
{{text}}

Output only the JSON array.`;

/**
 * Fills a prompt template. Accepts the legacy {{continuationNote}} slot so
 * custom prompts written for older versions keep working; a template without
 * a notes slot gets the notes in front of the text, and one without {{text}}
 * gets the text appended, so the document is never silently left out.
 * @param {string} template
 * @param {string} notes
 * @param {string} text
 * @returns {string}
 */
function _fillTemplate(template, notes, text) {
    const hasNotesSlot = /\{\{(?:notes|continuationNote)\}\}/.test(template);
    const body = hasNotesSlot ? text : `${notes}${text}`;
    let out = template.replace(/\{\{(?:notes|continuationNote)\}\}/g, () => notes);
    out = /\{\{text\}\}/.test(out)
        ? out.replace(/\{\{text\}\}/g, () => body)
        : `${out}\n\nTEXT:\n${body}`;
    return out;
}

/**
 * Per-batch notes placed in the prompt's {{notes}} slot.
 * @param {object} [ctx]
 * @param {string} [ctx.headingPath] - "Doc › Section › Subsection" for this batch
 * @param {string} [ctx.contentType] - 'document' | 'url' | 'wiki' | 'youtube'
 * @param {{sectionTitle: string, alreadyExtractedNames: string[]}} [ctx.continuation]
 * @returns {string}
 */
function _buildNotes({ headingPath = '', contentType = '', continuation = null } = {}) {
    const notes = [];
    if (headingPath) {
        notes.push(`NOTE: This TEXT comes from this place in the document: ${headingPath}. Use it for context only; entry names stay short. When a section title is generic (such as "History" or "Abilities"), name its entry after its subject, like "History of <subject>" or "<Subject>: Abilities".`);
    }
    if (contentType === 'youtube') {
        notes.push('NOTE: This TEXT is a video transcript: spoken words, often without punctuation or speaker labels. Leave out filler words, false starts, and requests to like, subscribe or visit sponsors. Organize entries by the subjects discussed, and attribute statements to the speaker when the transcript makes clear who is speaking.');
    }
    if (continuation?.sectionTitle) {
        const names = continuation.alreadyExtractedNames?.length
            ? continuation.alreadyExtractedNames.join(', ')
            : '(none yet)';
        notes.push(`NOTE: This TEXT continues section "${continuation.sectionTitle}", which was split because it is long. Entries already extracted from earlier parts of this section: ${names}. Do not repeat them; extract only what this part adds.`);
    }
    return notes.length ? notes.join('\n') + '\n\n' : '';
}

/**
 * Builds the extraction prompt for one batch.
 *
 * @param {string} text - The batch's source text
 * @param {object} [options]
 * @param {string} [options.customPrompt] - settings.reformat_custom_prompt
 * @param {string} [options.headingPath]
 * @param {string} [options.contentType]
 * @param {{sectionTitle: string, alreadyExtractedNames: string[]}} [options.batchContext] -
 *        Set for continuation batches of an oversized section
 * @returns {string}
 */
export function buildReformatPrompt(text, { customPrompt = '', headingPath = '', contentType = '', batchContext = null } = {}) {
    const template = (customPrompt && customPrompt.trim()) ? customPrompt : DEFAULT_REFORMAT_PROMPT;
    const notes = _buildNotes({ headingPath, contentType, continuation: batchContext });
    return _fillTemplate(template, notes, text);
}

/**
 * Builds the prompt for the optional cross-batch linking pass. The catalog
 * lists names only (no types or bodies), written exactly as they must be
 * returned, and the caller drops any link whose ends aren't catalog entries.
 *
 * @param {string} text - One batch's source text
 * @param {Array<{name: string, aliases?: string[]}>} entityCatalog - Every merged entry
 * @returns {string}
 */
export function buildLinkingPrompt(text, entityCatalog) {
    const catalogLines = (Array.isArray(entityCatalog) ? entityCatalog : [])
        .map(e => {
            const aliasSuffix = e.aliases?.length ? `   (also called: ${e.aliases.join(', ')})` : '';
            return `- ${e.name}${aliasSuffix}`;
        })
        .join('\n');

    return `You are linking entries extracted from one document for an AI roleplay memory system.

ENTRIES lists every entry. TEXT is one part of the document. List each relationship the TEXT states between two different entries.

Output a JSON array of {"source": entry name, "target": entry name, "type": a short verb phrase that reads as "<source> <type> <target>", such as "is the mentor of", "is located in" or "governs"}.
- Write each name exactly as it appears in ENTRIES, without the "also called" part.
- Give each connection once, in the direction that reads most naturally.
- Include only connections the TEXT states. If there are none, output [].

ENTRIES:
${catalogLines}

TEXT:
${text}

Output only the JSON array.`;
}

// ---------------------------------------------------------------------------
// Coverage check + repair prompt (under-extraction guardrail)
// ---------------------------------------------------------------------------

// A section with fewer distinctive fact tokens than this is too small to
// score reliably — treat it as covered rather than generating noisy repairs.
const COVERAGE_MIN_FACT_TOKENS = 3;
// Cap the missing-facts list per section so the repair prompt stays bounded.
const COVERAGE_MAX_REPORTED_FACTS = 20;

/** Same header pattern as core/chunking.js's `section` strategy. */
const COVERAGE_HEADER_REGEX = /^(#{1,6})\s+(.+)$/gm;

/**
 * Splits batch text into the units coverage is measured on: each paragraph
 * of each header-delimited section. Measuring per paragraph (not per
 * section) catches one dropped paragraph inside a long section, which a
 * section-wide ratio averages away. A paragraph that opens with a bold label
 * ("**Relations between the blocs.**") is titled by it.
 * @param {string} text
 * @returns {Array<{title: string, text: string}>}
 */
function _splitCoverageSections(text) {
    const sections = [];
    let lastIndex = 0;
    COVERAGE_HEADER_REGEX.lastIndex = 0;
    let match;
    while ((match = COVERAGE_HEADER_REGEX.exec(text)) !== null) {
        if (match.index > lastIndex) {
            const before = text.slice(lastIndex, match.index).trim();
            if (before) sections.push(before);
        }
        lastIndex = match.index;
    }
    if (lastIndex < text.length) {
        const rest = text.slice(lastIndex).trim();
        if (rest) sections.push(rest);
    }

    const shorten = s => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
    const units = [];
    for (const section of sections) {
        const firstLine = section.split('\n').map(l => l.trim()).find(Boolean) || 'section';
        const isHeader = /^#{1,6}\s/.test(firstLine);
        const sectionTitle = shorten(firstLine.replace(/^#{1,6}\s+/, '').replace(/\*+/g, '').trim());
        for (const para of section.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)) {
            if (isHeader && para === firstLine) continue;
            const label = para.match(/^\*\*([^*\n]{2,80}?)[.:]?\*\*/);
            units.push({ title: label ? `${sectionTitle} › ${label[1].trim()}` : sectionTitle, text: para });
        }
    }
    return units;
}

/**
 * Extracts the "fact tokens" of a section — the details a faithful extraction
 * cannot drop: figures, quoted terms, proper-noun phrases, and rare long
 * words. Deterministic and language-light by design.
 * @param {string} text
 * @returns {string[]} Deduplicated raw tokens (pre-normalization)
 */
function _extractFactTokens(text) {
    const tokens = new Set();

    // Figures: $ amounts, percentages, multi-digit numbers, years, ranges.
    for (const m of text.matchAll(/\$\s?\d[\d,.]*|\d[\d,.]*\s?%|\d{2,}(?:[.,]\d+)*/g)) {
        tokens.add(m[0].trim());
    }

    // Quoted terms: double quotes (straight/curly) and curly single quotes;
    // straight single quotes only when they delimit a standalone term, so
    // apostrophes ("it's") don't match.
    for (const m of text.matchAll(/"([^"\n]{2,60})"|“([^”\n]{2,60})”|‘([^’\n]{2,60})’/g)) {
        tokens.add((m[1] || m[2] || m[3]).trim());
    }
    for (const m of text.matchAll(/(?<=^|[\s(])'([^'\n]{2,60})'(?=[\s).,;:!?]|$)/gm)) {
        tokens.add(m[1].trim());
    }

    // Proper-noun phrases: 2+ capitalized words, allowing lowercase
    // connectors ("Edict of Coals"). Same-line whitespace only.
    for (const m of text.matchAll(/\b[A-Z][\w'’-]*(?:[ \t]+(?:of|the|and|in|for|under|on|to)[ \t]+[A-Z][\w'’-]*|[ \t]+[A-Z][\w'’-]*)+\b/g)) {
        tokens.add(m[0].trim());
    }

    // Rare long lowercase words — the signal for prose with few names or numbers.
    for (const m of text.matchAll(/\b[a-z][a-z'’-]{7,}\b/g)) {
        tokens.add(m[0].trim());
    }

    return [...tokens];
}

/**
 * Under-extraction guardrail: measures how much of each source section's
 * distinctive content landed in the extracted entries, and returns the
 * sections below `threshold`.
 *
 * @param {string} batchText
 * @param {object[]} entries - Validated entries extracted so far for this batch/chain
 * @param {number} [threshold=0.5] - Minimum covered-token ratio per section
 * @returns {Array<{title: string, text: string, coverage: number, missingFacts: string[]}>}
 */
export function computeBatchCoverage(batchText, entries, threshold = 0.5) {
    if (!batchText || typeof batchText !== 'string') return [];

    const corpusParts = [];
    for (const e of (Array.isArray(entries) ? entries : [])) {
        if (!e || typeof e !== 'object') continue;
        corpusParts.push(e.name || '', ...(e.aliases || []), e.body || '');
        for (const kw of e.keywords || []) {
            corpusParts.push(typeof kw === 'string' ? kw : kw?.text || '');
        }
    }
    const corpus = ' ' + normalizeForMatch(corpusParts.join(' ')) + ' ';

    const flagged = [];
    for (const section of _splitCoverageSections(batchText)) {
        const factTokens = _extractFactTokens(section.text);
        if (factTokens.length < COVERAGE_MIN_FACT_TOKENS) continue;

        const missing = [];
        let covered = 0;
        for (const token of factTokens) {
            const norm = normalizeForMatch(token);
            if (!norm) { covered++; continue; }
            if (corpus.includes(norm)) covered++;
            else missing.push(token);
        }

        const coverage = covered / factTokens.length;
        if (coverage < threshold) {
            flagged.push({
                title: section.title,
                text: section.text,
                coverage,
                missingFacts: missing.slice(0, COVERAGE_MAX_REPORTED_FACTS),
            });
        }
    }
    return flagged;
}

/**
 * Builds the one-shot repair prompt for sections computeBatchCoverage
 * flagged. Reuses the full extraction template (calls are stateless).
 *
 * @param {Array<{title: string, text: string, missingFacts: string[]}>} flaggedSections
 * @param {object} [options]
 * @param {string} [options.customPrompt]
 * @param {string[]} [options.alreadyExtractedNames]
 * @param {string} [options.headingPath]
 * @param {string} [options.contentType]
 * @returns {string}
 */
export function buildRepairPrompt(flaggedSections, { customPrompt = '', alreadyExtractedNames = [], headingPath = '', contentType = '' } = {}) {
    const sections = Array.isArray(flaggedSections) ? flaggedSections : [];
    const namesList = alreadyExtractedNames.length ? alreadyExtractedNames.join(', ') : '(none)';
    const missingLines = sections
        .map(s => `- "${s.title}": ${s.missingFacts?.length ? s.missingFacts.join('; ') : '(most of the section)'}`)
        .join('\n');

    const repairNote = `NOTE: A previous extraction of this TEXT missed some of its content. Entries already extracted: ${namesList}. These details are in no existing entry:
${missingLines}
Extract entries that cover what is missing. You may add entries named "<Existing entry's name>: <Part title>" for parts of an existing entry. Do not repeat content the existing entries already have.

`;

    const template = (customPrompt && customPrompt.trim()) ? customPrompt : DEFAULT_REFORMAT_PROMPT;
    const text = sections.map(s => s.text).join('\n\n');
    return _fillTemplate(template, _buildNotes({ headingPath, contentType }) + repairNote, text);
}
