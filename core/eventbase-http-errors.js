const MODEL_CONFIG_STATUSES = new Set([400, 404]);
const MODEL_CONFIG_ERROR_RE = /\b(model|deprecated|no endpoints?|not found|not_found|unknown model|invalid model)\b/i;

function _upstreamSnippet(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
}

/**
 * Returns a fatal configuration message for provider/model HTTP failures that
 * should abort EventBase ingestion instead of being treated as per-window skips.
 *
 * @param {{ provider: string, model: string, status: number, responseText: string }} failure
 * @returns {string|null}
 */
export function getEventBaseModelConfigErrorMessage({ provider, model, status, responseText }) {
    const snippet = _upstreamSnippet(responseText);
    if (!MODEL_CONFIG_STATUSES.has(status) || !MODEL_CONFIG_ERROR_RE.test(snippet)) {
        return null;
    }

    return `EventBase: ${provider} model/configuration error for model "${model}" (HTTP ${status}). Upstream response: ${snippet || '(empty response)'}`;
}
