export type FieldId =
  | "utb_gross_ending_balance"
  | "dta_valuation_allowance"
  | "unrecognized_rsu_comp_cost";

export const FIELD_IDS: FieldId[] = [
  "utb_gross_ending_balance",
  "dta_valuation_allowance",
  "unrecognized_rsu_comp_cost",
];

export const FIELD_LABELS: Record<FieldId, string> = {
  utb_gross_ending_balance: "Gross unrecognized tax benefits (ending)",
  dta_valuation_allowance: "DTA valuation allowance",
  unrecognized_rsu_comp_cost: "Unrecognized RSU comp. cost",
};

export const FIELD_SHORT: Record<FieldId, string> = {
  utb_gross_ending_balance: "UTB ending balance",
  dta_valuation_allowance: "Valuation allowance",
  unrecognized_rsu_comp_cost: "Unrecognized RSU cost",
};

export type Unit = "USD thousands" | "USD millions" | "USD billions";

/** A box on a rendered page, as fractions of page width/height (0..1). */
export interface EvidenceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A rendered image of the page a value was read from, plus where on it the
 * figure sits.
 *
 * Rects are fractions rather than pixels so one record drives both the
 * thumbnail and the full-size view. `value`/`row`/`matchedText` are null when
 * the page rendered but the figure could not be tied to a specific word --
 * the image is still worth showing, so that is a partial result, not a failure.
 */
export interface Evidence {
  /** Filename under data/evidence, served via /api/evidence. */
  image: string;
  page: number;
  widthPx: number;
  heightPx: number;
  /** Tight box around the figure itself. */
  value: EvidenceRect | null;
  /** Looser box around the whole line/row it was read from. */
  row: EvidenceRect | null;
  /** The word text that was matched, for display. */
  matchedText: string | null;
  /** How trustworthy the value->word join is. */
  confidence: "high" | "medium" | "low" | "none";
}

/** What the extractor found in a PDF, with its own citation. */
export interface Extracted {
  value: number | null;
  unit: Unit | null;
  valueUsd: number | null;
  /** Page number in the PDF (1-based). */
  page: number | null;
  /** Line number within the pdftotext output (1-based). */
  line: number | null;
  /** The text the value was read from. */
  snippet: string | null;
  /** Which heuristic produced this. */
  method: string;
  error?: string;
  /**
   * Rendered page image and highlight boxes.
   *
   * Optional on purpose: runs recorded before this existed have no such field,
   * and machines without poppler cannot produce one. Readers must treat
   * absent, null and present-but-unlocated as three normal cases.
   */
  evidence?: Evidence | null;
}

/** The sanitized answer key entry. */
export interface TruthField {
  value: number;
  unit: Unit;
  value_usd: number;
  as_printed: string;
  row_label: string | null;
  truth_source_line: number;
  scope?: string;
  rsu_only_separable?: boolean;
}

export interface TruthCompany {
  company_id: string;
  company_name: string;
  fiscal_year: number;
  fiscal_year_end: string;
  pdf_file: string;
  fields: Record<FieldId, TruthField>;
}

export interface AnswerKey {
  description: string;
  generated_at: string;
  field_ids: FieldId[];
  company_count: number;
  companies: TruthCompany[];
}

export type Verdict = "match" | "mismatch" | "missing";

export interface Comparison {
  companyId: string;
  companyName: string;
  fiscalYear: number;
  pdfFile: string;
  fieldId: FieldId;
  verdict: Verdict;
  extracted: Extracted;
  expected: TruthField;
  /** Human-readable description of the difference. */
  delta: string | null;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  extractorVersion: string;
  total: number;
  matched: number;
  mismatched: number;
  missing: number;
  accuracy: number;
  byField: Record<FieldId, { matched: number; total: number }>;
}

export interface RunRecord extends RunSummary {
  results: Comparison[];
}
