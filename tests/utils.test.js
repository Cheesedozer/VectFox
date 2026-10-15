/**
 * Utility Functions Tests
 * Tests for async utilities and data structures
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AsyncUtils from '../utils/async-utils.js';
import { LRUCache } from '../utils/data-structures.js';

// =============================================================================
// ASYNC UTILS TESTS
// =============================================================================

describe('AsyncUtils', () => {
    describe('sleep', () => {
        it('should resolve after specified time', async () => {
            const start = Date.now();
            await AsyncUtils.sleep(50);
            const elapsed = Date.now() - start;
            expect(elapsed).toBeGreaterThanOrEqual(45); // Allow small variance
        });

        it('should return a promise', () => {
            const result = AsyncUtils.sleep(0);
            expect(result).toBeInstanceOf(Promise);
        });
    });

    describe('retry', () => {
        it('should return result on first success', async () => {
            const fn = vi.fn().mockResolvedValue('success');
            const result = await AsyncUtils.retry(fn);
            expect(result).toBe('success');
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should retry on failure', async () => {
            const fn = vi.fn()
                .mockRejectedValueOnce(new Error('fail'))
                .mockRejectedValueOnce(new Error('fail'))
                .mockResolvedValue('success');

            const result = await AsyncUtils.retry(fn, {
                maxAttempts: 3,
                delay: 10
            });

            expect(result).toBe('success');
            expect(fn).toHaveBeenCalledTimes(3);
        });

        it('should throw after max attempts', async () => {
            const fn = vi.fn().mockRejectedValue(new Error('always fails'));

            await expect(AsyncUtils.retry(fn, {
                maxAttempts: 2,
                delay: 10
            })).rejects.toThrow('always fails');

            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should call onRetry callback', async () => {
            const onRetry = vi.fn();
            const fn = vi.fn()
                .mockRejectedValueOnce(new Error('fail'))
                .mockResolvedValue('success');

            await AsyncUtils.retry(fn, {
                maxAttempts: 3,
                delay: 10,
                onRetry
            });

            expect(onRetry).toHaveBeenCalledTimes(1);
            expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
        });

        it('should respect shouldRetry callback', async () => {
            const fn = vi.fn().mockRejectedValue(new Error('no retry'));
            const shouldRetry = vi.fn().mockReturnValue(false);

            await expect(AsyncUtils.retry(fn, {
                maxAttempts: 3,
                delay: 10,
                shouldRetry
            })).rejects.toThrow('no retry');

            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should apply exponential backoff', async () => {
            const fn = vi.fn()
                .mockRejectedValueOnce(new Error('fail'))
                .mockResolvedValue('success');

            const start = Date.now();
            await AsyncUtils.retry(fn, {
                maxAttempts: 2,
                delay: 50,
                backoffFactor: 2
            });
            const elapsed = Date.now() - start;

            // First retry should wait 50ms
            expect(elapsed).toBeGreaterThanOrEqual(40);
        });
    });

    describe('timeout', () => {
        it('should resolve if promise completes in time', async () => {
            const promise = Promise.resolve('done');
            const result = await AsyncUtils.timeout(promise, 100);
            expect(result).toBe('done');
        });

        it('should reject if promise exceeds timeout', async () => {
            const promise = AsyncUtils.sleep(200).then(() => 'done');

            await expect(AsyncUtils.timeout(promise, 50))
                .rejects.toThrow('Operation timed out');
        });

        it('should use custom error message', async () => {
            const promise = AsyncUtils.sleep(200);

            await expect(AsyncUtils.timeout(promise, 50, 'Custom timeout'))
                .rejects.toThrow('Custom timeout');
        });
    });

    describe('parallel', () => {
        it('should execute functions concurrently', async () => {
            const fns = [
                async () => 1,
                async () => 2,
                async () => 3
            ];

            const results = await AsyncUtils.parallel(fns);
            expect(results).toEqual([1, 2, 3]);
        });

        it('should respect concurrency limit', async () => {
            let concurrent = 0;
            let maxConcurrent = 0;

            const fns = Array(10).fill(null).map(() => async () => {
                concurrent++;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                await AsyncUtils.sleep(20);
                concurrent--;
                return 1;
            });

            await AsyncUtils.parallel(fns, 3);

            expect(maxConcurrent).toBeLessThanOrEqual(3);
        });
    });

    describe('batch', () => {
        it('should process items in batches', async () => {
            const items = [1, 2, 3, 4, 5];
            const processor = vi.fn().mockImplementation(batch => batch.map(x => x * 2));

            const results = await AsyncUtils.batch(items, processor, {
                batchSize: 2
            });

            expect(results).toEqual([2, 4, 6, 8, 10]);
            expect(processor).toHaveBeenCalledTimes(3); // 2 + 2 + 1
        });

        it('should call onProgress callback', async () => {
            const items = [1, 2, 3, 4];
            const onProgress = vi.fn();
            const processor = batch => batch.map(x => x * 2);

            await AsyncUtils.batch(items, processor, {
                batchSize: 2,
                onProgress
            });

            expect(onProgress).toHaveBeenCalledWith(2, 4);
            expect(onProgress).toHaveBeenCalledWith(4, 4);
        });
    });

});

// =============================================================================
// LRU CACHE TESTS
// =============================================================================

describe('LRUCache', () => {
    let cache;

    beforeEach(() => {
        cache = new LRUCache(3);
    });

    describe('basic operations', () => {
        it('should set and get values', () => {
            cache.set('a', 1);
            expect(cache.get('a')).toBe(1);
        });

        it('should return undefined for missing keys', () => {
            expect(cache.get('missing')).toBeUndefined();
        });

        it('should check if key exists', () => {
            cache.set('a', 1);
            expect(cache.has('a')).toBe(true);
            expect(cache.has('b')).toBe(false);
        });

        it('should delete keys', () => {
            cache.set('a', 1);
            expect(cache.delete('a')).toBe(true);
            expect(cache.has('a')).toBe(false);
        });

        it('should clear all items', () => {
            cache.set('a', 1);
            cache.set('b', 2);
            cache.clear();
            expect(cache.size).toBe(0);
        });
    });

    describe('LRU eviction', () => {
        it('should evict least recently used item when at capacity', () => {
            cache.set('a', 1);
            cache.set('b', 2);
            cache.set('c', 3);
            cache.set('d', 4); // Should evict 'a'

            expect(cache.has('a')).toBe(false);
            expect(cache.has('b')).toBe(true);
            expect(cache.has('c')).toBe(true);
            expect(cache.has('d')).toBe(true);
        });

        it('should update LRU order on get', () => {
            cache.set('a', 1);
            cache.set('b', 2);
            cache.set('c', 3);
            cache.get('a'); // Access 'a', making it most recent
            cache.set('d', 4); // Should evict 'b' (not 'a')

            expect(cache.has('a')).toBe(true);
            expect(cache.has('b')).toBe(false);
        });

        it('should update LRU order on set of existing key', () => {
            cache.set('a', 1);
            cache.set('b', 2);
            cache.set('c', 3);
            cache.set('a', 10); // Update 'a', making it most recent
            cache.set('d', 4); // Should evict 'b'

            expect(cache.has('a')).toBe(true);
            expect(cache.get('a')).toBe(10);
            expect(cache.has('b')).toBe(false);
        });
    });

    describe('utility methods', () => {
        it('should return correct size', () => {
            expect(cache.size).toBe(0);
            cache.set('a', 1);
            expect(cache.size).toBe(1);
            cache.set('b', 2);
            expect(cache.size).toBe(2);
        });

        it('should return all keys', () => {
            cache.set('a', 1);
            cache.set('b', 2);
            expect(cache.keys()).toContain('a');
            expect(cache.keys()).toContain('b');
        });

        it('should return all values', () => {
            cache.set('a', 1);
            cache.set('b', 2);
            expect(cache.values()).toContain(1);
            expect(cache.values()).toContain(2);
        });
    });
});

// =============================================================================
// QUEUE TESTS
// =============================================================================

describe('StringUtils.decodeHtmlEntities', () => {
    let StringUtils;

    beforeEach(async () => {
        ({ default: StringUtils } = await import('../utils/string-utils.js'));
    });

    it('decodes named entities', () => {
        expect(StringUtils.decodeHtmlEntities('Tom &amp; Jerry&nbsp;&mdash;&hellip;')).toBe('Tom & Jerry\u00a0—…');
    });

    it('decodes decimal and hex numeric entities', () => {
        expect(StringUtils.decodeHtmlEntities('&#39;quoted&#x27; &#8212;')).toBe("'quoted' —");
    });

    it('only decodes entity tokens, never surrounding text', () => {
        expect(StringUtils.decodeHtmlEntities('a &lt;b&gt; c')).toBe('a <b> c');
        // The decoded angle brackets are plain text output, not parsed markup
        expect(StringUtils.decodeHtmlEntities('&lt;script&gt;')).toBe('<script>');
    });

    it('passes unknown entities and stray ampersands through unchanged', () => {
        expect(StringUtils.decodeHtmlEntities('&notarealentity12345; & &&')).toBe('&notarealentity12345; & &&');
    });

    it('handles empty and non-string input', () => {
        expect(StringUtils.decodeHtmlEntities('')).toBe('');
        expect(StringUtils.decodeHtmlEntities(null)).toBe('');
        expect(StringUtils.decodeHtmlEntities('no entities')).toBe('no entities');
    });

    it('decodes double-encoded entities one level per call', () => {
        const once = StringUtils.decodeHtmlEntities('&amp;#39;');
        expect(once).toBe('&#39;');
        expect(StringUtils.decodeHtmlEntities(once)).toBe("'");
    });
});
