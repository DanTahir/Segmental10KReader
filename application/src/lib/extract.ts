/**
 * Field extractors: read three metrics straight out of a 10-K PDF's text.
 *
 * v1.0.0 -- see EXTRACTOR_VERSION. Known simplifications are commented inline
 * with `SIMPLIFICATION:` so the run report can be reasoned about honestly. This
 * extractor has NO access to the answer key; it only sees PDF text.
 */

import type { Extracted, Unit } from "./types";
import { pdfToText, type PdfText } from "./pdftext";

export const EXTRACTOR_VERSION = "1.0.0";

// ---------------------------------------------------------------- primitives

/** Strip footnote markers like "(2)" that sit inside a row LABEL. */
function stripFootnoteMarkers(label: string): string {
  return label.replace(/\((\d{1,2})\)/g, " ");
}

/** Split a table row into its label part and its numeric part. */
function splitRow(line: string): { label: string; data: string } {
  // The label runs until the first run of 2+ spaces followed by a $ or digit.
  const m = line.match(/^(.*?)(\s{2,}(?=[$(\d-]).*)$/);
  if (!m) return { label: line, data: "" };
  return { label: m[1], data: m[2] };
}

/** Parse signed numbers out of a table row's data region. */
export function parseRowNumbers(data: string): number[] {
  const out: number[] = [];
  const re = /\((\d[\d,]*(?:\.\d+)?)\)|(\d[\d,]*(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(data)) !== null) {
    const neg = m[1];
    const raw = neg ?? m[2];
    const v = Number(raw.replace(/,/g, ""));
    if (Number.isNaN(v)) continue;
    out.push(neg ? -v : v);
  }
  return out;
}

/**
 * Detect the unit a table is denominated in by scanning backwards.
 *
 * The scan stops at a page boundary: a table's "(in millions)" caption sits on
 * the same page as its rows, and continuing past the page break would pick up
 * the caption of whatever unrelated table happened to end the previous page.
 */
function detectTableUnit(t: PdfText, idx: number, back = 90): Unit {
  const page = t.pageOf[idx];
  for (let i = idx; i >= Math.max(0, idx - back); i--) {
    if (t.pageOf[i] !== page) break;
    const s = t.lines[i].toLowerCase();
    if (/in\s+thousands|\(in\s+thousands/.test(s)) return "USD thousands";
    if (/in\s+millions|\(in\s+millions/.test(s)) return "USD millions";
    if (/in\s+billions|\(in\s+billions/.test(s)) return "USD billions";
  }
  return "USD millions";
}

const MULT: Record<Unit, number> = {
  "USD thousands": 1e3,
  "USD millions": 1e6,
  "USD billions": 1e9,
};

function cite(t: PdfText, idx: number, extra: Partial<Extracted> = {}): Extracted {
  return {
    value: null,
    unit: null,
    valueUsd: null,
    page: t.pageOf[idx] ?? null,
    line: idx + 1,
    snippet: (t.lines[idx] ?? "").trim().replace(/\s{2,}/g, "  ").slice(0, 240),
    method: "",
    ...extra,
  };
}

function fail(method: string, error: string): Extracted {
  return {
    value: null, unit: null, valueUsd: null,
    page: null, line: null, snippet: null,
    method, error,
  };
}

/**
 * Find the year header above a table and return the index of the column that
 * holds the most recent fiscal year.
 */
function currentYearColumn(t: PdfText, idx: number, back = 30): number | null {
  for (let i = idx - 1; i >= Math.max(0, idx - back); i--) {
    const s = t.lines[i];
    const years = (s.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
    const uniq = [...new Set(years)];
    if (uniq.length >= 2) {
      const max = Math.max(...uniq);
      return uniq.indexOf(max);
    }
  }
  return null;
}

// ------------------------------------------------------- sentence extraction

interface Sentence { text: string; lineIdx: number; }

/** A pdftotext line that is really a table row rather than prose. */
function looksLikeTableRow(line: string): boolean {
  return /\s{3,}\$?\s*[(]?\d/.test(line);
}

/** Page numbers, running headers and other non-prose furniture. */
function looksLikeFurniture(line: string): boolean {
  const s = line.trim();
  return /^\d{1,4}$/.test(s) || /^table of contents$/i.test(s);
}

/**
 * Join wrapped lines into sentences, remembering the starting line.
 *
 * pdftotext often separates the wrapped lines of one paragraph with a blank
 * line, so a single blank line is treated as a wrap artifact rather than a
 * paragraph break -- otherwise a disclosure sentence gets cut in half and its
 * dollar amount is lost. Table rows and page furniture DO end a paragraph:
 * without that, a table row's numbers would bleed into the next sentence and
 * be misread as that sentence's own figures.
 */
function sentences(t: PdfText): Sentence[] {
  const out: Sentence[] = [];
  let buf = "";
  let start = 0;
  let blanks = 0;

  const flush = () => {
    if (!buf) return;
    for (const piece of buf.split(/(?<=[.;])\s+(?=[A-Z("$])/)) {
      const txt = piece.trim();
      if (txt) out.push({ text: txt, lineIdx: start });
    }
    buf = "";
  };

  for (let i = 0; i < t.lines.length; i++) {
    const line = t.lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      blanks++;
      if (blanks >= 2) flush();
      continue;
    }
    if (looksLikeTableRow(line) || looksLikeFurniture(line)) {
      flush();
      blanks = 0;
      continue;
    }
    blanks = 0;
    if (!buf) start = i;
    buf += (buf ? " " : "") + trimmed.replace(/\s{2,}/g, " ");
    if (buf.length > 4000) flush();
  }
  flush();
  return out;
}

const MONEY = /\$\s?([\d,]+(?:\.\d+)?)\s*(billion|million|thousand)?/i;

function parseMoney(text: string): { value: number; unit: Unit } | null {
  const m = text.match(MONEY);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ""));
  if (Number.isNaN(value)) return null;
  const word = (m[2] || "").toLowerCase();
  const unit: Unit =
    word === "billion" ? "USD billions"
    : word === "thousand" ? "USD thousands"
    : "USD millions";
  return { value, unit };
}

// ------------------------------------------------------------------- FIELD A

const A_END_ROW =
  /(ending\s+(gross\s+)?unrecognized\s+tax\s+benefits?|unrecognized\s+tax\s+benefit,?\s+end\s+of\s+the\s+period|gross\s+unrecognized\s+tax\s+benefits?\s*.{0,3}\s*end\s+of\s+period|balance\s+of\s+gross\s+unrecognized\s+tax\s+benefits\s+at\s+the\s+end|balance,?\s+(at\s+)?(the\s+)?end\s+of\s+(the\s+)?(year|period|fiscal\s+year)|^ending\s+balances?)/i;

const A_PROSE =
  /(total\s+amount\s+of\s+gross\s+unrecognized\s+tax\s+benefits|unrecognized\s+tax\s+benefits\s+totaled|gross\s+unrecognized\s+tax\s+benefits\s+of|of\s+income\s+tax\s+contingencies)/i;

/**
 * Gross unrecognized tax benefits, ending balance.
 *
 * Generic row labels like "Ending balances" and "Balance, end of period" are
 * reused by unrelated rollforwards elsewhere in a filing, so candidate rows are
 * scored on the text ABOVE them and the best-scoring one wins.
 */
export function extractUtbEndingBalance(t: PdfText): Extracted {
  interface Cand { idx: number; nums: number[]; score: number; }
  const cands: Cand[] = [];

  for (let i = 0; i < t.lines.length; i++) {
    const line = t.lines[i];
    const { label, data } = splitRow(line);
    if (!A_END_ROW.test(stripFootnoteMarkers(label).trim())) continue;
    const nums = parseRowNumbers(data);
    if (nums.length === 0) continue;

    // Score using the enclosing table's preamble.
    let score = 0;
    const ctx = t.lines.slice(Math.max(0, i - 60), i).join(" ").toLowerCase();
    if (/unrecognized\s+tax\s+benefit/.test(ctx)) score += 10;
    if (/uncertain\s+tax\s+position/.test(ctx)) score += 4;
    if (/gross\s+unrecognized/.test(ctx)) score += 3;
    // Penalise rollforwards that are definitely something else.
    if (/valuation\s+allowance/.test(ctx)) score -= 8;
    if (/allowance\s+for\s+credit\s+losses/.test(ctx)) score -= 12;
    if (/shareholders.{0,3}\s+equity|paid-in\s+capital|accumulated\s+deficit/.test(ctx)) score -= 12;
    // A self-labelling row needs no help from context.
    if (/unrecognized\s+tax\s+benefit/i.test(label)) score += 12;

    if (score > 0) cands.push({ idx: i, nums, score });
  }

  if (cands.length > 0) {
    cands.sort((a, b) => b.score - a.score || a.idx - b.idx);
    const best = cands[0];
    const col = currentYearColumn(t, best.idx);
    const pick = col !== null && col < best.nums.length ? col : 0;
    const unit = detectTableUnit(t, best.idx);
    const value = best.nums[pick];
    return cite(t, best.idx, {
      value,
      unit,
      valueUsd: value * MULT[unit],
      method: `rollforward row (score ${best.score}, col ${pick + 1}/${best.nums.length})`,
    });
  }

  // Fallback: some filers state the balance only in prose.
  for (const s of sentences(t)) {
    if (!A_PROSE.test(s.text)) continue;
    const money = parseMoney(s.text);
    if (!money) continue;
    return cite(t, s.lineIdx, {
      value: money.value,
      unit: money.unit,
      valueUsd: money.value * MULT[money.unit],
      snippet: s.text.slice(0, 240),
      method: "prose sentence (no rollforward table found)",
    });
  }

  return fail("none", "no UTB ending balance found");
}

// ------------------------------------------------------------------- FIELD B

const B_ROW = /^(less:?\s*)?valuation\s+allowances?$/i;

/**
 * Deferred tax asset valuation allowance, balance.
 *
 * A same-named line appears in the effective-tax-rate reconciliation, so the
 * row is only accepted when the surrounding text looks like the deferred tax
 * asset table.
 */
export function extractValuationAllowance(t: PdfText): Extracted {
  for (let i = 0; i < t.lines.length; i++) {
    const { label, data } = splitRow(t.lines[i]);
    const clean = stripFootnoteMarkers(label).trim().replace(/\s{2,}/g, " ");
    if (!B_ROW.test(clean)) continue;

    const nums = parseRowNumbers(data);
    if (nums.length === 0) continue;

    // Must be inside the deferred-tax-asset table, not the rate reconciliation.
    const ctx = t.lines.slice(Math.max(0, i - 30), i + 4).join(" ").toLowerCase();
    if (!/deferred\s+tax\s+asset/.test(ctx)) continue;
    if (/effective\s+(income\s+)?tax\s+rate\s+reconcil|statutory\s+(federal\s+)?(income\s+)?tax\s+rate/.test(ctx)
        && !/total\s+deferred\s+tax\s+asset/.test(ctx)) continue;

    const unit = detectTableUnit(t, i);

    // SIMPLIFICATION: assumes the current fiscal year is the FIRST numeric
    // column, which holds for most filers but not for those that print their
    // deferred tax table in ascending year order.
    const raw = nums[0];

    // SIMPLIFICATION: a valuation allowance is a contra-asset, so the magnitude
    // is normalised negative. Filers that present the deferred tax table as
    // "(assets) and liabilities" print it positive instead.
    const value = -Math.abs(raw);

    return cite(t, i, {
      value,
      unit,
      valueUsd: value * MULT[unit],
      method: `deferred tax asset table, first numeric column (${nums.length} cols)`,
    });
  }
  return fail("none", "no valuation allowance row found in a deferred tax asset table");
}

// ------------------------------------------------------------------- FIELD C

// Anchored deliberately tightly: "unrecognized/unamortized" must lead straight
// into "compensation". Filers word the noun three ways -- "unrecognized
// compensation cost", "unrecognized share-based compensation expense", and
// "unamortized stock-based compensation" with no cost/expense word at all.
const C_SENT =
  /(unrecognized|unamortized)\s+((stock|share)-based\s+)?compensation(\s+(cost|expense))?/i;
const C_AWARD = /(rsu|restricted\s+stock|stock\s+option|stock-based|share-based)/i;

/**
 * Unrecognized (unamortized) RSU compensation cost.
 *
 * This figure is disclosed in prose rather than a table, so the equity-
 * compensation note is scanned for the disclosure sentence.
 */
export function extractUnrecognizedRsuCost(t: PdfText): Extracted {
  for (const s of sentences(t)) {
    if (!C_SENT.test(s.text)) continue;
    if (!C_AWARD.test(s.text)) continue;
    // Skip sentences that state an absence rather than an amount.
    if (/there\s+was\s+no\s+(unamortized|unrecognized)/i.test(s.text)) continue;

    const money = parseMoney(s.text);
    if (!money) continue;

    // SIMPLIFICATION: takes the FIRST dollar amount in the FIRST matching
    // sentence. Filers that disclose several award types in sequence, or that
    // pair two amounts with "respectively", need the award type bound to the
    // amount rather than positional matching.
    return cite(t, s.lineIdx, {
      value: money.value,
      unit: money.unit,
      valueUsd: money.value * MULT[money.unit],
      snippet: s.text.slice(0, 240),
      method: "first matching disclosure sentence, first amount",
    });
  }
  return fail("none", "no unrecognized compensation cost sentence found");
}

// ------------------------------------------------------------------ pipeline

export function extractAll(pdfPath: string): Record<string, Extracted> {
  const t = pdfToText(pdfPath);
  return {
    utb_gross_ending_balance: safe(() => extractUtbEndingBalance(t)),
    dta_valuation_allowance: safe(() => extractValuationAllowance(t)),
    unrecognized_rsu_comp_cost: safe(() => extractUnrecognizedRsuCost(t)),
  };
}

function safe(fn: () => Extracted): Extracted {
  try {
    return fn();
  } catch (err) {
    return fail("error", err instanceof Error ? err.message : String(err));
  }
}
