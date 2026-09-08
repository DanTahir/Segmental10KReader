"""Probe which candidate scalar fields are actually present in all 10 filings.

New spec: we want THREE DISTINCT NUMERICAL FIELDS that are
  (a) a single scalar number,
  (b) PRINTED DIRECTLY in the filing (never computed by us),
  (c) hard to locate (buried in a note, with near-miss decoys nearby),
  (d) present in ALL TEN reports, so every company yields a gradeable value.

(d) is the constraint that kills most otherwise-great candidates (e.g. a stated
legal accrual: only Alphabet prints one). This script measures (d) empirically
instead of assuming it, and prints a sample line per company so (b) and (c) can
be eyeballed.

Usage:
  python scripts/probe_candidate_fields.py            # presence matrix
  python scripts/probe_candidate_fields.py --samples  # + one sample line each
"""

import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXT_GLOB = os.path.join(ROOT, "build", "text", "*.txt")
SHOW = "--samples" in sys.argv

NUM = re.compile(r"\(?\$?\s?\d[\d,]*(?:\.\d+)?\)?")

# Each candidate: (short name, regex that should sit ON the line printing the
# number). Deliberately generous, since terminology varies between filers.
CANDIDATES = [
    ("UTB gross ending balance",
     r"(balance|balances?) (at|as of) (the )?(end|beginning)|"
     r"gross unrecognized tax benefits|"
     r"unrecognized tax benefits.*(balance|end of)|"
     r"income tax contingencies"),

    ("UTB if-recognized (affects ETR)",
     r"(if recognized|that if recognized|would (favorably )?(affect|impact|reduce)).*"
     r"(effective tax rate|income tax (expense|provision))|"
     r"(effective tax rate).*(if recognized)"),

    ("UTB accrued interest & penalties",
     r"accrued interest and penalt|interest and penalties (related to|accrued)|"
     r"(accrued|accrual for) interest"),

    ("DTA valuation allowance",
     r"valuation allowance"),

    ("Operating lease liabilities (total)",
     r"(total )?operating lease liabilit"),

    ("Unrecognized share-based comp cost",
     r"(unrecognized|unamortized).{0,40}(compensation (cost|expense))|"
     r"compensation cost.{0,60}not yet recognized"),

    ("Weighted-avg period to recognize SBC",
     r"weighted[- ]average period of|"
     r"over a weighted[- ]average (period|remaining period)"),

    ("Remaining performance obligation",
     r"remaining performance obligation|unsatisfied performance obligation"),

    ("Goodwill (balance)",
     r"^goodwill|total goodwill"),
]


def numbers_on(line):
    out = []
    for t in NUM.findall(line):
        s = t.strip().strip("$ ").replace(",", "")
        neg = s.startswith("(") and s.endswith(")")
        s = s.strip("()")
        try:
            v = float(s)
        except ValueError:
            continue
        if neg:
            v = -v
        out.append(v)
    return out


def main():
    files = sorted(glob.glob(TEXT_GLOB))
    if not files:
        print("No text files found at %s" % TEXT_GLOB)
        return 1
    names = [os.path.basename(f).replace(".txt", "") for f in files]
    short = [re.sub(r"10[kK]?20\d\d$", "", n)[:9] for n in names]

    docs = []
    for f in files:
        with open(f, "r", encoding="utf-8", errors="replace") as fh:
            docs.append(fh.read().split("\n"))

    print("Filings probed: %d\n" % len(files))
    hdr = "%-36s" % "candidate field"
    for s in short:
        hdr += " %-4s" % s[:4]
    hdr += "  universal?"
    print(hdr)
    print("-" * len(hdr))

    results = []
    for label, pat in CANDIDATES:
        rx = re.compile(pat, re.I)
        row = "%-36s" % label[:36]
        per_company = []
        for lines in docs:
            hits = []
            for i, ln in enumerate(lines):
                if rx.search(ln):
                    nums = [v for v in numbers_on(ln) if abs(v) >= 0.1]
                    if nums:
                        hits.append((i + 1, ln.strip()))
            per_company.append(hits)
            row += " %-4s" % (len(hits) if hits else ".")
        universal = all(len(h) > 0 for h in per_company)
        row += "  %s" % ("YES" if universal else "no")
        print(row)
        results.append((label, per_company, universal))

    if SHOW:
        for label, per_company, universal in results:
            print("\n" + "=" * 78)
            print("%s   (universal=%s)" % (label, universal))
            print("=" * 78)
            for s, hits in zip(short, per_company):
                if hits:
                    ln, txt = hits[0]
                    print("  %-9s L%-6d %s" % (s, ln, txt[:110]))
                else:
                    print("  %-9s --- NO NUMERIC HIT ---" % s)

    print("\nUniversal candidates (present with a number in all %d filings):" % len(files))
    for label, _, universal in results:
        if universal:
            print("  * %s" % label)
    return 0


if __name__ == "__main__":
    sys.exit(main())
