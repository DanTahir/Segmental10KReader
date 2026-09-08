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
  the row is only accepted inside a deferred tax asset table.
- **Field C (RSU cost)** is disclosed in prose, so the equity note is scanned
  for the disclosure sentence. Wording varies three ways: `unrecognized
  compensation cost`, `unrecognized share-based compensation expense`, and
  `unamortized stock-based compensation` with no cost/expense noun at all.

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

## Current accuracy: 25/30 (83.3%)

Field A is 10/10; field B is 7/10; field C is 8/10. The five failures come from
just **two** root causes, both flagged with `SIMPLIFICATION:` comments in
`src/lib/extract.ts`:

| Company | Field | Got | Expected | Cause |
|---|---|---|---|---|
| Alphabet | Valuation allowance | (11,493) | (13,942) | reads the first numeric column |
| Amazon | Valuation allowance | (4,893) | (5,560) | same |
| Disney | Valuation allowance | (2,931) | 2,931 | contra-asset sign normalization |
| Coinbase | RSU comp cost | $25.6M | $307.2M | first matching sentence is stock *options* |
| Disney | RSU comp cost | $79M | $1,845M | "respectively" amounts unbound to award type |

**Cause 1 — column order.** Field B takes the *first* numeric column, assuming
the current fiscal year is printed leftmost. Most filers do that; Alphabet and
Amazon print their deferred tax table in **ascending** year order, so the first
column is the *prior* year. Disney compounds it by presenting the table as
"(assets) and liabilities" with the allowance printed **positive**, which the
contra-asset normalization then flips.

**Cause 2 — positional amount matching.** Field C takes the first dollar amount
in the first matching sentence. Coinbase discloses stock options, RSUs, and
PRSUs in three separate sentences and the options one comes first. Disney puts
both in one sentence — "unrecognized compensation cost related to unvested stock
options and RSUs was $79 million and $1,845 million, **respectively**" — where
correctness requires binding each amount to its award type rather than taking
the leftmost.

Fixing cause 1 requires parsing the deferred tax table's year header (field A
already does this) and reading the sign as printed. Fixing cause 2 requires
award-type-aware amount binding, including `respectively` handling.

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
