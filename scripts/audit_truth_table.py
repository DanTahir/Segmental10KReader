"""Independently re-verify every recorded value against the source filing text.

This does NOT trust the JSON. For each of the 3 fields x 10 companies it
re-opens the cited filing text and checks:

  1  LINE       the cited source_line really contains the recorded as_printed text
  2  VALUE      the recorded value is a numeric token actually present in that line
  3  COLUMN     for table rows, the value sits at the recorded column_index_of_fy
                (this is the check that catches prior-year / wrong-column reads)
  4  HEADER     the cited column_header line matches, its year order agrees with
                the recorded ASCENDING/DESCENDING, and the year at
                column_index_of_fy equals the record's fiscal_year
  5  DISTINCT   the recorded value differs from the other year-columns in the row,
                so an off-by-one-column read cannot silently pass
  3b PROSE      for non-tabular (prose) fields, the exact printed token (e.g.
                "$1,845 million") is present and parses to the recorded value.
                Without this, any number in a multi-figure sentence passes.
  6  UNITS      value_usd == value x unit multiplier
  7  CITATIONS  every decoy that cites an 'L<number>' line is checked: at least one
                multi-digit number quoted in the decoy must appear on that line

Exit code is nonzero if any check fails.

Usage:  python scripts/audit_truth_table.py [--quiet]
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMPANIES_DIR = os.path.join(ROOT, "TruthTable", "companies")

FIELDS = [
    "utb_gross_ending_balance",
    "dta_valuation_allowance",
    "unrecognized_rsu_comp_cost",
]
MULT = {"USD thousands": 1e3, "USD millions": 1e6, "USD billions": 1e9}

NUM = re.compile(r"\((\d[\d,]*(?:\.\d+)?)\)|(\d[\d,]*(?:\.\d+)?)")
YEAR = re.compile(r"\b(19|20)(\d\d)\b")
LREF = re.compile(r"\bL(\d{2,5})\b")


def norm(s):
    """Normalize unicode dashes/quotes and whitespace for text comparison."""
    if s is None:
        return ""
    for ch in ("\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2212"):
        s = s.replace(ch, "-")
    s = s.replace("\u2019", "'").replace("\u2018", "'")
    s = s.replace("\u201c", '"').replace("\u201d", '"')
    s = s.replace("\ufffd", "")
    return re.sub(r"\s+", " ", s).strip()


def row_numbers(line):
    """Signed numbers from the DATA portion of a table row (after the first '|').

    Splitting on the first pipe is essential: footnote markers in row labels
    such as 'Less valuation allowances (2)' would otherwise parse as -2 and
    shift every column index by one.
    """
    data = line.split("|", 1)[1] if "|" in line else line
    out = []
    for m in NUM.finditer(data):
        neg, pos = m.group(1), m.group(2)
        raw = neg if neg else pos
        try:
            v = float(raw.replace(",", ""))
        except ValueError:
            continue
        out.append(-v if neg else v)
    return out


def all_numbers(text):
    out = []
    for m in NUM.finditer(text):
        raw = m.group(1) or m.group(2)
        try:
            out.append(float(raw.replace(",", "")))
        except ValueError:
            pass
    return out


def digits(tok):
    return len(re.sub(r"[^\d]", "", tok))


def close(a, b):
    return abs(a - b) <= max(0.005, abs(b) * 1e-9)


def main():
    quiet = "--quiet" in sys.argv
    fails, checks = [], 0
    cache = {}

    files = sorted(f for f in os.listdir(COMPANIES_DIR) if f.endswith(".json"))
    for fname in files:
        with open(os.path.join(COMPANIES_DIR, fname), "r", encoding="utf-8") as fh:
            rec = json.load(fh)
        cid = rec["company_id"]
        fy = rec["fiscal_year"]
        rel = rec["source"]["local_text"]
        path = os.path.join(ROOT, rel.replace("/", os.sep))
        if path not in cache:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                cache[path] = fh.read().split("\n")
        lines = cache[path]

        def fail(field, code, msg):
            fails.append("%s.%s [%s] %s" % (cid, field, code, msg))

        if not quiet:
            print("\n%s (FY%s)  %s" % (cid, fy, rel))

        for fld in FIELDS:
            node = rec["fields"][fld]
            val = node["value"]
            sl = node["source_line"]

            # --- 1 LINE -------------------------------------------------
            checks += 1
            if not isinstance(sl, int) or not (1 <= sl <= len(lines)):
                fail(fld, "LINE", "source_line %r out of range" % sl)
                continue
            line = lines[sl - 1]
            nl, na = norm(line), norm(node["as_printed"])
            if nl == na:
                match = "exact"
            elif na and (na in nl or nl in na):
                match = "partial"
            else:
                match = None
                fail(fld, "LINE", "L%d does not contain as_printed.\n      file: %s\n      json: %s"
                     % (sl, nl[:120], na[:120]))

            # --- 2 VALUE ------------------------------------------------
            checks += 1
            present = any(close(abs(n), abs(val)) for n in all_numbers(line))
            if not present:
                fail(fld, "VALUE", "value %s not found among numbers on L%d: %s"
                     % (val, sl, all_numbers(line)[:12]))

            # --- 3 COLUMN + 5 DISTINCT ----------------------------------
            idx = node.get("column_index_of_fy")
            nums = row_numbers(line)
            if isinstance(idx, int) and "|" in line:
                checks += 1
                if idx < 1 or idx > len(nums):
                    fail(fld, "COLUMN", "column_index_of_fy %d outside %d parsed columns %s"
                         % (idx, len(nums), nums[:12]))
                elif not close(nums[idx - 1], val):
                    fail(fld, "COLUMN", "column %d of L%d is %s, but value is %s (columns=%s)"
                         % (idx, sl, nums[idx - 1], val, nums[:12]))
                else:
                    cc = node.get("column_count")
                    if isinstance(cc, int) and len(nums) >= cc >= 2:
                        checks += 1
                        others = [nums[i] for i in range(cc) if i != idx - 1]
                        if any(close(o, val) for o in others):
                            fail(fld, "DISTINCT",
                                 "value %s also appears in another year-column %s; an "
                                 "off-by-one read would pass undetected" % (val, others))

            # --- 3b PROSE ANCHOR ----------------------------------------
            # For prose fields the VALUE check is far too weak on its own: a
            # sentence like Disney's "$79 million and $1,845 million,
            # respectively" contains several amounts, so ANY of them would
            # satisfy VALUE. Mutation testing proved this hole. Every
            # non-tabular field must therefore carry the exact printed token,
            # which pins the value to one specific substring of the sentence.
            tok = node.get("value_printed_token")
            if tok:
                checks += 1
                if norm(tok) not in nl:
                    fail(fld, "PROSE", "value_printed_token %r not present on L%d"
                         % (tok, sl))
                else:
                    tnums = all_numbers(tok)
                    if not tnums or not close(tnums[0], abs(val)):
                        fail(fld, "PROSE", "token %r parses to %s, but recorded value is %s"
                             % (tok, tnums[:3], val))
            elif not (isinstance(idx, int) and "|" in line):
                checks += 1
                fail(fld, "PROSE", "non-tabular field has no value_printed_token anchor, "
                                   "so any number on the line would satisfy VALUE")

            # --- 4 HEADER -----------------------------------------------
            hsl = node.get("column_header_source_line")
            if isinstance(hsl, int):
                checks += 1
                if not (1 <= hsl <= len(lines)):
                    fail(fld, "HEADER", "column_header_source_line %d out of range" % hsl)
                else:
                    hline, hjson = norm(lines[hsl - 1]), norm(node.get("column_header"))
                    if hjson and hjson not in hline and hline not in hjson:
                        fail(fld, "HEADER", "L%d is not the recorded header.\n      file: %s\n      json: %s"
                             % (hsl, hline[:110], hjson[:110]))
                    else:
                        yrs = [int(m.group(0)) for m in YEAR.finditer(hline)]
                        yrs = [y for y in yrs if 1990 <= y <= 2100]
                        if len(yrs) >= 2:
                            checks += 1
                            order = "ASCENDING" if yrs[1] > yrs[0] else "DESCENDING"
                            if node.get("column_order") != order:
                                fail(fld, "HEADER", "header years %s are %s but record says %s"
                                     % (yrs, order, node.get("column_order")))
                            if isinstance(idx, int) and 1 <= idx <= len(yrs):
                                checks += 1
                                if yrs[idx - 1] != fy:
                                    fail(fld, "HEADER",
                                         "column_index_of_fy %d points at header year %d, "
                                         "but record fiscal_year is %d" % (idx, yrs[idx - 1], fy))
            elif node.get("column_order") not in (None, "N/A (prose, not a table)") \
                    and not node.get("column_order_evidence"):
                checks += 1
                fail(fld, "HEADER", "column_order %r asserted with neither a header line "
                                    "nor column_order_evidence" % node.get("column_order"))

            # --- 6 UNITS ------------------------------------------------
            checks += 1
            u = node.get("unit")
            if u not in MULT:
                fail(fld, "UNITS", "unknown unit %r" % u)
            elif not close(node["value_usd"], val * MULT[u]):
                fail(fld, "UNITS", "value_usd %s != %s x %s" % (node["value_usd"], val, u))

            # --- 7 CITATIONS --------------------------------------------
            for d in (node.get("decoys") or []):
                for m in LREF.finditer(d):
                    dl = int(m.group(1))
                    checks += 1
                    if not (1 <= dl <= len(lines)):
                        fail(fld, "CITATION", "decoy cites L%d, out of range" % dl)
                        continue
                    toks = [t for t in re.findall(r"\d[\d,]*(?:\.\d+)?", d)
                            if digits(t) >= 3 and t != m.group(1)]
                    if not toks:
                        continue
                    dline = lines[dl - 1]
                    dnums = all_numbers(dline)
                    hit = False
                    for t in toks:
                        try:
                            tv = float(t.replace(",", ""))
                        except ValueError:
                            continue
                        if any(close(abs(n), abs(tv)) for n in dnums):
                            hit = True
                            break
                    if not hit:
                        fail(fld, "CITATION",
                             "decoy cites L%d but none of %s appear there: %s"
                             % (dl, toks[:5], norm(dline)[:100]))

            if not quiet:
                tag = {"exact": "exact", "partial": "partial", None: "MISMATCH"}[match]
                print("   %-28s %14s %-14s L%-5d col %-4s %s"
                      % (fld, "{:,}".format(val), node.get("unit", "?").replace("USD ", ""),
                         sl, idx if idx else "-", tag))

    print("\n" + "=" * 78)
    if fails:
        print("FAILED: %d of %d checks" % (len(fails), checks))
        for f in fails:
            print("  - " + f)
        return 1
    print("PASS: all %d checks green across %d companies x %d fields"
          % (checks, len(files), len(FIELDS)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
