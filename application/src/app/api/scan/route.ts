import { NextResponse } from "next/server";
import { loadAnswerKey, pdfPathFor } from "@/lib/truth";
import { EXTRACTOR_VERSION, extractAll } from "@/lib/extract";
import { compareOne } from "@/lib/compare";
import { nextRunId, saveRun, summarize } from "@/lib/runs";
import { FIELD_IDS, type Comparison, type RunRecord } from "@/lib/types";

// Shells out to pdftotext and touches the filesystem, so this must be Node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** POST /api/scan -- convert every PDF, extract all fields, grade, persist. */
export async function POST() {
  try {
    const key = loadAnswerKey();
    const startedAt = new Date();
    const results: Comparison[] = [];

    for (const company of key.companies) {
      const pdfPath = pdfPathFor(company.pdf_file);
      const found = extractAll(pdfPath);
      for (const fieldId of FIELD_IDS) {
        results.push(
          compareOne(
            company.company_id,
            company.company_name,
            company.fiscal_year,
            company.pdf_file,
            fieldId,
            found[fieldId],
            company.fields[fieldId]
          )
        );
      }
    }

    const finishedAt = new Date();
    const runId = nextRunId();
    const run: RunRecord = {
      ...summarize(runId, startedAt, finishedAt, EXTRACTOR_VERSION, results),
      results,
    };
    saveRun(run);
    return NextResponse.json(run);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
