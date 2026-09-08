import fs from "node:fs";
import path from "node:path";
import type { Comparison, FieldId, RunRecord, RunSummary } from "./types";
import { FIELD_IDS } from "./types";
import { DATA_DIR } from "./pdftext";

const RUNS_DIR = path.join(DATA_DIR, "runs");
const INDEX = path.join(RUNS_DIR, "index.json");

/**
 * Run history is stored as one JSON file per run plus an index, under data/runs.
 * That directory is outside the build output, so history survives rebuilds,
 * restarts, and extractor version changes -- successive runs stay comparable.
 */

function ensure() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  if (!fs.existsSync(INDEX)) fs.writeFileSync(INDEX, JSON.stringify([], null, 2));
}

export function summarize(
  runId: string,
  startedAt: Date,
  finishedAt: Date,
  extractorVersion: string,
  results: Comparison[]
): RunSummary {
  const byField = {} as Record<FieldId, { matched: number; total: number }>;
  for (const f of FIELD_IDS) byField[f] = { matched: 0, total: 0 };

  let matched = 0, mismatched = 0, missing = 0;
  for (const r of results) {
    byField[r.fieldId].total++;
    if (r.verdict === "match") { matched++; byField[r.fieldId].matched++; }
    else if (r.verdict === "mismatch") mismatched++;
    else missing++;
  }

  return {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    extractorVersion,
    total: results.length,
    matched, mismatched, missing,
    accuracy: results.length ? matched / results.length : 0,
    byField,
  };
}

export function saveRun(run: RunRecord): void {
  ensure();
  fs.writeFileSync(
    path.join(RUNS_DIR, `${run.runId}.json`),
    JSON.stringify(run, null, 2)
  );
  const idx = listRuns();
  const { results: _omit, ...summary } = run;
  idx.unshift(summary);
  fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2));
}

export function listRuns(): RunSummary[] {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(INDEX, "utf8")) as RunSummary[];
  } catch {
    return [];
  }
}

export function getRun(runId: string): RunRecord | null {
  ensure();
  const p = path.join(RUNS_DIR, `${runId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as RunRecord;
}

export function nextRunId(): string {
  const n = listRuns().length + 1;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `run-${String(n).padStart(3, "0")}-${stamp}`;
}
