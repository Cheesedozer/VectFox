#!/usr/bin/env node
/**
 * Installs the bundled Similharity server plugin into the SillyTavern this
 * VectFox extension lives in.
 *
 *   npm run install-plugin            copy + npm install + config check
 *   ... -- --st-root <path>           explicit SillyTavern root (skips auto-detect)
 *   ... -- --symlink                  symlink instead of copy (dev workflow)
 *   ... -- --force                    overwrite an existing install without prompting
 *   ... -- --enable-config            set enableServerPlugins: true in config.yaml
 *                                     (default: print the instruction, never edit)
 *
 * Auto-detect walks upward from this repo looking for SillyTavern's
 * config.yaml, which covers both install locations:
 *   <ST>/public/scripts/extensions/third-party/VectFox
 *   <ST>/data/<user-handle>/extensions/VectFox
 *
 * Zero dependencies; Node >= 18.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const pluginSource = join(repoRoot, 'similharity-plugin');

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const flagValue = (name) => {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
};

function fail(message) {
    console.error(`\n✗ ${message}`);
    process.exit(1);
}

function findSillyTavernRoot() {
    const override = flagValue('--st-root');
    if (override) {
        const root = resolve(override);
        if (!existsSync(join(root, 'config.yaml'))) {
            fail(`--st-root ${root} does not contain config.yaml — is that really the SillyTavern folder?`);
        }
        return root;
    }
    let dir = repoRoot;
    for (let i = 0; i < 8; i++) {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
        if (existsSync(join(dir, 'config.yaml'))) return dir;
    }
    fail(
        'Could not find SillyTavern\'s config.yaml above this extension folder.\n' +
        '  Run again with an explicit root:  npm run install-plugin -- --st-root /path/to/SillyTavern',
    );
}

function readPackageVersion(dir) {
    try {
        return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
}

async function confirm(question) {
    if (hasFlag('--force')) return true;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((res) => rl.question(`${question} [y/N] `, res));
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
}

const stRoot = findSillyTavernRoot();
const target = join(stRoot, 'plugins', 'similharity');

console.log(`SillyTavern root: ${stRoot}`);
console.log(`Plugin source:    ${pluginSource}`);
console.log(`Install target:   ${target}\n`);

if (!existsSync(join(pluginSource, 'package.json'))) {
    fail(
        'The bundled plugin source (similharity-plugin/) is not present in this VectFox checkout.\n' +
        '  Install it the standalone way instead:\n' +
        `    git clone -b Similharity-Plugin https://github.com/KritBlade/VectFox.git "${join(stRoot, 'plugins', 'similharity')}"\n` +
        `    cd "${join(stRoot, 'plugins', 'similharity')}" && npm install --omit=dev`,
    );
}

if (existsSync(target)) {
    const existingVersion = readPackageVersion(target) || 'unknown';
    const bundledVersion = readPackageVersion(pluginSource) || 'unknown';
    console.log(`An install already exists (installed: ${existingVersion}, bundled: ${bundledVersion}).`);
    if (!(await confirm('Replace it with the bundled version?'))) {
        console.log('Aborted — existing install left untouched.');
        process.exit(0);
    }
    rmSync(target, { recursive: true, force: true });
}

mkdirSync(dirname(target), { recursive: true });

if (hasFlag('--symlink')) {
    symlinkSync(pluginSource, target, 'junction'); // 'junction' = dir link on Windows, ignored elsewhere
    console.log('✓ Symlinked plugin source (dev mode)');
} else {
    cpSync(pluginSource, target, {
        recursive: true,
        filter: (src) => !src.includes('node_modules'),
    });
    console.log('✓ Copied plugin files');
}

console.log('\nInstalling plugin dependencies...');
const npmResult = spawnSync('npm', ['install', '--omit=dev'], {
    cwd: target,
    stdio: 'inherit',
    shell: process.platform === 'win32',
});
if (npmResult.status !== 0) {
    fail('npm install failed inside the plugin folder — see output above.');
}
console.log('✓ Dependencies installed');

// config.yaml: server plugins are opt-in. Never edit silently.
const configPath = join(stRoot, 'config.yaml');
const configText = readFileSync(configPath, 'utf8');
const enabled = /^\s*enableServerPlugins:\s*true\s*$/m.test(configText);
if (enabled) {
    console.log('✓ enableServerPlugins is already true in config.yaml');
} else if (hasFlag('--enable-config')) {
    const updated = /^\s*enableServerPlugins:\s*\w+\s*$/m.test(configText)
        ? configText.replace(/^(\s*enableServerPlugins:\s*)\w+(\s*)$/m, '$1true$2')
        : `${configText.replace(/\s*$/, '')}\nenableServerPlugins: true\n`;
    writeFileSync(configPath, updated);
    console.log('✓ Set enableServerPlugins: true in config.yaml');
} else {
    console.log(
        '\n⚠ One manual step left — server plugins are disabled by default.\n' +
        `  Open ${configPath}\n` +
        '  and set:  enableServerPlugins: true\n' +
        '  (or re-run with --enable-config to let this script set it)',
    );
}

console.log(
    '\nDone. Restart SillyTavern, then verify the plugin is up:\n' +
    '  - VectFox → Diagnostics, or\n' +
    '  - open <your ST URL>/api/plugins/similharity/health in a browser (expect {"status":"ok"}).',
);
