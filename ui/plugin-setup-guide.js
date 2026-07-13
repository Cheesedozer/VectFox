/**
 * Guided setup popup for the Similharity server plugin.
 *
 * VectFox is a browser-side UI extension; the Qdrant backend (and the richer
 * metadata features on Standard) need the Similharity SERVER plugin running
 * inside SillyTavern's Node process. A UI extension cannot install a server
 * plugin or flip enableServerPlugins itself — the best it can do is walk the
 * user through the four manual steps and re-probe on demand, which is what
 * this module does.
 */

import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { checkPluginAvailable, resetPluginAvailability } from '../core/collection-loader.js';

/**
 * Shows the step-by-step install guide. The "Check again" button drops the
 * cached health probe and re-checks live, so the user can verify right after
 * restarting SillyTavern without reloading the page.
 *
 * @returns {Promise<void>} resolves when the popup closes
 */
export async function showPluginSetupGuide() {
    const html = `
        <h3>Set up the VectFox server plugin (Similharity)</h3>
        <p style="text-align:left;">The Qdrant backend and chunk-level database features run inside a
        SillyTavern <strong>server plugin</strong>, which has to be installed once on the machine that
        runs SillyTavern:</p>
        <ol style="text-align:left; line-height:1.7;">
            <li>Open a terminal in your <strong>VectFox extension folder</strong> and run:<br>
                <code style="user-select:all;">npm run install-plugin</code><br>
                <small>(copies the bundled plugin into SillyTavern/plugins and installs its dependencies;
                if this VectFox has no bundled copy, the script prints the git command to fetch it)</small></li>
            <li>In SillyTavern's <code>config.yaml</code>, set:<br>
                <code style="user-select:all;">enableServerPlugins: true</code></li>
            <li><strong>Restart SillyTavern.</strong></li>
            <li>Click <strong>Check again</strong> below (or open VectFox → Diagnostics).</li>
        </ol>
        <p style="text-align:left;"><span id="vectfox_plugin_check_result"></span></p>
    `;

    const popupPromise = callGenericPopup(html, POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        customButtons: ['Check again'],
        wide: false,
    });

    // callGenericPopup resolves when ANY button is pressed — including custom
    // ones. Loop so "Check again" re-probes and reopens instead of closing.
    const result = await popupPromise;
    if (result === 2) {
        resetPluginAvailability();
        const available = await checkPluginAvailable();
        if (available) {
            toastr.success('Similharity plugin detected — you\'re all set!', 'VectFox');
        } else {
            toastr.warning('Plugin still not reachable. Did you restart SillyTavern after installing?', 'VectFox');
            return showPluginSetupGuide();
        }
    }
}
