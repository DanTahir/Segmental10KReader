"""Print targeted slices of a converted 10-K text file for manual ground-truthing.

Usage:
    python scripts/slice_sections.py <Company> <topic> [width]

topics: legal | segment | tax | grep:<pattern>

Anchors are chosen to land on the *financial statement note* occurrence rather
than the Item 3 / MD&A cross-reference, which is the classic retrieval trap.
"""

import os
import re
import sys

ANCHORS = {
    "legal": [
        r"reasonably possible",
        r"Legal Proceedings",
        r"Commitments and Contingencies",
        r"Loss Contingenc",
    ],
    "segment": [
        r"Segment (Information|Reporting|Results)",
        r"reportable segment",
        r"Reconciliation of.*segment|segment.*[Rr]econcil",
    ],
    "tax": [
        r"statutory federal income tax rate",
        r"unrecognized tax benefits",
        r"Income Taxes",
    ],
}


def main():
    company = sys.argv[1]
    topic = sys.argv[2]
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 45

    path = os.path.join("build", "text", company + ".txt")
    lines = open(path, encoding="utf-8").read().splitlines()

    if topic.startswith("grep:"):
        pats = [topic[5:]]
    else:
        pats = ANCHORS[topic]

    shown = set()
    for pat in pats:
        rx = re.compile(pat, re.I)
        for i, ln in enumerate(lines):
            if not rx.search(ln):
                continue
            lo, hi = max(0, i - 3), min(len(lines), i + width)
            if any(x in shown for x in range(lo, hi)):
                continue
            print(f"\n===== {company} [{pat}] lines {lo+1}-{hi} =====")
            for j in range(lo, hi):
                print(f"{j+1}: {lines[j]}")
                shown.add(j)
            break  # one window per pattern


if __name__ == "__main__":
    main()
