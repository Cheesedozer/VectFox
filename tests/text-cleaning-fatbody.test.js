/**
 * Unit tests for the Fatbody D&D builtin cleaning pattern group.
 * Verifies the strip_fatbody_* builtins remove every mechanical notation shape
 * from Fatbody's sysprompt.txt ROLL FORMAT / footer / level-up protocol while
 * narrative prose survives, and that the group is never enabled by default.
 */

import { describe, it, expect, beforeEach } from 'vitest';

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
    BUILTIN_PATTERNS,
    CLEANING_PRESETS,
    getCleaningSettings,
    cleanText,
    cleanContentOrNull,
} from '../core/text-cleaning.js';

const FATBODY_IDS = Object.keys(BUILTIN_PATTERNS).filter(id => id.startsWith('strip_fatbody_'));

/** Activate exactly the Fatbody preset for a test. */
function useFatbodyPreset() {
    extension_settings.vectfox.cleaning = {
        selectedPreset: 'fatbody_dnd',
        customPatterns: [],
        enabledBuiltins: [],
    };
}

beforeEach(() => {
    extension_settings.vectfox = {};
});

describe('fatbody pattern group: registration', () => {
    it('ships all expected strip_fatbody_* builtins', () => {
        expect(FATBODY_IDS.length).toBeGreaterThanOrEqual(15);
        for (const id of FATBODY_IDS) {
            const p = BUILTIN_PATTERNS[id];
            expect(p.builtin).toBe(true);
            expect(p.pattern.length).toBeLessThanOrEqual(300);
            // every pattern must compile
            expect(() => new RegExp(p.pattern, p.flags || 'g')).not.toThrow();
        }
    });

    it('fatbody_dnd preset exists and includes the whole group', () => {
        const preset = CLEANING_PRESETS.fatbody_dnd;
        expect(preset).toBeDefined();
        for (const id of FATBODY_IDS) {
            expect(preset.patterns).toContain(id);
        }
    });

    it('Fatbody patterns are NOT in the default enabled set', () => {
        const settings = getCleaningSettings(); // builds defaults
        for (const id of FATBODY_IDS) {
            expect(settings.enabledBuiltins).not.toContain(id);
        }
        // sanity: standard patterns still default-enabled
        expect(settings.enabledBuiltins).toContain('strip_font_tags');
        expect(settings.enabledBuiltins).not.toContain('strip_all_html');
    });
});

describe('fatbody pattern group: cleaning behavior', () => {
    it('strips every ROLL FORMAT notation while keeping prose', () => {
        useFatbodyPreset();
        const message = [
            'Elara nocks an arrow and looses it at the goblin. *(Attack: 12 + 5 = 17 vs AC 15)*',
            'The shaft sinks deep. *(Damage: d8 + 3 → 7 slashing)*',
            'You try to lift the merchant\'s coin pouch. *(Sleight of Hand: DC 15)* then *(Roll: 20 + 5 = 25)*',
            'The pouch slides free without a whisper. *(+25 XP — flawless lift)*',
            '*[QUEST ACCEPTED]*',
            '*(Status: 34/40 HP) | (XP: 1,250/2,700) | (Location: Khelt, Market Row)*',
            '*Level 3 | 11:52 AM, Day 4*',
        ].join('\n');

        const out = cleanText(message);

        expect(out).toContain('Elara nocks an arrow');
        expect(out).toContain('The shaft sinks deep.');
        expect(out).toContain('The pouch slides free without a whisper.');
        expect(out).not.toMatch(/Attack:|Damage:|DC 15|Roll: 20|XP|QUEST ACCEPTED|Status:|Level 3/);
    });

    it('strips RNG queue blocks and state memo injections', () => {
        useFatbodyPreset();
        const message = [
            '[RNG_QUEUE v6.0_PROPER]',
            'turn_id=1717171717',
            'scope=this_response',
            'queue=[7(d4:2,d6:5,d8:1,d10:9,d12:11)]',
            '[/RNG_QUEUE]',
            '',
            '### STATE MEMO (DO NOT REPEAT)',
            '[CHARACTER]',
            'Aqua (Cleric): 30/40 HP',
            'Attr: STR 12, DEX 10, CON 14, INT 8, WIS 16, CHA 15',
            '[/CHARACTER]',
            '',
            'I sneak toward the warehouse door.',
        ].join('\n');

        const out = cleanText(message);

        expect(out).toBe('I sneak toward the warehouse door.');
    });

    it('strips level-up protocol blocks and statblock lines', () => {
        useFatbodyPreset();
        const message = [
            '*⬆ LEVEL UP — Now Level 4.*',
            '**Aqua gains:**',
            '**→ Awaiting your choice before the story continues.**',
            '**👥 PARTY SYNC:**',
            'Kazuma steps through the gate, blade drawn.',
            '- Saves: Fort +3 | Ref +5 | Will +2',
            '- Attr: STR 12, DEX 16, CON 14, INT 10, WIS 14, CHA 12',
            'Goblin Chief: AC 15 | 38/38 HP | ATK +6',
            'COMBAT ROUND 2',
            '**Goblin: 4/12 HP**',
        ].join('\n');

        const out = cleanText(message);

        expect(out).toContain('Kazuma steps through the gate');
        expect(out).not.toMatch(/LEVEL UP|Awaiting your choice|PARTY SYNC|Saves: Fort|Attr: STR|COMBAT ROUND|4\/12 HP/);
    });

    it('cleanContentOrNull returns null for a pure-mechanics message', () => {
        useFatbodyPreset();
        const mechanicsOnly = [
            '*(Attack: 9 + 4 = 13 vs AC 14)*',
            '*(Damage: d6 + 2 → 5 piercing)*',
            '*(Status: 12/40 HP) | (XP: 300/900) | (Location: Sewers)*',
            '*Level 2 | 03:10 PM, Day 2*',
        ].join('\n');

        expect(cleanContentOrNull(mechanicsOnly)).toBeNull();
    });

    it('leaves ordinary asterisk-emphasis prose alone', () => {
        useFatbodyPreset();
        const prose = 'She whispers *quietly* and points at the tower. *The wind howls.*';
        expect(cleanText(prose)).toBe(prose);
    });
});
