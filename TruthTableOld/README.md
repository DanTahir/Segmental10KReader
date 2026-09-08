# Segmental10KReader — Ground Truth Table

Hand-verified ground truth for **three hard-to-extract 10-K disclosures** across **10 companies**,
built to grade an AI extraction pipeline against the companies' actual SEC filings.

## Contents

| Path | What it is |
|---|---|
| `companies/*.json` | One hand-verified record per company. **These are the source of truth.** |
| `truth_table.json` | Machine-generated merge of all 10 records + a cross-company `index`. Do not edit by hand. |
| `../scripts/build_truth_table.py` | Validates and merges `companies/*.json` → `truth_table.json`. |
| `../scripts/audit_truth_table.py` | Mechanical auditor: evaluates every arithmetic claim, sums every reconciliation array, recomputes ETRs, checks value-presence and citation ranges. |
| `../scripts/test_auditor.py` | **Mutation test for the auditor.** Deliberately corrupts records in memory and asserts each corruption is caught. |
| `../scripts/audit_citations.py` | Grades every `source_line` citation individually against the text at that location. |
| `../scripts/audit_column_order.py` | Derives each filer's year-column ordering from the source text; flags anything ambiguous. |

Rebuild the combined file after editing any company record, then re-validate:

```bash
python scripts/build_truth_table.py
python scripts/test_auditor.py       # prove the auditor can still fail
python scripts/audit_truth_table.py  # then trust its result
python scripts/audit_citations.py
python scripts/audit_column_order.py
```

Run `test_auditor.py` **before** trusting `audit_truth_table.py`: a passing audit only
means something if the checks are capable of failing. Two checks were found to be
silently decorative exactly this way (see *Validation* below).

## The three metrics

1. **`legal_contingencies`** — loss contingency disclosure: amounts accrued, and whether a
   *reasonably possible* loss in excess of accrual is disclosed and/or quantified.
2. **`segment_reporting`** — segment revenue and segment profit, plus the reconciliation from
   segment profit to consolidated pretax income.
3. **`income_taxes`** — the effective tax rate reconciliation and the unrecognized tax benefit
   (UTB) balance / rollforward.

These were chosen because each is narrative-heavy, inconsistently labeled across filers, and
full of near-miss numbers — exactly where naive extraction fails.

## Methodology

1. **Filing resolution** — each PDF was matched to its real filing via the EDGAR submissions API,
   confirming CIK, accession number, entity name, and `period_of_report` against the PDF cover page
   (`scripts/fetch_filings.py` → `build/manifest.json`).
2. **Text conversion** — official filing HTML → text, with tables flattened to pipe-delimited rows
   bounded by `<<<TABLE>>>` markers so row labels stay attached to their figures
   (`scripts/html_to_text.py` → `build/text/*.txt`).
3. **Manual extraction** — every figure was read off the source text with `scripts/print_table.py`
   (which prints a table with its column headers intact) or targeted `grep`. Line numbers are
   recorded in each record so any value can be re-checked at its source.
4. **Arithmetic verification** — every segment table, reconciliation, and rollforward was summed and
   tied to an independently-stated total. The check is stored *inline* in each record
   (`reconciliation_checks`, `reconciliation_check`, `rollforward_check`) as a human-readable string,
   e.g. Disney's `"17,551 - 1,646 - 202 - 819 - 1,305 - 1,576 = 12,003 ✓"`.

### Verification stance

An earlier attempt used parallel automated agents to extract these figures. Their output was
**discarded in full** because it could not be traced to source text, and several values were wrong
(e.g. Schwab's segment data was reported "not found" because the agent searched for *operating
income* when Schwab reports segment *pretax income*). Every number in this dataset was re-derived
from the filing text and cross-checked arithmetically.

Where something could not be confirmed, it is recorded as `null` / `"extracted": false` with a note
explaining what is missing, **never guessed**. Example: Alphabet's per-matter EU fine breakdown.

The 19 remaining `null`s were each re-examined and are all **genuine non-disclosures**, not
extraction gaps: they are the `accrued_amount` / `reasonably_possible_loss` fields for filers that
discuss loss contingencies only qualitatively. Meta is the clearest case — it affirmatively states
it "accrued significant amounts" and that further losses "could be material individually or in the
aggregate", but attaches **no dollar figure anywhere**.

### Validation

Every arithmetic claim, figure, and citation is checked by machine rather than by eye. Current state
of a full run:

| Check | Result |
|---|---|
| Mutation tests (can the auditor fail?) | **9/9 corruptions caught** |
| Mechanical checks over all 10 records | **186 passed, 0 failures, 0 warnings** |
| Per-citation grading | **62/62 (100%)** supported at the cited location; 0 out-of-range |
| Column ordering | resolved for **all 10** filers |

The auditor is itself treated as untrusted code. Writing a mutation test for it exposed **two checks
that could not fail**, and fixing those revealed that Alphabet's, Disney's, and Meta's segment
reconciliation claims had **never actually been evaluated** — they were nested one level deeper than
the key-matching regex looked (they pass now). Five auditor bugs total were found and fixed this way
(unary-minus stripping, percent-vs-ratio comparison, positional total-row detection, path-vs-key
claim matching, and a parenthetical-stripper that deleted negative numbers like `(-127)`).

A clean audit run should therefore be read as "the checks that exist all pass", and the mutation test
is what makes that statement worth anything.

## Record schema

```jsonc
{
  "company_id": "disney",
  "company_name": "The Walt Disney Company",
  "pdf_file": "Reports10K/Disney10k2025.pdf",
  "cik": "0001744489",
  "fiscal_year": 2025,
  "fiscal_year_end": "2025-09-27",
  "fiscal_year_note": "...",          // flags filename/fiscal-year mismatches
  "source": {                          // full provenance back to EDGAR
    "accession": "...", "filing_date": "...", "edgar_entity_name": "...",
    "edgar_filing_dir": "https://www.sec.gov/Archives/edgar/data/...",
    "local_text": "build/text/Disney10k2025.txt"
  },
  "reporting_unit_warning": "...",     // millions vs thousands, and any structural caveat
  "metrics": {
    "legal_contingencies": { /* accrued_amount, reasonably_possible_loss_*, verbatim_quote, why_hard */ },
    "segment_reporting":   { /* unit, reportable_segments, profit_measure, revenue, operating_income,
                                reconciling_items_*, reconciliation_checks, traps */ },
    "income_taxes":        { /* effective_tax_rate_percent, rate_reconciliation_*,
                                unrecognized_tax_benefits, reconciliation_check, traps */ }
  }
}
```

Field conventions:

- **`source_line` / `source_lines`** — 1-based line numbers into the record's `local_text` file.
- **`verbatim_quote`** — exact filing text. Use for string-match grading.
- **`traps` / `why_hard`** — the specific failure mode an extractor is expected to hit. These are the
  most useful part of the dataset for diagnosing *why* a pipeline got something wrong.
- **Signs** — losses and benefits are stored as negative numbers even where the filing prints them in
  parentheses or in a costs-positive presentation. `*_sign_note` explains any such normalization.

## Cross-company index

Generated into `truth_table.json` as `index`:

| Company | FY | Unit | Segs | ETR % | RP loss disclosed / quantified |
|---|---|---|---|---|---|
| alphabet | 2025 | millions | 3 | 16.8 | no / no |
| amazon | 2025 | millions | 3 | 19.6 | yes / no |
| apple | 2025 | millions | 5 | 15.6 | yes / no |
| block | 2025 | **thousands** | 2 | 22.8 | yes / no |
| coinbase | **2024** | **thousands** | 1 | 12.36 | yes / no |
| disney | 2025 | millions | 3 | **−11.9** | no / no |
| dropbox | **2024** | millions | 1 | 11.3 | no / no |
| meta | 2025 | millions | 2 | 29.6 | yes / no |
| netflix | 2025 | **thousands** | 1 | 13.7 | no / no |
| schwab | 2025 | millions | 2 | 22.8 | yes / no |

**No company in this set quantifies an aggregate reasonably-possible legal loss in excess of
accrual.** A pipeline that returns a dollar figure for that field is wrong for all 10 — most often
because it grabbed a *tax* figure (see Apple/Disney below).

## Known traps

**Fiscal year / identity**

- `Coinbase10k2025.pdf` and `Dropbox10k2025.pdf` are actually **FY2024** filings despite the "2025"
  filename. Records are named `coinbase_fy2024.json` / `dropbox_fy2024.json`.
- Apple and Disney have **non-calendar** fiscal years, both ending **September 27, 2025**.

**Year-column ordering — filers disagree**

This is the highest-risk silent failure in the whole dataset: read the wrong column and you get a
real, plausible, *wrong-year* number that passes every arithmetic check.

| Ordering | Filers |
|---|---|
| **Ascending** (oldest → newest, current year **last**) | Alphabet, Amazon |
| **Descending** (newest → oldest, current year **first**) | Apple, Block, Coinbase, Disney, Dropbox, Meta, Netflix, Schwab |

Two further layout traps sit on top of that, both confirmed benign here but both capable of fooling a
positional extractor:

- **Alphabet's MD&A change tables** (e.g. L633 `350,018 | 402,836 | 52,818 | 15%`) put a **dollar
  delta** in the third numeric slot, so "third column" is not a year at all.
- **Meta's segment tables run segments across the row** (FoA, then Reality Labs, then Total), each
  with its own current/prior/percent triplet — so the consolidated total sits in the **5th** numeric
  position, not the 1st or last.

**Units**

- Block, Coinbase, and Netflix report in **thousands**; the other seven in **millions**.
- Netflix mixes units *within a single note*: rate reconciliation in thousands, UTB narrative in
  millions.

**Legal contingencies**

- **Apple / Disney — the conflation trap.** Each filing's only `"reasonably possible"` occurrences are
  in the **tax** note (Apple: UTB could decrease "as much as $6 billion"; Disney: $0.4 billion). Both
  are UTB figures, *not* legal contingencies. Disney's whole-document count for the phrase is exactly 1.
- **Netflix — the inverse trap.** The phrase `"reasonably possible"` appears **zero** times. The real
  disclosure is an affirmative immateriality statement. A nearby WBD merger agreement is a distractor.
- **Apple** states a **negative** assertion (no reasonable possibility of material loss) — the opposite
  meaning to a positive disclosure using nearly identical vocabulary.
- **Schwab — two-tier, self-contradicting-looking.** One sentence block contains *both* "a reasonable
  possibility that a material loss could be incurred" (for described matters) *and* "it does not appear
  reasonably possible" (for all others). Extracting half of it inverts the meaning.
- **Alphabet** is the only filer with a large stated legal accrual (**$15.6B**).
- **Meta — the auditor-report decoy.** Meta's *real* disclosure is in Note 11 (L1800): accruals exist
  and additional losses "could be material individually or in the aggregate" — **unquantified**. A
  sentence that reads almost identically ("When applicable, the Company discloses an estimate of the
  amount of loss or range of possible loss...") sits at L1100 inside the **independent auditor's
  report** (Critical Audit Matters). That one is the *auditor* describing Meta's policy, not a company
  disclosure, and citing it as the reasonably-possible disclosure is wrong. Meta thus has **three**
  layers of near-identical ASC 450 vocabulary — policy paragraph, auditor boilerplate, and the real
  assertion — and only the third counts.

**Segments**

- **Block's** segment profit measure is **gross profit**, not operating income.
- **Schwab's** is **pretax income**, and its revenue line is **net** revenues (net of interest expense).
  Its segment table also puts a *percent-change* column **before** the dollar columns.
- **Coinbase — phrasing trap.** Conveys single-segment status as the CODM reviewing the company
  **"as a whole"**, never *self-asserting* "one operating segment" / "single reportable segment".
  The literal phrase `single reportable segments` does occur once, but only inside the **ASU 2023-07
  boilerplate** describing the standard's scope — so keyword search either finds nothing or cites the
  accounting-pronouncement sentence as the company's assertion. (Contrast Netflix, which says it
  plainly.) In PDF text the real sentence also **wraps across lines**, defeating single-line regexes.
- **Netflix** is single-segment: UCAN/EMEA/LATAM/APAC are a **geographic revenue disaggregation** with
  no operating income. Do not treat them as segments. LATAM and APAC differ by <0.1% — easy to transpose.
- **Meta** — "Advertising" ($196,175M) is a **component of** Family of Apps ($198,759M), not a segment.
  Reality Labs operating income is **−$19,193M**; dropping the sign turns $83.3B into $121.7B.
- **Disney** presents segment revenue **gross** of intersegment eliminations, then removes $1,869M —
  summing segment totals without it overstates revenue. Six reconciling items sit between segment
  operating income and pretax income.

**Income taxes**

- **Disney's ETR is negative (−11.9%)** — a $1,428M net tax *benefit* on positive pretax income, so net
  income *exceeds* pretax income. Its reconciliation has **no dollar column**, only percentages.
- **Block's** statutory-rate line literally prints **21.2%** (the true U.S. statutory rate is 21.0%).
  Worse, its printed statutory **amount** is not reproducible from its printed pretax income:
  `21.0% × 1,689,911 = 354,881`, but the filing prints **357,813** (a 2,932 gap; the implied base
  1,703,871 and the 13,960 delta appear **nowhere** in the filing). The column still sums exactly to
  the 385,701 provision, and `357,813 / 1,689,911 = 21.17%` does round to the printed 21.2%. Treat
  both as as-filed values; do **not** expect `21.0% × pretax` to reproduce them.
- **Dropbox** uses negative-in-parens = *expense*: `$(57.5)M` is a provision, not a benefit. Its ETR
  (11.3%) is **never printed** and must be computed.
- **Coinbase's** real ETR is **12.36%**, with percentages printed to two decimals.
- **Meta's** MD&A rounds the ETR to **30%** while the tax note prints **29.6%** — two "correct-looking"
  answers in one filing. The table value is authoritative here.
- **Schwab's** FY2025 and FY2024 ETRs are **both 22.8%**, so a right answer does not prove the right
  column was read.
- **Amazon** calls its UTBs **"income tax contingencies"**, not "unrecognized tax benefits".
- `"Changes in unrecognized tax benefits"` is a **rate-reconciliation line**, not a UTB balance —
  distinct from the gross UTB, the if-recognized amount, and any balance-sheet classification. Meta has
  three near-identical UTB figures: $16.45B gross, $11.25B if realized, $11.23B net on balance sheet.

## Grading notes

- Compare against `companies/*.json` (or `truth_table.json` → `companies[]`); `index` is a convenience
  summary only.
- Treat `null` / `"extracted": false` as **"not gradeable"**, not as "the answer is zero/absent".
- For unit errors, check `reporting_unit_warning` before scoring a magnitude mismatch — a 1000× miss is
  usually a thousands/millions bug, worth distinguishing from a misread figure.
- `traps` entries make good targeted regression tests: each names a concrete, reproducible failure mode.
- **Do not score a wrong-year value as "close".** Because filers disagree on column order (see above),
  an off-by-one-column answer is a *distinct* failure mode from a misread digit and is worth its own
  bucket — it is the error most likely to survive an extractor's own internal consistency checks.
- Fields named `*_note`, `*_warning`, `confidence`, and `as_printed` record **why** a value is what it
  is (including as-filed inconsistencies the filer itself introduced). When a pipeline disagrees with
  ground truth, read these first — several "errors" are the filing's own quirks, faithfully recorded.
