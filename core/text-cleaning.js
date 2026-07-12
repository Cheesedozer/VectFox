/**
 * ============================================================================
 * VectFox TEXT CLEANING
 * ============================================================================
 * Pre-vectorization text cleaning with regex patterns.
 * Strips HTML, metadata blocks, and custom tags before chunking.
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { uuidv4 } from '../../../../utils.js';
import { log } from './log.js';

// ============================================================================
// BUILT-IN PRESETS
// ============================================================================

/**
 * Built-in cleaning patterns that users can enable
 */
export const BUILTIN_PATTERNS = {
    strip_font_tags: {
        id: 'strip_font_tags',
        name: 'Strip Font Tags (keep text)',
        pattern: '<font[^>]*>(.*?)</font>',
        replacement: '$1',
        flags: 'gi',
        builtin: true,
    },
    strip_color_spans: {
        id: 'strip_color_spans',
        name: 'Strip Color Spans (keep text)',
        pattern: '<span[^>]*style="[^"]*color[^"]*"[^>]*>(.*?)</span>',
        replacement: '$1',
        flags: 'gi',
        builtin: true,
    },
    strip_bold_italic: {
        id: 'strip_bold_italic',
        name: 'Strip Bold/Italic Tags (keep text)',
        pattern: '</?(?:b|i|u|em|strong)>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_hidden_divs: {
        id: 'strip_hidden_divs',
        name: 'Strip Hidden Divs',
        pattern: '<div[^>]*style="[^"]*display:\\s*none[^"]*"[^>]*>[\\s\\S]*?</div>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_details_blocks: {
        id: 'strip_details_blocks',
        name: 'Strip Details/Summary Blocks',
        pattern: '<details>[\\s\\S]*?</details>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_thinking_tags: {
        id: 'strip_thinking_tags',
        name: 'Strip <thinking> Tags',
        pattern: '<thinking>[\\s\\S]*?</thinking>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_tucao_tags: {
        id: 'strip_tucao_tags',
        name: 'Strip <tucao> Tags',
        pattern: '<tucao>[\\s\\S]*?</tucao>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_all_html: {
        id: 'strip_all_html',
        name: 'Strip ALL HTML Tags (keep text)',
        pattern: '<[^>]+>',
        replacement: '',
        flags: 'g',
        builtin: true,
    },
    strip_mvu_update_variable: {
        id: 'strip_mvu_update_variable',
        name: 'Strip <UpdateVariable> Tags (MVU)',
        pattern: '<UpdateVariable>[\\s\\S]*?<\/UpdateVariable>',
        replacement: '',
        flags: 'gm',
        builtin: true,
    },
    strip_mvu_combat_calculation: {
        id: 'strip_mvu_combat_calculation',
        name: 'Strip <combat_calculation> Tags (MVU)',
        pattern: '<combat_calculation>[\\s\\S]*?<\/combat_calculation>',
        replacement: '',
        flags: 'gm',
        builtin: true,
    },
    strip_mvu_story_analysis: {
        id: 'strip_mvu_story_analysis',
        name: 'Strip <StoryAnalysis> Tags (MVU)',
        pattern: '<StoryAnalysis>[\\s\\S]*?<\/StoryAnalysis>',
        replacement: '',
        flags: 'gm',
        builtin: true,
    },
    strip_mvu_combat_log: {
        id: 'strip_mvu_combat_log',
        name: 'Strip <combat_log> Tags (MVU)',
        pattern: '<combat_log>[\\s\\S]*?<\/combat_log>',
        replacement: '',
        flags: 'gm',
        builtin: true,
    },
    // ── Fatbody D&D Framework markup ─────────────────────────────────────────
    // Strips the mechanical notation Fatbody emits into chat (rolls, footers,
    // RNG queues, state memos, statblocks) so only narrative prose is
    // vectorized / event-extracted. Pattern shapes mirror Fatbody's
    // sysprompt.txt ROLL FORMAT and the cleaning-presets/fatbody template.
    // NOT enabled by default (game-specific) — see getCleaningSettings().
    strip_fatbody_rng_queue: {
        id: 'strip_fatbody_rng_queue',
        name: 'Strip [RNG_QUEUE] Blocks (Fatbody)',
        pattern: '\\[RNG_QUEUE v[\\d.]+_?\\w*\\][\\s\\S]*?\\[\\/RNG_QUEUE\\]',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_fatbody_state_memo_header: {
        id: 'strip_fatbody_state_memo_header',
        name: 'Strip State Memo Header (Fatbody)',
        pattern: '^###\\s*STATE MEMO \\(DO NOT REPEAT\\)[^\\n]*$',
        replacement: '',
        flags: 'gim',
        builtin: true,
    },
    strip_fatbody_memo_blocks: {
        id: 'strip_fatbody_memo_blocks',
        name: 'Strip State Memo [TAG] Blocks (Fatbody)',
        pattern: '\\[(CHARACTER|PARTY|COMBAT|INVENTORY|ABILITIES|SPELLS|XP|TIME|QUESTS)\\][\\s\\S]*?\\[\\/\\1\\]',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_fatbody_rng_system_tag: {
        id: 'strip_fatbody_rng_system_tag',
        name: 'Strip <rng_system> Blocks (Fatbody)',
        pattern: '<rng_system>[\\s\\S]*?</rng_system>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_fatbody_status_footer: {
        id: 'strip_fatbody_status_footer',
        name: 'Strip Status/XP/Location Footer (Fatbody)',
        pattern: '\\*\\(Status:[^\\n]*\\)\\*',
        replacement: '',
        flags: 'g',
        builtin: true,
    },
    strip_fatbody_level_line: {
        id: 'strip_fatbody_level_line',
        name: 'Strip Level/Time Footer Line (Fatbody)',
        pattern: '\\*Level \\d[^\\n]*\\*',
        replacement: '',
        flags: 'g',
        builtin: true,
    },
    strip_fatbody_xp_awards: {
        id: 'strip_fatbody_xp_awards',
        name: 'Strip XP Award Lines (Fatbody)',
        pattern: '\\*\\(\\+[\\d,]+ ?XP[^\\n)]*\\)\\*',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_fatbody_roll_equals: {
        id: 'strip_fatbody_roll_equals',
        name: "Strip Roll-Result Parentheticals: contains '=' (Fatbody)",
        pattern: '\\*\\([^\\n*]*=[^\\n)]*\\)\\*',
        replacement: '',
        flags: 'g',
        builtin: true,
    },
    strip_fatbody_dc_checks: {
        id: 'strip_fatbody_dc_checks',
        name: 'Strip DC/Check Parentheticals (Fatbody)',
        pattern: '\\*\\([^\\n*]*\\bDC \\d[^\\n)]*\\)\\*',
        replacement: '',
        flags: 'g',
        builtin: true,
    },
    strip_fatbody_damage_arrow: {
        id: 'strip_fatbody_damage_arrow',
        name: 'Strip Damage Parentheticals: contains → (Fatbody)',
        pattern: '\\*\\([^\\n*]*\\u2192[^\\n)]*\\)\\*',
        replacement: '',
        flags: 'g',
        builtin: true,
    },
    strip_fatbody_quest_marker: {
        id: 'strip_fatbody_quest_marker',
        name: 'Strip [QUEST ACCEPTED] Marker (Fatbody)',
        pattern: '\\*\\[QUEST ACCEPTED\\]\\*',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_fatbody_levelup_banner: {
        id: 'strip_fatbody_levelup_banner',
        name: 'Strip Level-Up Banner Line (Fatbody)',
        pattern: '\\*\\u2b06?\\s*LEVEL UP[^\\n]*\\*',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_fatbody_party_sync: {
        id: 'strip_fatbody_party_sync',
        name: 'Strip Party Sync Header (Fatbody)',
        pattern: '\\*\\*[^\\n*]*PARTY SYNC[^\\n]*\\*\\*',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_fatbody_awaiting_choice: {
        id: 'strip_fatbody_awaiting_choice',
        name: "Strip 'Awaiting your choice' Line (Fatbody)",
        pattern: '\\*\\*[^\\n*]*Awaiting your choice[^\\n]*\\*\\*',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_fatbody_combat_headers: {
        id: 'strip_fatbody_combat_headers',
        name: 'Strip Combat/Round/Initiative Headers (Fatbody)',
        pattern: '^\\**(?:COMBAT\\b[^\\n]*|ROUND \\d[^\\n]*|Rolling initiative[^\\n]*)',
        replacement: '',
        flags: 'gim',
        builtin: true,
    },
    strip_fatbody_hp_bolds: {
        id: 'strip_fatbody_hp_bolds',
        name: 'Strip Combat HP Status Bolds (Fatbody)',
        pattern: '\\*\\*[^\\n*]*\\d+/\\d+ HP[^\\n]*\\*\\*',
        replacement: '',
        flags: 'g',
        builtin: true,
    },
    strip_fatbody_saves_line: {
        id: 'strip_fatbody_saves_line',
        name: 'Strip Statblock Saves Line (Fatbody)',
        pattern: '^[ \\t]*[-\\u2022*]?[ \\t]*Saves: Fort [^\\n]*',
        replacement: '',
        flags: 'gim',
        builtin: true,
    },
    strip_fatbody_attr_line: {
        id: 'strip_fatbody_attr_line',
        name: 'Strip Statblock Attr Line (Fatbody)',
        pattern: '^[ \\t]*[-\\u2022*]?[ \\t]*Attr: STR \\d[^\\n]*',
        replacement: '',
        flags: 'gim',
        builtin: true,
    },
    strip_fatbody_ac_hp_atk_line: {
        id: 'strip_fatbody_ac_hp_atk_line',
        name: 'Strip Statblock AC/HP/ATK Line (Fatbody)',
        pattern: '^[ \\t]*[-\\u2022*]?[ \\t]*AC \\d+[^\\n]*\\bHP\\b[^\\n]*',
        replacement: '',
        flags: 'gim',
        builtin: true,
    },
    // ── Wiki/booru HTML-export noise (see the 'Wiki Export Noise' preset) ──
    // Targets the junk that generic HTML scrapers leave in wiki page dumps
    // (booru sites especially): repeated site-news banners, post-score number
    // runs, truncation fragments, and search/layout navigation lines. The
    // built-in MediaWiki/e621 scrapers produce almost none of this — these
    // exist for content scraped through outside tools.
    strip_wiki_announcement_blocks: {
        id: 'strip_wiki_announcement_blocks',
        name: 'Strip Site Announcement Blocks (Wiki Export)',
        // "**10 June** Have you heard? … Get verified now!](…/staff#verification)"
        // — the news banner repeated on every exported page. Anchored on the
        // bold date + greeting, lazily bounded at the verification link that
        // closes the banner; an unterminated banner simply doesn't match.
        pattern: '\\*\\*\\d{1,2} \\w+\\*\\*\\s+(?:Have you heard|Hey there)[\\s\\S]{0,3000}?verification\\)',
        replacement: '',
        flags: 'g',
        builtin: true,
    },
    strip_wiki_promo_lines: {
        id: 'strip_wiki_promo_lines',
        name: 'Strip Changelog/Discord/Advertising Lines (Wiki Export)',
        // Backstop for banner fragments that survive the block pattern when a
        // page's banner is cut off mid-way.
        pattern: '^[^\\n]*(?:Read the full changelog|We still have a Discord server|Want to advertise on|Get verified now|changing the API response format|post deletion appeal system|crop any post on the site|Download our userscript)[^\\n]*$',
        replacement: '',
        flags: 'gim',
        builtin: true,
    },
    strip_wiki_score_runs: {
        id: 'strip_wiki_score_runs',
        name: 'Strip Post-Score Number Runs (Wiki Export)',
        // " 3 8 Q  4 3 E  1.3k 2.8k E …" — score/favcount/rating triplets from
        // post thumbnails. Requires 3+ consecutive triplets so a legitimate
        // lone "3 8 Q" inside prose survives.
        pattern: '(?:\\b\\d+(?:\\.\\d+)?k?[ \\t]+\\d+(?:\\.\\d+)?k?[ \\t]+[SQE]\\b[ \\t]*){3,}',
        replacement: '',
        flags: 'g',
        builtin: true,
    },
    strip_wiki_compact_score_runs: {
        id: 'strip_wiki_compact_score_runs',
        name: 'Strip Compact Score Runs (Wiki Export)',
        // "2529E  99192E  6151298E" — the same data with inner spaces collapsed.
        pattern: '(?:\\b\\d{2,}(?:\\.\\d+)?k?[SQE]\\b[ \\t]*){2,}',
        replacement: '',
        flags: 'g',
        builtin: true,
    },
    strip_wiki_posts_hidden: {
        id: 'strip_wiki_posts_hidden',
        name: "Strip 'N post(s) hidden' Notices (Wiki Export)",
        pattern: '\\d+\\s+post\\(s\\) on this page were hidden[^\\n]*',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_wiki_read_more: {
        id: 'strip_wiki_read_more',
        name: "Strip 'Read More' Truncation Fragments (Wiki Export)",
        // "\[... [Read More](https://…/wiki_pages/3515)" — truncated-article
        // markers, with or without the leading escaped-bracket ellipsis.
        pattern: '(?:\\\\?\\[\\.{3}\\s*)?\\[Read More\\]\\([^)]*\\)',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_wiki_nav_settings: {
        id: 'strip_wiki_nav_settings',
        name: 'Strip Search/Layout Navigation Lines (Wiki Export)',
        pattern: '(?:^(?:#{1,6}[ \\t]*)?(?:Advanced Options|Layout Settings|Rating Safe Questionable Explicit[^\\n]*|Card Size Small Medium Large[^\\n]*)$|Posts[ \\t]+\\[.{0,4}search help.{0,4}\\]\\([^)]*\\))',
        replacement: '',
        flags: 'gim',
        builtin: true,
    },
    strip_wiki_url_echo_lines: {
        id: 'strip_wiki_url_echo_lines',
        name: 'Strip Bare-URL Echo Lines (Wiki Export)',
        // "[*https://e621.net/posts?tags=…*](https://…)" — the italicized URL
        // echo scrapers emit directly under each page header.
        pattern: '^\\[\\*https?:[^\\n]*$',
        replacement: '',
        flags: 'gim',
        builtin: true,
    },
    strip_mvu_game_system_tags: {
        id: 'strip_mvu_game_system_tags',
        name: 'Strip Game-System Guide/Protocol Tags (MVU)',
        pattern: '<(COT_Guide|JSONPatch_Format|CURRENT_VARIABLE_DATA|Reply_Request|Schema_Syntax|Update_Analysis_Detail|Social_Check_System|encounter_guide|Story_Analysis_Detail|Economic_System|Stat_System|Initiative_System|Trait_Behavior|World_Advancement_Protocol|DC_Determine_Guide|World_Building_Logic|Cognitive_Isolation|Character_Mind_Simulation_Protocol|Conflict_System|Personality_Guide|Intimacy_System|CharacterGenerationProtocol|battle_system_text_rpg|character_attributes_system|combat_calculation_detail|core-points-guide|monster_guide|familiar_system|progression_system|equipment_guide|MoneySystem|Ranking_System|Skill_and_Spell_System|Journey|Healing_System|World Simulation Operations|World_Info|world_faction_distribution|Erotic_Guide|combat_log_detail|Political_Ecosystem|Darkness_mode|Location_Generation_Protocol|Weather_System|Anti_Dramatization|map_coordinate|world_map)\\b[^>]*>[\\s\\S]*?</\\1\\s*>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
};

/**
 * Preset groups for quick selection
 */
export const CLEANING_PRESETS = {
    none: {
        id: 'none',
        name: 'None',
        description: 'No cleaning applied',
        patterns: [],
    },
    html_formatting: {
        id: 'html_formatting',
        name: 'Strip HTML Formatting',
        description: 'Removes font, color, bold/italic tags but keeps the text',
        patterns: ['strip_font_tags', 'strip_color_spans', 'strip_bold_italic'],
    },
    metadata_blocks: {
        id: 'metadata_blocks',
        name: 'Strip Metadata Blocks',
        description: 'Removes hidden divs, details/summary sections',
        patterns: ['strip_hidden_divs', 'strip_details_blocks'],
    },
    ai_reasoning: {
        id: 'ai_reasoning',
        name: 'Strip AI Reasoning Tags',
        description: 'Removes thinking, tucao, and similar tags',
        patterns: ['strip_thinking_tags', 'strip_tucao_tags'],
    },
    comprehensive: {
        id: 'comprehensive',
        name: 'Comprehensive Clean',
        description: 'All formatting, metadata, and reasoning tags',
        patterns: ['strip_font_tags', 'strip_color_spans', 'strip_bold_italic', 'strip_hidden_divs', 'strip_details_blocks', 'strip_thinking_tags', 'strip_tucao_tags'],
    },
    nuclear: {
        id: 'nuclear',
        name: 'Strip All HTML',
        description: 'Removes ALL HTML tags - plain text only',
        patterns: ['strip_all_html'],
    },
    fatbody_dnd: {
        id: 'fatbody_dnd',
        name: 'Fatbody D&D Framework',
        description: 'Strips Fatbody D&D mechanical markup (dice-roll parentheticals, RNG queues, state memos, status footers, level-up blocks, statblock lines) plus standard HTML formatting and AI reasoning tags, so only narrative prose is vectorized',
        patterns: [
            'strip_font_tags',
            'strip_color_spans',
            'strip_bold_italic',
            'strip_hidden_divs',
            'strip_details_blocks',
            'strip_thinking_tags',
            'strip_tucao_tags',
            'strip_fatbody_rng_queue',
            'strip_fatbody_state_memo_header',
            'strip_fatbody_memo_blocks',
            'strip_fatbody_rng_system_tag',
            'strip_fatbody_status_footer',
            'strip_fatbody_level_line',
            'strip_fatbody_xp_awards',
            'strip_fatbody_roll_equals',
            'strip_fatbody_dc_checks',
            'strip_fatbody_damage_arrow',
            'strip_fatbody_quest_marker',
            'strip_fatbody_levelup_banner',
            'strip_fatbody_party_sync',
            'strip_fatbody_awaiting_choice',
            'strip_fatbody_combat_headers',
            'strip_fatbody_hp_bolds',
            'strip_fatbody_saves_line',
            'strip_fatbody_attr_line',
            'strip_fatbody_ac_hp_atk_line',
        ],
    },
    mvu_game_maker: {
        id: 'mvu_game_maker',
        name: 'MVU Game Maker',
        description: 'Strips MVU game engine tags (UpdateVariable, combat_calculation, StoryAnalysis, combat_log) plus standard HTML formatting and AI reasoning tags',
        patterns: [
            'strip_font_tags',
            'strip_color_spans',
            'strip_bold_italic',
            'strip_hidden_divs',
            'strip_details_blocks',
            'strip_thinking_tags',
            'strip_tucao_tags',
            'strip_mvu_update_variable',
            'strip_mvu_combat_calculation',
            'strip_mvu_story_analysis',
            'strip_mvu_combat_log',
            'strip_mvu_game_system_tags',
        ],
    },
    wiki_noise: {
        id: 'wiki_noise',
        name: 'Wiki Export Noise',
        description: 'Strips booru/wiki HTML-export noise — repeated site announcement banners, post-score number runs, "Read More" truncation fragments, "N post(s) hidden" notices, and search/layout/advertising lines — plus standard HTML formatting. For page dumps from outside scrapers; the built-in wiki scraper produces little of this',
        patterns: [
            'strip_font_tags',
            'strip_color_spans',
            'strip_bold_italic',
            'strip_wiki_announcement_blocks',
            'strip_wiki_promo_lines',
            'strip_wiki_score_runs',
            'strip_wiki_compact_score_runs',
            'strip_wiki_posts_hidden',
            'strip_wiki_read_more',
            'strip_wiki_nav_settings',
            'strip_wiki_url_echo_lines',
        ],
    },
};

// ============================================================================
// SETTINGS MANAGEMENT
// ============================================================================

/**
 * Gets the cleaning settings from extension_settings
 * @returns {object} Cleaning settings
 */
export function getCleaningSettings() {
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = {};
    }
    if (!extension_settings.vectfox.cleaning) {
        // Default: Custom preset with all MVU + standard patterns pre-checked
        // (equivalent to MVU Game Maker preset, but lets users toggle individual patterns).
        // Fatbody patterns are game-specific — opt in via the 'Fatbody D&D Framework'
        // preset or per-pattern toggles, never by default. Wiki-export patterns are
        // likewise opt-in via the 'Wiki Export Noise' preset: the score-run regexes
        // could plausibly eat stat tables in game chats.
        const defaultEnabled = Object.keys(BUILTIN_PATTERNS)
            .filter(id => id !== 'strip_all_html' && !id.startsWith('strip_fatbody_') && !id.startsWith('strip_wiki_'));
        extension_settings.vectfox.cleaning = {
            selectedPreset: 'custom',
            customPatterns: [],
            enabledBuiltins: defaultEnabled,
        };
    }
    return extension_settings.vectfox.cleaning;
}

/**
 * Saves cleaning settings
 * @param {object} settings - Settings to save
 */
export function saveCleaningSettings(settings) {
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = {};
    }
    extension_settings.vectfox.cleaning = settings;
}

/**
 * Gets all active patterns (builtin + custom)
 * @returns {Array<object>} Array of active pattern objects
 */
export function getActivePatterns() {
    const settings = getCleaningSettings();
    const patterns = [];

    // If using a preset, get its patterns
    if (settings.selectedPreset && settings.selectedPreset !== 'custom') {
        const preset = CLEANING_PRESETS[settings.selectedPreset];
        if (preset) {
            for (const patternId of preset.patterns) {
                if (BUILTIN_PATTERNS[patternId]) {
                    patterns.push(BUILTIN_PATTERNS[patternId]);
                }
            }
        }
    } else {
        // Custom mode - use enabled builtins + custom patterns
        for (const patternId of (settings.enabledBuiltins || [])) {
            if (BUILTIN_PATTERNS[patternId]) {
                patterns.push(BUILTIN_PATTERNS[patternId]);
            }
        }
        for (const custom of (settings.customPatterns || [])) {
            if (custom.enabled !== false) {
                patterns.push(custom);
            }
        }
    }

    return patterns;
}

// ============================================================================
// TEXT CLEANING
// ============================================================================

/**
 * Applies a single pattern to text
 * @param {string} text - Text to clean
 * @param {object} pattern - Pattern object with pattern, replacement, flags
 * @returns {string} Cleaned text
 */
function applyPattern(text, pattern) {
    try {
        const regex = new RegExp(pattern.pattern, pattern.flags || 'g');
        return text.replace(regex, pattern.replacement || '');
    } catch (e) {
        log.warn(`VectFox: Invalid regex pattern "${pattern.name || pattern.pattern}":`, e.message);
        return text;
    }
}

/**
 * Cleans text and returns null when nothing meaningful survives.
 *
 * Canonical entry point for content-preparation pipelines (lorebook,
 * character, document, URL, wiki, YouTube) — anywhere the pattern is
 * "clean a piece of content, then drop the unit entirely if nothing
 * is left." Bundles the clean + emptiness-check into one call so
 * callers can't accidentally skip the check.
 *
 * Returns null when:
 *   - input is falsy
 *   - input is not a string
 *   - cleaned result has zero non-whitespace characters
 *
 * Why a separate function vs. an `if (!cleanText(x).trim())` check at
 * each call site: the 2026-05-24 lorebook regression where a stripped
 * `<Intimacy_System>...</Intimacy_System>` block left an empty entry
 * whose `# <comment>` header + auto-appended `[KEYWORDS: ...]` still
 * built a "valid-looking" chunk. The fix needed an emptiness re-check
 * after cleanText — and every other content pipeline (character per-
 * field, document, URL, wiki, YouTube, wiki per-page) has the exact
 * same shape, the exact same bug, just with different surrounding
 * metadata. Centralizing the gate stops the pattern from drifting.
 *
 * DOES NOT replace `cleanText`. Use the original when you want the
 * cleaned string regardless of whether it's empty (e.g. per-message
 * cleaning fed to an LLM extractor like eventbase-extractor.js, where
 * an empty message just produces no events and isn't a chunk leak).
 *
 * @param {string} text - raw content
 * @returns {string|null} cleaned text, or null if empty/whitespace-only
 */
export function cleanContentOrNull(text) {
    if (typeof text !== 'string' || !text) return null;
    const cleaned = cleanText(text);
    return cleaned && cleaned.trim() ? cleaned : null;
}

/**
 * Cleans text using all active patterns
 * @param {string} text - Text to clean
 * @returns {string} Cleaned text
 */
export function cleanText(text) {
    if (!text || typeof text !== 'string') return text;

    const patterns = getActivePatterns();
    if (patterns.length === 0) return text;

    let result = text;
    for (const pattern of patterns) {
        result = applyPattern(result, pattern);
    }

    // Clean up extra whitespace left behind
    result = result.replace(/\n{3,}/g, '\n\n').trim();

    return result;
}

// cleanMessages removed 2026-05-24 — its only consumer was prepareChatContent
// in content-vectorization.js, which is itself gone. EventBase's per-message
// cleaning happens inline in eventbase-extractor.js via cleanText() directly.

// ============================================================================
// CUSTOM PATTERN MANAGEMENT
// ============================================================================

/**
 * Adds a custom cleaning pattern
 * @param {object} pattern - Pattern to add
 * @returns {string} The ID of the added pattern
 */
export function addCustomPattern(pattern) {
    const settings = getCleaningSettings();
    const id = pattern.id || uuidv4();

    const newPattern = {
        id,
        name: pattern.name || 'Custom Pattern',
        pattern: pattern.pattern,
        replacement: pattern.replacement || '',
        flags: pattern.flags || 'g',
        enabled: true,
        builtin: false,
    };

    settings.customPatterns = settings.customPatterns || [];
    settings.customPatterns.push(newPattern);
    saveCleaningSettings(settings);

    return id;
}

/**
 * Updates a custom pattern
 * @param {string} id - Pattern ID
 * @param {object} updates - Fields to update
 */
export function updateCustomPattern(id, updates) {
    const settings = getCleaningSettings();
    if (!settings.customPatterns || !Array.isArray(settings.customPatterns)) {
        return false;
    }

    const index = settings.customPatterns.findIndex(p => p.id === id);

    if (index !== -1 && index !== undefined) {
        settings.customPatterns[index] = {
            ...settings.customPatterns[index],
            ...updates,
        };
        saveCleaningSettings(settings);
        return true;
    }
    return false;
}

/**
 * Removes a custom pattern
 * @param {string} id - Pattern ID to remove
 */
export function removeCustomPattern(id) {
    const settings = getCleaningSettings();
    settings.customPatterns = (settings.customPatterns || []).filter(p => p.id !== id);
    saveCleaningSettings(settings);
}

/**
 * Toggles a builtin pattern
 * @param {string} id - Builtin pattern ID
 * @param {boolean} enabled - Whether to enable
 */
export function toggleBuiltinPattern(id, enabled) {
    const settings = getCleaningSettings();
    settings.enabledBuiltins = settings.enabledBuiltins || [];

    if (enabled && !settings.enabledBuiltins.includes(id)) {
        settings.enabledBuiltins.push(id);
    } else if (!enabled) {
        settings.enabledBuiltins = settings.enabledBuiltins.filter(x => x !== id);
    }

    saveCleaningSettings(settings);
}

// ============================================================================
// IMPORT/EXPORT
// ============================================================================

/**
 * Exports custom patterns as JSON
 * @returns {string} JSON string of custom patterns
 */
export function exportPatterns() {
    const settings = getCleaningSettings();
    return JSON.stringify(settings.customPatterns || [], null, 2);
}

/** Length cap on imported regex patterns. Legitimate patterns are well
 * under 200 chars; 300 leaves headroom without restricting normal use. */
const MAX_IMPORTED_PATTERN_LEN = 300;

/** Catastrophic-backtracking motifs commonly found in ReDoS payloads:
 *  - nested quantifier: (X+)+ or (X*)* — exponential on inputs that
 *    can be split multiple ways
 *  - quantified alternation with overlapping branches: (X|X)+ — same
 *    class of exponential ambiguity
 * These heuristics intentionally don't sweep up legitimate patterns
 * like `(foo)+` (single non-quantified group, then quantifier). */
const REDOS_MOTIF_RE = /\([^)]*[+*][^)]*\)\s*[+*]|\([^)]*\|[^)]*\)\s*[+*]/;

/**
 * Validate an imported pattern string for length + ReDoS shape before
 * it reaches `new RegExp(...)`. Returns { ok: true } if safe to import,
 * or { ok: false, reason: string } if it should be skipped.
 */
function _validateImportedPattern(pattern) {
    if (typeof pattern !== 'string') {
        return { ok: false, reason: 'pattern is not a string' };
    }
    if (pattern.length > MAX_IMPORTED_PATTERN_LEN) {
        return { ok: false, reason: `exceeds ${MAX_IMPORTED_PATTERN_LEN} char limit (got ${pattern.length})` };
    }
    if (REDOS_MOTIF_RE.test(pattern)) {
        return { ok: false, reason: 'matches a catastrophic-backtracking motif (nested quantifier or quantified alternation) — add manually if intended' };
    }
    return { ok: true };
}

/**
 * Imports patterns from JSON (supports both pattern arrays and full templates)
 * @param {string} json - JSON string of patterns or template
 * @returns {{success: boolean, count: number, isTemplate?: boolean, templateName?: string, error?: string, warnings?: string[]}}
 */
export function importPatterns(json) {
    try {
        const data = JSON.parse(json);
        const settings = getCleaningSettings();
        settings.customPatterns = settings.customPatterns || [];
        const warnings = [];

        // Check if this is a full template (has preset/enabledBuiltins/customPatterns)
        if (data.customPatterns && !Array.isArray(data)) {
            // Template format
            if (data.preset) {
                settings.selectedPreset = data.preset;
            }
            if (Array.isArray(data.enabledBuiltins)) {
                settings.enabledBuiltins = data.enabledBuiltins;
            }

            let count = 0;
            for (const pattern of (data.customPatterns || [])) {
                if (!pattern.pattern) continue;

                const validation = _validateImportedPattern(pattern.pattern);
                if (!validation.ok) {
                    warnings.push(`Pattern "${pattern.name || '(unnamed)'}" skipped: ${validation.reason}`);
                    continue;
                }

                const exists = settings.customPatterns.some(p => p.pattern === pattern.pattern);
                if (!exists) {
                    settings.customPatterns.push({
                        id: uuidv4(),
                        name: pattern.name || 'Imported Pattern',
                        pattern: pattern.pattern,
                        replacement: pattern.replacement || '',
                        flags: pattern.flags || 'g',
                        enabled: pattern.enabled !== false,
                        builtin: false,
                    });
                    count++;
                }
            }

            saveCleaningSettings(settings);
            return { success: true, count, warnings, isTemplate: true, templateName: data.name || 'Unnamed Template' };
        }

        // Array format (just patterns)
        if (!Array.isArray(data)) {
            return { success: false, count: 0, error: 'Invalid format - expected array or template object' };
        }

        let count = 0;
        for (const pattern of data) {
            if (!pattern.pattern) continue;

            const validation = _validateImportedPattern(pattern.pattern);
            if (!validation.ok) {
                warnings.push(`Pattern "${pattern.name || '(unnamed)'}" skipped: ${validation.reason}`);
                continue;
            }

            // Check for duplicates by pattern string
            const exists = settings.customPatterns.some(p => p.pattern === pattern.pattern);
            if (!exists) {
                settings.customPatterns.push({
                    id: uuidv4(),
                    name: pattern.name || 'Imported Pattern',
                    pattern: pattern.pattern,
                    replacement: pattern.replacement || '',
                    flags: pattern.flags || 'g',
                    enabled: true,
                    builtin: false,
                });
                count++;
            }
        }

        saveCleaningSettings(settings);
        return { success: true, count, warnings };

    } catch (e) {
        return { success: false, count: 0, error: e.message };
    }
}

/**
 * Tests a pattern against sample text
 * @param {string} pattern - Regex pattern
 * @param {string} flags - Regex flags
 * @param {string} replacement - Replacement string
 * @param {string} sampleText - Text to test against
 * @returns {{success: boolean, result?: string, error?: string}}
 */
export function testPattern(pattern, flags, replacement, sampleText) {
    try {
        const regex = new RegExp(pattern, flags || 'g');
        const result = sampleText.replace(regex, replacement || '');
        return { success: true, result };
    } catch (e) {
        return { success: false, error: e.message };
    }
}
