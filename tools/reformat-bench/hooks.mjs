// Redirect the SillyTavern host modules the extension imports
// (extensions.js, script.js, secrets.js — they live outside the extension)
// to local stubs, so core/ modules load under plain Node.
const STUBS = new URL('./stubs/', import.meta.url);
const REPO = new URL('../../', import.meta.url).href;
export async function resolve(specifier, context, next) {
    const m = specifier.match(/(?:\.\.\/)+(extensions|script|secrets)\.js$/);
    if (m && context.parentURL?.startsWith(REPO) && !context.parentURL.startsWith(STUBS.href)) {
        const target = new URL(specifier, context.parentURL).href;
        if (!target.startsWith(REPO)) return { url: new URL(`${m[1]}.js`, STUBS).href, shortCircuit: true };
    }
    return next(specifier, context);
}
