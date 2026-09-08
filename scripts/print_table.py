"""Print the full <<<TABLE>>> block(s) containing a line matching an anchor regex.

Usage:
    python scripts/print_table.py <Company> <anchor-regex> [--which N] [--width N]

Printing the WHOLE table block (including its header rows) is what makes column/
year association verifiable -- a bare grep of a number can't tell you which
fiscal-year column it came from.
"""

import os
import re
import sys


def blocks(lines):
    """Yield (start_idx, end_idx) for each table block."""
    start = None
    for i, ln in enumerate(lines):
        if ln.strip() == "<<<TABLE>>>":
            start = i
        elif ln.strip() == "<<<END TABLE>>>" and start is not None:
            yield start, i
            start = None


def main():
    company = sys.argv[1]
    anchor = sys.argv[2]
    which = None
    width = 220
    if "--which" in sys.argv:
        which = int(sys.argv[sys.argv.index("--which") + 1])
    if "--width" in sys.argv:
        width = int(sys.argv[sys.argv.index("--width") + 1])

    path = os.path.join("build", "text", company + ".txt")
    lines = open(path, encoding="utf-8").read().splitlines()
    rx = re.compile(anchor, re.I)

    hits = []
    for s, e in blocks(lines):
        if any(rx.search(lines[j]) for j in range(s, e)):
            hits.append((s, e))

    if not hits:
        print(f"!! NO TABLE BLOCK matching /{anchor}/ in {company}")
        # fall back: show plain matching lines so we can see what's there
        for i, ln in enumerate(lines):
            if rx.search(ln):
                print(f"  (loose) {i+1}: {ln[:width]}")
        return

    sel = hits if which is None else [hits[which - 1]]
    for s, e in sel:
        print(f"\n===== {company}: table block lines {s+1}-{e+1} "
              f"(anchor /{anchor}/, {len(hits)} block(s) matched) =====")
        for j in range(s + 1, e):
            ln = lines[j].strip()
            if ln:
                print(f"{j+1}: {ln[:width]}")


if __name__ == "__main__":
    main()
