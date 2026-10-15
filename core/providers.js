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

/**
 * Provider used when settings name none, or name one that no longer exists.
 */
export const DEFAULT_EMBEDDING_PROVIDER = 'transformers';

/**
 * All supported embedding providers
 * This is the canonical list - update here and it applies everywhere
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
    // webllm: { name: 'WebLLM Extension', local: true, requiresModel: true, modelField: 'webllm_model', requiresApiKey: false, requiresUrl: false },

    // Local server providers (need URL)
    // bananabread: { name: 'BananaBread', local: true, requiresModel: false, requiresApiKey: true, secretKey: 'bananabread_api_key', requiresUrl: true, defaultUrl: 'http://localhost:8008' },
    ollama: {
        name: 'Ollama',
        local: true,
        requiresModel: true,
        modelField: 'ollama_model',
        requiresApiKey: false,
        requiresUrl: true,
    },
    // llamacpp: { name: 'llama.cpp', local: true, requiresModel: false, requiresApiKey: false, requiresUrl: true },
    // koboldcpp: { name: 'KoboldCpp', local: true, requiresModel: false, requiresApiKey: false, requiresUrl: true },
    vllm: {
        name: 'vLLM',
        local: true,
        requiresModel: true,
        modelField: 'vllm_model',
        requiresApiKey: false,
        requiresUrl: true,
    },

    // Cloud providers (need API key)
    // openai: { name: 'OpenAI', local: false, requiresModel: true, modelField: 'openai_model', requiresApiKey: true, secretKey: SECRET_KEYS.OPENAI, requiresUrl: false },
    // cohere: { name: 'Cohere', local: false, requiresModel: true, modelField: 'cohere_model', requiresApiKey: true, secretKey: SECRET_KEYS.COHERE, requiresUrl: false },
    // togetherai: { name: 'TogetherAI', local: false, requiresModel: true, modelField: 'togetherai_model', requiresApiKey: true, secretKey: SECRET_KEYS.TOGETHERAI, requiresUrl: false },
    openrouter: {
        name: 'OpenRouter',
        local: false,
        requiresModel: true,
        modelField: 'openrouter_model',
        requiresApiKey: true,
        secretKey: SECRET_KEYS.OPENROUTER,
        requiresUrl: false,
    },
    // mistral: { name: 'MistralAI', local: false, requiresModel: true, modelField: 'mistral_model', requiresApiKey: true, secretKey: SECRET_KEYS.MISTRALAI, requiresUrl: false },
    // nomicai: { name: 'NomicAI', local: false, requiresModel: false, requiresApiKey: true, secretKey: SECRET_KEYS.NOMICAI, requiresUrl: false },
    // palm: { name: 'Google AI Studio', local: false, requiresModel: true, modelField: 'google_model', requiresApiKey: true, secretKey: SECRET_KEYS.MAKERSUITE, requiresUrl: false },
    // vertexai: { name: 'Google Vertex AI', local: false, requiresModel: true, modelField: 'google_model', requiresApiKey: true, secretKey: SECRET_KEYS.VERTEXAI, requiresUrl: false },
    // electronhub: { name: 'Electron Hub', local: false, requiresModel: true, modelField: 'electronhub_model', requiresApiKey: true, secretKey: SECRET_KEYS.ELECTRONHUB, requiresUrl: false },
    // extras: { name: 'Extras (deprecated)', local: false, requiresModel: false, requiresApiKey: false, requiresUrl: true, deprecated: true },
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
