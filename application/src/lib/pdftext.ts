import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.join(process.cwd(), "data");
const CACHE_DIR = path.join(DATA_DIR, "cache");

/**
 * Locate the pdftotext binary. On Windows it is commonly only on the Git-for-
 * Windows PATH, which the Node process may not inherit, so fall back to known
 * install locations before giving up.
 */
let resolvedBin: string | null = null;

export function resolvePdfToText(): string {
  if (resolvedBin) return resolvedBin;

  const candidates = [
    process.env.PDFTOTEXT_PATH,
    "pdftotext",
    "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe",
    "C:\\Program Files (x86)\\Git\\mingw64\\bin\\pdftotext.exe",
    "/usr/bin/pdftotext",
    "/usr/local/bin/pdftotext",
  ].filter(Boolean) as string[];

  for (const cand of candidates) {
    try {
      if (cand !== "pdftotext" && !fs.existsSync(cand)) continue;
      execFileSync(cand, ["-v"], { stdio: "pipe" });
      resolvedBin = cand;
      return cand;
    } catch (err: unknown) {
      // `pdftotext -v` exits non-zero on some builds but still proves presence.
      const e = err as { status?: number; code?: string };
      if (e && e.status !== undefined && e.code !== "ENOENT") {
        resolvedBin = cand;
        return cand;
      }
    }
  }
  throw new Error(
    "pdftotext not found. Install xpdf/poppler or set PDFTOTEXT_PATH."
  );
}

export interface PdfText {
  /** Full text, `-table` mode (keeps table row labels and values on one line). */
  lines: string[];
  /** For each line index, the 1-based PDF page it came from. */
  pageOf: number[];
  pageCount: number;
}

/**
 * Convert a PDF to text using xpdf's `-table` mode.
 *
 * `-table` matters: the default `-layout` mode frequently orphans a table's
 * row label from its numbers onto separate output lines, which makes row-wise
 * parsing impossible. `-table` keeps "label ... 1,234  5,678" intact.
 *
 * Results are cached on disk keyed by file size, so repeat runs are fast but a
 * changed PDF is always re-converted.
 */
export function pdfToText(pdfPath: string): PdfText {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const stat = fs.statSync(pdfPath);
  const key = `${path.basename(pdfPath, ".pdf")}.${stat.size}.table.txt`;
  const cachePath = path.join(CACHE_DIR, key);

  let raw: string;
  if (fs.existsSync(cachePath)) {
    raw = fs.readFileSync(cachePath, "utf8");
  } else {
    const bin = resolvePdfToText();
    execFileSync(bin, ["-table", "-enc", "UTF-8", pdfPath, cachePath], {
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    });
    raw = fs.readFileSync(cachePath, "utf8");
  }

  // pdftotext separates pages with a form feed (\f).
  const lines: string[] = [];
  const pageOf: number[] = [];
  let page = 1;
  for (const rawLine of raw.split(/\r?\n/)) {
    const ffCount = (rawLine.match(/\f/g) || []).length;
    if (ffCount > 0) {
      // The form feed marks the boundary; text after it is on the next page.
      const parts = rawLine.split("\f");
      lines.push(parts[0]);
      pageOf.push(page);
      page += ffCount;
      for (let i = 1; i < parts.length; i++) {
        if (i === parts.length - 1) {
          lines.push(parts[i]);
          pageOf.push(page);
        }
      }
    } else {
      lines.push(rawLine);
      pageOf.push(page);
    }
  }

  return { lines, pageOf, pageCount: page };
}
