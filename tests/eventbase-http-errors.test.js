import { describe, expect, it } from 'vitest';

import { getEventBaseModelConfigErrorMessage } from '../core/eventbase-http-errors.js';

describe('getEventBaseModelConfigErrorMessage', () => {
    it('classifies OpenRouter deprecated model 404 responses as fatal model config errors', () => {
        const message = getEventBaseModelConfigErrorMessage({
            provider: 'OpenRouter',
            model: 'x-ai/grok-4.1-fast',
            status: 404,
            responseText: 'Grok 4.1 Fast is deprecated. Please switch to Grok 4.3.',
        });

        expect(message).toContain('OpenRouter');
        expect(message).toContain('x-ai/grok-4.1-fast');
        expect(message).toContain('HTTP 404');
        expect(message).toContain('Grok 4.1 Fast is deprecated');
    });

    it('classifies vLLM missing model 400 responses as fatal model config errors', () => {
        const message = getEventBaseModelConfigErrorMessage({
            provider: 'vLLM',
            model: 'missing-model',
            status: 400,
            responseText: 'No endpoints found for model missing-model.',
        });

        expect(message).toContain('vLLM');
        expect(message).toContain('missing-model');
        expect(message).toContain('HTTP 400');
        expect(message).toContain('No endpoints found');
    });

    it('leaves non-model provider failures as per-window extraction failures', () => {
        expect(getEventBaseModelConfigErrorMessage({
            provider: 'OpenRouter',
            model: 'anthropic/claude-haiku-4-5',
            status: 500,
            responseText: 'upstream overloaded',
        })).toBeNull();

        expect(getEventBaseModelConfigErrorMessage({
            provider: 'OpenRouter',
            model: 'anthropic/claude-haiku-4-5',
            status: 429,
            responseText: 'rate limited for this model',
        })).toBeNull();
    });
});
