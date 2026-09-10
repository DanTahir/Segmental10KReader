/**
 * Visual evidence for an extracted statistic: a rendered image of the PDF page
 * the value came from, plus the coordinates needed to highlight the exact figure
 * on it.
 *
 * The join problem
 * ----------------
 * The extractor works on pdftotext's TEXT output, which carries no geometry --
 * a line index cannot be drawn onto a page. Geometry therefore comes from a
 * second, independent conversion (`pdftotext -bbox-layout`), which reports a
 * bounding box for every word. The two views share no coordinate system and no
 * line numbering, so they are joined by CONTENT: find the word on the cited
 * page whose printed digits equal the extracted value, and when a page prints
 * that same number more than once, disambiguate by how well the candidate
 * word's own line matches the snippet the extractor quoted.
 *
 * That join is deliberately allowed to be imperfect and says so: every result
 * carries a confidence, and a page that renders but yields no located figure is
 * still returned (image, no box) rather than being silently dropped.
 *
 * Coordinates
 * -----------
 * Boxes are stored as FRACTIONS of the page, not pixels. One record then
 * overlays correctly on a 150px thumbnail and on a full-size view without
 * rescaling, and stays correct if RENDER_DPI ever changes.
 *
 * Tooling
 * -------
 * Everything here is best-effort. It needs poppler's `pdftoppm` plus a
 * `pdftotext` built with `-bbox-layout`, and that is NOT the same binary the
 * extractor depends on: xpdf's pdftotext provides the `-table` mode extraction
 * requires but supports neither bbox output nor rendering, while poppler's
 * supports both but has no `-table`. A machine can therefore extract without
 * being able to produce evidence. Every failure path returns null and leaves
 * the run otherwise untouched.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./pdftext";
import type { Evidence, EvidenceRect, Extracted } from "./types";

const EVIDENCE_DIR = path.join(DATA_DIR, "evidence");

/**
 * 110dpi renders a US Letter page to 935x1210 -- readable when opened full
 * size, ~330KB on disk, ~0.4s to produce. Higher costs run time and disk for
 * detail the UI never shows.
 */
const RENDER_DPI = 110;

// -------------------------------------------------------------- binary lookup

const SEARCH_DIRS = [
  "/usr/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "C:\\Program Files\\poppler\\Library\\bin",
  "C:\\Program Files\\poppler\\bin",
];

function candidatePaths(name: string, envVar: string): string[] {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const out: string[] = [];
  const fromEnv = process.env[envVar];
  if (fromEnv) out.push(fromEnv);
  out.push(name); // whatever is on PATH
  for (const dir of SEARCH_DIRS) out.push(path.join(dir, exe));
  return out;
}

/**
 * Run a binary purely to read its banner/usage text.
 *
 * spawnSync rather than execFileSync, because the identifying text may arrive
 * on either stream with either exit status and all four combinations occur in
 * the wild: poppler 24.08 prints `pdftoppm -v` and `pdftotext -h` to *stderr*
 * while exiting *zero*, whereas some xpdf builds exit non-zero for the same
 * flags. execFileSync returns stdout alone on success and only exposes stderr
 * by throwing, so a zero-exit-to-stderr tool reads as empty output and gets
 * misdetected as missing. Concatenating both streams unconditionally is the
 * only check that holds across builds.
 *
 * Only a genuine spawn failure (ENOENT) means "not installed"; that is reported
 * by throwing, so callers can skip the candidate.
 */
function probe(bin: string, args: string[]): string {
  const res = spawnSync(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

let ppmBin: { v: string | null } | undefined;
let bboxBin: { v: string | null } | undefined;

function resolvePdfToPpm(): string | null {
  if (ppmBin !== undefined) return ppmBin.v;
  for (const cand of candidatePaths("pdftoppm", "PDFTOPPM_PATH")) {
    try {
      if (/pdftoppm/i.test(probe(cand, ["-v"]))) {
        ppmBin = { v: cand };
        return cand;
      }
    } catch {
      // not this one
    }
  }
  ppmBin = { v: null };
  return null;
}

/**
 * Find a pdftotext that actually supports `-bbox-layout`.
 *
 * A deliberately separate env var from PDFTOTEXT_PATH: that one may legitimately
 * point at an xpdf build (for `-table`), which would fail here. Capability is
 * verified from the usage text rather than assumed from the name.
 */
function resolveBboxTool(): string | null {
  if (bboxBin !== undefined) return bboxBin.v;
  for (const cand of candidatePaths("pdftotext", "PDFTOTEXT_BBOX_PATH")) {
    try {
      if (/-bbox-layout/.test(probe(cand, ["-h"]))) {
        bboxBin = { v: cand };
        return cand;
      }
    } catch {
      // not this one
    }
  }
  bboxBin = { v: null };
  return null;
}

/** Whether this machine can produce evidence at all. */
export function evidenceAvailable(): boolean {
  return resolvePdfToPpm() !== null && resolveBboxTool() !== null;
}

// ------------------------------------------------------------- bbox parsing

interface BBoxWord {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
}

interface BBoxLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  words: BBoxWord[];
  text: string;
}

interface BBoxPage {
  widthPt: number;
  heightPt: number;
  lines: BBoxLine[];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (m, g: string) => {
    if (g.startsWith("#")) return String.fromCharCode(Number(g.slice(1)));
    return ENTITIES[g] ?? m;
  });
}

const LINE_RE =
  /<line\s+xMin="([-\d.]+)"\s+yMin="([-\d.]+)"\s+xMax="([-\d.]+)"\s+yMax="([-\d.]+)"\s*>([\s\S]*?)<\/line>/g;
const WORD_RE =
  /<word\s+xMin="([-\d.]+)"\s+yMin="([-\d.]+)"\s+xMax="([-\d.]+)"\s+yMax="([-\d.]+)"\s*>([\s\S]*?)<\/word>/g;

/**
 * Pull page size and word boxes out of pdftotext's bbox XHTML.
 *
 * Regex rather than an XML parser: the input is machine-generated, the shape is
 * fixed, and only three element types matter -- not worth a dependency.
 */
function parseBboxPage(xml: string): BBoxPage | null {
  const head = xml.match(/<page\s+width="([\d.]+)"\s+height="([\d.]+)"/);
  if (!head) return null;

  const widthPt = Number(head[1]);
  const heightPt = Number(head[2]);
  if (!(widthPt > 0) || !(heightPt > 0)) return null;

  const lines: BBoxLine[] = [];
  LINE_RE.lastIndex = 0;
  let lm: RegExpExecArray | null;
  while ((lm = LINE_RE.exec(xml)) !== null) {
    const words: BBoxWord[] = [];
    WORD_RE.lastIndex = 0;
    let wm: RegExpExecArray | null;
    while ((wm = WORD_RE.exec(lm[5])) !== null) {
      const text = decodeEntities(wm[5]).trim();
      if (!text) continue;
      words.push({
        x0: Number(wm[1]),
        y0: Number(wm[2]),
        x1: Number(wm[3]),
        y1: Number(wm[4]),
        text,
      });
    }
    if (words.length === 0) continue;
    lines.push({
      x0: Number(lm[1]),
      y0: Number(lm[2]),
      x1: Number(lm[3]),
      y1: Number(lm[4]),
      words,
      text: words.map((w) => w.text).join(" "),
    });
  }
  return { widthPt, heightPt, lines };
}

// ------------------------------------------------------------------ caching

/** Cache key component that changes whenever the PDF itself does. */
function pdfKey(pdfPath: string): string {
  const st = fs.statSync(pdfPath);
  return `${path.basename(pdfPath, ".pdf")}.${st.size}`;
}

const pageMemo = new Map<string, BBoxPage | null>();

/** Word boxes for one page, memoised in process and cached on disk. */
function bboxPage(pdfPath: string, page: number): BBoxPage | null {
  const key = `${pdfKey(pdfPath)}.p${page}`;
  const hit = pageMemo.get(key);
  if (hit !== undefined) return hit;

  const cachePath = path.join(EVIDENCE_DIR, `${key}.bbox.xhtml`);
  let xml: string;

  if (fs.existsSync(cachePath)) {
    xml = fs.readFileSync(cachePath, "utf8");
  } else {
    const bin = resolveBboxTool();
    if (!bin) {
      pageMemo.set(key, null);
      return null;
    }
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    // One page at a time: a whole-document bbox dump of a 100+ page 10-K is
    // megabytes of XML to produce and parse for the sake of a single row.
    execFileSync(
      bin,
      ["-bbox-layout", "-f", String(page), "-l", String(page), pdfPath, cachePath],
      { stdio: "pipe", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }
    );
    xml = fs.readFileSync(cachePath, "utf8");
  }

  const parsed = parseBboxPage(xml);
  pageMemo.set(key, parsed);
  return parsed;
}

interface Rendered {
  file: string;
  widthPx: number;
  heightPx: number;
}

/**
 * Render one page to PNG, cached on disk.
 *
 * `-singlefile` matters: without it pdftoppm zero-pads the page number in the
 * output filename to the width of the document's last page number, so the name
 * would depend on the PDF's length and could not be predicted here.
 *
 * Pixel dimensions are computed from the PDF's own point size rather than read
 * back from the PNG header -- pdftoppm rounds exactly this way (612pt at 110dpi
 * -> 935px), so the arithmetic is authoritative and needs no image decoding.
 */
function renderPage(
  pdfPath: string,
  page: number,
  widthPt: number,
  heightPt: number
): Rendered | null {
  const file = `${pdfKey(pdfPath)}.p${page}.r${RENDER_DPI}.png`;
  const out = path.join(EVIDENCE_DIR, file);
  const widthPx = Math.round((widthPt * RENDER_DPI) / 72);
  const heightPx = Math.round((heightPt * RENDER_DPI) / 72);

  if (!fs.existsSync(out)) {
    const bin = resolvePdfToPpm();
    if (!bin) return null;
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    execFileSync(
      bin,
      [
        "-png",
        "-r", String(RENDER_DPI),
        "-f", String(page),
        "-l", String(page),
        "-singlefile",
        pdfPath,
        out.replace(/\.png$/, ""),
      ],
      { stdio: "pipe", timeout: 120_000 }
    );
  }

  if (!fs.existsSync(out)) return null;
  return { file, widthPx, heightPx };
}

// ----------------------------------------------------------------- matching

/** Words too common to carry any signal about which line is the right one. */
const STOP = new Set([
  "the", "and", "for", "was", "were", "are", "that", "which", "with", "this",
  "from", "not", "its", "has", "had", "have", "been", "will", "our", "their",
  "other", "total", "year", "years", "december", "january",
]);

function contentTokens(s: string): string[] {
  const found = s.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  return found.filter((t) => !STOP.has(t));
}

/**
 * Read a printed figure out of a single word.
 *
 * Accounting parentheses are noted rather than applied: they are used as a
 * SIGN HINT when choosing between repeats of the same magnitude, while the
 * comparison itself is on magnitude only (the extractor already decided sign).
 */
function wordNumber(raw: string): { magnitude: number; paren: boolean } | null {
  const paren = /[()]/.test(raw);
  const cleaned = raw.replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return { magnitude: Math.abs(n), paren };
}

interface Located {
  line: BBoxLine;
  word: BBoxWord;
  confidence: Evidence["confidence"];
}

/**
 * Find the word on the page that prints `value`.
 *
 * A 10-K page reprints the same magnitude freely -- prior-year columns, page
 * furniture, unrelated tables -- so a bare numeric match is not enough. Each
 * candidate is scored by how many content words it shares with the snippet the
 * extractor quoted, which is the only independent evidence available about
 * which line was actually read.
 */
function locate(
  page: BBoxPage,
  value: number,
  snippet: string | null
): Located | null {
  const target = Math.abs(value);
  const tol = Math.max(1e-9, target * 1e-9);
  const want = new Set(contentTokens(snippet ?? ""));
  const negative = value < 0;

  interface Cand {
    line: BBoxLine;
    word: BBoxWord;
    overlap: number;
    score: number;
  }
  const cands: Cand[] = [];

  for (const line of page.lines) {
    const lineTokens = new Set(contentTokens(line.text));
    let overlap = 0;
    for (const t of want) if (lineTokens.has(t)) overlap++;

    for (const word of line.words) {
      const num = wordNumber(word.text);
      if (!num) continue;
      if (Math.abs(num.magnitude - target) > tol) continue;

      // Snippet agreement dominates; sign presentation breaks near-ties; very
      // long lines are mildly discounted as less specific.
      let score = overlap * 10;
      if (negative === num.paren) score += 3;
      else score -= 3;
      score -= Math.min(2, line.words.length / 40);

      cands.push({ line, word, overlap, score });
    }
  }

  if (cands.length === 0) return null;
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];

  const confidence: Evidence["confidence"] =
    cands.length === 1 ? "high"
    : best.overlap >= 2 ? "high"
    : best.overlap === 1 ? "medium"
    : "low";

  return { line: best.line, word: best.word, confidence };
}

/** Convert a point-space box to page fractions, padded and clamped. */
function toRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  page: BBoxPage,
  padX: number,
  padY: number
): EvidenceRect {
  const X0 = Math.max(0, x0 - padX);
  const Y0 = Math.max(0, y0 - padY);
  const X1 = Math.min(page.widthPt, x1 + padX);
  const Y1 = Math.min(page.heightPt, y1 + padY);
  return {
    x: X0 / page.widthPt,
    y: Y0 / page.heightPt,
    w: Math.max(0, X1 - X0) / page.widthPt,
    h: Math.max(0, Y1 - Y0) / page.heightPt,
  };
}

// ------------------------------------------------------------------- public

/**
 * Build evidence for one extracted value. Returns null when there is nothing
 * to show or the tooling is unavailable -- never throws.
 */
export function captureEvidence(
  pdfPath: string,
  extracted: Extracted
): Evidence | null {
  try {
    if (extracted.page === null || extracted.value === null) return null;

    const page = bboxPage(pdfPath, extracted.page);
    if (!page) return null;

    const rendered = renderPage(pdfPath, extracted.page, page.widthPt, page.heightPt);
    if (!rendered) return null;

    const hit = locate(page, extracted.value, extracted.snippet);

    return {
      image: rendered.file,
      page: extracted.page,
      widthPx: rendered.widthPx,
      heightPx: rendered.heightPx,
      // Padding is asymmetric by design: the figure gets a tight box, the row
      // a looser one so its label stays readable inside the highlight.
      value: hit ? toRect(hit.word.x0, hit.word.y0, hit.word.x1, hit.word.y1, page, 2.5, 1.5) : null,
      row: hit ? toRect(hit.line.x0, hit.line.y0, hit.line.x1, hit.line.y1, page, 3, 2) : null,
      matchedText: hit ? hit.word.text : null,
      confidence: hit ? hit.confidence : "none",
    };
  } catch {
    // Evidence is decoration: a broken render must never fail a run.
    return null;
  }
}

/** Attach evidence in place to every field extracted from one PDF. */
export function attachEvidence(
  pdfPath: string,
  found: Record<string, Extracted>
): void {
  for (const key of Object.keys(found)) {
    found[key].evidence = captureEvidence(pdfPath, found[key]);
  }
}

/**
 * Resolve a request's filename to a real evidence image.
 *
 * Returns null unless the name matches the exact shape this module generates
 * and the resolved path is still inside the evidence directory -- the name
 * arrives from a query string, so it is treated as hostile.
 */
export function evidenceFilePath(file: string): string | null {
  if (!/^[A-Za-z0-9._-]+\.png$/.test(file)) return null;
  if (file.includes("..")) return null;

  const full = path.join(EVIDENCE_DIR, file);
  const rel = path.relative(EVIDENCE_DIR, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}
