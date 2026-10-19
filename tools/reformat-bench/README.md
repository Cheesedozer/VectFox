# Auto-Reformat bench

A harness that runs Auto-Reformat strategies on a document and scores them for
fact recall, duplicates, cost and time. It runs under plain Node: SillyTavern's
host modules are stubbed (`hooks.mjs`, `stubs/`) and ST's chat-completions
proxy calls go straight to OpenRouter (`or.mjs`), so the baseline is the
extension's real `reformatDocument`.

The OpenRouter key comes from the `OPENROUTER_API_KEY` environment variable
only.

## Methods

- `run-baseline.mjs` — the extension as shipped: `batched` (6k-char batches,
  continuation names, coverage repair, exact-key merge) or `whole`
  (whole-document mode).
- `run-baseline.mjs ... roster` — the extension's roster mode
  (`reformat_roster`), the shipped version of `roster2.mjs` + `sections`.
- `e2e-sillybunny.mjs` — drives a running SillyBunny/SillyTavern in headless
  Chromium: Auto-Reformat of a document in roster mode, review, accept,
  vectorize into Qdrant (setup in the file's header).
- `roster2.mjs` — incremental roster, for documents of any length (see the
  Bulfinch results below). The roster is built window by window (60k chars):
  each call sees one window, every roster name so far, and details for the
  items the window mentions, and returns `new` / `update` operations. Fill is
  either `items` (a slice of roster items from their listed sections) or
  `sections` (6k-char source batches, each writing what it says about the
  roster items it covers, under their roster names; pieces are joined by
  name). Pass a previous run's JSON as the last argument to reuse its roster.
- `roster.mjs` — single-call roster prototype:
  - **A. Roster:** one call lists every entry to write (name, aliases, type,
    hidden, scope, sources). Duplicate names are resolved here, with the
    whole document in view.
  - **B. Fill:** calls of 12 roster items each write those entries. The
    instructions, the document and the roster form a prompt-cached prefix,
    so each call pays full price only for its short task. The first call
    runs alone to write the cache; the rest run in parallel.
  - **C. Leftovers:** paragraphs the extension's coverage check flags go back
    to the model as `append` / `create` operations against existing entries.
  - **D. Dedupe:** candidate pairs (embedding similarity ≥ 0.86, or one name
    contained in another) are judged by the model and merged.

## Scoring

- `evaluate.mjs` reports lexical recall, exact duplicates left, near-duplicate
  candidates and judged duplicates, plus calls, tokens, cost and wall time.
  - Lexical recall is the extension's `computeBatchCoverage`, computed per
    paragraph over the whole document, with author-note sections excluded.
  - Near-duplicate candidates use the same rule as phase D, scored with the
    same judge for every run.
- `semantic.mjs` gives LLM-judged recall. Every source paragraph is checked
  against all entries (cached), and the judge lists the facts no entry
  states.

```sh
export OPENROUTER_API_KEY=...
node --import ./register.mjs run-baseline.mjs DOC.md out/base.json anthropic/claude-haiku-5.5 batched
node --import ./register.mjs roster.mjs DOC.md out/roster.json anthropic/claude-haiku-5.5 "" 12 8
node --import ./register.mjs evaluate.mjs DOC.md out/*.json
node --import ./register.mjs semantic.mjs DOC.md out/base.json out/roster.json
node --import ./register.mjs roster2.mjs DOC.md out/r2.json anthropic/claude-haiku-5.5 "" 8 sections
node --import ./register.mjs semantic-rag.mjs DOC.md 200 out/base.json out/r2.json
```

`semantic-rag.mjs` is judged recall for large documents. Each sampled
paragraph is checked against its top 8 stored pieces, retrieved by embedding
similarity. A piece is what the extension stores: an entry split at the
2,000-character `reformat_max_body_chars`, under its name.

## Results: "The Settlement" (85k chars, ~21k tokens, 9 hidden truths)

| Run | Entries | Lexical recall | Judged duplicates | Missing world facts* | Cost | Time |
|---|---|---|---|---|---|---|
| batched, Haiku 5.5 | 140 | 99.6% | 9 | 12 | $0.054 | 182 s |
| batched, Haiku 5.5 (repeat) | 165 | 99.5% | 7 | 5 | $0.059 | 202 s |
| batched, Flash Lite 3.5 | 127 | 99.2% | 2 | 14 | $0.101 | 44 s |
| whole doc, Haiku 5.5 medium | 75 | 86.8% | 0 | 210 | $0.022 | 140 s |
| roster, Haiku 5.5 | 82 | 99.1% | 0 | 3 | $0.091 | 344 s |
| roster, Haiku 5.5 (repeat, concurrency 8) | 87 | 99.6% | 0 | 4 | $0.077 | 244 s |
| roster, Haiku 5.5 low effort | 81 | 99.6% | 0 | 16 | $0.064 | 190 s |
| roster, Flash Lite 3.5 | 24 | 88.0% | 0 | — | $0.052 | 53 s |

\* LLM-judged facts missing from every entry, not counting "see also" /
navigation links, which make up most of the raw misses for every method.

Findings:

- **Roster + fill matches batched recall with no duplicates.**
  - Batched runs left 7–9 duplicate pairs, e.g. GAMA / GAMA app /
    Gender Authentication Mobile Application, GARS / Gender Authentication
    Registry System, "Male Bodily Integrity Act" with and without "of 2014".
  - Every roster run had none, and the dedupe pass found nothing to merge.
- **Whole-document mode summarizes on this document.** At 85k characters,
  Haiku's single reply dropped about a fifth of the facts. The earlier 99%
  was measured on a 31k-character document.
- **Prompt caching works through OpenRouter.** About 245k of the ~258k
  fill-phase input tokens were cache reads (billed at 1/10), so sending the
  whole document with every call costs little.
- **Roster entries are fewer and longer.**
  - Median body: roster 0.9–1.2k chars, batched 0.5k.
  - The roster folds small items into their parents. The Whitcombe Files'
    named incidents sit inside the files' entry instead of getting their own.
- **Reasoning effort matters for the roster.**
  - At low effort it missed 16 world facts, against 3–4 at the default
    effort.
  - Flash Lite can't build the roster: 24 coarse entries.
- **The roster call is the slow part.** It is one sequential call: ~170 s
  with 33k thinking tokens. It is also the part that still depends on output
  limits: about 0.5 roster tokens per source token, before thinking.

## Results: Bulfinch's Mythology, "Stories of Gods and Heroes" (727k chars, ~180k tokens, ~300 pages)

Source: Project Gutenberg #4928, converted to markdown (chapters `##`,
stories `###`). The book is too long for whole-document mode and for a
single roster call.

| Run | Entries | Lexical recall | Judged duplicates | Retrieved recall | Cost | Time |
|---|---|---|---|---|---|---|
| batched (shipped, concurrency 8) | 1380 | 94.9% | 34 (+5 exact) | 94.4% | $0.57 | 9 min |
| incremental roster, `items` fill | 711 | 88.7% | 0 | 76.4% | $0.65 | 25 min |
| incremental roster, `sections` fill | 715 | 95.3% | 1 | 93.7% | $0.81 | 27 min |

On the Settlement, incremental roster + `sections` fill scored:
- 86 entries, 0 duplicates
- 99.8% lexical and 96.4% judged recall
- $0.10, 3 min

Findings:

- **The incremental roster scales.**
  - 726 items from 13 sequential calls.
  - Largest prompt 36k tokens, largest reply 25k tokens including thinking.
  - No call crossed the 100k-token prompt size where Haiku 5.5's
    long-context price (5× input and output) starts.
  - The roster phase cost $0.16 and took 16 min.
- **`items` fill summarizes.**
  - A slice of 12 items got up to 120k chars of source and wrote replies
    as short as 4k tokens.
  - This is the same failure as whole-document mode: a large input against
    a few entries comes back compressed.
- **`sections` fill keeps the detail and the identity.**
  - It matches batched recall, within judge noise.
  - Duplicates: 1 against 34.
  - Fragmentation is mostly gone. Entries named after Hercules: 11 in
    batched, e.g. "Achelous and Hercules: The wrestling match". In this run:
    3, e.g. "Pillars of Hercules".
  - Only 14 of 1,713 pieces landed outside the roster.
- **Costs:**
  - About 40% more money than batched and three times the time, mostly the
    sequential roster.
  - The roster's name list grows with the document (726 names ≈ 9k
    tokens). Past a few thousand items it should also be filtered to the
    names that resemble the window's.

## Results: the extension's roster mode (`reformat_roster`)

Same documents, run through `reformatDocument` with Claude Haiku 5.5 at
concurrency 8. Batched rows are repeated from above.

| Document / run | Entries | Lexical recall | Judged duplicates | Judged recall | Cost | Time |
|---|---|---|---|---|---|---|
| Bulfinch, batched | 1380 | 94.9% | 34 | 94.4% (retrieved) | $0.57 | 9 min |
| Bulfinch, roster v1 | 1042 | 95.4% | 33 | 93.7% (retrieved) | $0.96 | 28 min |
| Bulfinch, roster v2 | 881 | 95.3% | 3 | 95.3% (retrieved) | $0.97 | 28 min |
| Settlement, batched | 140 / 165 | 99.6% / 99.5% | 9 / 7 | 95.7% / 93.4% | ~$0.06 | ~3 min |
| Settlement, roster v1 | 135 | 98.8% | 1 | 94.8% | $0.09 | 3.4 min |
| Settlement, roster v2 | 104 | 99.1% | 0 | 94.7% | $0.09 | 3.7 min |

- **v1 → v2.** v1 only told batches the roster names. The standard
  extraction prompt's "<Section>: <Part>" rule still split each story's
  episodes off as their own entries ("Tantalus: Punishment",
  "Icarus: Fall into the sea"); those were 33 of v1's 34 pairs. v2:
  - tells batches the roster already decided which parts get entries;
  - folds an off-roster "<Roster name>: <Part>" piece into its roster entry
    (never a hidden piece into a public one).
- **Cost.** The extension costs more than the `roster2.mjs` prototype
  ($0.81) because its prompts carry no cache markers (see `CLAUDE.md`).
- **End-to-end check in SillyBunny 1.8.0** (Similharity plugin, Qdrant
  Cloud, `qwen/qwen3-embedding-8b`):
  - The Settlement, roster mode, gave 110 entries in 226 s, stored as 124
    chunks.
  - The collection had 125 points, 111 distinct names and all 9 hidden
    truths.
  - GAMA was stored once, with "Gender Authentication Mobile Application"
    as its alias.
  - Vector queries returned the expected entry first, e.g. "Which app
    tracks where men are at all times?" → GAMA.
  - The collection was deleted afterwards.
