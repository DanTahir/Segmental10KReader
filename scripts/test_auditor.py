"""Mutation-test the auditor: prove it actually FAILS on corrupted records.

A green audit run only means something if the auditor can go red. This copies
the real records to a temp dir, applies one deliberate corruption at a time --
each modelled on a mistake genuinely made or nearly made while building this
table -- and asserts the auditor rejects it with the expected check code.

A mutation that survives (auditor still passes) is a hole in the auditor and is
reported as a test failure.

Usage:  python scripts/test_auditor.py
"""

import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REAL_DIR = os.path.join(ROOT, "TruthTable", "companies")
AUDITOR = os.path.join(ROOT, "scripts", "audit_truth_table.py")


def mutate_value(rec, fld, new):
    rec["fields"][fld]["value"] = new
    unit = rec["fields"][fld]["unit"]
    mult = {"USD thousands": 1e3, "USD millions": 1e6, "USD billions": 1e9}[unit]
    rec["fields"][fld]["value_usd"] = new * mult
    return rec


# Each mutation: (label, company file, mutator, expected check code)
MUTATIONS = [
    ("Alphabet field B read from the FY2024 column (the ascending-order trap "
     "that actually bit during construction): -13942 -> -11493",
     "alphabet_fy2025.json",
     lambda r: mutate_value(r, "dta_valuation_allowance", -11493), "COLUMN"),

    ("Alphabet field A read from the middle column: 11512 -> 12619",
     "alphabet_fy2025.json",
     lambda r: mutate_value(r, "utb_gross_ending_balance", 12619), "COLUMN"),

    ("Alphabet column_order mislabelled DESCENDING while header is 2024|2025",
     "alphabet_fy2025.json",
     lambda r: r["fields"]["dta_valuation_allowance"].update(
         {"column_order": "DESCENDING"}) or r, "HEADER"),

    ("Apple field A pointed at the Shareholders' Equity 'Ending balances' row "
     "(same row label, different statement): L939 -> L631",
     "apple_fy2025.json",
     lambda r: r["fields"]["utb_gross_ending_balance"].update(
         {"source_line": 631}) or r, "LINE"),

    ("Apple field A swapped to the equity-statement figure: 23242 -> 93568",
     "apple_fy2025.json",
     lambda r: mutate_value(r, "utb_gross_ending_balance", 93568), "VALUE"),

    ("Coinbase field A set to the if-recognized amount (the error actually made "
     "and caught during construction): 190944 -> 136800",
     "coinbase_fy2024.json",
     lambda r: mutate_value(r, "utb_gross_ending_balance", 136800), "VALUE"),

    ("Coinbase field A pointed at the valuation-allowance rollforward, which "
     "shares the row label 'Balance, end of period': L2978 -> L2961",
     "coinbase_fy2024.json",
     lambda r: r["fields"]["utb_gross_ending_balance"].update(
         {"source_line": 2961}) or r, "LINE"),

    ("Meta field B set to the rate-reconciliation decoy 11,974",
     "meta_fy2025.json",
     lambda r: mutate_value(r, "dta_valuation_allowance", -11974), "VALUE"),

    ("Disney field C set to the option figure with the prose anchor left intact "
     "(the hole mutation testing originally exposed): 1845 -> 79",
     "disney_fy2025.json",
     lambda r: mutate_value(r, "unrecognized_rsu_comp_cost", 79), "PROSE"),

    ("Netflix field C prose anchor deleted, leaving VALUE unpinned",
     "netflix_fy2025.json",
     lambda r: r["fields"]["unrecognized_rsu_comp_cost"].pop(
         "value_printed_token", None) and r, "PROSE"),

    ("Apple field C anchor points at a token absent from the sentence",
     "apple_fy2025.json",
     lambda r: r["fields"]["unrecognized_rsu_comp_cost"].update(
         {"value_printed_token": "$21.9 billion"}) or r, "PROSE"),

    ("Disney field B sign flipped to match the other nine filers: 2931 -> -2931",
     "disney_fy2025.json",
     lambda r: mutate_value(r, "dta_valuation_allowance", -2931), "COLUMN"),

    ("Netflix field A unit changed thousands -> millions (the mixed-unit trap)",
     "netflix_fy2025.json",
     lambda r: r["fields"]["utb_gross_ending_balance"].update(
         {"unit": "USD millions"}) or r, "UNITS"),

    ("Schwab field A pointed at the allowance-for-credit-losses rollforward "
     "('Balance at end of period'): L2868 -> L749",
     "schwab_fy2025.json",
     lambda r: r["fields"]["utb_gross_ending_balance"].update(
         {"source_line": 749}) or r, "LINE"),

    ("Schwab field B read from the prior-year column: -27 -> -20",
     "schwab_fy2025.json",
     lambda r: mutate_value(r, "dta_valuation_allowance", -20), "COLUMN"),

    ("Dropbox field A read from the prior fiscal year: 162.7 -> 149.8",
     "dropbox_fy2024.json",
     lambda r: mutate_value(r, "utb_gross_ending_balance", 149.8), "COLUMN"),

    ("Dropbox field C set to the Co-Founder Grant zero decoy",
     "dropbox_fy2024.json",
     lambda r: mutate_value(r, "unrecognized_rsu_comp_cost", 0), "VALUE"),

    ("Block field A column_index_of_fy shifted 1 -> 2 (prior year)",
     "block_fy2025.json",
     lambda r: r["fields"]["utb_gross_ending_balance"].update(
         {"column_index_of_fy": 2}) or r, "COLUMN"),

    ("Amazon field B read from the FY2024 column: -5560 -> -4893",
     "amazon_fy2025.json",
     lambda r: mutate_value(r, "dta_valuation_allowance", -4893), "COLUMN"),

    ("Amazon field A value_usd inflated by 1000x",
     "amazon_fy2025.json",
     lambda r: r["fields"]["utb_gross_ending_balance"].update(
         {"value_usd": 6600000000000}) or r, "UNITS"),

    ("Coinbase fiscal_year mislabelled 2025 (the PDF-filename trap), so the "
     "header year no longer matches the record",
     "coinbase_fy2024.json",
     lambda r: r.update({"fiscal_year": 2025}) or r, "HEADER"),

    ("Meta field A decoy citation pointed at a line that lacks the number",
     "meta_fy2025.json",
     lambda r: r["fields"]["utb_gross_ending_balance"].update(
         {"decoys": ["L1234 'net uncertain tax positions of $11.23 billion'"]}) or r,
     "CITATION"),
]


def run_auditor(companies_dir):
    """Run the auditor against a swapped-in companies dir. Returns (rc, output)."""
    backup = tempfile.mkdtemp(prefix="tt_backup_")
    bpath = os.path.join(backup, "companies")
    shutil.move(REAL_DIR, bpath)
    try:
        shutil.copytree(companies_dir, REAL_DIR)
        p = subprocess.Popen([sys.executable, AUDITOR, "--quiet"],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        out, _ = p.communicate()
        rc = p.returncode
    finally:
        if os.path.isdir(REAL_DIR):
            shutil.rmtree(REAL_DIR)
        shutil.move(bpath, REAL_DIR)
        shutil.rmtree(backup, ignore_errors=True)
    return rc, out.decode("utf-8", "replace")


def main():
    print("Mutation-testing the auditor (%d mutations)\n" % len(MUTATIONS))

    pristine = tempfile.mkdtemp(prefix="tt_pristine_")
    shutil.rmtree(pristine)
    shutil.copytree(REAL_DIR, pristine)

    # Control: unmutated records must PASS, else every mutation result is noise.
    rc, out = run_auditor(pristine)
    if rc != 0:
        print("CONTROL FAILED: the auditor rejects the real records.")
        print(out)
        shutil.rmtree(pristine, ignore_errors=True)
        return 1
    print("control (unmutated records): auditor PASSES as expected\n")

    survivors, wrongcode, killed = [], [], 0
    for label, fname, mut, expect in MUTATIONS:
        work = tempfile.mkdtemp(prefix="tt_mut_")
        shutil.rmtree(work)
        shutil.copytree(pristine, work)
        target = os.path.join(work, fname)
        with open(target, "r", encoding="utf-8") as fh:
            rec = json.load(fh)
        rec = mut(copy.deepcopy(rec))
        with open(target, "w", encoding="utf-8") as fh:
            json.dump(rec, fh, indent=2, ensure_ascii=False)

        rc, out = run_auditor(work)
        shutil.rmtree(work, ignore_errors=True)

        if rc == 0:
            survivors.append(label)
            print("  SURVIVED  %s" % label)
        elif ("[%s]" % expect) not in out:
            codes = sorted(set(t.split("]")[0] for t in out.split("[")[1:]
                               if "]" in t and t.split("]")[0].isupper()))
            wrongcode.append((label, expect, codes))
            print("  caught, WRONG CODE (want %s, got %s)  %s" % (expect, codes, label))
        else:
            killed += 1
            print("  killed [%-8s] %s" % (expect, label))

    shutil.rmtree(pristine, ignore_errors=True)

    print("\n" + "=" * 78)
    print("killed %d/%d   survived %d   wrong-code %d"
          % (killed, len(MUTATIONS), len(survivors), len(wrongcode)))
    if survivors:
        print("\nMUTATIONS THE AUDITOR MISSED (auditor holes):")
        for s in survivors:
            print("  - " + s)
    if wrongcode:
        print("\nCaught by the wrong check (auditor imprecision):")
        for lbl, exp, got in wrongcode:
            print("  - want %s, got %s :: %s" % (exp, got, lbl))
    return 0 if not survivors and not wrongcode else 1


if __name__ == "__main__":
    sys.exit(main())
