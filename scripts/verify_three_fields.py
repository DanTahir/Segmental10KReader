"""Verify the three proposed scalar fields are findable in ALL 10 filings.

Spec for a good field under the revised plan:
  (a) a single scalar number,
  (b) printed DIRECTLY in the filing (never computed by us),
  (c) genuinely hard to locate -- buried in a note, with near-miss decoys,
  (d) present in all 10 reports.

The first probe under-reported (d) because filers word these lines very
differently (Block: "Unrecognized tax benefit, end of the period"; Apple:
"Ending balances"; Amazon: "income tax contingencies"). This script uses
per-field label VARIANTS and prints every candidate line so (d) can be judged
on evidence rather than on one regex's guess.

Usage:  python scripts/verify_three_fields.py [--all]
"""

import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXT_GLOB = os.path.join(ROOT, "build", "text", "*.txt")
ALL = "--all" in sys.argv

HAS_NUM = re.compile(r"\d")

FIELDS = {
    "A. UTB gross ending balance": [
        r"unrecognized tax benefit[s]?,? (end|ending)",
        r"(balance|balances)[^|]{0,30}(end of|at end)",
        r"ending balance",
        r"^ending balances",
        r"had (gross )?unrecognized tax benefits of",
        r"unrecognized tax benefits (were|totaled|of) ?\$",
        r"accrued liabilities of \$[\d\.]+ (billion|million) for various tax contingencies",
        r"income tax contingencies",
    ],
    "B. DTA valuation allowance (balance)": [
        r"^\s*(less:? )?valuation allowance",
        r"valuation allowance \|",
        r"(total|net) valuation allowance",
        r"valuation allowance of \$",
        r"valuation allowance (was|of|totaling|totaled)",
    ],
    "C. Unrecognized share-based comp cost": [
        r"(unrecognized|unamortized)[^.]{0,60}compensation (cost|expense)",
        r"compensation (cost|expense)[^.]{0,60}not yet (been )?recognized",
        r"total unrecognized compensation",
        r"unrecognized (stock-based |share-based )?compensation",
    ],
}

# Lines that merely mention the concept in policy/risk prose, not the figure.
NOISE = re.compile(
    r"(we recognize|policy is to|more likely than not|two-step|"
    r"risk factor|could (increase|adversely)|see note|refer to note|"
    r"critical audit matter|excludes interest and penalties)", re.I)


def load():
    out = []
    for f in sorted(glob.glob(TEXT_GLOB)):
        name = os.path.basename(f).replace(".txt", "")
        short = re.sub(r"10[kK]?20\d\d$", "", name)[:9]
        with open(f, "r", encoding="utf-8", errors="replace") as fh:
            out.append((short, fh.read().split("\n")))
    return out


def main():
    docs = load()
    print("Verifying 3 candidate fields across %d filings\n" % len(docs))
    summary = {}
    for field, pats in FIELDS.items():
        rxs = [re.compile(p, re.I) for p in pats]
        print("=" * 96)
        print(field)
        print("=" * 96)
        found_all = True
        for short, lines in docs:
            hits = []
            for i, ln in enumerate(lines):
                s = ln.strip()
                if not HAS_NUM.search(s):
                    continue
                if any(r.search(s) for r in rxs):
                    if NOISE.search(s) and len(s) > 300:
                        continue
                    hits.append((i + 1, s))
            if not hits:
                print("  %-9s *** NOT FOUND ***" % short)
                found_all = False
                continue
            show = hits if ALL else hits[:2]
            for j, (ln, txt) in enumerate(show):
                tag = short if j == 0 else ""
                print("  %-9s L%-6d %s" % (tag, ln, txt[:104]))
            if len(hits) > len(show):
                print("  %-9s          (+%d more candidate line(s))"
                      % ("", len(hits) - len(show)))
        summary[field] = found_all
        print()
    print("=" * 96)
    print("UNIVERSALITY SUMMARY")
    print("=" * 96)
    for field, ok in summary.items():
        print("  %-42s %s" % (field, "present in all 10" if ok else "GAPS -- see above"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
