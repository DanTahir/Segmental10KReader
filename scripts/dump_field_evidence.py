"""Dump the exact source evidence for the three target fields, all 10 filings.

Purpose: transcription safety. For each field this prints the surrounding
<<<TABLE>>> header (so the YEAR-COLUMN ORDER is visible and never guessed) plus
the exact row/sentence, with line numbers. Everything typed into the JSON
records is copied from this output.

Fields:
  A  gross unrecognized tax benefits -- ENDING balance
  B  deferred tax asset VALUATION ALLOWANCE -- balance
  C  unrecognized/unamortized RSU compensation cost

Usage:  python scripts/dump_field_evidence.py [A|B|C|all]
"""

import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXT_GLOB = os.path.join(ROOT, "build", "text", "*.txt")
WHICH = (sys.argv[1].upper() if len(sys.argv) > 1 else "ALL")

A_ROW = re.compile(
    r"(ending (gross )?unrecognized tax benefits|"
    r"unrecognized tax benefit,? end of the period|"
    r"balance,? (at )?(the )?end of (the )?(year|period|fiscal year)|"
    r"^ending balances|"
    r"balance of gross unrecognized tax benefits at the end)", re.I)
A_PROSE = re.compile(
    r"(had (approximately )?\$?[\d\.,]+ ?(billion|million)? ?(of )?"
    r"(gross )?(unrecognized tax benefits|income tax contingencies)|"
    r"unrecognized tax benefits totaled|"
    r"total amount of gross unrecognized tax benefits was|"
    r"of income tax contingencies)", re.I)

B_ROW = re.compile(r"^\s*(less:?\s*)?valuation allowances?\s*(\(\d\))?\s*\|", re.I)
B_CONTEXT = re.compile(r"deferred tax asset", re.I)

C_SENT = re.compile(
    r"(unrecognized|unamortized)[^.]{0,120}"
    r"(compensation (cost|expense))|"
    r"(compensation (cost|expense))[^.]{0,80}(not yet been recognized)", re.I)


def table_header_for(lines, idx, back=40):
    """Walk back to the enclosing <<<TABLE>>> and return its header lines."""
    start = None
    for i in range(idx, max(-1, idx - back), -1):
        if "<<<TABLE>>>" in lines[i]:
            start = i
            break
    if start is None:
        return []
    out = []
    for j in range(start + 1, min(len(lines), start + 6)):
        s = lines[j].strip()
        if not s:
            continue
        # A header row is one that names years / periods rather than data.
        if re.search(r"(19|20)\d\d", s) and not re.search(r"\|\s*\$?\s*[\d,]{4,}", s):
            out.append((j + 1, s))
        elif s.startswith("|") and re.search(r"(19|20)\d\d", s):
            out.append((j + 1, s))
        if len(out) >= 2:
            break
    return out


def main():
    files = sorted(glob.glob(TEXT_GLOB))
    for f in files:
        name = os.path.basename(f).replace(".txt", "")
        with open(f, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().split("\n")
        print("\n" + "#" * 100)
        print("# %s   (%d lines)" % (name, len(lines)))
        print("#" * 100)

        if WHICH in ("A", "ALL"):
            print("\n-- A: gross UTB ENDING balance ------------------------------")
            shown = 0
            for i, ln in enumerate(lines):
                s = ln.strip()
                if A_ROW.search(s) and re.search(r"\d", s):
                    hdr = table_header_for(lines, i)
                    for hl, ht in hdr:
                        print("   hdr L%-6d %s" % (hl, ht[:150]))
                    print("   ROW L%-6d %s" % (i + 1, s[:150]))
                    shown += 1
                    if shown >= 3:
                        break
            for i, ln in enumerate(lines):
                s = ln.strip()
                if A_PROSE.search(s) and len(s) < 700:
                    print("   PRO L%-6d %s" % (i + 1, s[:260]))
                    break

        if WHICH in ("B", "ALL"):
            print("\n-- B: DTA valuation allowance balance -----------------------")
            shown = 0
            for i, ln in enumerate(lines):
                s = ln.strip()
                if B_ROW.search(s):
                    ctx = " ".join(lines[max(0, i - 25):i])
                    if not B_CONTEXT.search(ctx):
                        continue
                    hdr = table_header_for(lines, i)
                    for hl, ht in hdr:
                        print("   hdr L%-6d %s" % (hl, ht[:150]))
                    print("   ROW L%-6d %s" % (i + 1, s[:150]))
                    # show the neighbouring total lines for orientation
                    for j in (i - 1, i + 1):
                        if 0 <= j < len(lines) and lines[j].strip():
                            print("       L%-6d %s" % (j + 1, lines[j].strip()[:130]))
                    shown += 1
                    if shown >= 2:
                        break
            if shown == 0:
                print("   *** no DTA-context valuation allowance row found ***")

        if WHICH in ("C", "ALL"):
            print("\n-- C: unrecognized/unamortized RSU comp cost ----------------")
            shown = 0
            for i, ln in enumerate(lines):
                s = ln.strip()
                if C_SENT.search(s) and re.search(r"\$?\s?\d", s):
                    if len(s) > 900:
                        continue
                    print("   SENT L%-5d %s" % (i + 1, s[:420]))
                    shown += 1
                    if shown >= 4:
                        break
            if shown == 0:
                print("   *** not found ***")
    return 0


if __name__ == "__main__":
    sys.exit(main())
