"""Per-citation verification: does each source_line actually point at its claim?

audit_truth_table.py only proves a citation is IN RANGE, plus (for verbatim
quotes) that the quoted string exists somewhere. Neither is the same as "the
cited line supports the specific field that cites it". This script grades every
`*source_line` / `*source_lines` citation individually and prints a verdict, so
citation drift cannot hide behind an aggregate pass count.

Grading, in priority order, within a +/-WINDOW line neighbourhood:
  NUM   - a sibling numeric value from the citing object appears there
  QUOTE - a sibling verbatim quote's opening words appear there
  LABEL - label words derived from the field/key name appear there
  MISS  - none of the above  -> needs a human look

Usage:  python scripts/audit_citations.py [--window N] [--verbose]
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audit_truth_table as A  # noqa: E402

WINDOW = 6
VERBOSE = "--verbose" in sys.argv
if "--window" in sys.argv:
    WINDOW = int(sys.argv[sys.argv.index("--window") + 1])

STOP = set("""the a an of and or for to in on at by with from as is are was were
be been value amount amounts total source line lines note notes unit units
percent fy2025 fy2024 fy2023 check checks quote verbatim printed as_printed
count status why hard trap traps confidence""".split())


def words(s):
    return [w for w in re.split(r"[^a-z0-9]+", s.lower()) if w and w not in STOP]


def parse_lines_field(v):
    """'2758-2766' or '877-885' or 2767 -> list of ints."""
    if isinstance(v, int):
        return [v]
    if isinstance(v, str):
        m = re.match(r"^\s*(\d+)\s*[-\u2013]\s*(\d+)\s*$", v)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if b >= a and b - a < 400:
                return list(range(a, b + 1))
        if re.match(r"^\s*\d+\s*$", v):
            return [int(v)]
    return []


def resolve_parent(rec, path):
    node = rec
    for part in path.split(".")[:-1]:
        try:
            if "[" in part:
                base, idx = part[:-1].split("[")
                node = node[base][int(idx)] if base else node[int(idx)]
            else:
                node = node[part]
        except Exception:
            return None
    return node


def main():
    files = sorted(f for f in os.listdir(A.COMPANIES_DIR) if f.endswith(".json"))
    grand = {"NUM": 0, "QUOTE": 0, "LABEL": 0, "MISS": 0, "OOR": 0}
    misses = []
    print("Per-citation verification (window +/-%d lines)\n" % WINDOW)
    for fname in files:
        with open(os.path.join(A.COMPANIES_DIR, fname), "r", encoding="utf-8") as fh:
            rec = json.load(fh)
        cid = rec["company_id"]
        tp = os.path.join(A.ROOT, rec["source"]["local_text"].replace("/", os.sep))
        if not os.path.exists(tp):
            print("%-9s NO LOCAL TEXT" % cid)
            continue
        with open(tp, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().split("\n")
        n = len(lines)
        tally = {"NUM": 0, "QUOTE": 0, "LABEL": 0, "MISS": 0, "OOR": 0}
        for path, key, val in A.walk(rec):
            if not re.search(r"source_lines?$", key, re.I):
                continue
            cited = parse_lines_field(val)
            if not cited:
                continue
            if any(c < 1 or c > n for c in cited):
                tally["OOR"] += 1
                grand["OOR"] += 1
                misses.append((cid, path, val, "OUT OF RANGE"))
                continue
            lo = max(0, min(cited) - 1 - WINDOW)
            hi = min(n, max(cited) + WINDOW)
            window = " ".join(lines[lo:hi])
            wl = window.lower()
            parent = resolve_parent(rec, path)
            verdict = "MISS"
            if isinstance(parent, dict):
                nums = [v for k, v in parent.items()
                        if isinstance(v, (int, float)) and not isinstance(v, bool)
                        and not A.CITATION_KEY.search(k) and abs(v) >= 100]
                for v in nums:
                    if any(f in window for f in A.fmt_variants(v)):
                        verdict = "NUM"
                        break
                if verdict == "MISS":
                    for k, v in parent.items():
                        if isinstance(v, str) and len(v) > 40 and \
                                re.search(r"quote|as_printed|printed", k, re.I):
                            head = A.norm_ws(v)[:45].lower()
                            if head and head in A.norm_ws(window).lower():
                                verdict = "QUOTE"
                                break
            if verdict == "MISS":
                base = key
                base = re.sub(r"_source_lines?$", "", base)
                cand = words(base) + words(path.split(".")[-2] if "." in path else "")
                hits = [w for w in cand if len(w) > 3 and w in wl]
                if hits:
                    verdict = "LABEL"
            tally[verdict] += 1
            grand[verdict] += 1
            if verdict == "MISS":
                misses.append((cid, path, val, "no num/quote/label nearby"))
            if VERBOSE:
                print("  %-9s %-6s %-58s %s" % (cid, verdict, path[:58], val))
        print("%-9s NUM=%-3d QUOTE=%-3d LABEL=%-3d MISS=%-3d OOR=%-3d"
              % (cid, tally["NUM"], tally["QUOTE"], tally["LABEL"],
                 tally["MISS"], tally["OOR"]))
    tot = sum(grand.values())
    print("\nTOTAL citations graded: %d" % tot)
    for k in ("NUM", "QUOTE", "LABEL", "MISS", "OOR"):
        print("  %-6s %3d  (%.0f%%)" % (k, grand[k], 100.0 * grand[k] / tot if tot else 0))
    supported = grand["NUM"] + grand["QUOTE"] + grand["LABEL"]
    print("\nSupported by evidence at the cited location: %d/%d (%.0f%%)"
          % (supported, tot, 100.0 * supported / tot if tot else 0))
    if misses:
        print("\n--- NEEDS HUMAN LOOK (%d) ---" % len(misses))
        for cid, path, val, why in misses:
            print("  %-9s %-60s cited=%-10s %s" % (cid, path[:60], val, why))
    return 1 if grand["OOR"] else 0


if __name__ == "__main__":
    sys.exit(main())
