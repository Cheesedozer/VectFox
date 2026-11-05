/**
 * Regression: ChunkBase character locks drifted to another character.
 *
 * Locks used to be keyed by getContext().characterId, which in SillyTavern is
 * the character's index in the `characters` array. Adding, deleting or
 * re-sorting characters shifts indices, so a lock silently moved to whichever
 * character took over that index. Locks are now keyed by avatar filename.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSettings = vi.hoisted(() => ({ vectfox: {} }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: mockSettings }));
vi.mock('../../../../../script.js', () => ({ saveSettingsDebounced: vi.fn() }));

import {
    getCharacterLockKey,
    getCharacterLockDisplayName,
    setCollectionCharacterLock,
    isCollectionActiveForContext,
    getCollectionCharacterLocks,
    migrateLegacyCharacterLocks,
    _resetCharacterLockMigrationForTests,
} from '../core/collection-metadata.js';

const alice = { avatar: 'Alice.png', name: 'Alice', data: { name: 'Alice' } };
const bob = { avatar: 'Bob.png', name: 'Bob', data: { name: 'Bob' } };
const carol = { avatar: 'Carol.png', name: 'Carol', data: { name: 'Carol' } };

beforeEach(() => {
    mockSettings.vectfox = { collections: {} };
    _resetCharacterLockMigrationForTests();
});

describe('getCharacterLockKey', () => {
    it('returns the avatar of the active character, not its index', () => {
        expect(getCharacterLockKey({ characterId: '1', characters: [alice, bob] })).toBe('Bob.png');
    });

    it('treats index 0 as a real character', () => {
        expect(getCharacterLockKey({ characterId: 0, characters: [alice] })).toBe('Alice.png');
    });

    it('returns null with no active character (e.g. group chat)', () => {
        expect(getCharacterLockKey({ characterId: undefined, characters: [alice] })).toBeNull();
        expect(getCharacterLockKey({ characterId: '5', characters: [alice] })).toBeNull();
        expect(getCharacterLockKey(null)).toBeNull();
    });
});

describe('character lock survives character list changes', () => {
    it('stays on the locked character when a new character shifts indices', () => {
        const coll = 'standard:vf_doc_x';
        mockSettings.vectfox.collections[coll] = { scope: 'character' };

        // Lock while Bob is at index 1.
        setCollectionCharacterLock(coll, getCharacterLockKey({ characterId: '1', characters: [alice, bob] }));

        // Carol is added and sorts before Bob: Carol is now index 1, Bob index 2.
        const characters = [alice, carol, bob];
        expect(isCollectionActiveForContext(coll, { characterId: getCharacterLockKey({ characterId: '1', characters }) })).toBe(false);
        expect(isCollectionActiveForContext(coll, { characterId: getCharacterLockKey({ characterId: '2', characters }) })).toBe(true);
    });
});

describe('migrateLegacyCharacterLocks', () => {
    it('converts index-keyed locks to avatar keys and keeps avatar keys', () => {
        mockSettings.vectfox.collections.a = { lockedToCharacterIds: ['1', 'Alice.png'] };
        mockSettings.vectfox.collections.b = { lockedToCharacterIds: ['0'] };
        const converted = migrateLegacyCharacterLocks([alice, bob]);
        expect(converted).toBe(2);
        expect(getCollectionCharacterLocks('a')).toEqual(['Bob.png', 'Alice.png']);
        expect(getCollectionCharacterLocks('b')).toEqual(['Alice.png']);
    });

    it('drops indices that point at no character and de-duplicates', () => {
        mockSettings.vectfox.collections.a = { lockedToCharacterIds: ['9', '0', 'Alice.png'] };
        migrateLegacyCharacterLocks([alice]);
        expect(getCollectionCharacterLocks('a')).toEqual(['Alice.png']);
    });

    it('waits for characters to load and then runs only once', () => {
        mockSettings.vectfox.collections.a = { lockedToCharacterIds: ['0'] };
        expect(migrateLegacyCharacterLocks([])).toBe(0);
        expect(getCollectionCharacterLocks('a')).toEqual(['0']);
        expect(migrateLegacyCharacterLocks([alice])).toBe(1);
        mockSettings.vectfox.collections.b = { lockedToCharacterIds: ['0'] };
        expect(migrateLegacyCharacterLocks([alice])).toBe(0);
    });
});

describe('getCharacterLockDisplayName', () => {
    it('resolves names by avatar and flags unknown keys', () => {
        expect(getCharacterLockDisplayName('Bob.png', [alice, bob])).toBe('Bob');
        expect(getCharacterLockDisplayName('Gone.png', [alice])).toBe('Unknown character (Gone.png)');
    });
});
