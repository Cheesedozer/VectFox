/**
 * ============================================================================
 * VectFox EMBEDDING PROVIDERS
 * ============================================================================
 * Single source of truth for embedding providers and their configurations.
 * Import this anywhere you need provider information.
 *
 * @author VectFox
 * @version 2.0.0
 * ============================================================================
 */

import { SECRET_KEYS } from '../../../../secrets.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';
import { log } from './log.js';

/**
 * Provider used when settings name none, or name one that no longer exists.
 */
export const DEFAULT_EMBEDDING_PROVIDER = 'transformers';

/**
 * All supported embedding providers
 * This is the canonical list - update here and it applies everywhere.
 * Every other provider that VectFox once supported (webllm, koboldcpp,
 * llamacpp, bananabread, extras, openai, cohere, togetherai, mistral,
 * nomicai, palm, vertexai, electronhub) has been removed for good; saved
 * settings that still name one are reset by migrateRemovedProviderSettings().
 */
export const EMBEDDING_PROVIDERS = {
    // Local providers (no API key needed)
    transformers: {
        name: 'Local (Transformers)',
        local: true,
        requiresModel: false,
        requiresApiKey: false,
        requiresUrl: false,
    },

    // Local server providers (need URL)
    ollama: {
        name: 'Ollama',
        local: true,
        requiresModel: true,
        modelField: 'ollama_model',
        requiresApiKey: false,
        requiresUrl: true,
    },
    vllm: {
        name: 'vLLM',
        local: true,
        requiresModel: true,
        modelField: 'vllm_model',
        requiresApiKey: false,
        requiresUrl: true,
    },

    // Cloud providers (need API key)
    openrouter: {
        name: 'OpenRouter',
        local: false,
        requiresModel: true,
        modelField: 'openrouter_model',
        requiresApiKey: true,
        secretKey: SECRET_KEYS.OPENROUTER,
        requiresUrl: false,
    },
};

/**
 * Get list of all valid provider IDs
 */
export function getValidProviderIds() {
    return Object.keys(EMBEDDING_PROVIDERS);
}

/**
 * Check if a provider ID is valid
 */
export function isValidProvider(providerId) {
    return providerId in EMBEDDING_PROVIDERS;
}

/**
 * Get provider config by ID
 */
export function getProviderConfig(providerId) {
    return EMBEDDING_PROVIDERS[providerId] || null;
}

/**
 * Get the model field name for a provider
 */
export function getModelField(providerId) {
    return EMBEDDING_PROVIDERS[providerId]?.modelField || null;
}

/**
 * Resolve the actual model value from settings for the active provider.
 *
 * The settings object uses provider-specific field names — `openrouter_model`,
 * `ollama_model`, `vllm_model`, etc. — not a flat `settings.model`. Code that
 * sends a `model` field to the plugin API (chunks/insert, chunks/list,
 * chunks/query) MUST use this function. Reading `settings.model` directly
 * returns an empty string for every real provider and leads to insert/query
 * model-bucket mismatches (chunks land under model='' while queries look up
 * the real name → 0-result silent failures).
 *
 * The query path in backends/standard.js + backends/qdrant.js already routes
 * through this — keep insert/list/import paths in sync by calling it here.
 *
 * @param {object} settings - VectFox settings
 * @param {string} [fallback=''] - Returned when the provider has no model field
 *   or the value is empty/unset.
 * @returns {string}
 */
export function getModelFromSettings(settings, fallback = '') {
    const modelField = getModelField(settings?.source);
    if (!modelField) return fallback;
    return settings[modelField] || fallback;
}

/**
 * Strip a trailing slash and an OpenAI-style `/v1/embeddings` or `/embeddings`
 * suffix, so a vLLM URL pasted in either form reaches the server as its base.
 * @param {string|undefined} url
 * @returns {string|undefined}
 */
function normalizeVllmUrl(url) {
    return url
        ?.replace(/\/$/, '')
        .replace(/\/v1\/embeddings$/, '')
        .replace(/\/embeddings$/, '');
}

/**
 * Build the embedding-provider fields that every vector request sends to ST's
 * /api/vector/* endpoints or the Similharity plugin's /chunks/* endpoints.
 *
 * This is the one place that maps VectFox settings to those fields. Spread the
 * result into the request body: `{ collectionId, ...getEmbeddingRequestParams(settings) }`.
 *
 * - `source`: the active provider, defaulting to transformers.
 * - `model`: the provider's model field (see getModelFromSettings).
 * - Ollama: `apiUrl` (the per-provider alternative endpoint when
 *   `ollama_use_alt_endpoint` is on, otherwise ST's Text Completion Ollama URL)
 *   and `keep`. No API key: ST has no Ollama auth path.
 * - vLLM: `apiUrl` (the alternative endpoint when `vllm_use_alt_endpoint` is on,
 *   otherwise ST's Text Completion vLLM URL), normalised by normalizeVllmUrl.
 *   No API key: ST's vLLM embedding handler reads SECRET_KEYS.VLLM server-side,
 *   so anything sent here would be ignored.
 * - transformers / openrouter: nothing extra. OpenRouter's key is read
 *   server-side from SECRET_KEYS.OPENROUTER.
 *
 * @param {object} settings - VectFox settings
 * @param {object} [serverUrls] - ST's Text Completion server URLs, keyed by
 *   textgen type. Defaults to ST's live settings; tests pass their own.
 * @returns {{source: string, model: string, apiUrl?: string, keep?: boolean}}
 */
export function getEmbeddingRequestParams(settings, serverUrls = textgenerationwebui_settings?.server_urls ?? {}) {
    const source = settings?.source || DEFAULT_EMBEDDING_PROVIDER;
    const params = { source, model: getModelFromSettings(settings) };

    switch (source) {
        case 'ollama':
            params.apiUrl = settings.ollama_use_alt_endpoint
                ? settings.ollama_alt_endpoint_url
                : serverUrls[textgen_types.OLLAMA];
            params.keep = !!settings.ollama_keep;
            break;
        case 'vllm':
            params.apiUrl = normalizeVllmUrl(settings.vllm_use_alt_endpoint
                ? settings.vllm_alt_endpoint_url
                : serverUrls[textgen_types.VLLM]);
            break;
        default:
            break;
    }

    return params;
}

/**
 * Settings keys that only removed providers read. Nothing reads them any more,
 * so the load-time migration deletes them from saved settings.
 */
const REMOVED_PROVIDER_SETTING_KEYS = [
    'openai_model',
    'cohere_model',
    'togetherai_model',
    'electronhub_model',
    'google_model',
    'webllm_model',
    'koboldcpp_model',
    'bananabread_model',
    'bananabread_rerank',
];

/**
 * One-time, idempotent clean-up of saved settings after the removal of every
 * embedding provider except the ones in EMBEDDING_PROVIDERS. Mutates `store`
 * (normally `extension_settings.vectfox`) in place:
 *
 * 1. If `store.source` names a provider that no longer exists, reset it to
 *    DEFAULT_EMBEDDING_PROVIDER, so no code path sees a removed provider.
 * 2. Move the legacy shared `use_alt_endpoint` / `alt_endpoint_url` pair onto
 *    the active provider's own keys (`ollama_*` or `vllm_*`) when those are not
 *    already set, then delete the legacy pair. The Standard backend used to
 *    read the legacy pair, so this keeps such a user's endpoint.
 * 3. Delete settings keys that only removed providers read.
 *
 * @param {object} store - Saved VectFox settings
 * @returns {{changed: boolean, resetSource: string|null, removedKeys: string[]}}
 *   `resetSource` is the invalid provider that was replaced, if any.
 */
export function migrateRemovedProviderSettings(store) {
    const result = { changed: false, resetSource: null, removedKeys: [] };
    if (!store || typeof store !== 'object') return result;

    if (store.source !== undefined && !isValidProvider(store.source)) {
        result.resetSource = String(store.source);
        store.source = DEFAULT_EMBEDDING_PROVIDER;
        result.changed = true;
        log.warn(`[VectFox migrate] Embedding provider '${result.resetSource}' no longer exists; reset to '${DEFAULT_EMBEDDING_PROVIDER}'. Pick a provider in VectFox settings if this is not what you want.`);
    }

    if (store.use_alt_endpoint && store.alt_endpoint_url && (store.source === 'ollama' || store.source === 'vllm')) {
        const flagKey = `${store.source}_use_alt_endpoint`;
        const urlKey = `${store.source}_alt_endpoint_url`;
        if (!store[flagKey] && !store[urlKey]) {
            store[flagKey] = true;
            store[urlKey] = store.alt_endpoint_url;
            result.changed = true;
            log.lifecycle(`[VectFox migrate] Moved legacy alternative endpoint to ${urlKey}`);
        }
    }

    for (const key of ['use_alt_endpoint', 'alt_endpoint_url', ...REMOVED_PROVIDER_SETTING_KEYS]) {
        if (Object.prototype.hasOwnProperty.call(store, key)) {
            delete store[key];
            result.removedKeys.push(key);
        }
    }
    if (result.removedKeys.length > 0) {
        result.changed = true;
        log.lifecycle(`[VectFox migrate] Removed settings of deleted providers: ${result.removedKeys.join(', ')}`);
    }

    return result;
}

/**
 * Get the secret key constant for a provider
 */
export function getSecretKey(providerId) {
    return EMBEDDING_PROVIDERS[providerId]?.secretKey || null;
}

/**
 * Check if provider requires an API key
 */
export function requiresApiKey(providerId) {
    return EMBEDDING_PROVIDERS[providerId]?.requiresApiKey || false;
}

/**
 * Check if provider requires a custom URL
 */
export function requiresUrl(providerId) {
    return EMBEDDING_PROVIDERS[providerId]?.requiresUrl || false;
}

/**
 * Get providers that require API keys
 */
export function getCloudProviders() {
    return Object.entries(EMBEDDING_PROVIDERS)
        .filter(([_, config]) => config.requiresApiKey)
        .map(([id]) => id);
}

/**
 * Get providers that require custom URLs
 */
export function getUrlProviders() {
    return Object.entries(EMBEDDING_PROVIDERS)
        .filter(([_, config]) => config.requiresUrl)
        .map(([id]) => id);
}
