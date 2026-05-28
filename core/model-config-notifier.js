/**
 * ============================================================================
 * MODEL-CONFIG ERROR NOTIFIER
 * ============================================================================
 * Shared UX for "the configured model is no longer valid" failures — the errors
 * tagged with `code === 'invalid_model_config'` by core/model-http-errors.js.
 *
 * Every model path can hit this (EventBase extraction, summarizer, agent mode,
 * embedding), so the user-facing toast and the auto-sync pause live here once
 * instead of being re-implemented at each catch site.
 * ============================================================================
 */

// A bad model fails on EVERY attempt (every auto-sync tick, every generation), so
// without de-dup the user would get a wall of identical sticky toasts. Keyed by the
// message (which embeds the model id + upstream reason) — a different model warns again.
const _notified = new Set();

/**
 * @param {unknown} err
 * @returns {boolean} true if this is a "model no longer valid" failure.
 */
export function isInvalidModelConfigError(err) {
    return err?.code === 'invalid_model_config';
}

/**
 * Show a sticky (non-auto-dismissing) error toast, once per distinct message.
 * timeOut:0 + extendedTimeOut:0 means the user must dismiss it — a background
 * auto-sync failure can't scroll past unnoticed like a 3-second toast would.
 * @param {string} message
 */
export function notifyInvalidModel(message) {
    if (!message || _notified.has(message)) return;
    _notified.add(message);
    try {
        toastr.error(message, 'VectFox — model no longer valid', {
            timeOut: 0,
            extendedTimeOut: 0,
        });
    } catch (_) { /* toastr unavailable (e.g. unit tests) */ }
}

/** Forget prior notifications so a corrected-then-broken-again model can warn afresh. */
export function resetInvalidModelNotifications() {
    _notified.clear();
}

/**
 * Turn OFF auto-sync for the current chat's EventBase collection(s) so a bad model
 * stops silently re-failing on every message. The user re-enables it after fixing
 * the model. Dispatches `vectfox:collections-updated` so the UI checkbox updates.
 *
 * @param {string} chatUUID
 * @param {string} backend - registry backend, i.e. getRegistryBackend(settings.vector_backend)
 */
export async function pauseAutoSyncForChat(chatUUID, backend) {
    if (!chatUUID || !backend) return;
    const { findEventBaseCollectionIdsForChat } = await import('./eventbase-store.js');
    const { setCollectionAutoSync } = await import('./collection-metadata.js');

    let paused = 0;
    for (const { registryKey } of findEventBaseCollectionIdsForChat(chatUUID, backend)) {
        setCollectionAutoSync(registryKey, false);
        paused++;
    }
    if (paused > 0) {
        try { document.dispatchEvent(new CustomEvent('vectfox:collections-updated')); } catch (_) {}
    }
}
