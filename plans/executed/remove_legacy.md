# Plan: Remove LanceDB + Milvus Backend Support

Officially drop LanceDB and Milvus backends from VectHare. The supported backends become **Standard (ST Vectra)** and **Qdrant** only. Covers both repos: VectHare (extension/UI) and similharity (server plugin).

---

## Pre-Execution Notes

**The user has a complete backup of this project** — proceed aggressively, do not preserve "just in case" code.

**Do NOT touch:**
- `backends/standard.js` (only update `knownBackends` arrays as instructed)
- `backends/qdrant.js` (only update `knownBackends` arrays as instructed)
- `backends/backend-interface.js`
- Any `core/eventbase-*.js`
- The `vectra → standard` alias in `BACKEND_ALIASES` — KEEP

---

## VectHare repo (`h:\Github\Dev\VectHare\`)

### 1.1 Delete files
- `backends/lancedb.js`
- `backends/milvus.js`

### 1.2 Modify `backends/backend-manager.js`
- Remove `import { LanceDBBackend } from './lancedb.js';` (line 15)
- Remove `import { MilvusBackend } from './milvus.js';` (line 17)
- Remove `lancedb: LanceDBBackend` and `milvus: MilvusBackend` from the `BACKENDS` registry object
- Update JSDoc `@param backendName` description to list only `'standard'` and `'qdrant'`
- Keep `vectra → standard` alias in `BACKEND_ALIASES`

### 1.3 Modify `index.js` (defaultSettings)
- Remove all `milvus_*` keys: `milvus_host`, `milvus_port`, `milvus_username`, `milvus_password`, `milvus_token`, `milvus_address`
- Update comment on `vector_backend` line to say `'standard' (ST Vectra) | 'qdrant'` only

### 1.4 Modify `ui/ui-manager.js`
- Remove `<option value="lancedb">LanceDB (disk-based, scalable)</option>` from `#vecthare_vector_backend`
- Remove `<option value="milvus">Milvus (popular open source engine)</option>` from `#vecthare_vector_backend`
- Update the `<small>` help text block below the dropdown to remove LanceDB and Milvus bullet points
- Delete the entire `<div id="vecthare_milvus_settings">...</div>` block (lines 145–183, ~39 lines)
- In the `#vecthare_vector_backend` change handler: remove the `if (settings.vector_backend === 'milvus')` show/hide block (lines 2199–2203)
- Remove all seven `$('#vecthare_milvus_*')` input event handler blocks (lines 2298–2355, ~58 lines)
- Remove the `if (settings.vector_backend === 'milvus')` show block at the bottom (lines 2357–2360)
- In `updateNativeHybridUI()`: change `backend === 'qdrant' || backend === 'milvus'` → `backend === 'qdrant'` (line 2149)
- In `applyBackendHybridDefaults()`: change `backend === 'qdrant' || backend === 'milvus'` → `backend === 'qdrant'` (line 2168); update the comment on line 2170 to remove "Milvus"; update the else-branch comment on line 2174 to remove "LanceDB"
- Update comment on line 502: `<!-- Only shown when backend supports native hybrid (qdrant) -->`

### 1.5 Modify `ui/database-browser.js`
- Remove `lancedb: "LanceDB"` from the backend label map (line 813)
- Update the surrounding comment if it still says "Standard, LanceDB, Qdrant"

### 1.6 Modify `core/collection-ids.js`
- In the corrupted-prefix regex (line ~69): remove `milvus` and `lancedb` → keep only `(vectra|qdrant|standard)`
- If `knownBackends` arrays exist in this file, update to `['standard', 'vectra', 'qdrant']`

### 1.7 Modify `backends/standard.js`
- Update `knownBackends` array (line 346) → `['standard', 'vectra', 'qdrant']`

### 1.8 Modify `backends/qdrant.js`
- Update `knownBackends` array (line 173) → `['standard', 'vectra', 'qdrant']`

### 1.9 Modify `core/world-info-integration.js`
- Line 51: change `settings.vector_backend === 'qdrant' || settings.vector_backend === 'milvus'` → `settings.vector_backend === 'qdrant'`

### 1.10 Modify `diagnostics/infrastructure.js`
- Delete the entire `checkLanceDBBackend()` function (lines ~319–380)
- Remove any export of `checkLanceDBBackend` from this file
- If there is a `checkMilvusBackend()` function, delete it too

### 1.11 Modify `diagnostics/configuration.js`
- Line 683: change `settings.vector_backend === 'lancedb' || settings.vector_backend === 'qdrant'` → `settings.vector_backend === 'qdrant'`

### 1.12 Modify `tests/backends.test.js`
- Remove `import { LanceDBBackend } from '../backends/lancedb.js';` (line 74)
- Remove `import { MilvusBackend } from '../backends/milvus.js';` (line 76)
- Delete the entire `LanceDBBackend` describe block (lines ~485–535)
- Delete the entire `MilvusBackend` describe block (lines ~825–870)
- Remove any hybrid-search capability tests that mention lancedb/milvus (lines ~1056–1063)

### 1.13 Modify `tests/backend-manager.test.js`
- Remove `expect(backends).toContain('lancedb')` (line 92)
- Remove `expect(backends).toContain('milvus')` (line 94)
- Delete the Milvus metrics test block (lines ~210–218)
- Delete the LanceDB error recording / tracking test blocks (lines ~224–249)
- Delete the Milvus health check test block (lines ~256–270)

### 1.14 Update `.github/copilot-instructions.md`
- Remove `lancedb` and `milvus` from the dependency map lines (~21, 29, 32)
- Remove the `### backends\lancedb.js` section (~line 84)
- Remove the `### backends\milvus.js` section (~line 98)

### 1.15 Update `README.md`
Strip LanceDB and Milvus from the backend table, capabilities, and prerequisites sections.

---

## similharity repo (`h:\Github\Dev\similharity\`)

### 1.16 Delete files
- `lancedb-backend.js`
- `milvus-backend.js`

### 1.17 Modify `index.js`
- Remove `import lancedbBackend from './lancedb-backend.js';` (line 18)
- Remove `import milvusBackend from './milvus-backend.js';` (line 20)
- Delete `ensureLanceDBInitialized()` helper function (lines ~186–189)
- Delete the entire `case 'lancedb':` handler block (lines ~416–495)
- Delete the entire `case 'milvus':` handler block (lines ~594–669)
- Update supported backends list (line 690): `backends: ['vectra', 'qdrant']`
- Remove LanceDB path construction block (lines ~709–712)
- Remove LanceDB health check block (lines ~842–848)
- Remove Milvus health check block (lines ~855–858)
- Remove LanceDB init endpoint block (lines ~887–890)
- Remove Milvus init endpoint block (lines ~897–900)
- Remove all six `ensureLanceDBInitialized()` auto-init calls (lines ~1154, ~1202, ~1244, ~1285, ~1325, ~1367)

### 1.18 Modify `package.json`
- Remove `"@lancedb/lancedb": "^0.5.0"` from dependencies
- Remove `"@zilliz/milvus2-sdk-node": "^2.6.5"` from dependencies
- Remove `"@lancedb/lancedb-linux-x64-musl": "^0.23.0"` from optionalDependencies
- Remove `"lancedb"` from keywords array
- Run `npm install` in the similharity directory to regenerate `package-lock.json`

### 1.19 Update `README.md` (similharity)
- Remove the LanceDB feature description (line 11)
- Remove `lancedb-backend.js` from the file structure listing (line 50)
- Remove `"lancedb"` from features list (line 115)
- Remove LanceDB example usage (lines 148–149)
- Delete the entire LanceDB API documentation section (lines ~235–425)

---

## Verification

```
npm test   (in VectHare)
npm test   (in similharity, if tests exist)
```

Manual smoke test:
1. Load extension, confirm backend dropdown shows only **Standard** and **Qdrant**
2. Check console for import errors on load
3. Confirm Qdrant backend still initializes
4. Confirm Standard backend still works (switch to it briefly)
5. Open Database Browser — confirm Qdrant collections still listed correctly

---

## Notes

- Existing user data in LanceDB / Milvus instances is left untouched (we only remove client-side support — any deployed LanceDB/Milvus servers and their data are unaffected, just no longer accessible through VectHare)
- Settings migration: any users with `vector_backend: 'lancedb'` or `'milvus'` saved in `extension_settings.vecthareplus` will need to manually re-select. The dispatcher in `backend-manager.js` will throw an unknown-backend error on load — consider adding a one-shot migration that maps removed backends to `'qdrant'` on settings load. (Optional, not required for this cleanup.)
