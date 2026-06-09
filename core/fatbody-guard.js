/**
 * ============================================================================
 * VECTFOX — FATBODY DnD FRAMEWORK GUARD
 * ============================================================================
 * Keeps VectFox's semantic lorebook activation away from lorebooks owned by the
 * Fatbody DnD Framework extension.
 *
 * Fatbody's "Lore Router" stores D&D stat / world-state tracking AS world-info
 * (lorebook) entries, in "campaign books" namespaced by a prefix derived from the
 * chat id, and it deliberately deactivates entries to manage its token budget. If
 * VectFox were to vectorize and semantically re-surface those entries, it would
 * fight Fatbody's controlled activation and corrupt stat tracking.
 *
 * This module mirrors Fatbody's own ownership rule so VectFox can recognise — and
 * leave alone — books that belong to Fatbody. It reads Fatbody's live campaign
 * prefix through the global Fatbody publishes (`globalThis._rpgGetCurrentPrefix`),
 * so there is NO hard dependency: when Fatbody is not installed the prefix resolves
 * to '' and every check below is a no-op.
 * ============================================================================
 */

/**
 * Read Fatbody's current campaign prefix from the global it publishes
 * (SillyTavern-FatbodyDnDFramework/index.js — `globalThis._rpgGetCurrentPrefix`).
 *
 * Re-read on every call (never cached): Fatbody's prefix is chat-dependent and
 * changes on chat switch, and the guard runs in the per-generation retrieval path.
 *
 * @returns {string} The live Fatbody prefix, or '' when Fatbody is absent/unset.
 */
export function getFatbodyPrefix() {
    try {
        const fn = globalThis._rpgGetCurrentPrefix;
        if (typeof fn !== 'function') return '';
        return fn() || '';
    } catch (_) {
        return '';
    }
}

/**
 * True if `bookName` belongs to the given Fatbody `prefix`.
 *
 * Copied verbatim (semantics) from Fatbody's own rule —
 * SillyTavern-FatbodyDnDFramework/router.js `bookBelongsToPrefix`:
 *   Exact match: bookName === prefix, OR bookName === prefix + '_' + <single-word suffix>
 *   (the suffix must contain no underscores, so a short prefix like "Assistant"
 *   does NOT match "Assistant_2026_05_13_NPCs" which belongs to a longer prefix).
 * Case-insensitive on both sides.
 *
 * @param {string} bookName
 * @param {string} prefix
 * @returns {boolean}
 */
export function bookBelongsToPrefix(bookName, prefix) {
    if (!prefix) return false;
    const lowerBook = String(bookName).toLowerCase();
    const lowerPref = String(prefix).toLowerCase();
    if (lowerBook === lowerPref) return true;
    const rest = lowerBook.startsWith(lowerPref + '_') ? lowerBook.slice(lowerPref.length + 1) : null;
    return rest !== null && !rest.includes('_');
}

/**
 * True if the named lorebook is owned by Fatbody's Lore Router for the active chat.
 * No-op (returns false) when Fatbody is absent or there is no live prefix.
 *
 * @param {string} bookName - The original SillyTavern lorebook (world) name.
 * @returns {boolean}
 */
export function isFatbodyOwnedBook(bookName) {
    return !!bookName && bookBelongsToPrefix(bookName, getFatbodyPrefix());
}
