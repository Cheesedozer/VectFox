/**
 * Enforces that core/plugin-version.js's EXPECTED_PLUGIN_VERSION matches the
 * vendored similharity-plugin/package.json — vendoring a new plugin drop
 * without bumping the constant fails here.
 *
 * While the plugin source is not yet vendored (no similharity-plugin/ dir),
 * the constant must be null and the compat check must be permissive.
 */

import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// plugin-version.js only needs the detected-version getter from the (heavy,
// ST-coupled) collection-loader module — mock it out entirely.
vi.mock('../core/collection-loader.js', () => ({
    getDetectedPluginVersion: vi.fn(() => null),
}));
vi.mock('../core/log.js', () => ({
    log: { warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

import { EXPECTED_PLUGIN_VERSION, isPluginVersionCompatible } from '../core/plugin-version.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginPackageJson = join(repoRoot, 'similharity-plugin', 'package.json');

describe('bundled plugin version sync', () => {
    if (existsSync(pluginPackageJson)) {
        it('EXPECTED_PLUGIN_VERSION matches similharity-plugin/package.json', () => {
            const bundled = JSON.parse(readFileSync(pluginPackageJson, 'utf8')).version;
            expect(EXPECTED_PLUGIN_VERSION).toBe(bundled);
        });
    } else {
        it('EXPECTED_PLUGIN_VERSION is null while no plugin source is vendored', () => {
            expect(EXPECTED_PLUGIN_VERSION).toBeNull();
        });
    }

    it('compat check is permissive on unknown data', () => {
        expect(isPluginVersionCompatible(null)).toBe(true);
        expect(isPluginVersionCompatible('garbage')).toBe(true);
    });
});
