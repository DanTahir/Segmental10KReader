import type { Comparison, Extracted, FieldId, TruthField, Verdict } from "./types";

const UNIT_LABEL: Record<string, string> = {
  "USD thousands": "K",
  "USD millions": "M",
  "USD billions": "B",
};

export function formatValue(value: number | null, unit: string | null): string {
  if (value === null || unit === null) return "—";
  const suffix = UNIT_LABEL[unit] ?? "";
  const abs = Math.abs(value);
  const body = abs.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${value < 0 ? "(" : ""}$${body}${suffix}${value < 0 ? ")" : ""}`;
}

/**
 * Compare on the normalised USD figure so a filer's own unit choice never
 * decides correctness, and so a sign flip is still counted as wrong.
 */
export function compareOne(
  companyId: string,
  companyName: string,
  fiscalYear: number,
  pdfFile: string,
  fieldId: FieldId,
  extracted: Extracted,
  expected: TruthField
): Comparison {
  let verdict: Verdict;
  let delta: string | null = null;

  if (extracted.value === null || extracted.valueUsd === null) {
    verdict = "missing";
    delta = extracted.error ?? "not found";
  } else {
    const exp = expected.value_usd;
    const got = extracted.valueUsd;
    const tol = Math.max(1, Math.abs(exp) * 1e-9);
    if (Math.abs(got - exp) <= tol) {
      verdict = "match";
    } else {
      verdict = "mismatch";
      const diff = got - exp;
      const pct = exp !== 0 ? (diff / Math.abs(exp)) * 100 : 0;
      const signFlip = Math.abs(Math.abs(got) - Math.abs(exp)) <= tol;
      if (signFlip) {
        delta = "correct magnitude, wrong sign";
      } else {
        const dir = diff > 0 ? "over" : "under";
        delta = `${dir} by ${formatValue(
          Math.abs(diff) / (Math.abs(exp) > 1e9 ? 1e9 : 1e6),
          Math.abs(exp) > 1e9 ? "USD billions" : "USD millions"
        )} (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`;
      }
    }
  }

  return {
    companyId, companyName, fiscalYear, pdfFile, fieldId,
    verdict, extracted, expected, delta,
  };
}
