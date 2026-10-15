/**
 * Tests for callWithHedge in core/core-vector-api.js: the duplicate-request
 * race used for embedding inserts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    modules: [],
}));

vi.mock('../core/providers.js', () => ({
    getModelFromSettings: () => 'test-model',
    getEmbeddingRequestParams: () => ({ source: 'transformers', model: 'test-model' }),
}));

vi.mock('../core/reformat-store.js', () => ({
    invalidateAllVectorizedReformatCaches: vi.fn(),
}));

vi.mock('../backends/backend-manager.js', () => ({
    getBackend: vi.fn(async () => ({})),
    getBackendForCollection: vi.fn(async () => ({})),
    invalidateBackendHealth: vi.fn(),
    recordQuery: vi.fn(),
    recordInsert: vi.fn(),
    recordDelete: vi.fn(),
    recordError: vi.fn(),
}));

import { callWithHedge } from '../core/core-vector-api.js';

const ctx = { batchIdx: 1, totalBatches: 1, provider: 'openrouter' };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('callWithHedge', () => {
    it('reports a permanent error at once, unchanged, without firing hedges', async () => {
        const fn = vi.fn(async () => { throw new Error('HTTP 401: invalid API key'); });
        const result = callWithHedge(fn, 15000, 3, ctx).catch(e => e);
        await vi.advanceTimersByTimeAsync(0);
        const err = await result;
        expect(err.message).toBe('HTTP 401: invalid API key');
        expect(err.isHedgeFatal).toBeUndefined();
        await vi.advanceTimersByTimeAsync(60000);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('keeps racing after a transient error and resolves with a hedge that succeeds', async () => {
        let call = 0;
        const fn = vi.fn(async () => {
            call++;
            if (call === 1) throw new Error('HTTP 503 Service Unavailable');
            return 'ok';
        });
        const result = callWithHedge(fn, 15000, 3, ctx);
        await vi.advanceTimersByTimeAsync(15000);
        await expect(result).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('gives up with a HedgeFatalError when every attempt keeps failing transiently', async () => {
        const fn = vi.fn(async () => { throw new Error('network error'); });
        const result = callWithHedge(fn, 1000, 2, ctx).catch(e => e);
        await vi.advanceTimersByTimeAsync(3000);
        const err = await result;
        expect(err.isHedgeFatal).toBe(true);
        expect(err.message).toMatch(/last error: Error: network error/);
        expect(fn).toHaveBeenCalledTimes(3);
    });
});
