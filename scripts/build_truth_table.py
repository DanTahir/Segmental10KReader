"""Validate the per-company ground-truth JSON records and merge them into a
single combined TruthTable/truth_table.json.

The per-company files under TruthTable/companies/ are the hand-verified source of
truth. This script never invents data: it only loads, validates, and concatenates
them, then derives a small cross-company index from fields already present.

Usage:  python scripts/build_truth_table.py
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMPANIES_DIR = os.path.join(ROOT, "TruthTable", "companies")
OUT_PATH = os.path.join(ROOT, "TruthTable", "truth_table.json")

EXPECTED = [
    "alphabet_fy2025.json",
    "amazon_fy2025.json",
    "apple_fy2025.json",
    "block_fy2025.json",
    "coinbase_fy2024.json",
    "disney_fy2025.json",
    "dropbox_fy2024.json",
    "meta_fy2025.json",
    "netflix_fy2025.json",
    "schwab_fy2025.json",
]

REQUIRED_TOP = ["company_id", "company_name", "pdf_file", "cik",
                "fiscal_year", "fiscal_year_end", "source", "metrics"]
REQUIRED_METRICS = ["legal_contingencies", "segment_reporting", "income_taxes"]


def main():
    errors = []
    found = sorted(f for f in os.listdir(COMPANIES_DIR) if f.endswith(".json"))

    missing = [f for f in EXPECTED if f not in found]
    extra = [f for f in found if f not in EXPECTED]
    if missing:
        errors.append("MISSING company files: %s" % ", ".join(missing))
    if extra:
        errors.append("UNEXPECTED company files: %s" % ", ".join(extra))

    records = []
    for fname in found:
        path = os.path.join(COMPANIES_DIR, fname)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                rec = json.load(fh)
        except Exception as exc:  # noqa: BLE001
            errors.append("%s: JSON PARSE FAILED: %s" % (fname, exc))
            continue

        for key in REQUIRED_TOP:
            if key not in rec:
                errors.append("%s: missing top-level key '%s'" % (fname, key))
        metrics = rec.get("metrics", {})
        for key in REQUIRED_METRICS:
            if key not in metrics:
                errors.append("%s: missing metrics.%s" % (fname, key))

        records.append((fname, rec))
        print("  OK  %-24s %-34s FY%s (ends %s)" % (
            fname, rec.get("company_name", "?"),
            rec.get("fiscal_year", "?"), rec.get("fiscal_year_end", "?")))

    print("\nParsed %d/%d files." % (len(records), len(EXPECTED)))

    if errors:
        print("\nVALIDATION ERRORS:")
        for e in errors:
            print("  - " + e)
        return 1

    records.sort(key=lambda r: r[1]["company_id"])

    index = []
    for _fname, rec in records:
        seg = rec["metrics"]["segment_reporting"]
        tax = rec["metrics"]["income_taxes"]
        legal = rec["metrics"]["legal_contingencies"]
        rp = legal.get("reasonably_possible_loss_in_excess_of_accrual", {})
        index.append({
            "company_id": rec["company_id"],
            "company_name": rec["company_name"],
            "fiscal_year": rec["fiscal_year"],
            "fiscal_year_end": rec["fiscal_year_end"],
            "reporting_unit": seg.get("unit"),
            "segment_count": seg.get("segment_count"),
            "segment_profit_measure": seg.get("profit_measure"),
            "effective_tax_rate_percent": tax.get("effective_tax_rate_percent"),
            "rp_loss_disclosed": rp.get("disclosed"),
            "rp_loss_quantified": rp.get("quantified"),
            "rp_loss_aggregate_amount": rp.get("aggregate_amount"),
        })

    combined = {
        "dataset": "Segmental10KReader ground-truth table",
        "description": (
            "Manually verified ground truth for three hard-to-extract 10-K "
            "disclosures (legal loss contingencies; segment revenue & profit "
            "with reconciliation; income tax rate reconciliation & unrecognized "
            "tax benefit rollforward) across 10 companies. Built to grade an AI "
            "extraction pipeline."
        ),
        "metrics_covered": [
            "legal_contingencies",
            "segment_reporting",
            "income_taxes",
        ],
        "source_of_record": (
            "Company 10-K filings retrieved from SEC EDGAR as HTML and converted "
            "to text (build/text/*.txt). Every figure was read from those texts and "
            "arithmetically cross-checked; see per-company reconciliation_checks."
        ),
        "company_count": len(records),
        "index": index,
        "companies": [rec for _fname, rec in records],
    }

    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(combined, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    size = os.path.getsize(OUT_PATH)
    print("\nWrote %s (%d companies, %.1f KB)" % (OUT_PATH, len(records), size / 1024.0))

    print("\nCross-company index:")
    print("  %-10s %-6s %-16s %-5s %-8s %s" % (
        "company", "FY", "unit", "segs", "ETR%", "RP-loss (disclosed/quantified)"))
    for row in index:
        print("  %-10s %-6s %-16s %-5s %-8s %s/%s" % (
            row["company_id"], row["fiscal_year"],
            (row["reporting_unit"] or "?").replace("USD ", ""),
            row["segment_count"], row["effective_tax_rate_percent"],
            row["rp_loss_disclosed"], row["rp_loss_quantified"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
