/**
 * ============================================================================
 * HYBRID FUSION — LEGACY MATH (A/B/C MODE: native_sparse_legacy_fusion)
 * ============================================================================
 * Browser-side fusion that mirrors the Similharity plugin's legacy RRF + bonus
 * + penalty math. Used when fusionMode == 'native_sparse_legacy_fusion':
 * Qdrant returns un-fused dense and sparse prefetch lists; we fuse here.
 *
 * Native sparse BM25 scores from Qdrant are raw IDF dot-products (unbounded),
 * so we apply the same saturation normalisation `s / (s + k)` that the legacy
 * plugin path uses before comparing the two signal scales.
 *
 * ABC-DELETE — after the fusion-mode A/B/C winner is picked, this file is
 * deleted along with the corresponding branches in backends/qdrant.js.
 *
 * @since Phase 3 — Qdrant native sparse vectors
 * ============================================================================
 */

const DEFAULT_RRF_K               = 60;
const DEFAULT_BM25_SAT_K          = 3.0;   // saturation: bm25Norm = raw / (raw + k)
const DUAL_SIGNAL_BONUS_FACTOR    = 0.08;  // max +8%
const VECTOR_ONLY_PENALTY         = 0.55;
const KEYWORD_ONLY_PENALTY        = 0.60;
const SIGNAL_THRESHOLD            = 0.01;

/**
 * Fuse two prefetch lists (dense + sparse) from Qdrant into a single ranked list,
 * applying the legacy plugin-side RRF + dual-signal bonus + single-signal penalty.
 *
 * @param {Array<{hash, text, score, metadata, vectorScore}>} vectorResults    Dense prefetch results, ordered by Qdrant rank.
 * @param {Array<{hash, text, score, metadata, keywordScore?, bm25Score?}>} keywordResults  Sparse prefetch results, ordered by Qdrant rank.
 * @param {object} [opts]
 * @param {number} [opts.topK=10]
 * @param {number} [opts.vectorWeight=0.5]
 * @param {number} [opts.textWeight=0.5]
 * @param {'rrf'|'weighted'} [opts.fusionMethod='rrf']
 * @param {number} [opts.rrfK=60]
 * @param {number} [opts.bm25SatK=3.0]
 * @returns {Array<{hash, text, score, vectorScore, bm25Score, vectorRank, keywordRank, metadata, signalMode}>}
 */
export function fuseUnfusedSparseResults(vectorResults, keywordResults, opts = {}) {
    const topK         = opts.topK         ?? 10;
    const vectorWeight = opts.vectorWeight ?? 0.5;
    const keywordWeight = opts.textWeight  ?? 0.5;
    const method       = opts.fusionMethod ?? 'rrf';
    const rrfK         = opts.rrfK         ?? DEFAULT_RRF_K;
    const satK         = opts.bm25SatK     ?? DEFAULT_BM25_SAT_K;

    // Saturation-normalise the keyword (BM25) scores so they share a 0-1 scale with cosine.
    const normalizedKeywordResults = keywordResults.map(r => {
        const raw = r.keywordScore ?? r.bm25Score ?? r.score ?? 0;
        return {
            ...r,
            bm25RawScore: raw,
            keywordScore: raw > 0 ? raw / (raw + satK) : 0,
        };
    });

    // Build the merged map keyed by point hash.
    const map = new Map();

    vectorResults.forEach((r, i) => {
        map.set(r.hash, {
            hash: r.hash,
            text: r.text,
            metadata: r.metadata,
            vectorScore: r.vectorScore ?? r.score ?? 0,
            vectorRank: i + 1,
            keywordScore: 0,
            keywordRank: Infinity,
            bm25RawScore: 0,
        });
    });

    normalizedKeywordResults.forEach((r, i) => {
        const existing = map.get(r.hash);
        if (existing) {
            existing.keywordScore = r.keywordScore;
            existing.keywordRank = i + 1;
            existing.bm25RawScore = r.bm25RawScore;
        } else {
            map.set(r.hash, {
                hash: r.hash,
                text: r.text,
                metadata: r.metadata,
                vectorScore: 0,
                vectorRank: Infinity,
                keywordScore: r.keywordScore,
                keywordRank: i + 1,
                bm25RawScore: r.bm25RawScore,
            });
        }
    });

    // Pass 1: raw fusion score.
    const rawFused = [...map.values()].map(item => {
        let rawScore;
        if (method === 'rrf') {
            const vRRF = 1 / (rrfK + item.vectorRank);
            const kRRF = 1 / (rrfK + item.keywordRank);
            rawScore = (vectorWeight * vRRF) + (keywordWeight * kRRF);
        } else {
            rawScore = (vectorWeight * item.vectorScore) + (keywordWeight * item.keywordScore);
        }
        return { ...item, rawScore };
    });

    // Pass 2: display score with dual-signal bonus + single-signal penalty.
    const fused = rawFused.map(item => {
        const v = item.vectorScore  || 0;
        const k = item.keywordScore || 0;
        const hasV = v > SIGNAL_THRESHOLD;
        const hasK = k > SIGNAL_THRESHOLD;

        let displayScore;
        let signalMode;
        if (hasV && hasK) {
            const combined = (v * 0.55) + (k * 0.45);
            const bonus = 1.0 + (Math.min(v, k) * DUAL_SIGNAL_BONUS_FACTOR);
            displayScore = Math.min(1.0, combined * bonus);
            signalMode = 'dual';
        } else if (hasV) {
            displayScore = v * VECTOR_ONLY_PENALTY;
            signalMode = 'vector-only';
        } else if (hasK) {
            displayScore = k * KEYWORD_ONLY_PENALTY;
            signalMode = 'keyword-only';
        } else {
            displayScore = item.rawScore * 0.25;
            signalMode = 'rank-only';
        }

        return {
            hash: item.hash,
            text: item.text,
            metadata: item.metadata,
            score: displayScore,
            vectorScore: v,
            bm25Score: k,
            bm25RawScore: item.bm25RawScore,
            vectorRank: item.vectorRank,
            keywordRank: item.keywordRank,
            signalMode,
        };
    });

    return fused.sort((a, b) => b.score - a.score).slice(0, topK);
}
