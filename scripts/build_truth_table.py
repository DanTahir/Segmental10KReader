"""Validate and merge TruthTable/companies/*.json into TruthTable/truth_table.json.

Schema (per company): three fields, each a SINGLE SCALAR printed directly in the
filing -- never computed by us:

  utb_gross_ending_balance   gross unrecognized tax benefits, ending balance
  dta_valuation_allowance    deferred tax asset valuation allowance, balance
  unrecognized_rsu_comp_cost unrecognized/unamortized RSU compensation cost

Validation is strict: a missing required key, an unparseable number, or a
value_usd that disagrees with value x unit is a hard failure. Exit code is
nonzero if any record fails, so this can gate a commit.

Usage:  python scripts/build_truth_table.py
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMPANIES_DIR = os.path.join(ROOT, "TruthTable", "companies")
OUT = os.path.join(ROOT, "TruthTable", "truth_table.json")

FIELDS = [
    "utb_gross_ending_balance",
    "dta_valuation_allowance",
    "unrecognized_rsu_comp_cost",
]

MULT = {
    "USD thousands": 1e3,
    "USD millions": 1e6,
    "USD billions": 1e9,
}

REQUIRED_TOP = ["company_id", "company_name", "fiscal_year", "fiscal_year_end",
                "source", "fields"]
REQUIRED_FIELD = ["value", "unit", "value_usd", "as_printed", "source_line"]


def main():
    errs = []
    warns = []
    records = []
    files = sorted(f for f in os.listdir(COMPANIES_DIR) if f.endswith(".json"))
    print("Building from %d company files\n" % len(files))

    for fname in files:
        path = os.path.join(COMPANIES_DIR, fname)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                rec = json.load(fh)
        except ValueError as e:
            errs.append("%s: INVALID JSON: %s" % (fname, e))
            continue

        cid = rec.get("company_id", "?")
        for k in REQUIRED_TOP:
            if k not in rec:
                errs.append("%s: missing top-level key '%s'" % (cid, k))

        # source text must exist, since every citation refers to it
        lt = rec.get("source", {}).get("local_text")
        n_lines = None
        if lt:
            tp = os.path.join(ROOT, lt.replace("/", os.sep))
            if not os.path.exists(tp):
                errs.append("%s: local_text not found: %s" % (cid, lt))
            else:
                with open(tp, "r", encoding="utf-8", errors="replace") as fh:
                    n_lines = len(fh.read().split("\n"))

        for fld in FIELDS:
            node = rec.get("fields", {}).get(fld)
            if node is None:
                errs.append("%s: missing field '%s'" % (cid, fld))
                continue
            for k in REQUIRED_FIELD:
                if k not in node:
                    errs.append("%s.%s: missing '%s'" % (cid, fld, k))
            v, u, vusd = node.get("value"), node.get("unit"), node.get("value_usd")
            if not isinstance(v, (int, float)):
                errs.append("%s.%s: value is not numeric: %r" % (cid, fld, v))
            elif u not in MULT:
                errs.append("%s.%s: unrecognized unit %r" % (cid, fld, u))
            elif not isinstance(vusd, (int, float)):
                errs.append("%s.%s: value_usd is not numeric: %r" % (cid, fld, vusd))
            else:
                expect = v * MULT[u]
                if abs(expect - vusd) > max(1.0, abs(expect) * 1e-9):
                    errs.append("%s.%s: value_usd %s != value %s x %s (= %s)"
                                % (cid, fld, vusd, v, u, expect))
            sl = node.get("source_line")
            if isinstance(sl, int) and n_lines and not (1 <= sl <= n_lines):
                errs.append("%s.%s: source_line %d out of range (1..%d)"
                            % (cid, fld, sl, n_lines))
            if not node.get("decoys") and not node.get("why_hard"):
                warns.append("%s.%s: no decoys/why_hard recorded" % (cid, fld))

        records.append(rec)
        print("  %-4s %-26s %-34s FY%s"
              % ("OK" if not errs else "..", fname, rec.get("company_name", "?"),
                 rec.get("fiscal_year", "?")))

    if errs:
        print("\n--- VALIDATION FAILURES (%d) ---" % len(errs))
        for e in errs:
            print("  " + e)
        return 1

    index = []
    for r in records:
        row = {"company_id": r["company_id"], "fiscal_year": r["fiscal_year"]}
        for fld in FIELDS:
            node = r["fields"][fld]
            row[fld] = {"value": node["value"], "unit": node["unit"],
                        "value_usd": node["value_usd"],
                        "source_line": node["source_line"]}
        index.append(row)

    out = {
        "description": "Ground truth for three hard-to-locate scalar fields in "
                       "10-K filings. Every value is printed directly in the "
                       "filing; none is computed.",
        "fields": FIELDS,
        "company_count": len(records),
        "companies": records,
        "index": index,
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)

    print("\nParsed %d/%d files." % (len(records), len(files)))
    print("Wrote %s (%.1f KB)" % (OUT, os.path.getsize(OUT) / 1024.0))
    if warns:
        print("\nWarnings (%d):" % len(warns))
        for w in warns:
            print("  " + w)

    print("\n%-9s %-4s %18s %18s %18s" % ("company", "FY", "UTB ending",
                                          "val. allowance", "unrecog RSU cost"))
    print("-" * 74)
    for r in records:
        f = r["fields"]
        def fmt(fld):
            n = f[fld]
            unit = {"USD thousands": "K", "USD millions": "M",
                    "USD billions": "B"}[n["unit"]]
            return "%s%s" % ("{:,}".format(n["value"]), unit)
        print("%-9s %-4s %18s %18s %18s"
              % (r["company_id"], r["fiscal_year"],
                 fmt(FIELDS[0]), fmt(FIELDS[1]), fmt(FIELDS[2])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
