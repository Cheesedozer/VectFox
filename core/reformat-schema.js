/**
 * ============================================================================
 * AUTO-REFORMAT SCHEMA
 * ============================================================================
 * Canonical schema constants, validator, prompt builder, and hallucination
 * guardrail for the Auto-Reformat feature (Document/URL/Wiki content).
 *
 * Pure, no ST dependencies — same convention as glossary-extractor.js — so
 * this can be unit-tested without mocking SillyTavern globals.
 *
 * DELIBERATELY INDEPENDENT from core/eventbase-schema.js: the record shape is
 * EventBase-*inspired* (a single self-tagged enum field carries the "is this
 * an entity or a topic" branch, same trick as EVENT_TYPES), but nothing here
 * imports from EventBase — this feature must stand on its own so a bug or
 * schema change in chat's EventBase pipeline can never affect Document/Wiki/
 * URL reformatting, and vice versa.
 *
 * No CJK-localized prompt variants yet (unlike EventBase's prompts-i18n.js
 * variants) — out of scope for this feature's first pass. buildReformatPrompt
 * still takes a `customPrompt` override so a user who needs non-English
 * extraction instructions can supply their own template today.
 * ============================================================================
 */

import StringUtils from '../utils/string-utils.js';

/**
 * Controlled vocabulary for entry_type field. LLM is instructed to map every
 * extracted record to one of these; 'other' is the fallback.
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

// v2: relationships changed from string[] to {target, type}[] (validator still
// coerces legacy strings — see ensureRelationships).
export const REFORMAT_SCHEMA_VERSION = 2;

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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerces a single array item to a display string (used for `aliases` and
 * `traits`; `relationships` has its own structured coercion — see
 * ensureRelationships). Models occasionally ignore the "array of strings"
 * instruction and emit an object instead. Naively falling through to
 * `String(obj)` produces the literal text "[object Object]", which then gets
 * stored, embedded, and shown to the user as if it were real content. Pull
 * readable text out of common keys instead, and only fall back to
 * JSON.stringify (never the bare `[object Object]` coercion) if none match.
 * @param {unknown} item
 * @returns {{text: string, wasObjectCoercion: boolean}}
 */
function coerceArrayItem(item) {
    if (typeof item === 'string') return { text: item.trim(), wasObjectCoercion: false };
    if (item && typeof item === 'object' && !Array.isArray(item)) {
        const parts = ['target', 'name', 'description', 'relation', 'type']
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
 * Deduplicate + trim an array of strings; drop empties. Coerces stray objects
 * (see coerceArrayItem) instead of silently degrading to "[object Object]",
 * and reports how many items needed coercion via `errors` when a fieldName
 * and errors array are supplied.
 * Duplicated from eventbase-schema.js's helper of the same name rather than
 * imported — see file docstring on independence.
 * @param {unknown} val
 * @param {string} [fieldName]
 * @param {string[]} [errors]
 * @returns {string[]}
 */
function ensureArray(val, fieldName = '', errors = null) {
    if (!Array.isArray(val)) return [];
    let objectCoercions = 0;
    const items = val.map(item => {
        const { text, wasObjectCoercion } = coerceArrayItem(item);
        if (wasObjectCoercion) objectCoercions++;
        return text;
    }).filter(Boolean);
    if (objectCoercions > 0 && fieldName && errors) {
        errors.push(`${fieldName}: ${objectCoercions} item(s) were objects instead of strings — coerced to text`);
    }
    return [...new Set(items)];
}

/**
 * Coerce + dedupe a raw `relationships` field into {target, type}[] — the
 * canonical schema-v2 shape. The expected input is an array of
 * {target, type} objects, but tolerates:
 *  - a bare string (non-compliant model, or a legacy v1 record) → treated as
 *    the target with an empty type. Parentheticals are deliberately NOT
 *    parsed out of strings (parens legitimately appear in entity names).
 *  - alternate object keys: `name` for target, `relation`/`relationship`
 *    for type.
 * Items with no resolvable target are dropped. Dedupes by lowercased
 * target|type. Pushes a coercion note into `errors` when items needed
 * reshaping, same pattern as ensureArray/entry_type.
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
 * Coerce + dedupe a raw `keywords` field into {text, importance}[]. Accepts
 * either a plain string (legacy shape, or a model that ignored the importance
 * instruction — defaults to mid-scale 5) or a {text, importance} object.
 * importance is clamped the same way eventbase-schema.js clamps its own
 * `importance` field — duplicated locally rather than imported, per this
 * file's independence rule (see file docstring).
 * @param {unknown} val
 * @returns {{text: string, importance: number}[]}
 */
function ensureKeywords(val) {
    if (!Array.isArray(val)) return [];
    const seen = new Set();
    const out = [];
    for (const item of val) {
        let text = '';
        let rawImportance = 5;
        if (typeof item === 'string') {
            text = item.trim();
        } else if (item && typeof item === 'object') {
            text = typeof item.text === 'string' ? item.text.trim() : '';
            rawImportance = item.importance;
        }
        if (!text) continue;

        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const parsedImportance = Number(rawImportance);
        const importance = Number.isFinite(parsedImportance)
            ? Math.round(Math.max(1, Math.min(10, parsedImportance)))
            : 5;

        out.push({ text, importance });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validates and coerces a raw LLM-produced reformatted-chunk object.
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: string[], chunk?: object }}
 */
export function validateReformattedChunk(raw) {
    const errors = [];

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        const debugInfo = typeof raw === 'string' ? `string "${raw.slice(0, 50)}"` : typeof raw;
        return { ok: false, errors: [`Reformatted chunk is not an object (got ${debugInfo})`] };
    }

    // entry_type — coerce unknown to 'other'
    let entry_type = String((/** @type {any} */ (raw)).entry_type ?? '').trim().toLowerCase();
    if (!REFORMAT_ENTRY_TYPES.includes(entry_type)) {
        errors.push(`entry_type "${entry_type}" not in vocabulary — coerced to "other"`);
        entry_type = 'other';
    }

    // name — required non-empty string (nothing to key retrieval/dedup on without it)
    const name = typeof (/** @type {any} */ (raw)).name === 'string' ? (/** @type {any} */ (raw)).name.trim() : '';
    if (!name) {
        return { ok: false, errors: ['name is empty or missing'] };
    }

    // body — required non-empty string (nothing to store/embed without it)
    const body = typeof (/** @type {any} */ (raw)).body === 'string' ? (/** @type {any} */ (raw)).body.trim() : '';
    if (!body) {
        return { ok: false, errors: ['body is empty or missing'] };
    }

    const affiliation = typeof (/** @type {any} */ (raw)).affiliation === 'string'
        ? (/** @type {any} */ (raw)).affiliation.trim()
        : '';

    const chunk = {
        entry_type,
        name,
        aliases: ensureArray((/** @type {any} */ (raw)).aliases, 'aliases', errors),
        affiliation,
        traits: ensureArray((/** @type {any} */ (raw)).traits, 'traits', errors),
        relationships: ensureRelationships((/** @type {any} */ (raw)).relationships, errors),
        keywords: ensureKeywords((/** @type {any} */ (raw)).keywords),
        body,
    };

    return { ok: true, errors, chunk };
}

// ---------------------------------------------------------------------------
// Relational clause builder
// ---------------------------------------------------------------------------

/**
 * Builds a short factual trailer summarizing `affiliation`/`relationships`,
 * meant to be appended to a record's `body` before it becomes the stored/
 * embedded `text`. affiliation/relationships are otherwise inert metadata:
 * they're validated here and shown in the review UI, but nothing downstream
 * (dense embedding, sparse/BM25 index, or the block injected into the
 * roleplay model's context — see world-info-integration.js, which reads only
 * `meta.text`) ever consults them once accepted. Appending this trailer to
 * `body` is the one change point that gets this connective information into
 * all three, the same way the `[KEYWORDS: ...]` suffix already does for
 * keywords (see backends/qdrant.js).
 *
 * Deliberately additive/redundant rather than trying to detect whether the
 * body prose already covers the same ground — that detection is unreliable
 * (paraphrasing, aliases, case) and the cost of mild repetition is far lower
 * than the cost of silently omitting the connection again.
 *
 * @param {string} affiliation
 * @param {Array<{target: string, type: string}|string>} relationships - Schema-v2
 *        {target, type} objects; legacy v1 plain strings are rendered as-is.
 * @returns {string} e.g. " Affiliated with the Reich. Related: Schutzstaffel (parent organization); Oberkatze (leader)."
 *          or '' when there's nothing to add.
 */
export function buildRelationalClause(affiliation, relationships) {
    const parts = [];

    const trimmedAffiliation = typeof affiliation === 'string' ? affiliation.trim() : '';
    if (trimmedAffiliation) parts.push(`Affiliated with ${trimmedAffiliation}.`);

    const cleanRelationships = (Array.isArray(relationships) ? relationships : [])
        .map(r => {
            if (typeof r === 'string') return r.trim();
            if (r && typeof r === 'object') {
                const target = typeof r.target === 'string' ? r.target.trim() : '';
                const type = typeof r.type === 'string' ? r.type.trim() : '';
                if (!target) return '';
                return type ? `${target} (${type})` : target;
            }
            return '';
        })
        .filter(Boolean);
    if (cleanRelationships.length > 0) parts.push(`Related: ${cleanRelationships.join('; ')}.`);

    return parts.length > 0 ? ' ' + parts.join(' ') : '';
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
function normalizeForMatch(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Checks whether `name` is grounded in `sourceText` — either an exact
 * (normalized) substring match, or, for short names on reasonably-sized
 * sources, the best word-window Levenshtein similarity meets `threshold`.
 * The fuzzy fallback is intentionally bounded (name length, source length)
 * to keep this a cheap client-side sanity check, not a search engine — see
 * reformat-extractor.js's caller for the O(entities × source) cost note.
 * @param {string} name
 * @param {string} sourceText
 * @param {number} threshold
 * @returns {boolean}
 */
function isNameGroundedInSource(name, sourceText, threshold) {
    const normName = normalizeForMatch(name);
    if (!normName) return false;
    const normSource = normalizeForMatch(sourceText);
    if (!normSource) return false;

    if (normSource.includes(normName)) return true;

    const nameWords = normName.split(' ');
    if (nameWords.length > MAX_FUZZY_NAME_WORDS || normSource.length > MAX_FUZZY_SOURCE_CHARS) {
        // Too expensive to slide a window at this scale — no exact match was
        // found, so treat as unverified rather than silently skipping the check.
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
 * Hallucination guardrail: flags any extracted chunk whose `name` (or every
 * one of its `aliases`) doesn't fuzzy-match the source text it was supposedly
 * extracted from. Pure/synchronous — callers (the review UI) render the
 * result as a warning banner, they don't block on it.
 *
 * @param {object[]} chunks - Validated reformatted chunks (from validateReformattedChunk)
 * @param {string} sourceText - The batch's source text the chunks were extracted from
 * @param {number} [threshold=0.8] - Minimum similarity to count as grounded
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
 * Softer default than DEFAULT_NAME_FUZZY_THRESHOLD (0.8) — see
 * computeKeywordVerification's docstring for why keywords need a looser bar.
 */
const DEFAULT_KEYWORD_FUZZY_THRESHOLD = 0.7;

/**
 * Advisory grounding check for `keywords` — NOT a hallucination guardrail in
 * the same sense as computeNameVerification. A name/alias is expected to
 * appear (near-)literally in the source, so a miss is a strong hallucination
 * signal. Keywords are explicitly allowed to be inferred/thematic (the
 * prompt asks for "search terms someone might use to recall this entry"),
 * e.g. "betrayal" for a scene that never uses that word — so a miss here is
 * common and often fine. Callers should render this as a soft, informational
 * note, never the hard "verify this wasn't invented" treatment used for
 * names/aliases.
 *
 * @param {object[]} chunks - Validated reformatted chunks (from validateReformattedChunk)
 * @param {string} sourceText - The batch's source text the chunks were extracted from
 * @param {number} [threshold=DEFAULT_KEYWORD_FUZZY_THRESHOLD] - Minimum similarity to count as grounded
 * @returns {Array<{ungroundedKeywords: string[]}>} Parallel to `chunks`
 */
export function computeKeywordVerification(chunks, sourceText, threshold = DEFAULT_KEYWORD_FUZZY_THRESHOLD) {
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
// Extraction prompt builder
// ---------------------------------------------------------------------------

/**
 * Default (English) extraction prompt. Deliberately teaches BOTH regimes in
 * one pass via few-shot examples — see reformat-extractor.js's batching
 * design note on why this is a single self-tagged call, not a literal
 * two-pass classify-then-extract pipeline.
 */
const DEFAULT_REFORMAT_PROMPT = `You are restructuring a piece of reference material (a world bible, lore document, wiki export, or similar) so it can be split into clean, self-contained retrieval records for an AI roleplay memory system.

Read the TEXT below and extract every meaningful "entry" from it. An entry is either:
1. A NAMED ENTITY (a character, organization/faction, location, or item) — even if the document only marks it with bold/italic text or an inline label rather than a markdown heading. Give it its own entry so it can be retrieved on its own, without being diluted by unrelated entities that happen to share the same section.
2. A TOPIC / LORE entry — a self-contained subject (a system, a historical period, a rule, a piece of general worldbuilding) that isn't about one specific named entity.

Output ONLY a JSON array. Each element must have exactly these fields:
{
  "entry_type": one of "character" | "organization" | "concept" | "location" | "item" | "other",
  "name": string — required, the entity's name or the topic's title,
  "aliases": string[] — alternate names/titles this entry is also known by (empty array if none),
  "affiliation": string — group/faction/allegiance this entry belongs to, or "" if not applicable,
  "traits": string[] — short factual descriptors (abilities, role, notable qualities),
  "relationships": [{"target": string, "type": string}] — connections to OTHER named entries; "target" is the other entry's name exactly as it appears, "type" is how they relate (e.g. "parent organization", "rival", "mentor", "member", "located in"),
  "keywords": [{"text": string, "importance": number 1-10}] — additional search terms someone might use to recall this entry; importance = how central that term is to this entry (10 = essential/defining, e.g. a character's signature ability; 1 = minor/tangential, e.g. an incidental location mention),
  "body": string — the actual retrievable prose for this entry, written so it stands alone (resolve pronouns to the actual name where the source only used "he"/"she"/"they")
}

CRITICAL RULES:
- Reproduce facts VERBATIM from the source. Do not invent details, numbers, names, or relationships that aren't in the text. Do not omit a named detail that IS in the text.
- If a section names multiple distinct entities (e.g. several people in a roster, several factions in a table), give EACH one its own array element — never merge multiple named entities into a single entry.
- If a section is genuinely about one topic with no distinct named sub-entities, emit ONE entry of type "concept" for that whole section rather than fragmenting it.
- A relationship MUST point at another named entry via "target". A capability or description with no named target (e.g. "maintains extensive files on citizens") is a TRAIT, not a relationship. Do not repeat the affiliation field as a relationship.
- Extract every relationship the text actually states between named entries — if entity A's section mentions entity B, that connection belongs in A's relationships (and usually B's too).
- aliases and traits are arrays of strings; relationships is an array of {target, type} objects. Every array field must be an array, even if empty ([]), never a single string or null.

EXAMPLE — a roster where entities are separated only by bold text, not headings:
Input excerpt:
"***Ironclad Agency*** — New York City. **Lead Hero:** Bulwark (Eleanor Graves). **Spark:** Fortress (Transformation-type) — Bulwark can transform her hide into indestructible metal. Bulwark mentors the younger hero Solaris.
***Ember Corps*** — Los Angeles. **Lead Hero:** Solaris. **Spark:** Inferno Drive — controls fire at extreme temperatures."
Correct output (two SEPARATE entries, not one merged entry; the stated mentorship appears on BOTH — note "can transform hide" is a trait because it names no other entry, while the mentorship is a relationship because it does):
[
  {"entry_type":"character","name":"Bulwark","aliases":["Eleanor Graves"],"affiliation":"Ironclad Agency","traits":["Transformation-type Spark: Fortress","can transform hide into indestructible metal"],"relationships":[{"target":"Solaris","type":"mentor"}],"keywords":[{"text":"Fortress","importance":9},{"text":"Ironclad","importance":6},{"text":"New York City","importance":4}],"body":"Bulwark (Eleanor Graves) is the lead hero of Ironclad Agency, based in New York City. Her Spark, \\"Fortress\\" (Transformation-type), lets Bulwark transform her hide into indestructible metal. Bulwark mentors the younger hero Solaris."},
  {"entry_type":"character","name":"Solaris","aliases":[],"affiliation":"Ember Corps","traits":["Emitter-type Spark: Inferno Drive","controls fire at extreme temperatures"],"relationships":[{"target":"Bulwark","type":"mentored by"}],"keywords":[{"text":"Inferno Drive","importance":9},{"text":"Ember Corps","importance":6},{"text":"Los Angeles","importance":4}],"body":"Solaris is the lead hero of Ember Corps, based in Los Angeles. Her Spark, \\"Inferno Drive\\", lets Solaris control fire at extreme temperatures. Solaris is mentored by Bulwark of Ironclad Agency."}
]

EXAMPLE — a topic/lore section with no distinct named entity:
Input excerpt:
"## Spark Classification System — Sparks fall into four categories based on how they manifest: Emitter (generate/control without permanent change), Transformation (temporary physical change), Mutant (permanent physical change), and Accumulation (must store energy before use)."
Correct output (ONE concept entry, not split per category unless categories are independently discussed at length elsewhere):
[
  {"entry_type":"concept","name":"Spark Classification System","aliases":[],"affiliation":"","traits":["four categories: Emitter, Transformation, Mutant, Accumulation"],"relationships":[],"keywords":[{"text":"Spark types","importance":7},{"text":"Emitter","importance":6},{"text":"Transformation","importance":6},{"text":"Mutant","importance":6},{"text":"Accumulation","importance":6},{"text":"classification","importance":4}],"body":"Sparks fall into four categories based on how they manifest: Emitter-type (generate/control something without permanent physical change), Transformation-type (temporary physical change while active), Mutant-type (permanent physical change), and Accumulation-type (must store energy/resource before it can be used)."}
]

{{continuationNote}}
TEXT:
{{text}}

Output ONLY the JSON array, no commentary, no markdown code fences.`;

/**
 * Builds the LLM extraction prompt for a given batch of source text.
 *
 * @param {string} text - The batch's source text
 * @param {object} [options]
 * @param {string} [options.customPrompt] - User-edited override from settings.reformat_custom_prompt
 * @param {{sectionTitle: string, alreadyExtractedNames: string[]}} [options.batchContext] -
 *        Set when this batch is a continuation of an oversized section (see the
 *        packer in reformat-extractor.js) so the model doesn't re-emit entities
 *        it already produced for an earlier slice of the same section.
 * @returns {string}
 */
export function buildReformatPrompt(text, { customPrompt = '', batchContext = null } = {}) {
    const template = (customPrompt && customPrompt.trim()) ? customPrompt : DEFAULT_REFORMAT_PROMPT;

    let continuationNote = '';
    if (batchContext?.sectionTitle) {
        const namesList = batchContext.alreadyExtractedNames?.length
            ? batchContext.alreadyExtractedNames.join(', ')
            : '(none yet)';
        continuationNote = `NOTE: This text is a continuation of section "${batchContext.sectionTitle}", which was too long for one call and was split. Entries already extracted from earlier in this same section: ${namesList}. Do NOT re-emit them — only extract entries that haven't been covered yet.\n\n`;
    }

    return template
        .replace(/\{\{continuationNote\}\}/g, continuationNote)
        .replace(/\{\{text\}\}/g, text);
}

/**
 * Builds the prompt for the OPTIONAL cross-batch linking pass (see
 * reformat-extractor.js). Runs after extraction + duplicate-merge, once per
 * batch, with a catalog of EVERY entity extracted anywhere in the document —
 * so it can catch connections the single-pass extraction missed because the
 * two entities were extracted from different batches (e.g. a concept entry
 * whose text names a location that was extracted elsewhere).
 *
 * The catalog deliberately carries names/types/aliases only, not bodies:
 * keeps the prompt small, and the model can only reference entities that
 * already exist — it cannot invent new ones (the caller additionally drops
 * any triple whose source/target doesn't resolve to a catalog entity).
 *
 * @param {string} text - One batch's source text
 * @param {Array<{name: string, entry_type: string, aliases: string[]}>} entityCatalog -
 *        Every merged entity extracted from the whole document
 * @returns {string}
 */
export function buildLinkingPrompt(text, entityCatalog) {
    const catalogLines = (Array.isArray(entityCatalog) ? entityCatalog : [])
        .map(e => {
            const aliasSuffix = e.aliases?.length ? ` (also known as: ${e.aliases.join(', ')})` : '';
            return `- ${e.name} [${e.entry_type}]${aliasSuffix}`;
        })
        .join('\n');

    return `You are finding connections between already-extracted entries of a reference document for an AI roleplay memory system.

Below is the CATALOG of every entry extracted from the document, followed by one section of the document's TEXT.

Find every relationship the TEXT states between two catalog entries. Output ONLY a JSON array of:
{"source": string — a catalog entry's name, "target": string — a different catalog entry's name, "type": string — how source relates to target (e.g. "parent organization", "rival", "located in", "site of")}

CRITICAL RULES:
- "source" and "target" MUST both be names from the CATALOG (exactly as written there). Never introduce a name that is not in the catalog.
- Only report a connection the TEXT actually states or directly implies. Do not infer from general knowledge.
- Report each connection from the most natural direction; both directions are welcome when the text supports them.
- If the TEXT states no connections between catalog entries, output [].

CATALOG:
${catalogLines}

TEXT:
${text}

Output ONLY the JSON array, no commentary, no markdown code fences.`;
}
