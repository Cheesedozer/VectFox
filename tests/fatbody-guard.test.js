/**
 * Unit tests for fatbody-guard.js
 * Verifies VectFox recognises (and excludes) lorebooks owned by the Fatbody DnD
 * Framework, and is a no-op when Fatbody is not installed.
 *
 * The ownership rule must stay in lock-step with Fatbody's own
 * `bookBelongsToPrefix` (SillyTavern-FatbodyDnDFramework/router.js).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getFatbodyPrefix, bookBelongsToPrefix, isFatbodyOwnedBook } from '../core/fatbody-guard.js';

afterEach(() => {
    delete globalThis._rpgGetCurrentPrefix;
});

describe('fatbody-guard: no-op when Fatbody absent', () => {
    it('getFatbodyPrefix returns "" when the global is missing', () => {
        expect(getFatbodyPrefix()).toBe('');
    });

    it('isFatbodyOwnedBook is false for any book when Fatbody absent', () => {
        expect(isFatbodyOwnedBook('Aqua_2026_NPCs')).toBe(false);
        expect(isFatbodyOwnedBook('MyWorldbuilding')).toBe(false);
    });

    it('survives a throwing global', () => {
        globalThis._rpgGetCurrentPrefix = () => { throw new Error('boom'); };
        expect(getFatbodyPrefix()).toBe('');
        expect(isFatbodyOwnedBook('Aqua_2026_NPCs')).toBe(false);
    });
});

describe('bookBelongsToPrefix: mirrors Fatbody router.js semantics', () => {
    it('exact match', () => {
        expect(bookBelongsToPrefix('Aqua_2026', 'Aqua_2026')).toBe(true);
    });
    it('case-insensitive', () => {
        expect(bookBelongsToPrefix('aqua_2026', 'Aqua_2026')).toBe(true);
    });
    it('single-word suffix belongs', () => {
        expect(bookBelongsToPrefix('Aqua_2026_NPCs', 'Aqua_2026')).toBe(true);
    });
    it('multi-underscore suffix does NOT belong (different/longer prefix)', () => {
        expect(bookBelongsToPrefix('Aqua_2026_05_13', 'Aqua_2026')).toBe(false);
    });
    it('concatenation without separator does NOT belong', () => {
        // Fatbody's own World_Chronicle book is `${prefix}World_Chronicle` and is
        // likewise NOT prefix-scoped by Fatbody's rule — kept faithful here.
        expect(bookBelongsToPrefix('Aqua_2026World_Chronicle', 'Aqua_2026')).toBe(false);
    });
    it('unrelated book does NOT belong', () => {
        expect(bookBelongsToPrefix('MyWorldbuilding', 'Aqua_2026')).toBe(false);
    });
    it('empty prefix never matches', () => {
        expect(bookBelongsToPrefix('Aqua_2026', '')).toBe(false);
    });
});

describe('isFatbodyOwnedBook: with a live Fatbody prefix', () => {
    it('excludes prefix-scoped campaign/stat books', () => {
        globalThis._rpgGetCurrentPrefix = () => 'Aqua_2026';
        expect(isFatbodyOwnedBook('Aqua_2026')).toBe(true);
        expect(isFatbodyOwnedBook('Aqua_2026_NPCs')).toBe(true);
        expect(isFatbodyOwnedBook('MyWorldbuilding')).toBe(false);
        expect(isFatbodyOwnedBook('')).toBe(false);
    });

    it('re-reads the prefix on every call (chat switch changes ownership)', () => {
        globalThis._rpgGetCurrentPrefix = () => 'ChatA';
        expect(isFatbodyOwnedBook('ChatA_NPCs')).toBe(true);
        expect(isFatbodyOwnedBook('ChatB_NPCs')).toBe(false);
        globalThis._rpgGetCurrentPrefix = () => 'ChatB';
        expect(isFatbodyOwnedBook('ChatA_NPCs')).toBe(false);
        expect(isFatbodyOwnedBook('ChatB_NPCs')).toBe(true);
    });
});
