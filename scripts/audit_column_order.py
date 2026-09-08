"""Column-ordering and citation-coverage diagnostics.

TWO independent worries motivate this:

A) COLUMN ORDER. Filers are not consistent about year ordering (some print
   oldest->newest, others newest->oldest). If a figure was read out of the wrong
   column, the recorded "current year" value is silently a prior-year value.

   Method, which trusts NO note written in the JSON: take a recorded
   current-year anchor figure, find the source line that prints it, tokenize
   every number on that line, and report the anchor's ORDINAL POSITION among
   them. On a three-year row, position 1 => filing is DESCENDING (current year
   first); last position => ASCENDING (current year last). If an anchor lands in
   the middle of a 3-year row, that is a red flag worth reading by hand.

B) CITATION COVERAGE. check_citation_proximity() silently no-ops when an object
   has no sibling figure to probe with. A check that never runs is not evidence,
   so this counts how many citations were actually exercised, per company.

Usage:  python scripts/audit_column_order.py
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audit_truth_table as A  # noqa: E402

ROOT = A.ROOT
NUMTOK = re.compile(r"\(?-?\d[\d,]*(?:\.\d+)?\)?")


def norm_tok(t):
    neg = t.startswith("(") and t.endswith(")")
    t = t.strip("()").replace(",", "")
    try:
        v = float(t)
    except ValueError:
        return None
    return -v if neg else v


def anchors(rec):
    """(label, current_year_value) pairs we can locate in the source text."""
    out = []
    m = rec.get("metrics", {})
    seg = m.get("segment_reporting") or {}
    rev = seg.get("revenue")
    if isinstance(rev, dict):
        for k, v in rev.items():
            if isinstance(v, (int, float)) and A.TOTAL_KEY.search(k) \
                    and not A.CITATION_KEY.search(k):
                out.append(("segment total revenue", v))
                break
    oi = seg.get("operating_income")
    if isinstance(oi, dict):
        for k, v in oi.items():
            if isinstance(v, (int, float)) and A.TOTAL_KEY.search(k) \
                    and not A.CITATION_KEY.search(k):
                out.append(("segment total op income", v))
                break
    tax = m.get("income_taxes") or {}
    for key, lab in (("provision_for_income_taxes", "tax provision"),
                     ("income_before_income_taxes", "pretax income")):
        v = tax.get(key)
        if isinstance(v, (int, float)):
            out.append((lab, v))
    for key, lab in (("provision_for_income_taxes", "tax provision (top)"),
                     ("income_before_income_taxes", "pretax income (top)")):
        v = rec.get(key)
        if isinstance(v, (int, float)) and not any(l == lab for l, _ in out):
            out.append((lab, v))
    return out


def locate(lines, val):
    """Lines printing `val`, with the anchor's ordinal position among numbers."""
    forms = sorted(A.fmt_variants(val), key=len, reverse=True)
    res = []
    for i, ln in enumerate(lines):
        if not any(f in ln for f in forms):
            continue
        toks = [t for t in NUMTOK.findall(ln)]
        vals = [norm_tok(t) for t in toks]
        big = [(j, v) for j, (t, v) in enumerate(zip(toks, vals))
               if v is not None and abs(v) >= 1000]
        if len(big) < 2:
            continue
        pos = None
        for rank, (j, v) in enumerate(big, start=1):
            if abs(abs(v) - abs(val)) < 0.005:
                pos = rank
                break
        if pos is None:
            continue
        res.append((i + 1, pos, len(big), ln.strip()[:100]))
    return res


def declared(rec):
    for path, key, val in A.walk(rec):
        if re.search(r"column_order", key, re.I):
            return True
    return False


def main():
    files = sorted(f for f in os.listdir(A.COMPANIES_DIR) if f.endswith(".json"))
    print("=" * 78)
    print("A) COLUMN ORDER EVIDENCE (from source text; JSON notes not trusted)")
    print("=" * 78)
    verdicts = {}
    for fname in files:
        with open(os.path.join(A.COMPANIES_DIR, fname), "r", encoding="utf-8") as fh:
            rec = json.load(fh)
        cid = rec["company_id"]
        tp = os.path.join(ROOT, rec["source"]["local_text"].replace("/", os.sep))
        if not os.path.exists(tp):
            print("\n%-9s (no local text)" % cid)
            continue
        with open(tp, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().split("\n")
        print("\n%-9s declared_column_order_note=%s" % (cid, declared(rec)))
        seen = []
        for label, val in anchors(rec):
            hits = locate(lines, val)
            if not hits:
                print("   %-26s %-12s not found on a multi-number row" % (label, val))
                continue
            ln, pos, tot, snip = hits[0]
            if pos == 1 and tot >= 2:
                verdict = "DESCENDING(cur first)"
            elif pos == tot and tot >= 2:
                verdict = "ASCENDING(cur last)"
            else:
                verdict = "MIDDLE pos %d/%d <-- INSPECT" % (pos, tot)
            seen.append(verdict.split("(")[0])
            print("   %-26s L%-6d pos %d/%d  %s" % (label, ln, pos, tot, verdict))
            print("       %s" % snip)
        if seen:
            uniq = sorted(set(seen))
            verdicts[cid] = uniq
    print("\n" + "-" * 78)
    print("PER-COMPANY VERDICT SUMMARY")
    print("-" * 78)
    for cid in sorted(verdicts):
        flag = "  <-- MIXED/CHECK" if len(verdicts[cid]) > 1 else ""
        print("  %-9s %s%s" % (cid, ",".join(verdicts[cid]), flag))

    print("\n" + "=" * 78)
    print("B) CITATION PROXIMITY COVERAGE (how many citations were really tested)")
    print("=" * 78)
    tot_cit = tot_probed = 0
    for fname in files:
        with open(os.path.join(A.COMPANIES_DIR, fname), "r", encoding="utf-8") as fh:
            rec = json.load(fh)
        cid = rec["company_id"]
        n_cit = n_probed = 0
        for path, key, val in A.walk(rec):
            if not (re.search(r"source_line$", key, re.I) and isinstance(val, int)):
                continue
            n_cit += 1
            parent = rec
            broke = False
            for part in path.split(".")[:-1]:
                try:
                    if "[" in part:
                        base, idx = part[:-1].split("[")
                        parent = parent[base][int(idx)]
                    else:
                        parent = parent[part]
                except Exception:
                    broke = True
                    break
            if broke or not isinstance(parent, dict):
                continue
            vals = [v for k, v in parent.items()
                    if isinstance(v, (int, float)) and not isinstance(v, bool)
                    and abs(v) >= 1000 and not A.CITATION_KEY.search(k)]
            if vals:
                n_probed += 1
        tot_cit += n_cit
        tot_probed += n_probed
        pct = (100.0 * n_probed / n_cit) if n_cit else 0.0
        print("  %-9s citations=%-3d actually_probed=%-3d (%.0f%%)"
              % (cid, n_cit, n_probed, pct))
    print("\n  TOTAL citations=%d probed=%d (%.0f%%); unprobed ones are structurally"
          % (tot_cit, tot_probed, (100.0 * tot_probed / tot_cit) if tot_cit else 0.0))
    print("  untestable by proximity (no sibling figure) and rely on the")
    print("  in-range + verbatim-quote checks instead.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
