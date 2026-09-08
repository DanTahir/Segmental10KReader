/**
 * Copies the source PDFs into the app and builds a SANITIZED answer key.
 *
 * The full ground-truth records in ../TruthTable/companies/ contain analysis of
 * why each field is hard: `decoys`, `why_hard`, `sign_warning`,
 * `magnitude_warning`, `terminology_note`, `encoding_note`, etc. Copying those
 * in would hand the extractor the answers to its own test, so this script uses
 * a strict ALLOWLIST and drops everything else.
 *
 * Allowlisted = the answer plus enough citation to display where it came from.
 * Everything describing a trap, a decoy, or a difficulty stays in the original
 * TruthTable only.
 *
 * Usage: npm run prepare-data
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, "..");
const REPO = path.resolve(APP, "..");

const SRC_TRUTH = path.join(REPO, "TruthTable", "companies");
const SRC_PDFS = path.join(REPO, "Reports10K");
const OUT_TRUTH = path.join(APP, "data", "truth");
const OUT_PDFS = path.join(APP, "data", "pdfs");

// Only these keys survive the copy.
const TOP_ALLOW = [
  "company_id",
  "company_name",
  "fiscal_year",
  "fiscal_year_end",
];
const FIELD_ALLOW = [
  "value",
  "unit",
  "value_usd",
  "as_printed",
  "row_label",
  "source_line",
  "scope",
  "rsu_only_separable",
];

// Recorded explicitly so the exclusion is auditable rather than implicit.
const DELIBERATELY_EXCLUDED = [
  "decoys",
  "why_hard",
  "sign_convention",
  "sign_warning",
  "magnitude_warning",
  "terminology_note",
  "encoding_note",
  "scope_note",
  "no_rollforward_table",
  "column_order",
  "column_order_evidence",
  "column_index_of_fy",
  "column_count",
  "column_header",
  "column_header_source_line",
  "value_printed_token",
  "fiscal_year_note",
  "reporting_unit",
  "reporting_unit_warning",
  "why_hard",
];

const FIELDS = [
  "utb_gross_ending_balance",
  "dta_valuation_allowance",
  "unrecognized_rsu_comp_cost",
];

function pick(obj, allow) {
  const out = {};
  for (const k of allow) if (k in obj) out[k] = obj[k];
  return out;
}

function main() {
  fs.mkdirSync(OUT_TRUTH, { recursive: true });
  fs.mkdirSync(OUT_PDFS, { recursive: true });

  // ---- PDFs ----
  let copied = 0;
  for (const f of fs.readdirSync(SRC_PDFS)) {
    if (!f.toLowerCase().endsWith(".pdf")) continue;
    const dst = path.join(OUT_PDFS, f);
    if (!fs.existsSync(dst) ||
        fs.statSync(dst).size !== fs.statSync(path.join(SRC_PDFS, f)).size) {
      fs.copyFileSync(path.join(SRC_PDFS, f), dst);
    }
    copied++;
  }
  console.log(`PDFs available: ${copied}`);

  // ---- Sanitized answer key ----
  const companies = [];
  const strippedKeys = new Set();

  for (const f of fs.readdirSync(SRC_TRUTH).sort()) {
    if (!f.endsWith(".json")) continue;
    const rec = JSON.parse(fs.readFileSync(path.join(SRC_TRUTH, f), "utf8"));

    for (const k of Object.keys(rec)) {
      if (!TOP_ALLOW.includes(k) && k !== "source" && k !== "fields") {
        strippedKeys.add(k);
      }
    }

    const clean = pick(rec, TOP_ALLOW);
    clean.pdf_file = guessPdf(rec.company_id);
    clean.fields = {};

    for (const fld of FIELDS) {
      const node = rec.fields?.[fld];
      if (!node) throw new Error(`${rec.company_id}: missing field ${fld}`);
      for (const k of Object.keys(node)) {
        if (!FIELD_ALLOW.includes(k)) strippedKeys.add(k);
      }
      clean.fields[fld] = pick(node, FIELD_ALLOW);
      // Rename to make it unmistakable that this line refers to the EDGAR HTML
      // text the ground truth was built from, NOT to the PDF the app scans.
      if ("source_line" in clean.fields[fld]) {
        clean.fields[fld].truth_source_line = clean.fields[fld].source_line;
        delete clean.fields[fld].source_line;
      }
    }
    companies.push(clean);
  }

  const out = {
    description:
      "Sanitized answer key. Values and citations only. All trap/decoy/" +
      "difficulty analysis intentionally omitted - see ../TruthTable for that.",
    generated_at: new Date().toISOString(),
    field_ids: FIELDS,
    company_count: companies.length,
    companies,
  };

  fs.writeFileSync(
    path.join(OUT_TRUTH, "answer_key.json"),
    JSON.stringify(out, null, 2)
  );

  console.log(`Answer key written: ${companies.length} companies x ${FIELDS.length} fields`);
  console.log(`\nKeys stripped during sanitization (${strippedKeys.size}):`);
  for (const k of [...strippedKeys].sort()) {
    const flag = DELIBERATELY_EXCLUDED.includes(k) ? "expected" : "NEW/unlisted";
    console.log(`  - ${k}  [${flag}]`);
  }
}

function guessPdf(companyId) {
  const files = fs.readdirSync(OUT_PDFS).filter((f) => f.endsWith(".pdf"));
  const hit = files.find((f) =>
    f.toLowerCase().startsWith(companyId.toLowerCase().slice(0, 5))
  );
  if (!hit) throw new Error(`no PDF found for ${companyId}`);
  return hit;
}

main();
