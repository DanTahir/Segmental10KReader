"""Resolve each 10-K PDF in Reports10K/ to its matching EDGAR HTML filing.

Matching is done on (CIK, form=10-K, periodOfReport) where periodOfReport comes
from the fiscal-year-ended date printed on the PDF cover page -- NOT from the
PDF filename, which is unreliable (Coinbase/Dropbox are named 2025 but are FY2024).
"""

import json
import os
import time
import urllib.request

UA = "Segmental10KReader research contact@example.com"
OUT = os.path.join("build", "filings")

# pdf basename -> (cik, period_of_report from cover page, label)
TARGETS = [
    ("Alphabet10K2025",  "1652044", "2025-12-31", "Alphabet Inc."),
    ("Amazon10K2025",    "1018724", "2025-12-31", "Amazon.com, Inc."),
    ("Apple10k2025",      "320193", "2025-09-27", "Apple Inc."),
    ("BlockInc10k2025",  "1512673", "2025-12-31", "Block, Inc."),
    ("Coinbase10k2025",  "1679788", "2024-12-31", "Coinbase Global, Inc."),
    ("Disney10k2025",    "1744489", "2025-09-27", "The Walt Disney Company"),
    ("Dropbox10k2025",   "1467623", "2024-12-31", "Dropbox, Inc."),
    ("Meta10k2025",      "1326801", "2025-12-31", "Meta Platforms, Inc."),
    ("Netflix10k2025",   "1065280", "2025-12-31", "Netflix, Inc."),
    ("Schwab10k2025",     "316709", "2025-12-31", "The Charles Schwab Corporation"),
]


def get(url, binary=False):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept-Encoding": "gzip, deflate",
        "Host": "www.sec.gov" if "www.sec.gov" in url else "data.sec.gov",
    })
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    if raw[:2] == b"\x1f\x8b":
        import gzip
        raw = gzip.decompress(raw)
    return raw if binary else raw.decode("utf-8", "replace")


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = []

    for base, cik, period, label in TARGETS:
        rec = {"pdf": base, "cik": cik, "expected_period": period, "label": label}
        try:
            subs = json.loads(get(f"https://data.sec.gov/submissions/CIK{cik.zfill(10)}.json"))
            rec["edgar_entity"] = subs.get("name")
            recent = subs["filings"]["recent"]
            hit = None
            for i, form in enumerate(recent["form"]):
                if form != "10-K":
                    continue
                if recent["reportDate"][i] == period:
                    hit = i
                    break
            if hit is None:
                # fall back: list what 10-K periods DO exist so we can reconcile
                rec["error"] = "no 10-K matching expected period"
                rec["available_periods"] = [
                    recent["reportDate"][i]
                    for i, f in enumerate(recent["form"]) if f == "10-K"
                ][:6]
            else:
                acc = recent["accessionNumber"][hit].replace("-", "")
                doc = recent["primaryDocument"][hit]
                rec["accession"] = recent["accessionNumber"][hit]
                rec["filing_date"] = recent["filingDate"][hit]
                rec["period_of_report"] = recent["reportDate"][hit]
                rec["url"] = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc}/{doc}"
                html = get(rec["url"], binary=True)
                path = os.path.join(OUT, base + ".html")
                with open(path, "wb") as f:
                    f.write(html)
                rec["html_path"] = path
                rec["html_bytes"] = len(html)
        except Exception as e:
            rec["error"] = f"{type(e).__name__}: {e}"

        print(json.dumps(rec, indent=None)[:300], flush=True)
        manifest.append(rec)
        time.sleep(0.4)  # SEC fair-access rate limit

    with open(os.path.join("build", "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    ok = sum(1 for r in manifest if r.get("html_path"))
    print(f"\n=== {ok}/{len(manifest)} filings downloaded")


if __name__ == "__main__":
    main()
