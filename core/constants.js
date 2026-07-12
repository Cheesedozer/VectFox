/**
 * ============================================================================
 * VECTFOX CONSTANTS
 * ============================================================================
 * Centralized configuration values used across the extension.
 * Change these values here instead of hunting through the codebase.
 *
 * @author Kritblade
 * @version 4.0.0
 * ============================================================================
 */

// =============================================================================
// EXTENSION IDENTITY
// =============================================================================

/** Extension prompt tag for SillyTavern's prompt system */
export const EXTENSION_PROMPT_TAG = '3_vectfox';

/** Extension prompt tag for lorebook semantic WI injection */
export const LOREBOOK_PROMPT_TAG = '3_vectfox_lorebook';

/** Extension name for logging and UI */
export const EXTENSION_NAME = 'VectFox';

// =============================================================================
// PERFORMANCE & RATE LIMITING
// =============================================================================

/** LRU cache size for hash computations */
export const HASH_CACHE_SIZE = 10000;

/** Maximum items to fetch when listing vectors (for hash comparison) */
export const VECTOR_LIST_LIMIT = 10000;

/** Rate limiter: max calls per window */
export const RATE_LIMIT_CALLS = 50;

/** Rate limiter: window duration in ms (1 minute) */
export const RATE_LIMIT_WINDOW_MS = 60000;

/** API request timeout in ms (30 seconds) */
export const API_TIMEOUT_MS = 30000;

/**
 * Per-turn retrieval timeout in ms (15 seconds). Bounds the read/search path
 * during generation (rearrangeChat -> EventBase retrieval + chunk retrieval) so
 * a hung embedding/query cannot freeze the whole conversation. On timeout the
 * turn proceeds WITHOUT memory injection -- soft Promise.race via
 * AsyncUtils.timeout; the orphaned fetch is reaped later by ST's server-side
 * timeout (read fetches carry no client AbortSignal). Matches the write-side
 * hedge threshold (vector_hedge_after_ms = 15000) for one consistent "too slow"
 * number. Unlike the write path, reads are NOT hedged/retried -- a stalled
 * retrieval fails soft (one turn without memory, self-corrects next message),
 * so a single bounded attempt is the right tradeoff. See dev_helper.md sec 6.8.
 */
export const RETRIEVAL_TIMEOUT_MS = 15000;

// =============================================================================
// RETRY CONFIGURATION
// =============================================================================

/** Maximum retry attempts for failed API calls */
export const RETRY_MAX_ATTEMPTS = 4;

/** Initial delay between retries in ms.
 *  Backoff schedule with maxDelay=8000 and multiplier=2 produces 5s, 8s, 8s
 *  (3 backoffs between 4 attempts). Worst-case wait under T-per-attempt is
 *  4T + 21s — chosen to fit inside the ~150s pair-spike window observed on
 *  OpenRouter embedding routing so a retry has a real chance of landing on a
 *  rotated upstream. See conversation 2026-05-30 — Doc/log.txt analysis. */
export const RETRY_INITIAL_DELAY_MS = 5000;

/** Maximum delay between retries in ms (caps the exponential growth at 8s) */
export const RETRY_MAX_DELAY_MS = 8000;

/** Backoff multiplier for exponential retry */
export const RETRY_BACKOFF_MULTIPLIER = 2;

// =============================================================================
// CHUNKING DEFAULTS
// =============================================================================

/** Default chunk size in characters */
export const DEFAULT_CHUNK_SIZE = 500;

/** Default overlap between chunks in characters */
export const DEFAULT_CHUNK_OVERLAP = 50;

/** Characters to search back when finding sentence boundaries */
export const SENTENCE_SEARCH_WINDOW = 50;

// =============================================================================
// CONDITIONAL ACTIVATION DEFAULTS
// =============================================================================

/** Default recency threshold for activation rules (messages ago) */
export const DEFAULT_RECENCY_THRESHOLD = 50;

// =============================================================================
// UI DEFAULTS
// =============================================================================

/** Default score threshold for vector search results */
export const DEFAULT_SCORE_THRESHOLD = 0.25;

/** Default number of chunks to insert into prompt */
export const DEFAULT_INSERT_COUNT = 5;

/** Default number of recent messages to use for query */
export const DEFAULT_QUERY_COUNT = 5;

/** Default number of messages to protect from vectorization */
export const DEFAULT_PROTECT_COUNT = 5;
