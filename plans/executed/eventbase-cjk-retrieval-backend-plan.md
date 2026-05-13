# Plan: Improve EventBase Native Hybrid Retrieval for CJK in Similharity Backend

## Summary

EventBase native hybrid retrieval is now fully wired and debuggable, but the current backend keyword-extraction path for CJK is weak. The vector side is working, and stored EventBase payloads appear structurally good, but the backend lexical side is currently fed poor query keywords because the plugin extracts keywords from `searchText` using whitespace splitting instead of proper CJK tokenization.

This causes the hybrid keyword branch to over-rely on English proper names like `mayla` while missing many meaningful Chinese tokens that are clearly present in the query text.

This plan explains:
- what is working already
- where the current CJK retrieval weakness comes from
- why insert-time quality is better than query-time keyword quality
- what to change in the backend/plugin
- the expected impact of each proposal

---

## Current situation

### What is already working

1. **EventBase hybrid retrieval is active**
   - The EventBase path is using hybrid retrieval when enabled.
   - Native Qdrant hybrid request is issued from [`backends/qdrant.js`](backends/qdrant.js).

2. **Backend debug is now available**
   - We added a dedicated GUI checkbox for backend debug.
   - The frontend passes a debug flag through the hybrid request payload.
   - The Similharity Qdrant backend now logs:
     - keyword list received by backend
     - `vectorScore`
     - `keywordScore`
     - `vectorRank`
     - `keywordRank`
     - `matchedKeywordList`
     - final fused score

3. **Insert-time EventBase data looks structurally better**
   - Insert path uses [`buildEmbedText()`](core/eventbase-schema.js:179) and stores structured payload fields like `keywords`, `characters`, `summary`, etc.
   - This is why the vector DB can still contain good structured CJK content.

---

## Evidence from logs: where the problem is

### Client log shows rich Chinese query text exists

From [`Doc/log.txt`](Doc/log.txt):

```text
[EventBase] Keyword query (user last message, 28 chars): 我對 Mayla 説 "你記得我當時怎樣為你贖身的嗎?"

[EventBase] Native hybrid request payload: ... searchTextLen=4452,
searchTextPreview="我對 Mayla 説 \"你記得我當時怎樣為你贖身的嗎?\" 好，來仔細思考一下這次的劇情！ ..."
```

This proves the retrieval query contains a lot of useful CJK material.

### Frontend debug only shows a narrow keyword view

Also from [`Doc/log.txt`](Doc/log.txt):

```text
[EventBase] Hybrid keyword debug — extracted 8 keyword(s) from boostText: mayla, critblade, kashier, fern, engni, lia, valerie, master
```

This is only the frontend proper-noun-biased extractor view. It is not the real backend keyword extraction.

### Server log shows the real backend problem

From the backend portion of [`Doc/log.txt`](Doc/log.txt):

```text
[Qdrant-backend] Hybrid query keywords (10): mayla,
"你記得我當時怎樣為你贖身的嗎?",
好，來仔細思考一下這次的劇情！,
回顧當前情況,
時間：20:15，晚上,
位置：新大陸.流沙之國.扎赫拉巴德.星月綠洲頂層皇家套房，9個人分配好床位（critblade+mayla一張，索拉雅單獨，阿斯蒙蒂斯單獨，kashier+fern，valerie單獨，engni+lia）, ...
```

This is the key issue:
- `mayla` is a useful token
- but the Chinese side is being treated as **large sentence fragments**, not proper segmented CJK keywords

Then the fused results show the keyword side mostly matching `mayla`:

```text
[Qdrant-backend] [0] finalScore=0.013716, vectorScore=0.779071, keywordScore=0.150000, vectorRank=5, keywordRank=23, matchedKeywordList=mayla:text
[Qdrant-backend] [1] finalScore=0.013682, vectorScore=0.692217, keywordScore=0.150000, vectorRank=19, keywordRank=8, matchedKeywordList=mayla:text
[Qdrant-backend] [3] finalScore=0.013100, vectorScore=0.721028, keywordScore=0.300000, vectorRank=8, keywordRank=27, matchedKeywordList=mayla:text, mayla:payload
```

This tells us:
- hybrid is active
- keyword scoring is active
- debug wiring is correct
- **but the lexical branch is weak because query-time keywords are poor**

---

## Root cause

The main weakness is in the Similharity plugin route [`../similharity/index.js`](../similharity/index.js), in the native hybrid endpoint.

Current logic:

```js
extractedKeywords = searchText
  .toLowerCase()
  .split(/\s+/)
  .filter(word => word.length > 2)
  .slice(0, 10);
```

This is acceptable for whitespace-separated English text, but bad for Chinese/Japanese because:
- Chinese text usually does not separate words with spaces
- whitespace splitting produces giant fragments instead of meaningful tokens
- large fragments rarely match well except when they happen to exist verbatim in payload text
- hybrid lexical scoring becomes dominated by English names or accidental phrase matches

---

## Why insert path does not have the same problem

Insert-time EventBase storage is different.

In [`core/eventbase-store.js`](core/eventbase-store.js:49), insert builds `embedText` from structured event fields using [`buildEmbedText()`](core/eventbase-schema.js:179):

- event type
- summary
- cause
- result
- characters
- locations
- items
- keywords
- open threads

This means:
- vector embeddings are built from a cleaner structured representation
- stored payload `keywords` are coming from extracted event fields, not whitespace splitting
- therefore vector DB content can still look good even though query-time keyword extraction is poor

So the problem is mainly **retrieval keyword generation**, not insertion.

---

## Goal of this plan

Improve CJK retrieval quality for EventBase native hybrid by fixing the **backend lexical/query-time side** while preserving the working vector side and the new debug tooling.

---

## Proposals

### Proposal 1 — Replace whitespace splitting with CJK-aware query tokenization

#### Why
Current backend keyword extraction turns Chinese text into giant sentence chunks. This makes the lexical branch weak and noisy.

#### What to do
In [`../similharity/index.js`](../similharity/index.js), replace the current:

```js
searchText.toLowerCase().split(/\s+/)...
```

with a proper tokenizer strategy:

1. Extract Latin/English word tokens normally.
2. Extract CJK tokens using a CJK-aware tokenizer.
3. Deduplicate.
4. Remove stopwords / low-signal tokens.
5. Cap to a reasonable top-N.

#### Preferred implementation
Use a helper similar in spirit to [`extractCJKTokens()`](core/bm25-scorer.js:984):
- if Node runtime supports `Intl.Segmenter`, use it for Chinese word segmentation
- fallback to bigrams if needed
- optionally add TinySegmenter/Jieba parity later if desired

#### Impact
**Highest impact / lowest risk**. This is the single biggest improvement for CJK hybrid retrieval.

---

### Proposal 2 — Distinguish text matches from payload-keyword matches in scoring

#### Why
The backend currently counts matches from:
- `text.includes(keyword)`
- payload `keywords`

but both effectively contribute similarly to `matchCount`.

Payload keywords are generally much higher quality than arbitrary substring hits in long text.

#### What to do
In [`../similharity/qdrant-backend.js`](../similharity/qdrant-backend.js):
- give **payload keyword matches** stronger contribution than raw text substring matches

Example:
- payload keyword hit = `+1.0`
- text substring hit = `+0.5`

or equivalent weighted scoring.

#### Impact
Improves precision significantly, especially for CJK where exact payload keyword hits are more trustworthy.

---

### Proposal 3 — Keep and extend backend debug logging

#### Why
We now have the right visibility to diagnose the keyword side. This should be preserved while improving tokenization.

#### What to do
Keep the `Debug Qdrant backend` path and ensure logs continue to show:
- received backend keyword list
- `vectorScore`
- `keywordScore`
- `vectorRank`
- `keywordRank`
- `matchedKeywordList`
- final fused score

Optionally add:
- final extracted backend keyword token list after stopword filtering
- token source (`latin`, `cjk`, `payload`, etc.)

#### Impact
High debugging value; low runtime risk when gated by GUI checkbox.

---

### Proposal 4 — Improve backend keyword extraction heuristics for mixed-language text

#### Why
Many EventBase queries are mixed:
- Chinese narrative
- English names
- punctuation-heavy prompt scaffolding

Without filtering, the backend can waste token slots on long prompt fragments.

#### What to do
After tokenization:
- drop very long phrase fragments
- strip prompt scaffolding phrases
- prioritize:
  - named entities
  - locations
  - event/action nouns
  - high-frequency meaningful CJK words

This can be done with simple heuristics first.

#### Impact
Medium to high. Helps both precision and stability.

---

### Proposal 5 — Upgrade backend keyword scoring from match-count to BM25-like weighting

#### Why
Current lexical scoring is simple:

```js
keywordScore = min(1.0, (matchCount / keywords.length) * keywordBoost)
```

This is easy to debug but weak compared to BM25.

#### What to do
Replace or augment the keyword branch with BM25-like scoring:
- token frequency
- document length normalization
- optional IDF-like weighting
- better per-token contribution accounting

This is more complex and should come after fixing tokenization.

#### Impact
Potentially strong retrieval improvement, but more implementation complexity.

---

### Proposal 6 — Strengthen EventBase extracted `keywords` payload quality

#### Why
Stored payload keywords are already useful, but better prompt discipline can improve lexical matching even more.

#### What to do
Review [`DEFAULT_EXTRACTION_PROMPT`](core/eventbase-schema.js:201) so the LLM emits better `keywords` for CJK:
- concise
- non-translated
- not overlong phrases
- high-signal story terms only

#### Impact
Medium. Helps the payload side once retrieval tokenization is fixed.

---

## Recommended order of work

### Phase 1 — Immediate / highest-value
1. Replace whitespace keyword extraction in [`../similharity/index.js`](../similharity/index.js)
2. Keep using current fusion logic
3. Use existing backend debug logs to validate new tokens

### Phase 2 — Precision improvements
4. Weight payload-keyword matches higher than raw text substring matches in [`../similharity/qdrant-backend.js`](../similharity/qdrant-backend.js)
5. Add token filtering / mixed-language heuristics

### Phase 3 — Advanced scoring
6. Replace simple keyword match-count scoring with BM25-like lexical scoring
7. Review EventBase extraction prompt for stronger payload keywords

---

## Expected results

After Phase 1, the backend keyword log should stop looking like this:

```text
mayla, "你記得我當時怎樣為你贖身的嗎?", 好，來仔細思考一下這次的劇情！, 回顧當前情況, 時間：20:15，晚上, ...
```

and should start looking more like a tokenized list such as:

```text
mayla, critblade, 贖身, 劇情, 回顧, 當前, 情況, 時間, 晚上, 位置, 新大陸, 流沙之國, 崩潰, 父親, 消失
```

Then the backend fused rows should show `matchedKeywordList` containing real CJK terms, not mostly `mayla:text`.

---

## Success criteria

The work is successful when:

1. Backend keyword logs show segmented CJK tokens rather than giant sentence fragments.
2. `matchedKeywordList` includes meaningful CJK terms regularly.
3. Keyword branch contributes more than just English names.
4. Retrieval quality improves on CJK-heavy EventBase queries.
5. Debug remains controllable through the `Debug Qdrant backend` GUI checkbox.

---

## Files most likely to change

- [`../similharity/index.js`](../similharity/index.js)
  - replace whitespace query keyword extraction

- [`../similharity/qdrant-backend.js`](../similharity/qdrant-backend.js)
  - improve keyword match scoring
  - optionally weight payload keyword hits more strongly
  - preserve / extend debug logs

- Optional later:
  - [`core/eventbase-schema.js`](core/eventbase-schema.js)
  - extraction prompt quality for `keywords`

---

## Final recommendation

Do **not** start with a complex BM25 rewrite.

Start with the simplest high-impact fix:

> Replace backend whitespace keyword extraction with proper CJK-aware tokenization.

That is the clearest root-cause fix, easiest to validate with the new debug logs, and most likely to produce immediate retrieval gains.
