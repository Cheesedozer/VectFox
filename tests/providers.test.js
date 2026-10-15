/**
 * Unit tests for core/providers.js: the shared embedding request-params
 * builder used by both backends and the diagnostics, and the load-time
 * migration that removes settings of deleted providers.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../extensions.js', () => ({ extension_settings: {} }));

vi.mock('../../../../secrets.js', () => ({
    SECRET_KEYS: { OPENROUTER: 'api_key_openrouter' },
}));

const ST_SERVER_URLS = {
    ollama: 'http://st-ollama:11434',
    vllm: 'http://st-vllm:8000/v1/embeddings',
};

vi.mock('../../../../textgen-settings.js', () => ({
    textgen_types: { OLLAMA: 'ollama', VLLM: 'vllm' },
    textgenerationwebui_settings: {
        server_urls: {
            ollama: 'http://st-ollama:11434',
            vllm: 'http://st-vllm:8000/v1/embeddings',
        },
    },
}));

import {
    EMBEDDING_PROVIDERS,
    DEFAULT_EMBEDDING_PROVIDER,
    getEmbeddingRequestParams,
    migrateRemovedProviderSettings,
} from '../core/providers.js';

describe('EMBEDDING_PROVIDERS', () => {
    it('lists exactly the four live providers', () => {
        expect(Object.keys(EMBEDDING_PROVIDERS).sort()).toEqual(['ollama', 'openrouter', 'transformers', 'vllm']);
        expect(DEFAULT_EMBEDDING_PROVIDER).toBe('transformers');
    });
});

describe('getEmbeddingRequestParams', () => {
    it('defaults to transformers with no model and no extra fields', () => {
        expect(getEmbeddingRequestParams({}, ST_SERVER_URLS)).toEqual({ source: 'transformers', model: '' });
    });

    it('sends only source and model for OpenRouter', () => {
        const params = getEmbeddingRequestParams({
            source: 'openrouter',
            openrouter_model: 'google/gemini-embedding-001',
        }, ST_SERVER_URLS);
        expect(params).toEqual({ source: 'openrouter', model: 'google/gemini-embedding-001' });
    });

    it('uses ST\'s Ollama URL and the keep flag when no alternative endpoint is set', () => {
        const params = getEmbeddingRequestParams({
            source: 'ollama',
            ollama_model: 'mxbai-embed-large',
            ollama_keep: true,
        }, ST_SERVER_URLS);
        expect(params).toEqual({
            source: 'ollama',
            model: 'mxbai-embed-large',
            apiUrl: 'http://st-ollama:11434',
            keep: true,
        });
    });

    it('uses the Ollama alternative endpoint from the per-provider keys the UI writes', () => {
        const params = getEmbeddingRequestParams({
            source: 'ollama',
            ollama_use_alt_endpoint: true,
            ollama_alt_endpoint_url: 'http://gpu-box:11434',
        }, ST_SERVER_URLS);
        expect(params.apiUrl).toBe('http://gpu-box:11434');
        expect(params.keep).toBe(false);
    });

    it('ignores the legacy shared use_alt_endpoint / alt_endpoint_url keys', () => {
        const params = getEmbeddingRequestParams({
            source: 'ollama',
            use_alt_endpoint: true,
            alt_endpoint_url: 'http://legacy:1',
        }, ST_SERVER_URLS);
        expect(params.apiUrl).toBe('http://st-ollama:11434');
    });

    it('normalises the vLLM URL from ST\'s settings (strips /v1/embeddings)', () => {
        const params = getEmbeddingRequestParams({ source: 'vllm', vllm_model: 'bge-m3' }, ST_SERVER_URLS);
        expect(params).toEqual({ source: 'vllm', model: 'bge-m3', apiUrl: 'http://st-vllm:8000' });
    });

    it.each([
        ['http://box:8000/', 'http://box:8000'],
        ['http://box:8000/v1/embeddings', 'http://box:8000'],
        ['http://box:8000/embeddings', 'http://box:8000'],
        ['http://box:8000/v1', 'http://box:8000/v1'],
    ])('normalises the vLLM alternative endpoint %s -> %s', (input, expected) => {
        const params = getEmbeddingRequestParams({
            source: 'vllm',
            vllm_use_alt_endpoint: true,
            vllm_alt_endpoint_url: input,
        }, ST_SERVER_URLS);
        expect(params.apiUrl).toBe(expected);
    });

    it('leaves apiUrl undefined when the alternative endpoint is enabled but empty', () => {
        const params = getEmbeddingRequestParams({ source: 'vllm', vllm_use_alt_endpoint: true }, ST_SERVER_URLS);
        expect(params.apiUrl).toBeUndefined();
    });

    it('reads ST\'s live server URLs when none are passed', () => {
        expect(getEmbeddingRequestParams({ source: 'ollama' }).apiUrl).toBe('http://st-ollama:11434');
    });
});

describe('migrateRemovedProviderSettings', () => {
    it('resets a removed provider to the default and logs a warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const store = { source: 'koboldcpp' };
        const result = migrateRemovedProviderSettings(store);
        expect(store.source).toBe('transformers');
        expect(result).toMatchObject({ changed: true, resetSource: 'koboldcpp' });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("'koboldcpp' no longer exists"));
        warn.mockRestore();
    });

    it('leaves a live provider and clean settings untouched', () => {
        const store = { source: 'openrouter', openrouter_model: 'm' };
        const result = migrateRemovedProviderSettings(store);
        expect(store).toEqual({ source: 'openrouter', openrouter_model: 'm' });
        expect(result).toEqual({ changed: false, resetSource: null, removedKeys: [] });
    });

    it('does not invent a source when none is saved', () => {
        const store = {};
        expect(migrateRemovedProviderSettings(store).changed).toBe(false);
        expect(store).toEqual({});
    });

    it('deletes settings that only removed providers read', () => {
        const store = {
            source: 'transformers',
            webllm_model: '',
            google_model: 'text-embedding-005',
            bananabread_rerank: false,
            openai_model: 'x',
        };
        const result = migrateRemovedProviderSettings(store);
        expect(store).toEqual({ source: 'transformers' });
        expect(result.changed).toBe(true);
        expect(result.removedKeys.sort()).toEqual(['bananabread_rerank', 'google_model', 'openai_model', 'webllm_model']);
    });

    it('moves the legacy shared alternative endpoint onto the active provider\'s keys', () => {
        const store = { source: 'ollama', use_alt_endpoint: true, alt_endpoint_url: 'http://gpu-box:11434' };
        migrateRemovedProviderSettings(store);
        expect(store).toEqual({
            source: 'ollama',
            ollama_use_alt_endpoint: true,
            ollama_alt_endpoint_url: 'http://gpu-box:11434',
        });
    });

    it('never overwrites a per-provider endpoint the user already set', () => {
        const store = {
            source: 'vllm',
            vllm_alt_endpoint_url: 'http://mine:8000',
            use_alt_endpoint: true,
            alt_endpoint_url: 'http://legacy:8000',
        };
        migrateRemovedProviderSettings(store);
        expect(store).toEqual({ source: 'vllm', vllm_alt_endpoint_url: 'http://mine:8000' });
    });

    it('is idempotent', () => {
        const store = { source: 'webllm', webllm_model: 'x' };
        migrateRemovedProviderSettings(store);
        const snapshot = { ...store };
        expect(migrateRemovedProviderSettings(store).changed).toBe(false);
        expect(store).toEqual(snapshot);
    });
});
