/**
 * ============================================================================
 * MIGRATE TO SPARSE — Dev-only browser driver
 * ============================================================================
 * Re-tokenizes an existing Qdrant collection's `payload.text` into native sparse
 * vectors WITHOUT re-embedding (kept dense vectors).
 *
 * Flow:
 *   1. Browser asks server to create `<source>_v2` with sparse_vectors schema.
 *   2. Browser scrolls `<source>` in batches via server endpoint.
 *   3. Browser tokenizes each `payload.text` locally (CJK pipeline lives here).
 *   4. Browser sends batches to `<source>_v2` with kept dense + new sparse.
 *   5. Browser asks server to finalize: write sentinel, drop source, alias.
 *
 * MIGRATE-DELETE — entire file. Plus:
 *   1. Delete similharity/routes/migrate-to-sparse.js (server side)
 *   2. Remove the Dev Tools UI block in ui-manager.js (also MIGRATE-DELETE tagged)
 *
 * @since Phase 4 — Qdrant native sparse vectors migration
 * ============================================================================
 */

import { encodeSparseVector } from './sparse-vector-encoder.js';
import { invalidateCollectionMetadata } from './tokenizer-lock.js';

const SCROLL_BATCH = 250;

async function getRequestHeaders() {
    const mod = await import('../../../../../script.js');
    return mod.getRequestHeaders();
}

async function postJSON(url, body) {
    const headers = await getRequestHeaders();
    const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`${url} → HTTP ${resp.status}: ${text}`);
    }
    return resp.json();
}

/**
 * Run the migration end-to-end.
 *
 * @param {object} args
 * @param {string} args.sourceCollection - Existing Qdrant collection name
 * @param {string} args.cjkTokenizerMode - Active CJK mode to bake into the sentinel
 * @param {(p: {phase: string, done: number, total: number|null}) => void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ok: true, totalMigrated: number, target: string}>}
 */
export async function migrateCollectionToSparse({ sourceCollection, cjkTokenizerMode, onProgress, signal }) {
    if (!sourceCollection) throw new Error('sourceCollection required');
    if (!cjkTokenizerMode) throw new Error('cjkTokenizerMode required');

    const report = (phase, done, total = null) => onProgress?.({ phase, done, total });

    // Step 1: discover vector size by reading a single point from the source.
    report('inspect', 0);
    const probe = await postJSON('/api/plugins/similharity/chunks/migrate-to-sparse/scroll-source', {
        sourceCollection,
        limit: 1,
    });
    if (!probe.points || probe.points.length === 0) {
        throw new Error(`Source collection "${sourceCollection}" is empty or unreadable`);
    }
    const firstVector = probe.points[0].vector;
    // Source might be plain-array or named-vector form. We only support unnamed source today.
    const denseSample = Array.isArray(firstVector) ? firstVector : firstVector?.[''];
    if (!Array.isArray(denseSample) || denseSample.length === 0) {
        throw new Error(`Could not determine dense vector size from "${sourceCollection}"`);
    }
    const vectorSize = denseSample.length;

    // Step 2: create target.
    report('create-target', 0);
    const target = `${sourceCollection}_v2`;
    await postJSON('/api/plugins/similharity/chunks/migrate-to-sparse/create-target', {
        sourceCollection,
        targetCollection: target,
        vectorSize,
    });

    // Step 3: scroll → tokenize → upsert in a loop until next_page_offset is null.
    let nextOffset = null;
    let totalMigrated = 0;
    let firstPage = true;
    while (true) {
        if (signal?.aborted) {
            await postJSON('/api/plugins/similharity/chunks/migrate-to-sparse/abort', { targetCollection: target }).catch(() => {});
            throw new Error('Migration aborted by user');
        }

        const page = firstPage && probe.points && nextOffset === null
            ? // Reuse the probe page on the first iteration to save a round-trip — but only
              // if it was a full batch; otherwise scroll fresh.
              (probe.points.length >= SCROLL_BATCH ? probe : await postJSON('/api/plugins/similharity/chunks/migrate-to-sparse/scroll-source', {
                  sourceCollection,
                  limit: SCROLL_BATCH,
                  offset: nextOffset,
              }))
            : await postJSON('/api/plugins/similharity/chunks/migrate-to-sparse/scroll-source', {
                  sourceCollection,
                  limit: SCROLL_BATCH,
                  offset: nextOffset,
              });
        firstPage = false;

        const points = page.points || [];
        if (points.length === 0) break;

        // Tokenize locally and prepare upsert batch.
        const prepared = points.map(p => {
            const dense = Array.isArray(p.vector) ? p.vector : p.vector?.[''];
            return {
                id: p.id,
                vector: dense,
                sparseVector: encodeSparseVector(p.text || ''),
                payload: p.payload,
            };
        });

        await postJSON('/api/plugins/similharity/chunks/migrate-to-sparse/upsert-target', {
            targetCollection: target,
            points: prepared,
        });

        totalMigrated += prepared.length;
        report('migrate', totalMigrated, null);

        nextOffset = page.nextOffset;
        if (!nextOffset) break;
    }

    // Step 4: finalize — write sentinel, drop source, alias.
    report('finalize', totalMigrated, totalMigrated);
    await postJSON('/api/plugins/similharity/chunks/migrate-to-sparse/finalize', {
        sourceCollection,
        targetCollection: target,
        cjkTokenizerMode,
        vectorSize,
    });

    // Invalidate cached metadata so the next query reads the new sentinel.
    invalidateCollectionMetadata(sourceCollection);

    report('done', totalMigrated, totalMigrated);
    return { ok: true, totalMigrated, target };
}
