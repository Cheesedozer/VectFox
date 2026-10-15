/**
 * String Utilities Module for SillyTavern UI Extensions
 * Provides common text processing operations for chat interfaces
 * Pure JavaScript implementation - no external dependencies
 *
 * From: https://github.com/prolix-oc/ST-Helpers
 * @module stringUtils
 */

// Shared state for decodeHtmlEntities: lazily created decoder element and memoized results
let entityDecoderEl = null;
const entityDecodeCache = new Map();

// Node fallback map for named entities (browser path uses the DOM and covers everything)
const NAMED_ENTITIES = {
  nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', hellip: '…', deg: '°',
  times: '×', middot: '·', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', plusmn: '±',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  sbquo: '‚', bdquo: '„', dagger: '†', Dagger: '‡',
  bull: '•', prime: '′', Prime: '″', minus: '−',
  frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', micro: 'µ', sect: '§',
  para: '¶', eacute: 'é', egrave: 'è', agrave: 'à',
  ccedil: 'ç', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä',
};

const ENTITY_TOKEN = /&(?:#\d+|#x[0-9a-f]+|[a-zA-Z][a-zA-Z0-9]*);/gi;

/**
 * String Manipulation Utilities
 */
const StringUtils = {
  /**
   * Strip HTML tags from string
   *
   * @param {string} str - String containing HTML
   * @param {boolean} preserveSpaces - Replace tags with spaces (default: true)
   * @returns {string} String without HTML tags
   */
  stripHtml(str, preserveSpaces = true) {
    if (typeof str !== 'string') {
      return '';
    }

    const replacement = preserveSpaces ? ' ' : '';
    return str
      .replace(/<[^>]*>/g, replacement)
      .replace(/\s+/g, ' ')
      .trim();
  },

  /**
   * Strip Markdown formatting from string
   *
   * @param {string} str - String containing Markdown
   * @returns {string} String without Markdown formatting
   */
  stripMarkdown(str) {
    if (typeof str !== 'string') {
      return '';
    }

    return str
      // Remove headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove bold/italic
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      // Remove inline code
      .replace(/`([^`]+)`/g, '$1')
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, '')
      // Remove links
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove images
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      // Remove horizontal rules
      .replace(/^(-{3,}|_{3,}|\*{3,})$/gm, '')
      // Remove blockquotes
      .replace(/^>\s+/gm, '')
      .trim();
  },

  /**
   * Calculate Levenshtein distance between two strings
   * Useful for fuzzy matching and spell checking
   *
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @param {boolean} caseSensitive - Case sensitive comparison (default: false)
   * @returns {number} Edit distance
   */
  levenshtein(str1, str2, caseSensitive = false) {
    const s1 = caseSensitive ? str1 : str1.toLowerCase();
    const s2 = caseSensitive ? str2 : str2.toLowerCase();

    const len1 = s1.length;
    const len2 = s2.length;

    // Create 2D array
    const matrix = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));

    // Initialize first row and column
    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;

    // Fill matrix
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,      // Deletion
          matrix[i][j - 1] + 1,      // Insertion
          matrix[i - 1][j - 1] + cost // Substitution
        );
      }
    }

    return matrix[len1][len2];
  },

  /**
   * Calculate similarity ratio between two strings (0 to 1)
   * Based on Levenshtein distance
   *
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @param {boolean} caseSensitive - Case sensitive comparison (default: false)
   * @returns {number} Similarity ratio (0 = completely different, 1 = identical)
   */
  similarity(str1, str2, caseSensitive = false) {
    const maxLen = Math.max(str1.length, str2.length);
    if (maxLen === 0) return 1.0;

    const distance = this.levenshtein(str1, str2, caseSensitive);
    return 1 - (distance / maxLen);
  },

  /**
   * Escape HTML entities. Safe for both element-text and attribute-value
   * contexts (escapes all 5 standard entities plus `/` per OWASP).
   *
   * Coerces null/undefined/non-strings to '' first, so call sites don't need
   * defensive `value || ''` guards — passing `null` is well-defined.
   *
   * @param {*} str - String (or anything coercible) to escape
   * @returns {string} Escaped string, or '' for null/undefined
   */
  escapeHtml(str) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '/': '&#x2F;'
    };
    return String(str ?? '').replace(/[&<>"'/]/g, char => map[char]);
  },

  /**
   * Decode all HTML entities (named, decimal, hex) to their characters.
   * Only entity-shaped tokens are decoded — surrounding text is never
   * parsed as markup, so this is safe on untrusted input.
   *
   * @param {string} str - String containing HTML entities
   * @returns {string} Decoded string
   */
  decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string' || !str.includes('&')) {
      return str ?? '';
    }

    return str.replace(ENTITY_TOKEN, token => {
      const cached = entityDecodeCache.get(token);
      if (cached !== undefined) return cached;

      let decoded;
      if (typeof document !== 'undefined') {
        if (!entityDecoderEl) {
          entityDecoderEl = document.createElement('textarea');
        }
        entityDecoderEl.innerHTML = token;
        decoded = entityDecoderEl.value;
      } else {
        // Node (test) environment: numeric entities + common named entities
        const numeric = token.match(/^&#(x?)([0-9a-f]+);$/i);
        if (numeric) {
          const codePoint = parseInt(numeric[2], numeric[1] ? 16 : 10);
          try {
            decoded = String.fromCodePoint(codePoint);
          } catch {
            decoded = token;
          }
        } else {
          const name = token.slice(1, -1);
          decoded = NAMED_ENTITIES[name] ?? token;
        }
      }

      entityDecodeCache.set(token, decoded);
      return decoded;
    });
  },
};

// Export module
export default StringUtils;
