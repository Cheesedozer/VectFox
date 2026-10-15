/**
 * Async Utilities Module for SillyTavern UI Extensions
 * Provides modern async/await helpers for API calls and async operations
 * Pure JavaScript implementation - no external dependencies
 *
 * From: https://github.com/prolix-oc/ST-Helpers
 * @module asyncUtils
 */

/**
 * Async Utilities
 */
const AsyncUtils = {
  /**
   * Sleep/delay for specified milliseconds
   *
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>} Promise that resolves after delay
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  /**
   * Retry async function with exponential backoff
   *
   * @param {Function} fn - Async function to retry
   * @param {Object} options - Retry options
   * @param {number} options.maxAttempts - Maximum retry attempts (default: 3)
   * @param {number} options.delay - Initial delay in ms (default: 1000)
   * @param {number} options.maxDelay - Maximum delay in ms (default: 30000)
   * @param {number} options.backoffFactor - Backoff multiplier (default: 2)
   * @param {Function} options.onRetry - Callback on retry (receives attempt number and error)
   * @param {Function} options.shouldRetry - Function to determine if should retry (receives error)
   * @returns {Promise<*>} Result of successful function call
   */
  async retry(fn, options = {}) {
    const {
      maxAttempts = 3,
      delay = 1000,
      maxDelay = 30000,
      backoffFactor = 2,
      onRetry = null,
      shouldRetry = () => true
    } = options;

    let lastError;
    let currentDelay = delay;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (attempt === maxAttempts || !shouldRetry(error)) {
          throw error;
        }

        if (onRetry) {
          onRetry(attempt, error);
        }

        await this.sleep(currentDelay);
        currentDelay = Math.min(currentDelay * backoffFactor, maxDelay);
      }
    }

    throw lastError;
  },

  /**
   * Add timeout to promise
   *
   * @param {Promise} promise - Promise to add timeout to
   * @param {number} ms - Timeout in milliseconds
   * @param {string} message - Error message (default: 'Operation timed out')
   * @returns {Promise<*>} Promise that rejects on timeout
   */
  timeout(promise, ms, message = 'Operation timed out') {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(message)), ms)
      )
    ]);
  },


  /**
   * Execute async functions in parallel with concurrency limit
   *
   * @param {Array<Function>} fns - Array of async functions
   * @param {number} concurrency - Maximum concurrent executions (default: 5)
   * @returns {Promise<Array>} Array of results
   */
  async parallel(fns, concurrency = 5) {
    const results = [];
    const executing = [];

    for (let i = 0; i < fns.length; i++) {
      const fn = fns[i];
      const promise = Promise.resolve().then(() => fn());
      results[i] = promise;

      if (concurrency <= fns.length) {
        const e = promise.then(() =>
          executing.splice(executing.indexOf(e), 1)
        );
        executing.push(e);

        if (executing.length >= concurrency) {
          await Promise.race(executing);
        }
      }
    }

    return Promise.all(results);
  },

  /**
   * Batch processor - process items in batches
   *
   * @param {Array} items - Items to process
   * @param {Function} processor - Async function to process each batch
   * @param {Object} options - Batch options
   * @param {number} options.batchSize - Items per batch (default: 10)
   * @param {number} options.delay - Delay between batches in ms (default: 0)
   * @param {Function} options.onProgress - Progress callback (receives processed count)
   * @returns {Promise<Array>} Array of results
   */
  async batch(items, processor, options = {}) {
    const {
      batchSize = 10,
      delay = 0,
      onProgress = null
    } = options;

    const results = [];
    let processed = 0;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await processor(batch);
      results.push(...batchResults);

      processed += batch.length;
      if (onProgress) {
        onProgress(processed, items.length);
      }

      if (delay > 0 && i + batchSize < items.length) {
        await this.sleep(delay);
      }
    }

    return results;
  },
};

export default AsyncUtils;
