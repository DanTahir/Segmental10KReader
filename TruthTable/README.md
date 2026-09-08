# Ground Truth: Three Hard-to-Locate Scalar Fields Across Ten 10-K Filings

A hand-verified answer key for grading an AI 10-K extraction pipeline.

Ten filers x three fields = **30 target values**. Every value is a single number
**printed directly in the filing**. Nothing here is computed, summed, averaged,
or otherwise derived by us — if a pipeline returns the number, it either found
the right line or it didn't.

## Why these three fields

The fields were not chosen for convenience. They were selected by probing the
filings for values that are (a) present in all ten, (b) buried deep in the
notes rather than on the face of the financial statements, and (c) surrounded by
**plausible wrong answers**. Each one sits in a different failure mode:

| | Field | Where it hides | Core difficulty |
|---|---|---|---|
| **A** | `utb_gross_ending_balance` — gross unrecognized tax benefits, ending balance | last row of the UTB rollforward, deep in the income-tax note | row labels are generic and non-unique; one filer has no table at all |
| **B** | `dta_valuation_allowance` — deferred tax asset valuation allowance, balance | one row of the deferred-tax-asset table | a *rate-reconciliation* line with a near-identical label appears **earlier** in 7 of 10 filings |
| **C** | `unrecognized_rsu_comp_cost` — unrecognized/unamortized RSU compensation cost | one prose sentence in the equity-compensation note | prose, not a table; multiple award types per sentence; non-standard wording |

## The answer key

Values exactly as printed. Note the unit column — it changes **within** filings,
not just between them.

| Company | FY | A: UTB ending | B: valuation allowance | C: unrecog. RSU cost | C scope |
|---|---|---|---|---|---|
| Alphabet | 2025 | $11,512 M | $(13,942) M | $42.9 B | RSU-only |
| Amazon | 2025 | $6.6 B *(prose)* | $(5,560) M | $16.9 B | all SBC |
| Apple | 2025 | $23,242 M | $(10,966) M | $21.8 B | RSU-only |
| Block | 2025 | $626,755 K | $(557,063) K | $2.1 B | options + RSA |
| Coinbase | 2024 | $190,944 K | $(124,202) K | $307.2 M | RSU-only |
| Disney | 2025 | $1,133 M | **$2,931 M** *(positive)* | $1,845 M | RSU-only |
| Dropbox | 2024 | $162.7 M | $(122.8) M | $589.5 M | options + RSA + RSU |
| Meta | 2025 | $16,450 M | $(15,895) M | $54.81 B | RSU-only |
| Netflix | 2025 | $566,363 K | $(617,575) K | $47 M | RSU + PSU |
| Schwab | 2025 | $458 M | $(27) M | $328 M | options + RSU |

Two filers are **FY2024**, not FY2025 — see the filename trap below.

## Field C scope: read this before grading

Field C was scoped as **RSU-only where the filer separates it**. Only **5 of 10**
do. The rest disclose a single combined figure across award types, so no RSU-only
number exists to extract:

- **Separable (RSU-only recorded):** Alphabet, Apple, Coinbase, Disney, Meta
- **Not separable (combined figure recorded as printed):** Amazon, Block, Dropbox, Netflix, Schwab

Every record carries `rsu_only_separable` (boolean) and `scope` (free text). We
did **not** force a split that the filing doesn't make, and we did not drop the
five non-separable filers. **Grade field C against `scope`**, not against a
uniform "RSU-only" expectation — otherwise five companies are unfairly scored.

## Decoys and traps

Every decoy below was observed in the actual filing text and is recorded in the
per-company JSON with its own line citation.

### Wrong-column / wrong-year

- **Alphabet and Amazon print their deferred-tax tables in ASCENDING year order**
  (`| 2024 | 2025`) while the other eight are descending. Reading "the first
  number" gives the **prior year**. This trap caught us mid-build: both of these
  field-B values were initially recorded a year off.
- Alphabet's field A is also ascending across three columns, so the current year
  is the **third** number and the FY2024 figure sits in the middle.
- Every rollforward repeats the prior-year ending balance as the current-year
  beginning balance, so the wrong answer appears twice and looks corroborated.

### Same row label, different table

- **Apple field A** — the row label `Ending balances` is **not unique**. The
  identical label appears in the *Consolidated Statements of Shareholders'
  Equity* about 300 lines earlier (`Ending balances | 93,568 | 83,276 | 73,812`,
  common stock and APIC). A naive first-match search lands there. The real UTB
  row is L938.
- **Coinbase field A** — `Balance, end of period` labels **three** different
  rollforwards in one filing. One of the decoys is the valuation-allowance
  rollforward, whose value (124,202) is this same record's **field B**.
- **Schwab field A** — `Balance at end of period` also labels the
  allowance-for-credit-losses rollforward ~2,100 lines earlier, whose figures are
  ~1,500x larger.

### The valuation-allowance rate-reconciliation decoy (field B, 7 of 10 filers)

A line mentioning "valuation allowance" appears in the **effective tax rate
reconciliation** — the year's *movement* or a *percentage* — and is printed
**before** the real balance-sheet figure. First keyword hit is wrong:

- Coinbase L2882 `(7,493)` vs. real balance L2940 `(124,202)`
- Meta L1938 `11,974` (paired with `13.9`, a percent) vs. real L1991 `(15,895)` — the most convincing decoy in the set
- Block has **three** such lines before the balance row
- Disney L2751 `(1.3) | (0.6) | (1.8)` — percentages, negative, same label as the positive balance
- Also present in Apple, Dropbox

### Sign convention

**Disney is the only filer printing field B as a positive number** (`2,931`).
Its table is titled *Deferred Tax (Assets) and Liabilities* — assets are shown
negative, so the allowance is a positive addition. The other nine print it in
parentheses. Any pipeline that normalizes signs globally will get either Disney
or the other nine wrong.

### Terminology

- **Amazon has no UTB rollforward table at all.** The balance exists only in
  prose, in a *footnote to a contractual-obligations table*, and Amazon never
  writes "unrecognized tax benefits" — it says **"income tax contingencies"**.
- **Dropbox says "unamortized", never "unrecognized"** for field C. Searching
  the standard phrase returns **zero** hits in that filing.
- **Meta's field A row label uses a non-breaking hyphen (U+2011)**, so a regex
  with an ASCII `-` matches nothing.
- Meta says "share-based expense"; everyone else says "stock-based cost".

### "If-recognized" amounts (field A)

Every filer discloses a *portion that would affect the effective tax rate if
recognized*, in the same breath as the gross balance. It is always smaller and
always wrong for this field. **This trap caught us during construction**:
Coinbase's field A was initially recorded as $136.8 M, which is the if-recognized
portion — the true gross ending balance is **$190,944 K**.

### Multi-figure sentences (field C)

- **Disney**: `"...stock options and RSUs was $79 million and $1,845 million,
  respectively"` — the RSU figure is the **second** number, bound only by the word
  "respectively". The naive pick is $79 M.
- **Coinbase** prints three near-identical sentences ($25.6 M options,
  $307.2 M RSUs, $8.5 M restricted stock). The RSU one is **not** first.
- **Dropbox** has a `$0` decoy 12 lines away: "no unamortized stock-based
  compensation expense related to the Co-Founder Grant" — the award explicitly
  *excluded* from the real figure.

### Unit and magnitude traps

- **Units change within a single filing.** Block's tax tables are in thousands
  while its equity-comp prose is in billions. Same for Coinbase and Netflix.
  A one-unit-per-filer assumption is off by 1000x on one field.
- **Netflix field A** appears both as `566,363` (thousands, in the table) and
  `$566 million` (prose, ~1,050 lines earlier).
- **Smallest values are real**: Schwab's field B is `$(27) M` — two digits in a
  table of four-digit rows. Netflix's field C is `$47 M`, ~1/1000th of Meta's.
  A plausibility filter will reject the correct answer.

### Filename trap

`Coinbase10k2025.pdf` and `Dropbox10k2025.pdf` are the **FY2024** 10-Ks. Trusting
the filename shifts the target column by a year. The `fiscal_year` in each record
is derived from the table headers, not the filename.

## Files

```
TruthTable/
  companies/<company>_fy<year>.json   10 records, the source of truth
  truth_table.json                    generated: all 10 + a flat index
  README.md                           this file
scripts/
  dump_field_evidence.py              prints each field's source row WITH its
                                      table header, so year order is never guessed
  build_truth_table.py                validates records, merges to truth_table.json
  audit_truth_table.py                re-verifies all 30 values against filing text
  test_auditor.py                     mutation-tests the auditor itself
```

`TruthTableOld/` holds the entire previous (superseded) three-metric deliverable,
preserved unchanged.

## Verification

Run in this order:

```bash
python scripts/build_truth_table.py   # -> Parsed 10/10 files, 0 failures
python scripts/audit_truth_table.py   # -> PASS: all 237 checks green
python scripts/test_auditor.py        # -> killed 22/22, survived 0
```

The auditor does **not** trust the JSON. For all 30 values it re-opens the cited
filing text and checks: the cited line really contains the recorded text
(`LINE`); the value is a number on that line (`VALUE`); it sits at the recorded
column index (`COLUMN`); the header line matches and its year order and target
year agree with the record (`HEADER`); the value differs from the other
year-columns so an off-by-one can't pass silently (`DISTINCT`); prose values are
pinned to an exact printed token like `$1,845 million` (`PROSE`); `value_usd`
equals value x unit (`UNITS`); and every `L####` decoy citation really contains
the number it claims (`CITATION`).

**A green auditor run means nothing unless the auditor can go red**, so
`test_auditor.py` corrupts records one at a time — each mutation modelled on a
mistake actually made or nearly made here (Alphabet's ascending-column misread,
Coinbase's if-recognized swap, Apple's equity-statement row, Disney's sign flip,
Netflix's unit swap) — and asserts the auditor rejects each with the expected
check code. It also verifies the unmutated records still pass as a control.

**Mutation testing found a real hole.** The Disney field-C mutation
(1845 -> 79, the stock-option figure) initially **survived**: prose fields have no
column index, so `VALUE` only asked "is 79 *a* number on this line?" — and it is.
Any figure in a multi-amount sentence would have passed. Fixed by adding the
`value_printed_token` anchor and the `PROSE` check. This is why the mutation test
exists.

### Errors caught during construction

Recorded honestly, since they show which traps actually bite:

| Field | First recorded | Corrected to | Cause |
|---|---|---|---|
| Coinbase A | $136.8 M | $190,944 K | grabbed the if-recognized portion |
| Alphabet B | $(11,493) M | $(13,942) M | read the FY2024 column (ascending table) |
| Amazon B | $(4,893) M | $(5,560) M | same ascending-column trap |
| Apple A | L939 | L938 | off-by-one citation (L939 is `<<<END TABLE>>>`) |

The first three were caught by dumping table **headers** alongside data rows; the
fourth by the auditor's `LINE` check.

## Known limitations

- **Line citations point into `build/text/*.txt`**, the flattened EDGAR HTML, not
  PDF pages. Re-running the text extraction could shift line numbers; the
  auditor's `LINE` check will flag it immediately if so.
- Two filings are FY2024 while eight are FY2025 — fiscal years are **not**
  uniform across the set by design, since the source PDFs aren't.
- The auditor verifies that a value is *the printed number at the cited
  location*. It cannot verify that the cited location is *the right concept* —
  that judgment is human, which is what the `why_hard`, `scope`, and `decoys`
  notes document. A mutation that changes both the value and its prose anchor
  consistently would survive; catching that requires reading the filing.
