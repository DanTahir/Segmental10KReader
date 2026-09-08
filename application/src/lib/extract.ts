/**
 * Field extractors: read three metrics straight out of a 10-K PDF's text.
 *
 * v2.0.0
 *
 * Design rule for this file: every decision must be derivable from the filing's
 * own structure -- its year headers, its printed signs, its award wording. No
 * rule may key off a company name, a page number, or an expected value, and the
 * extractor never reads the answer key. A heuristic that needs to know *which*
 * filing it is looking at is not a heuristic, it is the answer copied in.
 *
 * The three fields need genuinely different strategies:
 *
 *   A  gross unrecognized tax benefits, ending balance -- a rollforward table
 *      row, but with wildly varying labels, and generic labels ("Ending
 *      balances") that other rollforwards reuse. Solved by scoring candidates
 *      on their table's preamble.
 *
 *   B  deferred tax asset valuation allowance -- a table row whose twin lives
 *      in the effective-tax-rate reconciliation. Solved by requiring deferred
 *      tax asset context, then reading the year header to pick the column.
 *
 *   C  unrecognized RSU compensation cost -- prose, not a table, and filers
 *      disclose award types in every possible combination. Solved by binding
 *      amounts to award types and preferring the most RSU-specific disclosure.
 */

import type { Extracted, Unit } from "./types";
import { pdfToText, type PdfText } from "./pdftext";

export const EXTRACTOR_VERSION = "2.0.0";

// ---------------------------------------------------------------- primitives

/** Strip footnote markers like "(2)" that sit inside a row LABEL. */
function stripFootnoteMarkers(label: string): string {
  return label.replace(/\((\d{1,2})\)/g, " ");
}

/**
 * Split a table row into its label part and its numeric part.
 *
 * The label runs until the first run of 2+ spaces followed by a figure. A
 * single space is deliberately not enough: footnote markers ("allowances (2)")
 * hang off the label with one space and must stay with it.
 */
function splitRow(line: string): { label: string; data: string } {
  const m = line.match(/^(.*?)(\s{2,}(?=[$(\d-]).*)$/);
  if (!m) return { label: line, data: "" };
  return { label: m[1], data: m[2] };
}

/** Parse signed numbers out of a table row's data region, sign as printed. */
export function parseRowNumbers(data: string): number[] {
  const out: number[] = [];
  const re = /\((\d[\d,]*(?:\.\d+)?)\)|(\d[\d,]*(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(data)) !== null) {
    const neg = m[1];
    const raw = neg ?? m[2];
    const v = Number(raw.replace(/,/g, ""));
    if (Number.isNaN(v)) continue;
    // Accounting parentheses mean negative. Anything else is taken as printed:
    // a filer presenting "(assets) and liabilities" prints its valuation
    // allowance positive and means it.
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
 * Find the year header above a table and return the index of the column holding
 * the most recent fiscal year.
 *
 * The year is resolved *relative to the document*, not against the calendar:
 * a FY2024 filer's header reads "2024 2023" and its current column is the 2024
 * one. Filers print these headers in both directions, so position alone is not
 * information -- only the header is.
 *
 * Returns null when no header is found, in which case the caller should fall
 * back to the leftmost column (the common presentation).
 */
function currentYearColumn(t: PdfText, idx: number, back = 30): number | null {
  for (let i = idx - 1; i >= Math.max(0, idx - back); i--) {
    const years = (t.lines[i].match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
    const uniq = [...new Set(years)];
    if (uniq.length >= 2) {
      return uniq.indexOf(Math.max(...uniq));
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

interface Money { value: number; unit: Unit }

const MONEY_G = /\$\s?([\d,]+(?:\.\d+)?)\s*(billion|million|thousand)?/gi;

function unitOf(word: string | undefined): Unit {
  const w = (word || "").toLowerCase();
  if (w === "billion") return "USD billions";
  if (w === "thousand") return "USD thousands";
  return "USD millions";
}

/** Every dollar amount in a sentence, in order of appearance. */
function parseAllMoney(text: string): Money[] {
  const out: Money[] = [];
  for (const m of text.matchAll(MONEY_G)) {
    const value = Number(m[1].replace(/,/g, ""));
    if (Number.isNaN(value)) continue;
    out.push({ value, unit: unitOf(m[2]) });
  }
  return out;
}

// ------------------------------------------------------------------- FIELD A

const A_END_ROW =
  /(ending\s+(gross\s+)?unrecognized\s+tax\s+benefits?|unrecognized\s+tax\s+benefit,?\s+end\s+of\s+the\s+period|gross\s+unrecognized\s+tax\s+benefits?\s*.{0,3}\s*end\s+of\s+period|balance\s+of\s+gross\s+unrecognized\s+tax\s+benefits\s+at\s+the\s+end|balance,?\s+(at\s+)?(the\s+)?end\s+of\s+(the\s+)?(year|period|fiscal\s+year)|^ending\s+balances?)/i;

const A_PROSE =
  /(total\s+amount\s+of\s+gross\s+unrecognized\s+tax\s+benefits|unrecognized\s+tax\s+benefits\s+totaled|gross\s+unrecognized\s+tax\s+benefits\s+of|of\s+income\s+tax\s+contingencies)/i;

/**
 * Gross unrecognized tax benefits, ending balance.
 *
 * Labels vary from self-describing ("Ending gross unrecognized tax benefits")
 * to entirely generic ("Ending balances", "Balance at the end of the year"),
 * and the generic ones are reused by unrelated rollforwards -- shareholders'
 * equity, credit-loss allowances, valuation allowances. Candidates are
 * therefore scored on the text above them and the best-scoring row wins.
 */
export function extractUtbEndingBalance(t: PdfText): Extracted {
  interface Cand { idx: number; nums: number[]; score: number }
  const cands: Cand[] = [];

  for (let i = 0; i < t.lines.length; i++) {
    const { label, data } = splitRow(t.lines[i]);
    if (!A_END_ROW.test(stripFootnoteMarkers(label).trim())) continue;
    const nums = parseRowNumbers(data);
    if (nums.length === 0) continue;

    let score = 0;
    const ctx = t.lines.slice(Math.max(0, i - 60), i).join(" ").toLowerCase();
    if (/unrecognized\s+tax\s+benefit/.test(ctx)) score += 10;
    if (/uncertain\s+tax\s+position/.test(ctx)) score += 4;
    if (/gross\s+unrecognized/.test(ctx)) score += 3;
    // Rollforwards that are definitely something else.
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
      method: `rollforward row, ${col !== null ? "year-header" : "leftmost"} column ${pick + 1}/${best.nums.length}`,
    });
  }

  // Some filers state the balance only in prose, with no rollforward table.
  for (const s of sentences(t)) {
    if (!A_PROSE.test(s.text)) continue;
    const money = parseAllMoney(s.text)[0];
    if (!money) continue;
    return cite(t, s.lineIdx, {
      value: money.value,
      unit: money.unit,
      valueUsd: money.value * MULT[money.unit],
      snippet: s.text.slice(0, 240),
      method: "prose disclosure (no rollforward table present)",
    });
  }

  return fail("none", "no UTB ending balance found");
}

// ------------------------------------------------------------------- FIELD B

const B_ROW = /^(less:?\s*)?valuation\s+allowances?$/i;

/**
 * Deferred tax asset valuation allowance, balance.
 *
 * Two things make this harder than it looks. An identically-named line appears
 * in the effective-tax-rate reconciliation (as a percentage), so deferred tax
 * asset context is required. And the column order is not fixed -- filers print
 * year headers ascending or descending -- so the header decides the column,
 * never the position.
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
    const col = currentYearColumn(t, i);
    const pick = col !== null && col < nums.length ? col : 0;
    // Sign is taken exactly as printed -- see parseRowNumbers.
    const value = nums[pick];

    return cite(t, i, {
      value,
      unit,
      valueUsd: value * MULT[unit],
      method: `deferred tax asset table, ${col !== null ? "year-header" : "leftmost"} column ${pick + 1}/${nums.length}`,
    });
  }
  return fail("none", "no valuation allowance row found in a deferred tax asset table");
}

// ------------------------------------------------------------------- FIELD C

const C_SENT =
  /(unrecognized|unamortized)\s+((stock|share)-based\s+)?compensation(\s+(cost|expense))?/i;

/** "there was no unamortized ..." states an absence, not an amount. */
const C_NEGATION = /there\s+(was|were)\s+no\s+(unamortized|unrecognized)/i;

/**
 * RSU-family awards.
 *
 * The word boundary is load-bearing: "PRSUs" (performance RSUs) must NOT count
 * as an RSU, and it does not, because there is no boundary between the P and
 * the R. "Restricted stock units" is the same instrument spelled out.
 */
const AWARD_RSU = /\bRSUs?\b|restricted\s+stock\s+units?/i;
/** Restricted stock *awards* -- a different instrument from an RSU. */
const AWARD_RESTRICTED_STOCK = /restricted\s+stock/i;
/** Award types that are definitely not RSUs. */
const AWARD_OTHER =
  /\bstock\s+options?\b|\bPRSUs?\b|\bPSUs?\b|\bESPP\b|employee\s+stock\s+purchase|performance[-\s]based/i;
/** An umbrella phrase covering all equity awards at once. */
const AWARD_UMBRELLA = /(stock|share)-based\s+compensation/i;

/**
 * Isolate the phrase describing which awards the cost relates to, e.g.
 * "unvested stock options and RSUs" out of "... related to unvested stock
 * options and RSUs was $X million and $Y million, respectively."
 */
function awardScope(sentence: string): string {
  const m = sentence.match(/related\s+to\s+(.*)$/i);
  if (!m) return sentence;
  return m[1].split(/\bwas\b|\bwere\b|\bis\b|\bare\b|\bthat\b|\bwhich\b|\./i)[0];
}

/**
 * How well a disclosure's award scope matches "unrecognized RSU cost".
 *
 * A filer that breaks RSUs out on their own is the best evidence; one that
 * blends RSUs into a combined figure is the next best (that combined figure IS
 * the disclosed number -- there is nothing finer to be had); an umbrella
 * "stock-based compensation arrangements" total is weaker still; and a
 * disclosure about options or PRSUs only is not evidence at all.
 */
function scopeScore(scope: string): number {
  const rsu = AWARD_RSU.test(scope);
  const other = AWARD_OTHER.test(scope);
  if (rsu && !other) return 100;                        // RSUs alone
  if (rsu) return 60;                                   // RSUs + other types
  if (AWARD_RESTRICTED_STOCK.test(scope)) return 40;    // restricted stock + other
  if (AWARD_UMBRELLA.test(scope)) return 30;            // all awards, umbrella
  return 0;                                             // options/PRSUs only
}

/**
 * Unrecognized (unamortized) RSU compensation cost.
 *
 * Disclosed in prose, and filers pair amounts with award types in every
 * arrangement: one amount for RSUs alone, one blended amount for several award
 * types, or several amounts bound to several types by "respectively". Taking
 * the first amount in the first matching sentence gets all three wrong, so
 * amounts are bound to award types and the most RSU-specific disclosure wins.
 */
export function extractUnrecognizedRsuCost(t: PdfText): Extracted {
  interface Cand {
    lineIdx: number; text: string; money: Money; score: number; how: string;
  }
  const cands: Cand[] = [];

  for (const s of sentences(t)) {
    if (!C_SENT.test(s.text)) continue;
    if (C_NEGATION.test(s.text)) continue;

    const amounts = parseAllMoney(s.text);
    if (amounts.length === 0) continue;

    const scope = awardScope(s.text);
    const score = scopeScore(scope);
    if (score === 0) continue;

    let money = amounts[0];
    let how = "single disclosed amount";

    // "... was $X million and $Y million, respectively" -- amounts map
    // positionally onto the award list, so bind them and take the RSU one.
    if (/respectively/i.test(s.text) && amounts.length > 1) {
      const awards = scope
        .split(/,\s*and\s+|\s+and\s+|,\s*/)
        .map((a) => a.trim())
        .filter(Boolean);
      if (awards.length === amounts.length) {
        const rsuAt = awards.findIndex((a) => AWARD_RSU.test(a));
        if (rsuAt >= 0) {
          money = amounts[rsuAt];
          how = `"respectively" pair ${rsuAt + 1}/${awards.length} bound to RSUs`;
        }
      }
    }

    cands.push({ lineIdx: s.lineIdx, text: s.text, money, score, how });
  }

  if (cands.length === 0) {
    return fail("none", "no unrecognized compensation cost disclosure found");
  }

  cands.sort((a, b) => b.score - a.score || a.lineIdx - b.lineIdx);
  const best = cands[0];
  const label =
    best.score === 100 ? "RSU-only disclosure"
    : best.score === 60 ? "RSUs combined with other award types"
    : best.score === 40 ? "restricted stock disclosure"
    : "umbrella stock-based compensation total";

  return cite(t, best.lineIdx, {
    value: best.money.value,
    unit: best.money.unit,
    valueUsd: best.money.value * MULT[best.money.unit],
    snippet: best.text.slice(0, 240),
    method: `${label}, ${best.how}`,
  });
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
