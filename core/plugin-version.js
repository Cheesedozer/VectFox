/**
 * Version-sync between VectFox and the bundled Similharity server plugin.
 *
 * EXPECTED_PLUGIN_VERSION must equal similharity-plugin/package.json's
 * version — tests/plugin-version-sync.test.js enforces this, so vendoring a
 * new plugin drop without bumping the constant fails CI.
 *
 * The runtime check is a warning, never a hard gate: standalone plugin
 * installs (pre-bundling users) may legitimately run a different version and
 * everything still works — the warning just points them at the bundled
 * installer when drift could explain a problem.
 */

import { getDetectedPluginVersion } from './collection-loader.js';
import { log } from './log.js';

export const EXPECTED_PLUGIN_VERSION = null; // set when the plugin source is vendored into similharity-plugin/

/**
 * major.minor compare, tolerant of unknowns: null/unparseable on either side
 * counts as compatible (never nag on missing data).
 *
 * @param {string|null} [detected] - defaults to the last health-check result
 * @returns {boolean}
 */
export function isPluginVersionCompatible(detected = getDetectedPluginVersion()) {
    if (!EXPECTED_PLUGIN_VERSION || !detected) return true;
    const parse = (v) => String(v).trim().match(/^v?(\d+)\.(\d+)/);
    const want = parse(EXPECTED_PLUGIN_VERSION);
    const have = parse(detected);
    if (!want || !have) return true;
    return want[1] === have[1] && want[2] === have[2];
}

let warnedOnce = false;

/**
 * One-time toast when the installed plugin drifts from the bundled version.
 * Call after a successful checkPluginAvailable(); no-ops when compatible,
 * when versions are unknown, or when nothing is bundled yet.
 */
export function warnOnPluginVersionMismatch() {
    if (warnedOnce || isPluginVersionCompatible()) return;
    warnedOnce = true;
    const detected = getDetectedPluginVersion();
    log.warn(`VectFox: Similharity plugin v${detected} differs from the bundled v${EXPECTED_PLUGIN_VERSION}`);
    if (typeof toastr !== 'undefined') {
        toastr.warning(
            `Installed Similharity plugin is v${detected}, but this VectFox bundles v${EXPECTED_PLUGIN_VERSION}. ` +
            'Run "npm run install-plugin" in the VectFox folder to update it.',
            'VectFox',
            { timeOut: 10000 },
        );
    }
}
