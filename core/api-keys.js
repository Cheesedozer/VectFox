/**
 * ============================================================================
 * VectFox API KEY HELPERS
 * ============================================================================
 *
 * Single source of truth for resolving API keys at runtime, and the
 * one-shot migration that moved them from `extension_settings.vectfox.*`
 * plaintext to SillyTavern's `secret_state`.
 *
 * Background (2026-05-24, external code review item H-1):
 *
 * VectFox originally stored summarize_openrouter_api_key and
 * summarize_vllm_api_key as plain strings in settings.json — alongside
 * non-secret config. That meant:
 *   1. Keys persisted unencrypted to disk, visible to anyone with file
 *      access (backup, screenshot, git accident).
 *   2. The same key value got logged into diagnostic prints as a
 *      truthy/falsy check (`hasOpenRouterKey: !!settings.X`), which is
 *      benign but the underlying field was still plaintext.
 *
 * Fix: store these via `writeSecret(slot, value)` into ST's secret_state,
 * read via the same in-memory `secret_state` map. Plaintext settings
 * field is cleared on first load via `migrateLegacyApiKeys` (idempotent —
 * empty settings field on subsequent loads is a no-op).
 *
 * Why TWO new dedicated slots instead of reusing `SECRET_KEYS.OPENROUTER`:
 * a user may legitimately want different keys for the embedding side
 * (ST core's OpenRouter slot, used by the embedding section's UI) versus
 * the summarization side (this new dedicated slot). Different rate-limit
 * tiers, different accounts. The fallback to SECRET_KEYS.OPENROUTER
 * preserves the legacy UX where a user with only the embedding key set
 * gets the same key for summarization automatically.
 *
 * Reader fallback order (per key):
 *   1. Dedicated summarize slot in secret_state — post-migration canonical
 *   2. Legacy plaintext in settings.json — only non-empty in the brief
 *      window between user upgrade and first `migrateLegacyApiKeys` run
 *   3. (OpenRouter only) ST core's SECRET_KEYS.OPENROUTER — the embedding
 *      key, preserved as the "user only set embedding, summarize inherits"
 *      shortcut from pre-H-1 behavior.
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { SECRET_KEYS, secret_state, writeSecret, readSecretState } from '../../../../secrets.js';
import { saveSettingsDebounced, saveSettings } from '../../../../../script.js';

// Dedicated slot names — keep in sync with the writeSecret() calls in
// ui-manager.js summarize sections. Constants here so a typo can't drift
// between writer and reader.
export const SUMMARIZE_OPENROUTER_SECRET_SLOT = 'summarize_openrouter_api_key';
export const SUMMARIZE_VLLM_SECRET_SLOT = 'summarize_vllm_api_key';

// AgentMode (Agentic Retrieval) optional override slots. When the user
// sets one of these, the agentic-retrieval planner uses it instead of
// inheriting the summarize key. Same H-1 storage migration applies.
export const AGENTIC_OPENROUTER_SECRET_SLOT = 'agentic_retrieval_openrouter_api_key';
export const AGENTIC_VLLM_SECRET_SLOT = 'agentic_retrieval_vllm_api_key';

// Embedding-side keys (H-1 phase 2 — 2026-05-24). These are the keys the
// embedding section's UI inputs save into, used by core-vector-api.js for
// embedding generation and backends/qdrant.js for Qdrant Cloud auth.
//
// Note on OpenRouter: the embedding OpenRouter key uses ST core's
// SECRET_KEYS.OPENROUTER slot (NOT a new VectFox-specific one) because
// that's shared with ST itself — if the user changes their OpenRouter
// key in ST's own settings, our embedding picks it up. Intentional.
// So there's no NEW constant here for embedding OpenRouter; it's just
// SECRET_KEYS.OPENROUTER imported from ST.
export const QDRANT_API_KEY_SECRET_SLOT = 'qdrant_api_key';
export const OLLAMA_API_KEY_SECRET_SLOT = 'ollama_api_key';
export const VLLM_API_KEY_SECRET_SLOT = 'vllm_api_key';

/**
 * Extract the actual key value from a `secret_state[slot]` entry.
 *
 * `secret_state` schema varies by ST version / secret backend — observed
 * in production: array-of-secrets shape used by SECRET_KEYS.OPENROUTER
 * (multiple keys with `.active` / `.value` per entry) AND simpler string
 * or object shapes for other slots. Defensive against all three.
 *
 * An earlier code review (item L-9) claimed `secret_state[KEY]` returns
 * a boolean — verified false: the embedding section's display at
 * ui-manager.js:3744 reads `.active` and `.value` off array entries
 * and works in production (user sees masked key in placeholder). The
 * fallback branches in this helper are real, not dead code.
 *
 * @param {string} slot - secret_state key name
 * @returns {string} key value, trimmed; empty string if not set
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

/**
 * Resolve the OpenRouter API key for summarization paths
 * (summarizer.js, eventbase-extractor.js, agentic-retrieval.js).
 *
 * @param {object} [settings] - extension_settings.vectfox (for legacy fallback)
 * @returns {string} key value or empty string
 */
export function getSummarizeOpenRouterKey(settings) {
    // 1. Dedicated summarize slot (post-migration canonical)
    const dedicated = _readSecretValue(SUMMARIZE_OPENROUTER_SECRET_SLOT);
    if (dedicated) return dedicated;

    // 2. Legacy plaintext (only non-empty pre-migration; cleared by
    //    migrateLegacyApiKeys on first load post-upgrade)
    if (settings?.summarize_openrouter_api_key) {
        return settings.summarize_openrouter_api_key.trim();
    }

    // 3. Fall back to ST core's OpenRouter slot — the embedding key.
    //    Preserves the pre-H-1 UX where a user setting only the embedding
    //    OpenRouter key automatically got summarization too.
    return _readSecretValue(SECRET_KEYS.OPENROUTER);
}

/**
 * Resolve the vLLM API key for summarization paths.
 *
 * Same fallback ladder as OpenRouter except there's no ST-core fallback
 * (no shared "vLLM key" slot).
 *
 * @param {object} [settings] - extension_settings.vectfox (for legacy fallback)
 * @returns {string} key value or empty string
 */
export function getSummarizeVllmKey(settings) {
    const dedicated = _readSecretValue(SUMMARIZE_VLLM_SECRET_SLOT);
    if (dedicated) return dedicated;
    if (settings?.summarize_vllm_api_key) {
        return settings.summarize_vllm_api_key.trim();
    }
    return '';
}

/**
 * Resolve the AgentMode OpenRouter override key.
 *
 * Returns only the dedicated override (or legacy plaintext during the
 * migration window). Does NOT fall through to the summarize key — that
 * inheritance is handled by the caller (agentic-retrieval.js) so the
 * "empty → inherit" UX stays explicit at the call site.
 *
 * @param {object} [settings] - extension_settings.vectfox
 * @returns {string} override key value or empty string (caller decides
 *                   whether to inherit from getSummarizeOpenRouterKey)
 */
export function getAgenticOpenRouterKey(settings) {
    const dedicated = _readSecretValue(AGENTIC_OPENROUTER_SECRET_SLOT);
    if (dedicated) return dedicated;
    if (settings?.agentic_retrieval_openrouter_api_key) {
        return settings.agentic_retrieval_openrouter_api_key.trim();
    }
    return '';
}

/**
 * Resolve the AgentMode vLLM override key. Same shape as the OpenRouter
 * override above — caller decides whether to inherit.
 *
 * @param {object} [settings] - extension_settings.vectfox
 * @returns {string} override key value or empty string
 */
export function getAgenticVllmKey(settings) {
    const dedicated = _readSecretValue(AGENTIC_VLLM_SECRET_SLOT);
    if (dedicated) return dedicated;
    if (settings?.agentic_retrieval_vllm_api_key) {
        return settings.agentic_retrieval_vllm_api_key.trim();
    }
    return '';
}

// ─── Embedding-side key resolvers (H-1 phase 2 — 2026-05-24) ────────────

/**
 * Resolve the OpenRouter key used by the EMBEDDING section (Choose
 * Models button + actual embedding API calls).
 *
 * Reads from ST core's shared OpenRouter slot — same key ST itself uses
 * for chat completion. The legacy plaintext settings.openrouter_api_key
 * fallback covers users who saved before the H-1 migration drained that
 * field.
 *
 * Distinct from getSummarizeOpenRouterKey, which uses a VectFox-specific
 * slot for summarization paths. A user CAN configure different keys for
 * embedding vs summarization (different rate-limit tiers, separate
 * accounts) by setting them separately in the UI; only the summarize
 * side falls back to the embedding key when its own slot is empty.
 *
 * @param {object} [settings] - extension_settings.vectfox (for legacy fallback)
 * @returns {string} key value or empty string
 */
export function getEmbeddingOpenRouterKey(settings) {
    const fromSecrets = _readSecretValue(SECRET_KEYS.OPENROUTER);
    if (fromSecrets) return fromSecrets;
    if (settings?.openrouter_api_key) {
        return settings.openrouter_api_key.trim();
    }
    return '';
}

/**
 * Resolve the Qdrant API key (used for Qdrant Cloud auth at
 * backends/qdrant.js::initialize).
 *
 * Returns empty string when not set — caller at qdrant.js historically
 * uses `apiKey || null` to convert, so empty string is a safe sentinel.
 *
 * @param {object} [settings] - extension_settings.vectfox
 * @returns {string} key value or empty string
 */
export function getQdrantApiKey(settings) {
    const dedicated = _readSecretValue(QDRANT_API_KEY_SECRET_SLOT);
    if (dedicated) return dedicated;
    if (settings?.qdrant_api_key) {
        return settings.qdrant_api_key.trim();
    }
    return '';
}

/**
 * Resolve the Ollama API key (rarely needed — Ollama is typically local
 * and unauthenticated, but the field exists for hosted-Ollama setups).
 *
 * @param {object} [settings] - extension_settings.vectfox
 * @returns {string} key value or empty string
 */
export function getOllamaApiKey(settings) {
    const dedicated = _readSecretValue(OLLAMA_API_KEY_SECRET_SLOT);
    if (dedicated) return dedicated;
    if (settings?.ollama_api_key) {
        return settings.ollama_api_key.trim();
    }
    return '';
}

/**
 * Resolve the vLLM API key used by the EMBEDDING section.
 *
 * Distinct from getSummarizeVllmKey (separate slot). Settings UI for
 * embedding-side vLLM is at #VectFox_vllm_api_key; summarization-side
 * vLLM is at #VectFox_summarize_vllm_apikey.
 *
 * @param {object} [settings] - extension_settings.vectfox
 * @returns {string} key value or empty string
 */
export function getVllmApiKey(settings) {
    const dedicated = _readSecretValue(VLLM_API_KEY_SECRET_SLOT);
    if (dedicated) return dedicated;
    if (settings?.vllm_api_key) {
        return settings.vllm_api_key.trim();
    }
    return '';
}

/**
 * One-shot migration: copy any plaintext `*_api_key` values from
 * extension_settings.vectfox into ST's secret_state, then clear them
 * from settings.json so the plaintext copy stops persisting.
 *
 * Migrates eight slots (post phase-2 expansion 2026-05-24):
 *   Summarize/AgentMode (phase 1):
 *     - summarize_openrouter_api_key
 *     - summarize_vllm_api_key
 *     - agentic_retrieval_openrouter_api_key (AgentMode override)
 *     - agentic_retrieval_vllm_api_key (AgentMode override)
 *   Embedding-side (phase 2):
 *     - openrouter_api_key → SECRET_KEYS.OPENROUTER (ST shared slot)
 *     - qdrant_api_key → custom slot 'qdrant_api_key'
 *     - ollama_api_key → custom slot 'ollama_api_key'
 *     - vllm_api_key → custom slot 'vllm_api_key'
 *
 * Note on openrouter_api_key (embedding): the destination slot is
 * SECRET_KEYS.OPENROUTER — the SAME slot ST itself uses. If the user
 * already had that slot populated via ST's own UI or via the embedding
 * section's pre-fix writeSecret call, the migration's destination is
 * "already set". To avoid overwriting a more-canonical value, we ONLY
 * write the legacy plaintext to SECRET_KEYS.OPENROUTER when that slot
 * is currently empty. Either way, the legacy plaintext is cleared from
 * settings.json afterwards.
 *
 * BananaBread is INTENTIONALLY excluded — the provider has been
 * unselectable from the UI since day one (entry commented out in
 * EMBEDDING_PROVIDERS at providers.js:31), so no shipped user can ever
 * have a bananabread_api_key set in production. Leaving the existing
 * dual-storage code alive as zombie matches the "deprecated provider"
 * scope. See plans/review-fix.md §H-1 phase-2 for the full reasoning.
 *
 * Called once during index.js init. Idempotent — subsequent calls see
 * empty settings fields and do nothing.
 *
 * @returns {Promise<{migrated: number, slots: string[]}>}
 */
export async function migrateLegacyApiKeys() {
    console.log('[VectFox migrate] START — auditing legacy API-key fields in extension_settings.vectfox');

    const vf = extension_settings?.vectfox;
    if (!vf) {
        console.warn('[VectFox migrate] extension_settings.vectfox is not initialized — skipping migration');
        return { migrated: 0, slots: [] };
    }

    // Standard migration pairs: (legacy plaintext field, dedicated slot name).
    const MIGRATIONS = [
        ['summarize_openrouter_api_key', SUMMARIZE_OPENROUTER_SECRET_SLOT],
        ['summarize_vllm_api_key',       SUMMARIZE_VLLM_SECRET_SLOT],
        ['agentic_retrieval_openrouter_api_key', AGENTIC_OPENROUTER_SECRET_SLOT],
        ['agentic_retrieval_vllm_api_key',       AGENTIC_VLLM_SECRET_SLOT],
        ['qdrant_api_key', QDRANT_API_KEY_SECRET_SLOT],
        ['ollama_api_key', OLLAMA_API_KEY_SECRET_SLOT],
        ['vllm_api_key',   VLLM_API_KEY_SECRET_SLOT],
    ];

    // Pre-flight audit: log the current state of every legacy field so we
    // can diagnose stuck migrations from console output alone. NEVER logs
    // the key value itself — only type, length, hasOwnProperty status.
    const _describe = (key) => {
        const has = Object.prototype.hasOwnProperty.call(vf, key);
        if (!has) return 'not present';
        const v = vf[key];
        if (typeof v !== 'string') return `non-string (type=${typeof v})`;
        if (v.length === 0) return 'empty string ""';
        return `string len=${v.length} (non-empty)`;
    };
    console.log('[VectFox migrate] Pre-flight state of legacy fields:');
    for (const [field] of MIGRATIONS) {
        console.log(`[VectFox migrate]   ${field}: ${_describe(field)}`);
    }
    console.log(`[VectFox migrate]   openrouter_api_key (special-case): ${_describe('openrouter_api_key')}`);

    const moved = [];
    const deleted = [];
    // Track whether we mutated extension_settings.vectfox so we know to
    // call saveSettingsDebounced(). Just clearing in memory isn't enough:
    // without an explicit save, the value lingers in settings.json on disk
    // until something else triggers a write.
    let mutated = false;

    for (const [legacyField, slot] of MIGRATIONS) {
        if (!Object.prototype.hasOwnProperty.call(vf, legacyField)) {
            console.log(`[VectFox migrate]   ${legacyField}: SKIP (field not present)`);
            continue;
        }
        const val = vf[legacyField];
        let migratedThisOne = false;

        // Case A: non-empty plaintext value → migrate to secret_state first,
        // then delete. On writeSecret failure, KEEP the field so a retry
        // can happen on the next init (better to leave plaintext than to
        // delete it without preserving the value somewhere).
        if (typeof val === 'string' && val.trim().length > 0) {
            console.log(`[VectFox migrate]   ${legacyField}: has plaintext (len=${val.length}), writing to secret_state[${slot}]...`);
            try {
                await writeSecret(slot, val.trim());
                moved.push(slot);
                migratedThisOne = true;
                console.log(`[VectFox migrate]   ${legacyField}: writeSecret(${slot}) OK`);
            } catch (err) {
                console.warn(`[VectFox migrate]   ${legacyField}: writeSecret(${slot}) FAILED — keeping field for retry:`, err?.message || err);
                continue; // leave the field on disk for retry
            }
        } else {
            console.log(`[VectFox migrate]   ${legacyField}: empty/non-string value, no secret write needed`);
        }

        // Always delete the field once handled (whether we migrated a value
        // or there was just an empty leftover). User-visible: settings.json
        // no longer carries the field after this runs.
        delete vf[legacyField];
        deleted.push(legacyField);
        mutated = true;
        console.log(`[VectFox migrate]   ${legacyField}: DELETED from extension_settings.vectfox${migratedThisOne ? ' (after successful secret-write)' : ''}`);
    }

    // Special-case migration for embedding openrouter_api_key → SECRET_KEYS.OPENROUTER.
    // The destination slot is shared with ST; only write if it's currently empty
    // (don't clobber a value the user set through ST's own UI or via our pre-fix
    // writeSecret call). The legacy plaintext is always cleared regardless, INCLUDING
    // empty-string leftovers from earlier partial migrations.
    if (Object.prototype.hasOwnProperty.call(vf, 'openrouter_api_key')) {
        const legacyOR = vf.openrouter_api_key;
        let canDelete = true; // delete unless writeSecret failed

        if (typeof legacyOR === 'string' && legacyOR.trim().length > 0) {
            const existingInSlot = _readSecretValue(SECRET_KEYS.OPENROUTER);
            if (existingInSlot) {
                console.log(`[VectFox migrate]   openrouter_api_key: SECRET_KEYS.OPENROUTER already populated by ST or prior writeSecret — clearing legacy plaintext without overwriting secret`);
            } else {
                console.log(`[VectFox migrate]   openrouter_api_key: has plaintext (len=${legacyOR.length}), writing to secret_state[${SECRET_KEYS.OPENROUTER}]...`);
                try {
                    await writeSecret(SECRET_KEYS.OPENROUTER, legacyOR.trim());
                    moved.push(SECRET_KEYS.OPENROUTER);
                    console.log(`[VectFox migrate]   openrouter_api_key: writeSecret(${SECRET_KEYS.OPENROUTER}) OK`);
                } catch (err) {
                    console.warn(`[VectFox migrate]   openrouter_api_key: writeSecret(${SECRET_KEYS.OPENROUTER}) FAILED — keeping field for retry:`, err?.message || err);
                    canDelete = false;
                }
            }
        } else {
            console.log(`[VectFox migrate]   openrouter_api_key: empty/non-string value, no secret write needed`);
        }

        if (canDelete) {
            delete vf.openrouter_api_key;
            deleted.push('openrouter_api_key');
            mutated = true;
            console.log(`[VectFox migrate]   openrouter_api_key: DELETED from extension_settings.vectfox`);
        }
    } else {
        console.log(`[VectFox migrate]   openrouter_api_key: SKIP (field not present)`);
    }

    if (moved.length > 0) {
        // Refresh in-memory state so subsequent reads see the new values
        try {
            await readSecretState();
            console.log(`[VectFox migrate] readSecretState() refreshed in-memory secret_state`);
        } catch (err) {
            console.warn(`[VectFox migrate] readSecretState() failed:`, err?.message || err);
        }
    }

    if (mutated) {
        const trackedKeys = [...MIGRATIONS.map(([f]) => f), 'openrouter_api_key'];

        // Pre-save check — confirm extension_settings.vectfox really IS
        // what we deleted from (no stale reference / Proxy weirdness).
        const stillPresent = trackedKeys.filter(k => Object.prototype.hasOwnProperty.call(vf, k));
        const sameRef = vf === extension_settings?.vectfox;
        console.log(`[VectFox migrate] Pre-save check — vf === extension_settings.vectfox: ${sameRef} ; legacy fields still on vf: [${stillPresent.join(', ') || 'none'}] (expect: none)`);

        // Also confirm via the canonical reference path (not via vf alias) —
        // catches the case where vf was a stale reference and the canonical
        // object has been re-bound to something fresh since.
        const stillPresentCanonical = trackedKeys.filter(k =>
            extension_settings?.vectfox &&
            Object.prototype.hasOwnProperty.call(extension_settings.vectfox, k)
        );
        console.log(`[VectFox migrate] Pre-save check — legacy fields on extension_settings.vectfox (canonical): [${stillPresentCanonical.join(', ') || 'none'}] (expect: none)`);

        // Triple-save to defeat the "Settings not ready, scheduling another
        // save" race we sometimes hit when init runs before ST core is
        // fully ready (see log line 14 in the 2026-05-25 trace). The first
        // call may be no-op'd by ST's readiness guard; the deferred calls
        // run at known-safe points after init has settled.
        saveSettingsDebounced();
        console.log(`[VectFox migrate] saveSettingsDebounced() call #1 (immediate)`);

        setTimeout(() => {
            saveSettingsDebounced();
            console.log(`[VectFox migrate] saveSettingsDebounced() call #2 (deferred 2s)`);
        }, 2000);

        // Verification step + aggressive recovery — at the 5s mark we
        // RE-CHECK and RE-MIGRATE if the fields have reappeared. This
        // handles the "ST reloaded settings.json over our changes during
        // init" scenario. We also try the non-debounced saveSettings()
        // here in case the debounce window is what's preventing the
        // actual write.
        setTimeout(async () => {
            const reCheckPresent = trackedKeys.filter(k =>
                extension_settings?.vectfox &&
                Object.prototype.hasOwnProperty.call(extension_settings.vectfox, k)
            );

            if (reCheckPresent.length === 0) {
                console.log(`[VectFox migrate] Post-save VERIFICATION (5s after migration) — extension_settings.vectfox is clean: zero legacy fields present. ✓`);
            } else {
                console.warn(`[VectFox migrate] ⚠️ Post-save VERIFICATION (5s after migration) — these legacy fields REAPPEARED on extension_settings.vectfox: [${reCheckPresent.join(', ')}]. ST likely reloaded settings.json over our in-memory deletions. RE-DELETING and forcing a non-debounced save now.`);

                const vfNow = extension_settings.vectfox;
                for (const k of reCheckPresent) {
                    const v = vfNow[k];
                    const desc = (typeof v === 'string')
                        ? (v.length === 0 ? 'empty string ""' : `string len=${v.length} (non-empty)`)
                        : `non-string (type=${typeof v})`;
                    console.warn(`[VectFox migrate]   ${k}: ${desc} — deleting again`);
                    delete vfNow[k];
                }

                // After re-delete, try the non-debounced save. If saveSettings
                // is async / returns a Promise, await it so we know whether
                // it actually completed. If sync, just call it.
                try {
                    const result = saveSettings();
                    if (result && typeof result.then === 'function') {
                        await result;
                        console.log(`[VectFox migrate] saveSettings() (non-debounced, await) completed`);
                    } else {
                        console.log(`[VectFox migrate] saveSettings() (non-debounced, sync) returned`);
                    }
                } catch (err) {
                    console.warn(`[VectFox migrate] saveSettings() (non-debounced) threw:`, err?.message || err);
                }

                // Also queue the debounced one as belt-and-suspenders.
                saveSettingsDebounced();
            }

            // Final state check after the recovery attempt above
            const finalCheck = trackedKeys.filter(k =>
                extension_settings?.vectfox &&
                Object.prototype.hasOwnProperty.call(extension_settings.vectfox, k)
            );
            console.log(`[VectFox migrate] FINAL state — legacy fields on extension_settings.vectfox after recovery: [${finalCheck.join(', ') || 'none'}]. If this says 'none' but settings.json STILL has them after another 5s, ST's save isn't writing extension_settings to disk — different problem.`);
        }, 5000);
    } else {
        console.log(`[VectFox migrate] mutated=false, no save needed (no fields were present or all already deleted)`);
    }

    console.log(`[VectFox migrate] DONE (sync portion) — ${moved.length} secret(s) written: [${moved.join(', ') || 'none'}]; ${deleted.length} field(s) deleted from extension_settings.vectfox: [${deleted.join(', ') || 'none'}]. Watch for VERIFICATION line in ~5s.`);

    return { migrated: moved.length, slots: moved };
}
