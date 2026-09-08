import { NextResponse } from "next/server";
import { getRun, listRuns } from "@/lib/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/runs           -> summaries of every persisted run, newest first
 * GET /api/runs?runId=xyz -> one full run including per-field results
 */
export async function GET(request: Request) {
  const runId = new URL(request.url).searchParams.get("runId");
  if (runId) {
    const run = getRun(runId);
    if (!run) {
      return NextResponse.json({ error: "run not found" }, { status: 404 });
    }
    return NextResponse.json(run);
  }
  return NextResponse.json(listRuns());
}
