/**
 * Unit tests for the two caches added to core/text-cleaning.js for
 * performance: the compiled-RegExp cache in applyPattern (content-addressed
 * by "pattern + flags", used via cleanText) and the memoized getActivePatterns()
 * result (invalidated via saveCleaningSettings AND via an identity check
 * against extension_settings.vectfox.cleaning, since some mutators fetch the
 * settings object, mutate an array on it in place, then save the SAME
 * reference — and some callers, incl. sibling test files, replace
 * extension_settings.vectfox.cleaning wholesale without calling
 * saveCleaningSettings at all).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ chat: [] })),
}));
vi.mock('../../../../utils.js', () => ({
    uuidv4: vi.fn(() => 'test-uuid'),
}));
vi.mock('../core/log.js', () => ({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { extension_settings } from '../../../../extensions.js';
import {
    getActivePatterns,
    saveCleaningSettings,
    addCustomPattern,
    toggleBuiltinPattern,
    cleanText,
} from '../core/text-cleaning.js';

beforeEach(() => {
    extension_settings.vectfox = {};
});

function customOnlySettings(customPatterns) {
    return { selectedPreset: 'custom', enabledBuiltins: [], customPatterns };
}

describe('getActivePatterns caching', () => {
    it('returns the same array reference across calls when settings are unchanged', () => {
        saveCleaningSettings(customOnlySettings([
            { id: 'p1', name: 'P1', pattern: 'foo', replacement: '', flags: 'g', enabled: true, builtin: false },
        ]));

        const first = getActivePatterns();
        const second = getActivePatterns();
        expect(second).toBe(first); // cache hit, not just deep-equal
    });

    it('addCustomPattern (mutate-in-place + saveCleaningSettings) invalidates the cache', () => {
        saveCleaningSettings(customOnlySettings([]));
        const before = getActivePatterns();
        expect(before).toHaveLength(0);

        addCustomPattern({ name: 'New', pattern: 'bar', replacement: '', flags: 'g' });

        const after = getActivePatterns();
        expect(after).not.toBe(before);
        expect(after).toHaveLength(1);
        expect(after[0].pattern).toBe('bar');
    });

    it('toggleBuiltinPattern invalidates the cache', () => {
        saveCleaningSettings({ selectedPreset: 'custom', enabledBuiltins: [], customPatterns: [] });
        expect(getActivePatterns().some(p => p.id === 'strip_font_tags')).toBe(false);

        toggleBuiltinPattern('strip_font_tags', true);

        expect(getActivePatterns().some(p => p.id === 'strip_font_tags')).toBe(true);
    });

    it('a wholesale replacement of extension_settings.vectfox.cleaning is picked up even without saveCleaningSettings', () => {
        saveCleaningSettings(customOnlySettings([
            { id: 'p1', name: 'P1', pattern: 'foo', replacement: '', flags: 'g', enabled: true, builtin: false },
        ]));
        expect(getActivePatterns()).toHaveLength(1);

        // Direct mutation bypassing the public saveCleaningSettings API —
        // the pattern several sibling test files (text-cleaning-fatbody.test.js,
        // text-cleaning-wiki.test.js) use for setup.
        extension_settings.vectfox.cleaning = customOnlySettings([]);

        expect(getActivePatterns()).toHaveLength(0);
    });

    it('cleanText reflects a settings change made between two calls (no stale-cache regression)', () => {
        saveCleaningSettings(customOnlySettings([
            { id: 'p1', name: 'StripFoo', pattern: 'foo', replacement: 'X', flags: 'g', enabled: true, builtin: false },
        ]));
        expect(cleanText('foo bar')).toBe('X bar');

        saveCleaningSettings(customOnlySettings([
            { id: 'p2', name: 'StripBar', pattern: 'bar', replacement: 'Y', flags: 'g', enabled: true, builtin: false },
        ]));
        expect(cleanText('foo bar')).toBe('foo Y'); // must NOT still apply the old foo->X pattern
    });
});

describe('applyPattern compiled-regex cache (via cleanText)', () => {
    it('reuses a global-flag pattern correctly across many calls (no lastIndex leakage)', () => {
        saveCleaningSettings(customOnlySettings([
            { id: 'p1', name: 'StripAll', pattern: 'x', replacement: '', flags: 'g', enabled: true, builtin: false },
        ]));

        // If a cached global RegExp's lastIndex ever leaked across calls,
        // repeated invocations against the same input would eventually stop
        // matching from the start and under-replace.
        for (let i = 0; i < 5; i++) {
            expect(cleanText('x-x-x-x')).toBe('---');
        }
    });

    it('an invalid pattern logs once conceptually but never throws, and cached failure does not corrupt a differently-keyed pattern', () => {
        saveCleaningSettings(customOnlySettings([
            { id: 'bad', name: 'Bad', pattern: '(unterminated', replacement: '', flags: 'g', enabled: true, builtin: false },
            { id: 'good', name: 'Good', pattern: 'foo', replacement: 'X', flags: 'g', enabled: true, builtin: false },
        ]));

        expect(() => cleanText('foo (unterminated')).not.toThrow();
        const result1 = cleanText('foo text');
        const result2 = cleanText('foo text'); // second call must re-hit the cached error entry, not throw
        expect(result1).toBe('X text');
        expect(result2).toBe('X text');
    });

    it('two patterns with the same regex source but different flags are cached independently', () => {
        saveCleaningSettings(customOnlySettings([
            { id: 'ci', name: 'CaseInsensitive', pattern: 'foo', replacement: 'X', flags: 'gi', enabled: true, builtin: false },
        ]));
        expect(cleanText('FOO foo')).toBe('X X');

        saveCleaningSettings(customOnlySettings([
            { id: 'cs', name: 'CaseSensitive', pattern: 'foo', replacement: 'X', flags: 'g', enabled: true, builtin: false },
        ]));
        expect(cleanText('FOO foo')).toBe('FOO X'); // case-sensitive variant must not reuse the case-insensitive compiled regex
    });
});
