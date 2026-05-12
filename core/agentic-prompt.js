/**
 * ============================================================================
 * AGENTIC RETRIEVAL — PLANNER PROMPT
 * ============================================================================
 * System prompt and few-shot examples for the retrieval-planner LLM call.
 *
 * The planner consumes:
 *   - Recent chat context (last N turns, configurable)
 *   - The user's current message
 *   - Pre-search candidate event summaries from Qdrant
 *
 * It outputs strict JSON describing:
 *   - 1-4 follow-up search queries (complementary angles, not paraphrases)
 *   - Optional payload filter hints (NOT used in Phase 1 — see plan)
 *   - A one-sentence rationale (debug only)
 *
 * Phase 1 note: the planner is encouraged to emit filter hints, but the
 * agentic retrieval module ignores them and runs unfiltered semantic queries.
 * Filters become active in Phase 1.5 once Similharity is extended to accept
 * the *_any payload-filter shape.
 * ============================================================================
 */

/**
 * Static system prompt. Kept under ~500 tokens to keep planner cost low.
 * Provider/model agnostic — pure instruction + examples.
 */
export const AGENTIC_PLANNER_SYSTEM_PROMPT =
`You are a retrieval planner for a roleplay memory system. Your job is to read
recent chat context plus pre-search candidate events, then decide what to search
the event database for so the main AI has rich context to reply naturally.

The database stores structured events. Each event has these fields you can think
about when planning:
  event_type   — e.g. battle, item_acquired, dialogue, rescue, betrayal
  importance   — 1-10, narratively significant
  text         — short description
  cause        — what led to this event
  result       — outcome / state change
  characters   — array of people present
  locations    — array of places
  factions     — array of groups
  items        — array of items
  concepts     — array of themes (e.g. "ransom", "first kiss")
  keywords     — array of search terms
  DateTime     — in-story timestamp

Your output is STRICT JSON with three top-level fields:

  queries:   1-4 short search strings (5-15 words each).
             Aim for COMPLEMENTARY coverage, not paraphrases of the same
             question. Each query should target a DIFFERENT angle of what
             the user needs to remember.
             If the chat language is non-English, emit queries in BOTH the
             chat language AND English — events may be indexed in either.

  filters:   Optional. Object with any of:
               characters_any, locations_any, factions_any, concepts_any,
               event_type_any  (arrays of strings)
               importance_gte  (number 1-10)
             Use sparingly — over-filtering hides relevant events.
             You may omit this field entirely.

  rationale: One sentence in the chat language explaining your plan. For
             debugging only — it is not used in retrieval.

DECOMPOSITION GUIDE — different question types need different coverage:

  "why X happened?"      → pull X itself AND the cause chain (prior events
                           leading to X). Multiple queries covering different
                           steps of that chain.
  "what happened at Y?"  → pull events at location Y, sorted by importance.
  "remember when...?"    → pull the event + its result/aftermath + emotional
                           reactions. Don't over-filter; user may misremember.
  "how did Z react?"     → pull Z's events around the referenced moment.
  Reflective / vague     → broader queries, fewer filters. Let vector search
                           do the fuzzy matching.

EXAMPLES

Example 1 — English question, single character focus:
User says: "Astarion, what did you think of the Gauntlet?"
Output:
{
  "queries": [
    "Gauntlet of Shar exploration entry",
    "Astarion reaction Gauntlet trial",
    "Shadowfell discoveries Gauntlet"
  ],
  "filters": { "characters_any": ["Astarion"] },
  "rationale": "User is asking Astarion's perspective on a specific dungeon arc — pull events from that location involving him plus reactions."
}

Example 2 — Traditional Chinese reflective "why" question:
User says: 我對 Mayla 説 "你記得我當時為甚麼為你贖身嗎?"
Output:
{
  "queries": [
    "Mayla 贖身 ransom payment",
    "Mayla 綁架 kidnapping captivity",
    "贖金談判 negotiation ransom broker",
    "Mayla 獲救 rescue aftermath emotional"
  ],
  "filters": {
    "characters_any": ["Mayla"],
    "concepts_any": ["ransom", "kidnapping", "rescue"]
  },
  "rationale": "用戶在問「為甚麼」,需要完整因果鏈:綁架前因 → 贖金談判 → 付款 → 救出反應。"
}

Return ONLY the JSON object. No commentary, no markdown fences, no preamble.`;

/**
 * Build the user-message portion of the planner prompt. Combines recent chat,
 * the current user message, and a summary of pre-search candidates.
 *
 * @param {object} params
 * @param {{speaker: string, text: string}[]} params.recentTurns - Past chat (oldest first)
 * @param {string} params.userMessage - Current user input verbatim
 * @param {object[]} params.candidates - Pre-search event candidates (already trimmed)
 * @returns {string} The user-message text
 */
export function buildPlannerUserMessage({ recentTurns, userMessage, candidates }) {
    const parts = [];

    parts.push('Recent chat (oldest first):');
    if (!recentTurns || recentTurns.length === 0) {
        parts.push('  (no recent context — start of conversation)');
    } else {
        recentTurns.forEach((turn, idx) => {
            const idxLabel = `[-${recentTurns.length - idx}]`;
            const speaker = turn.speaker || (turn.is_user ? '{{user}}' : '{{character}}');
            // Soft-trim each turn to ~600 chars so very long replies don't blow the budget.
            const body = (turn.text || '').slice(0, 600);
            const ellipsis = (turn.text || '').length > 600 ? '...' : '';
            parts.push(`  ${idxLabel} ${speaker}: ${body}${ellipsis}`);
        });
    }

    parts.push('');
    parts.push('Current user message:');
    parts.push(`  ${userMessage || '(empty)'}`);

    parts.push('');
    parts.push('Candidate events from pre-search (top by similarity, may be incomplete):');
    if (!candidates || candidates.length === 0) {
        parts.push('  (none — DB returned no semantic matches)');
    } else {
        candidates.forEach((ev, i) => {
            parts.push(_formatCandidateLine(ev, i + 1));
        });
    }

    parts.push('');
    parts.push('Plan retrieval. Return strict JSON only.');

    return parts.join('\n');
}

/**
 * One-line summary of a candidate event for the planner prompt.
 * Format: E<N> [score] type — text (chars: [...], concepts: [...], importance: X)
 */
function _formatCandidateLine(ev, idx) {
    const score = typeof ev.score === 'number' ? ev.score.toFixed(2)
        : typeof ev.vectorScore === 'number' ? ev.vectorScore.toFixed(2)
        : '—';
    const type = ev.event_type || ev.metadata?.event_type || 'event';
    const text = (ev.text || ev.metadata?.text || '').replace(/\s+/g, ' ').slice(0, 90);
    const chars = (ev.characters || ev.metadata?.characters || []).slice(0, 4).join(', ');
    const concepts = (ev.concepts || ev.metadata?.concepts || []).slice(0, 4).join(', ');
    const importance = ev.importance ?? ev.metadata?.importance ?? '?';

    const meta = [
        chars ? `chars: [${chars}]` : '',
        concepts ? `concepts: [${concepts}]` : '',
        `importance: ${importance}`,
    ].filter(Boolean).join(' | ');

    return `  E${idx} [${score}] ${type} — ${text}\n      ${meta}`;
}
