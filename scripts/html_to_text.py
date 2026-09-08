"""Flatten EDGAR inline-XBRL 10-K HTML into text that preserves table structure.

Tables become pipe-delimited rows (one line per <tr>), which keeps row label and
column values on the same line -- essential for reading segment and tax tables,
where naive text extraction interleaves columns and destroys row/column association.
"""

import glob
import html
import os
import re
import sys
from html.parser import HTMLParser

SKIP = {"script", "style", "head"}


class Flattener(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []          # finished lines
        self.cell = []         # text of current cell
        self.row = []          # cells of current row
        self.block = []        # text of current non-table block
        self.tdepth = 0        # table nesting depth
        self.skip = 0

    # -- helpers ----------------------------------------------------------
    def _flush_block(self):
        t = re.sub(r"[ \t\u00a0]+", " ", "".join(self.block)).strip()
        if t:
            self.out.append(t)
        self.block = []

    def _flush_cell(self):
        t = re.sub(r"[ \t\u00a0]+", " ", "".join(self.cell)).strip()
        self.cell = []
        self.row.append(t)

    def _flush_row(self):
        if self.cell:
            self._flush_cell()
        cells = [c for c in self.row]
        self.row = []
        # drop rows that are entirely empty/decorative
        if any(c for c in cells):
            self.out.append(" | ".join(cells))

    # -- parser callbacks -------------------------------------------------
    def handle_starttag(self, tag, attrs):
        if tag in SKIP:
            self.skip += 1
            return
        if tag == "table":
            self._flush_block()
            self.tdepth += 1
            self.out.append("<<<TABLE>>>")
        elif tag == "tr" and self.tdepth:
            if self.cell or self.row:
                self._flush_row()
        elif tag in ("td", "th") and self.tdepth:
            if self.cell:
                self._flush_cell()
        elif tag in ("p", "div", "br", "li", "h1", "h2", "h3", "h4") and not self.tdepth:
            self._flush_block()

    def handle_endtag(self, tag):
        if tag in SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if tag == "table" and self.tdepth:
            self._flush_row()
            self.tdepth -= 1
            self.out.append("<<<END TABLE>>>")
        elif tag == "tr" and self.tdepth:
            self._flush_row()
        elif tag in ("td", "th") and self.tdepth:
            self._flush_cell()
        elif tag in ("p", "div", "li") and not self.tdepth:
            self._flush_block()

    def handle_data(self, data):
        if self.skip:
            return
        (self.cell if self.tdepth else self.block).append(data)

    def result(self):
        self._flush_row()
        self._flush_block()
        lines = []
        for ln in self.out:
            # collapse runs of empty pipe cells: "| | | |" -> "|"
            ln = re.sub(r"(\|\s*){2,}", "| ", ln).strip()
            ln = ln.strip("| ").strip() if ln.strip("| ").strip() == "" else ln
            if ln:
                lines.append(ln)
        text = "\n".join(lines)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text


def convert(path, outdir):
    with open(path, "rb") as f:
        raw = f.read()
    doc = raw.decode("utf-8", "replace")
    p = Flattener()
    p.feed(doc)
    text = p.result()
    base = os.path.basename(path).replace(".html", ".txt")
    out = os.path.join(outdir, base)
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    return out, len(text.splitlines())


if __name__ == "__main__":
    outdir = os.path.join("build", "text")
    os.makedirs(outdir, exist_ok=True)
    for p in sorted(glob.glob(os.path.join("build", "filings", "*.html"))):
        out, n = convert(p, outdir)
        print(f"{os.path.basename(out):28s} {n:7d} lines")
