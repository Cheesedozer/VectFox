/**
 * ============================================================================
 * VectFox API KEY HELPERS
 * ============================================================================
 *
 * Single source of truth for resolving API keys at runtime, and the
 * one-shot migration that consolidates legacy per-feature key fields
 * into a single key per provider.
 *
 * ARCHITECTURE (post-2026-05-25 simplification):
 *
 * The original H-1 fix tried to use VectFox-specific `secret_state` slots
 * (e.g. `'summarize_openrouter_api_key'`) to keep summarize/embedding/
 * agentic OpenRouter keys separate. That failed in practice: ST's
 * `writeSecret(customSlot, value)` accepts the write but `readSecretState`
 * doesn't surface custom slots back into the in-memory `secret_state`
 * object — so the keys were write-only and the migration effectively
 * destroyed them. The BananaBread comment at ui-manager.js:3589 had
 * warned about this; we re-learned it the hard way.
 *
 * Current model — reuse whatever ST already round-trips, and proxy when
 * the real key value is needed:
 *
 *   - OpenRouter (one key for embedding + summarize + agent):
 *     Stored in ST's well-known `SECRET_KEYS.OPENROUTER` slot. ST's
 *     `getSecretState` returns this slot as an array of `{value, label,
 *     active, id}` entries — but `value` is MASKED (e.g. "*******abcd")
 *     unless `allowKeysExposure: true` is set in `config.yaml` (default
 *     false). So `getOpenRouterApiKey()` returns the masked string when
 *     a key is configured, and empty string otherwise. That's a presence
 *     indicator — DON'T send it as a Bearer token; you'll get 401.
 *
 *     Embedding works because it goes through ST's `/api/vector/insert`
 *     (or the Similharity plugin's `/api/plugins/similharity/chunks/insert`)
 *     proxy, which reads the real key server-side via
 *     `readSecret(SECRET_KEYS.OPENROUTER)`.
 *
 *     Summarize, EventBase, and Agentic chat-completion paths apply the
 *     same pattern: POST to `/api/backends/chat-completions/generate` with
 *     `chat_completion_source: 'openrouter'` — ST's server reads the real
 *     key and forwards to OpenRouter. All three VectFox UI inputs
 *     (Embedding / LLM Summarization / AgentMode) write to the same slot
 *     via `writeSecret`, so setting the key in any of them is shared.
 *
 *   - vLLM-style "Custom OpenAI-compatible" (one key for embedding +
 *     summarize + agent):
 *     Stored in ST's `SECRET_KEYS.CUSTOM` slot (`api_key_custom`). Same
 *     masking behavior as OpenRouter — getCustomApiKey() returns the
 *     masked string for presence-check only. Chat-side requests route
 *     through `/api/backends/chat-completions/generate` with
 *     `chat_completion_source: 'custom'` and `custom_url:
 *     settings.vllm_url` in the body — ST's server reads the real key
 *     via `readSecret(SECRET_KEYS.CUSTOM)` and forwards to the
 *     user-specified endpoint. Embedding side relies on
 *     `SECRET_KEYS.VLLM` (ST's dedicated vLLM Text Completion slot) via
 *     ST's `/api/vector/insert` server-side header injection; the user
 *     configures that key via ST's Text Completion → vLLM UI, NOT
 *     through VectFox.
 *
 *     Pre-2026-05-26 the key lived in plaintext `settings.vllm_api_key`.
 *     The header comment in this file used to claim no ST vLLM slot
 *     existed and plaintext was justified by LAN scope — both wrong.
 *     `SECRET_KEYS.VLLM` (`'api_key_vllm'`) exists at ST:secrets.js:22
 *     but is non-EXPORTABLE (masked client-side), so we use the proxy
 *     pattern same as OpenRouter. The migration drains the legacy
 *     plaintext value into `SECRET_KEYS.CUSTOM` (don't-clobber) on
 *     first load post-upgrade.
 *
 *   - Qdrant API key (Cloud auth):
 *     Stored in ST's secret_state under the CUSTOM slot name `api_key_qdrant`
 *     (not in ST's SECRET_KEYS enum — writeSecret/readSecret accept any
 *     string key; only getSecretState's read-to-client path filters by enum).
 *     Server-side: the Similharity plugin reads it via
 *     `readSecret(req.user.directories, 'api_key_qdrant', null)` and uses
 *     the real value to authenticate to Qdrant Cloud. Client-side:
 *     `secret_state.api_key_qdrant` is undefined (enum filter), so the UI
 *     presence indicator round-trips via the plugin's
 *     `/qdrant/key-status` endpoint instead (see `fetchQdrantApiKeyPresence`).
 *     Migration drains any legacy `settings.qdrant_api_key` plaintext into
 *     the slot on first load and deletes the plaintext field.
 *
 *   - ollama_api_key:
 *     Stay as plaintext in settings.json. Ollama is local-only in practice
 *     (LAN/personal scope), and there's no ST proxy for the embedding path
 *     that ollama uses, so the masking problem would break it. Migration
 *     to secret_state would require refactoring every read site. Out of
 *     scope until someone demonstrates a real attack surface here.
 *
 *   - bananabread_api_key:
 *     Untouched — the provider has been unselectable since day one
 *     (commented out in EMBEDDING_PROVIDERS). Its dual-storage code
 *     stays alive as zombie. No shipped user can have a value set.
 *
 * Migration (`migrateLegacyApiKeys`) runs once at init:
 *   - Consolidates the three legacy OpenRouter slots
 *     (`summarize_openrouter_api_key`, `agentic_retrieval_openrouter_api_key`,
 *     `openrouter_api_key`) into `SECRET_KEYS.OPENROUTER` IF that slot is
 *     currently empty (won't clobber a value the user already set in ST's
 *     UI). Always deletes the three legacy fields from settings.json.
 *   - Consolidates the three legacy vLLM slots
 *     (`summarize_vllm_api_key`, `agentic_retrieval_vllm_api_key`,
 *     `vllm_api_key`) by draining the first non-empty value into
 *     `SECRET_KEYS.CUSTOM` (don't-clobber) and deleting all three legacy
 *     plaintext fields. After migration, the chat-side code paths read
 *     the key server-side via ST's chat-completions proxy.
 *   - Idempotent: empty fields = no-op. Wrapped in try/catch — failures
 *     are non-fatal and don't lock users out of their keys.
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { SECRET_KEYS, secret_state, writeSecret, readSecretState } from '../../../../secrets.js';
import { saveSettingsDebounced } from '../../../../../script.js';

// ─── Internal helpers ───────────────────────────────────────────────────

/**
 * Extract the actual key value from `secret_state[slot]`.
 *
 * `secret_state` schema varies by slot — observed in production:
 * array-of-secrets shape for `SECRET_KEYS.OPENROUTER` (multiple keys
 * with `.active`/`.value` per entry), plus simpler string or object
 * shapes for other slots. Defensive against all three.
 *
 * Only call this for slots ST natively round-trips (the `SECRET_KEYS`
 * constants). Custom slot names don't survive `readSecretState`.
 *
 * @param {string} slot
 * @returns {string} trimmed value, or empty string
 */
function _readSecretValue(slot) {
    if (!slot) return '';
    const stored = secret_state?.[slot];
    if (!stored) return '';
    if (typeof stored === 'string') return stored.trim();
    if (Array.isArray(stored) && stored.length > 0) {
        const active = stored.find(s => s?.active) || stored[0];
        if (typeof active?.value === 'string') return active.value.trim();
    }
    if (typeof stored === 'object' && typeof stored.value === 'string') {
        return stored.value.trim();
    }
    return '';
}

// ─── Public readers ─────────────────────────────────────────────────────

/**
 * Resolve the OpenRouter API key — RETURNS A MASKED VALUE, not the real key.
 *
 * ST's `getSecretState` masks all values for non-EXPORTABLE_KEYS (OpenRouter
 * is not exportable), so what we get back is something like "*******abcd".
 * Use this for:
 *   - Presence checks (empty string ⇒ no key configured)
 *   - UI placeholder masking
 *
 * DO NOT pass the return value as a Bearer token — you'll get 401. Instead,
 * route OpenRouter requests through ST's `/api/backends/chat-completions/generate`
 * proxy with `chat_completion_source: 'openrouter'`; the server reads the
 * real key via `readSecret(SECRET_KEYS.OPENROUTER)` and forwards correctly.
 * See `core/summarizer.js::_callOpenRouter` for the canonical call pattern.
 *
 * @param {object} [settings] - kept for signature compat; not read.
 * @returns {string} masked value (presence indicator) or empty string
 */
export function getOpenRouterApiKey(settings) {
    return _readSecretValue(SECRET_KEYS.OPENROUTER);
}

/**
 * Resolve the Custom OpenAI-compatible API key — the slot VectFox uses
 * for vLLM-style endpoints post-2026-05-26. RETURNS A MASKED VALUE,
 * not the real key — same as `getOpenRouterApiKey`. Use for presence
 * checks and placeholder masking only; chat-side calls route through
 * ST's `/api/backends/chat-completions/generate` proxy with
 * `chat_completion_source: 'custom'` where the server reads the real
 * key via `readSecret(SECRET_KEYS.CUSTOM)`.
 *
 * @param {object} [settings] - kept for signature compat; not read.
 * @returns {string} masked value (presence indicator) or empty string
 */
export function getCustomApiKey(settings) {
    return _readSecretValue(SECRET_KEYS.CUSTOM);
}

/**
 * @deprecated Use {@link getCustomApiKey}. Kept as an alias for the
 * transition period; both readers point at the same `SECRET_KEYS.CUSTOM`
 * slot. Pre-2026-05-26 callers expected plaintext from
 * `settings.vllm_api_key` — that field is migrated and deleted on first
 * load post-upgrade. Remove this alias once all call sites are confirmed
 * migrated.
 */
export const getVllmApiKey = getCustomApiKey;

/**
 * Resolve the Qdrant API key presence indicator.
 *
 * Post-2026-05-26: the key lives in ST's secret_state under the custom slot
 * `api_key_qdrant`. That slot is NOT in ST's `SECRET_KEYS` enum, so
 * `getSecretState` (and therefore client-side `secret_state.api_key_qdrant`)
 * does NOT surface it. Server-side `readSecret(directories, 'api_key_qdrant')`
 * DOES read it correctly — that's how the Similharity plugin auth-flows the
 * real key value into Qdrant.
 *
 * For client-side presence checks (UI placeholder, "is the key set"), call
 * `fetchQdrantApiKeyPresence()` below — it round-trips to the plugin's
 * `/qdrant/key-status` endpoint which returns `{set, masked}`.
 *
 * This synchronous reader is kept ONLY as a transition fallback for the
 * pre-migration plaintext field. After migration drains it, this returns ''
 * and the UI/backends rely on the async presence fetch + server-side
 * resolution respectively.
 *
 * @param {object} [settings] - extension_settings.vectfox
 * @returns {string} pre-migration plaintext value, or '' once migrated
 */
export function getQdrantApiKey(settings) {
    const v = settings?.qdrant_api_key;
    return (typeof v === 'string') ? v.trim() : '';
}

/**
 * Async presence fetch for the Qdrant API key via the Similharity plugin's
 * `/qdrant/key-status` endpoint. Returns `{set: false, masked: ''}` when the
 * plugin is unreachable so callers can degrade gracefully.
 *
 * @returns {Promise<{set: boolean, masked: string}>}
 */
export async function fetchQdrantApiKeyPresence() {
    try {
        const response = await fetch('/api/plugins/similharity/qdrant/key-status', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) {
            return { set: false, masked: '' };
        }
        const data = await response.json();
        return {
            set: !!data?.set,
            masked: typeof data?.masked === 'string' ? data.masked : '',
        };
    } catch (err) {
        // Plugin unreachable (not installed, network error, etc.) — caller
        // should treat as "presence unknown" and not render the key indicator.
        return { set: false, masked: '' };
    }
}

/**
 * Resolve the Ollama API key. Plaintext storage.
 * @param {object} [settings] - extension_settings.vectfox
 * @returns {string} key value or empty string
 */
export function getOllamaApiKey(settings) {
    const v = settings?.ollama_api_key;
    return (typeof v === 'string') ? v.trim() : '';
}

// ─── One-shot legacy field migration ────────────────────────────────────

/**
 * Consolidate legacy per-feature key fields into the new one-key-per-provider
 * shape. Runs once at init from `index.js`.
 *
 * For OpenRouter:
 *   - Legacy fields: `summarize_openrouter_api_key`,
 *     `agentic_retrieval_openrouter_api_key`, `openrouter_api_key`
 *   - Picks the first non-empty value as the canonical key.
 *   - Writes to `SECRET_KEYS.OPENROUTER` ONLY IF that slot is currently
 *     empty (don't clobber a value the user set through ST's own UI).
 *   - Deletes all three legacy fields from `extension_settings.vectfox`.
 *
 * For vLLM:
 *   - Legacy fields: `summarize_vllm_api_key`,
 *     `agentic_retrieval_vllm_api_key`, `vllm_api_key`
 *   - Picks the first non-empty value, stores it in `vllm_api_key` plaintext.
 *   - Deletes the other two from `extension_settings.vectfox`.
 *
 * qdrant_api_key, ollama_api_key, bananabread_api_key: left untouched.
 *
 * Idempotent: on subsequent runs the legacy fields are already absent
 * and the function is a no-op.
 *
 * @returns {Promise<{summary: string}>}
 */
export async function migrateLegacyApiKeys() {
    const vf = extension_settings?.vectfox;
    if (!vf) {
        console.warn('[VectFox migrate] extension_settings.vectfox not initialized — skipping');
        return { summary: 'not-initialized' };
    }

    let mutated = false;
    const moves = []; // human-readable log entries

    // ─── OpenRouter consolidation ───
    const orLegacy = [
        'summarize_openrouter_api_key',
        'agentic_retrieval_openrouter_api_key',
        'openrouter_api_key',
    ];
    let orValue = '';
    for (const field of orLegacy) {
        if (!Object.prototype.hasOwnProperty.call(vf, field)) continue;
        const v = vf[field];
        if (!orValue && typeof v === 'string' && v.trim().length > 0) {
            orValue = v.trim();
            moves.push(`OpenRouter source: ${field} (len=${orValue.length})`);
        }
        delete vf[field];
        mutated = true;
    }
    if (orValue) {
        const existing = _readSecretValue(SECRET_KEYS.OPENROUTER);
        if (!existing) {
            try {
                await writeSecret(SECRET_KEYS.OPENROUTER, orValue);
                moves.push(`OpenRouter → wrote to SECRET_KEYS.OPENROUTER (was empty)`);
            } catch (err) {
                console.warn('[VectFox migrate] writeSecret(SECRET_KEYS.OPENROUTER) failed:', err?.message || err);
                moves.push(`OpenRouter → writeSecret FAILED, key not migrated`);
            }
        } else {
            moves.push(`OpenRouter → SECRET_KEYS.OPENROUTER already has a key, keeping that one (didn't clobber)`);
        }
    }

    // ─── vLLM → SECRET_KEYS.CUSTOM drain ───
    // Pre-2026-05-26: VectFox stored the vLLM-style key plaintext in
    // `settings.vllm_api_key` and 2 sibling legacy fields. The chat-side
    // code did direct fetches with `Authorization: Bearer ${key}`.
    // Post-refactor: chat-side routes through ST's chat-completions proxy
    // with `chat_completion_source: 'custom'`, which reads the key from
    // `SECRET_KEYS.CUSTOM` server-side. Drain the legacy plaintext value
    // into that slot (first non-empty wins) and delete all three legacy
    // plaintext fields. Don't-clobber rule: if the slot is already non-
    // empty, leave it alone — user may have configured their main chat to
    // use Custom OpenAI-compatible with a different value and we'd silently
    // hijack it.
    const vllmLegacy = [
        'summarize_vllm_api_key',
        'agentic_retrieval_vllm_api_key',
        'vllm_api_key',
    ];
    let vllmValue = '';
    for (const field of vllmLegacy) {
        if (!Object.prototype.hasOwnProperty.call(vf, field)) continue;
        const v = vf[field];
        if (!vllmValue && typeof v === 'string' && v.trim().length > 0) {
            vllmValue = v.trim();
            moves.push(`vLLM source: ${field} (len=${vllmValue.length})`);
        }
        delete vf[field];
        mutated = true;
    }
    if (vllmValue) {
        // Dual-write: chat-side proxy reads SECRET_KEYS.CUSTOM; embedding-side
        // proxy reads SECRET_KEYS.VLLM. Writing to both preserves the "one
        // shared key" UX promise from pre-2026-05-26 while moving storage out
        // of plaintext. Each write is don't-clobber so existing ST main-chat
        // configs (Custom source) or existing ST vLLM Text Completion configs
        // are left alone — users with intentional per-slot values keep them.
        const existingCustom = _readSecretValue(SECRET_KEYS.CUSTOM);
        if (!existingCustom) {
            try {
                await writeSecret(SECRET_KEYS.CUSTOM, vllmValue);
                moves.push(`vLLM → wrote to SECRET_KEYS.CUSTOM (was empty)`);
            } catch (err) {
                console.warn('[VectFox migrate] writeSecret(SECRET_KEYS.CUSTOM) failed:', err?.message || err);
                moves.push(`vLLM → writeSecret(SECRET_KEYS.CUSTOM) FAILED, chat-side key not migrated — re-enter via VectFox UI`);
            }
        } else {
            const msg = `vLLM → SECRET_KEYS.CUSTOM already has a value (likely from ST main-chat config) — kept that one for chat-side. To override, clear ST's Custom OpenAI-compatible key and re-enter via VectFox UI.`;
            console.warn(`[VectFox migrate] ${msg}`);
            moves.push(msg);
        }

        const existingVllm = _readSecretValue(SECRET_KEYS.VLLM);
        if (!existingVllm) {
            try {
                await writeSecret(SECRET_KEYS.VLLM, vllmValue);
                moves.push(`vLLM → wrote to SECRET_KEYS.VLLM (was empty, used by embedding path)`);
            } catch (err) {
                console.warn('[VectFox migrate] writeSecret(SECRET_KEYS.VLLM) failed:', err?.message || err);
                moves.push(`vLLM → writeSecret(SECRET_KEYS.VLLM) FAILED, embedding-side key not migrated — configure via ST's Text Completion → vLLM UI`);
            }
        } else {
            const msg = `vLLM → SECRET_KEYS.VLLM already has a value (from ST Text Completion → vLLM config) — kept that one for embedding-side.`;
            console.warn(`[VectFox migrate] ${msg}`);
            moves.push(msg);
        }
    }

    // ─── Qdrant API key → 'api_key_qdrant' (custom slot) drain ───
    // Pre-2026-05-26: VectFox stored the Qdrant Cloud API key plaintext in
    // settings.qdrant_api_key. The backends/qdrant.js init flow sent the raw
    // value to the Similharity plugin which then auth'd to Qdrant Cloud.
    // Post-refactor: client sends `apiKey: null` to the plugin, which reads
    // the real value server-side from ST's secret_state slot 'api_key_qdrant'
    // via readSecret. The slot is a custom name (not in ST's SECRET_KEYS enum)
    // because no enum slot exists for Qdrant. writeSecret accepts any string
    // slot name; readSecret reads it correctly server-side; client-side
    // secret_state filters non-enum slots, so the UI presence indicator goes
    // through the plugin's /qdrant/key-status endpoint instead (see
    // fetchQdrantApiKeyPresence above).
    //
    // ⚠️ Capability probe BEFORE migration: if the user is on a pre-2026-05-26
    // Similharity plugin, the /qdrant/key-status endpoint doesn't exist yet.
    // Migrating in that state would write to secret_state but leave the
    // plugin unable to read it back — silently breaking Qdrant Cloud auth
    // while deleting the user's only working key from settings.json. The
    // probe gates BOTH the write and the delete: if the plugin doesn't yet
    // support secret_state lookup, we no-op and retry on next reload. The
    // migration is idempotent — once the plugin updates, the next ST start
    // probes successfully and the drain runs cleanly.
    const QDRANT_SLOT = 'api_key_qdrant';
    let pluginSupportsQdrantSecretSlot = false;
    try {
        const probe = await fetch('/api/plugins/similharity/qdrant/key-status', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });
        pluginSupportsQdrantSecretSlot = probe.ok;
        if (!probe.ok) {
            console.warn(`[VectFox migrate] Plugin /qdrant/key-status probe returned ${probe.status} — Similharity plugin is pre-2026-05-26. Skipping Qdrant key migration this run; plaintext key in settings.json is PRESERVED. Update the Similharity plugin (cd plugins/similharity && git pull && restart ST) to enable secret_state storage.`);
        }
    } catch (err) {
        console.warn(`[VectFox migrate] Plugin /qdrant/key-status probe failed (plugin unreachable or pre-2026-05-26). Skipping Qdrant key migration this run; plaintext key in settings.json is PRESERVED. Reason:`, err?.message || err);
    }

    if (pluginSupportsQdrantSecretSlot) {
        const rawQdrantPlaintext = vf?.qdrant_api_key;
        const hasPlaintextField = Object.prototype.hasOwnProperty.call(vf, 'qdrant_api_key');
        const hasPlaintextValue = typeof rawQdrantPlaintext === 'string' && rawQdrantPlaintext.trim().length > 0;
        let writeSucceeded = !hasPlaintextValue; // nothing to write = trivially succeeded

        if (hasPlaintextValue) {
            // No don't-clobber check: custom slot is undefined in client-side
            // secret_state, so we can't presence-check from JS. Plugin-side
            // this overwrites any prior value — acceptable for the first
            // migration pass (slot is brand new for VectFox users).
            try {
                await writeSecret(QDRANT_SLOT, rawQdrantPlaintext.trim());
                moves.push(`Qdrant → wrote to secret_state.${QDRANT_SLOT} (len=${rawQdrantPlaintext.trim().length})`);
                writeSucceeded = true;
            } catch (err) {
                console.warn('[VectFox migrate] writeSecret(api_key_qdrant) failed:', err?.message || err);
                moves.push(`Qdrant → writeSecret(${QDRANT_SLOT}) FAILED — plaintext key PRESERVED in settings.json for safety, retry next reload`);
                // writeSucceeded stays false → plaintext stays in settings.json
            }
        }

        // Delete the plaintext field ONLY after a confirmed-successful write
        // (or when there was no value to migrate). Never delete in a half-
        // migrated state — the user's only working key would be lost.
        if (writeSucceeded && hasPlaintextField) {
            delete vf.qdrant_api_key;
            mutated = true;
            if (!hasPlaintextValue) {
                moves.push(`Qdrant → removed empty plaintext qdrant_api_key from settings.json`);
            }
        }
    }

    if (mutated) {
        // saveSettingsDebounced flushes our deletions/consolidations to
        // settings.json. Without this, the in-memory changes don't reach
        // disk until something else triggers a save.
        saveSettingsDebounced();
    }

    if (moves.length > 0) {
        console.log(`[VectFox migrate] Migration complete:\n  - ${moves.join('\n  - ')}`);
        // Refresh in-memory secret_state if we wrote OpenRouter or CUSTOM
        try { await readSecretState(); } catch {}
    } else {
        console.log('[VectFox migrate] No legacy API-key fields found — nothing to migrate');
    }

    return { summary: moves.length > 0 ? moves.join('; ') : 'nothing-to-migrate' };
}
