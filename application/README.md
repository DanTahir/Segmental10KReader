# 10-K Metric Extractor

A self-contained Next.js + TypeScript app that scans the ten 10-K **PDFs**,
extracts three directly-printed disclosure metrics from each one, and grades its
own output against the ground-truth answer key — showing every value, every
mismatch, and the page/line in the PDF each figure was read from.

Runs on **http://localhost:3400**.

```bash
npm install
npm run prepare-data   # copy PDFs + build the sanitized answer key
npm run dev            # http://localhost:3400
```

Then press **Run extraction** in the UI.

---

## The three fields

| Field | Meaning |
|---|---|
| `utb_gross_ending_balance` | Gross unrecognized tax benefits, ending balance (income tax note) |
| `dta_valuation_allowance` | Deferred tax asset valuation allowance balance |
| `unrecognized_rsu_comp_cost` | Unrecognized/unamortized RSU compensation cost (equity comp note) |

10 companies x 3 fields = **30 graded values per run**.

---

## How it reads the PDFs

The app does its own PDF-to-text conversion — it does not reuse any text
extracted elsewhere in the repo.

`pdftotext -table` is used rather than the more common `-layout`. This matters a
lot: on these filings `-layout` frequently **orphans a table's row label from its
own numbers**, emitting the label on one line and the figures several lines
later, often against a neighbouring row's label. Row-wise parsing is impossible
in that state. `-table` keeps `Ending balances ... $ 23,242 $ 22,038` intact.

Conversions are cached in `data/cache/`, keyed by PDF file size, so a cold run
takes ~15s and warm runs ~2s. Page numbers are recovered by counting the form
feeds (`\f`) pdftotext emits at page boundaries, which is what lets the UI cite
"p.102 / line 8378".

## Extraction strategy

Each field needs a different approach:

- **Field A (UTB)** is a rollforward table row, but the label wording varies
  wildly (`Ending gross unrecognized tax benefits`, `Balance at end of year`,
  `Unrecognized tax benefit, end of the period`, bare `Ending balances`). The
  generic labels are also reused by *unrelated* rollforwards — shareholders'
  equity, credit-loss allowances, valuation allowances. So candidate rows are
  **scored on their table's preamble** and the best-scoring candidate wins.
  A year header above the table selects the current-year column. Two filers
  print no rollforward table at all, so a prose fallback handles them.
- **Field B (valuation allowance)** is a deferred-tax-asset table row. An
  identically-named line appears in the effective-tax-rate reconciliation, so
  the row is only accepted inside a deferred tax asset table. The column comes
  from the table's **own year header**, never from position — filers print
  these headers in both directions. The header is read *relative to the
  document*: a FY2024 filer's header reads `2024 2023` and its current column
  is the 2024 one, so "newest column" can never mean a hardcoded year. The
  sign is taken **exactly as printed** (parentheses mean negative, anything
  else is positive), because a filer presenting the table as "(assets) and
  liabilities" prints its allowance positive and means it.
- **Field C (RSU cost)** is disclosed in prose, so the equity note is scanned
  for the disclosure sentence. Wording varies three ways: `unrecognized
  compensation cost`, `unrecognized share-based compensation expense`, and
  `unamortized stock-based compensation` with no cost/expense noun at all.
  Amounts are then **bound to award types** rather than taken positionally —
  see below.

### Binding amounts to award types (field C)

Filers disclose award types in every possible combination, so the amount that
answers "unrecognized RSU cost" is not reliably the first one in the sentence.
The award phrase after `related to` is isolated and scored by how specifically
it describes RSUs:

| Award scope in the filing | Score | Example wording |
|---|---|---|
| RSUs alone | 100 | `unvested RSUs` |
| RSUs plus other award types | 60 | `unvested stock options and RSUs` |
| Restricted stock, no RSU wording | 40 | `stock options and restricted stock awards` |
| Umbrella equity-comp total | 30 | `unvested stock-based compensation arrangements` |
| Options / PRSUs only | rejected | `unvested stock options` |

The highest-scoring disclosure in the document wins. A filer that breaks RSUs
out on their own is the best evidence; one that blends RSUs into a combined
figure is the next best, because **that combined figure is the disclosed
number** — there is nothing finer to be had. A sentence about options or PRSUs
only is not evidence at all.

When a sentence pairs several amounts to several award types with
`respectively`, the award list and the amount list are zipped positionally and
the RSU-bound amount is selected, so `... related to unvested stock options and
RSUs was $X million and $Y million, respectively` correctly yields `$Y`.

One subtlety worth naming: the RSU pattern is `\bRSUs?\b`, and the word
boundary is load-bearing. **`PRSUs` (performance RSUs) must not count as an
RSU**, and it doesn't, because there is no word boundary between the `P` and
the `R`. One filer discloses options, RSUs, PRSUs and restricted stock in four
separate sentences; without that boundary the PRSU figure competes with the
real answer.

## Comparison

Grading is done on the **normalised USD figure**, so a filer's own choice of
thousands/millions/billions never decides correctness, and a sign flip is still
counted wrong. Verdicts are `match`, `mismatch`, or `missing`, and mismatches get
a human-readable delta ("over by $2.4B (+21.3%)", "correct magnitude, wrong
sign").

## Run history

Every run is persisted to `data/runs/<runId>.json` with a summary in
`data/runs/index.json`. That directory sits outside the build output, so history
**survives restarts, rebuilds, and extractor changes** — successive runs stay
comparable. Click any run in the sidebar to reload its full results.

---

## Current accuracy: 30/30 (100%)

Extractor `2.0.0` reads all 30 values correctly — field A 10/10, field B 10/10,
field C 10/10 — verified on a **cold run** (`data/cache/` emptied first, so all
ten PDFs were re-converted from source in 19.1s).

v1.0.0 scored 25/30. The five failures traced to two root causes, both now
fixed by better general logic rather than special-casing:

| Root cause (v1.0.0) | Fields fixed | Fix in v2.0.0 |
|---|---|---|
| Field B assumed the current year was the leftmost numeric column | 2 | Column chosen from the table's own year header, resolved relative to the document |
| Field B forced the allowance negative as a contra-asset | 1 | Sign read exactly as printed |
| Field C took the first amount in the first matching sentence | 2 | Amounts bound to award types; scope-scored; `respectively` pairs zipped |

### Why this isn't the answer key in disguise

A perfect score is exactly when an extractor deserves the most suspicion, so
the constraint held throughout the rewrite was: **every decision must be
derivable from the filing's own structure** — its year headers, its printed
signs, its award wording. A heuristic that needs to know *which* filing it is
looking at is not a heuristic, it is the answer copied in.

That is mechanically checkable, and it checks out:

- `src/lib/extract.ts` contains **no company name or ticker**, and no expected
  value. Every numeric literal in it is a regex fragment, a score, or a scan
  limit.
- The extractor imports only `./types` and `./pdftext`. `answer_key.json` is
  read solely by `src/lib/truth.ts`, which the extractor never touches — it
  cannot see the answers even accidentally.
- The answer key itself is sanitized (see below), so the trap analysis that
  would make the fields easy is absent from the app entirely.

The UI's "how it was found" column is the practical audit trail: it names the
rule that fired for each value (`year-header column 2/2`,
`"respectively" pair 2/2 bound to RSUs`, `umbrella stock-based compensation
total`), so a wrong answer and a *right answer found for the wrong reason* look
different on screen.

## Data & sanitization

`npm run prepare-data` copies the PDFs into `data/pdfs/` and builds
`data/truth/answer_key.json` from `../TruthTable/companies/*.json` using a strict
**allowlist**: values, units, `as_printed`, row labels and citations only.

All of the ground-truth table's difficulty analysis — `decoys`, `why_hard`,
`sign_warning`, `magnitude_warning`, `column_order`, `terminology_note`,
`reporting_unit_warning`, and the rest (19 keys in total) — is **deliberately
excluded**, and the script prints exactly what it stripped on every run. Handing
the extractor a field-by-field description of each trap would make the benchmark
meaningless. That analysis stays in `../TruthTable/` only.

## Layout

```
data/pdfs/           the 10 source 10-K PDFs
data/truth/          sanitized answer key (generated)
data/cache/          pdftotext -table output (generated)
data/runs/           persistent run history (generated)
scripts/prepare-data.mjs   PDF copy + answer-key sanitizer
src/lib/pdftext.ts   pdftotext -table pipeline, page mapping, caching
src/lib/extract.ts   the three field extractors
src/lib/compare.ts   USD-normalised grading
src/lib/runs.ts      run persistence
src/app/api/scan     POST: convert, extract, grade, persist
src/app/api/runs     GET: history list / single run
```
