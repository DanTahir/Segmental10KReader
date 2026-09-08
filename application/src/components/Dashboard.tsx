"use client";

import { useCallback, useEffect, useState } from "react";
import { formatValue } from "@/lib/compare";
import ValueChart from "./ValueChart";
import {
  FIELD_IDS,
  FIELD_LABELS,
  type Comparison,
  type FieldId,
  type RunRecord,
  type RunSummary,
} from "@/lib/types";

type Filter = "all" | "problems";

export default function Dashboard() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const loadRuns = useCallback(async (): Promise<RunSummary[]> => {
    const res = await fetch("/api/runs", { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as RunSummary[];
    setRuns(data);
    return data;
  }, []);

  const openRun = useCallback(async (runId: string) => {
    const res = await fetch(`/api/runs?runId=${encodeURIComponent(runId)}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    setRun((await res.json()) as RunRecord);
  }, []);

  useEffect(() => {
    void (async () => {
      const list = await loadRuns();
      if (list.length > 0) await openRun(list[0].runId);
    })();
  }, [loadRuns, openRun]);

  async function runScan() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/scan", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setRun(body as RunRecord);
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const shown =
    run === null
      ? []
      : filter === "all"
        ? run.results
        : run.results.filter((r) => r.verdict !== "match");

  // Group results by company, preserving order.
  const groups: { key: string; rows: Comparison[] }[] = [];
  for (const r of shown) {
    let g = groups.find((x) => x.key === r.companyId);
    if (!g) {
      g = { key: r.companyId, rows: [] };
      groups.push(g);
    }
    g.rows.push(r);
  }

  const problems = run ? run.mismatched + run.missing : 0;

  return (
    <>
      <header className="hero">
        <div className="hero-inner">
          <div>
            <span className="tag">PDF extraction benchmark</span>
            <h1>10-K Metric Extractor</h1>
            <p>
              Converts each 10-K PDF with <code>pdftotext -table</code>, pulls three
              disclosure metrics out of the tax and equity-compensation notes, then
              grades every value against the ground-truth answer key and cites the
              page and line it read.
            </p>
          </div>
          <button className="btn" onClick={runScan} disabled={busy}>
            {busy ? (
              <>
                <span className="spin">*</span> Scanning 10 PDFs...
              </>
            ) : (
              "Run extraction"
            )}
          </button>
        </div>
      </header>

      <div className="shell">
        {error && <div className="err">Scan failed: {error}</div>}

        {run && (
          <div className="cards">
            <div className="card hi">
              <div className="k">Accuracy</div>
              <div className={`v ${run.accuracy === 1 ? "ok" : ""}`}>
                {(run.accuracy * 100).toFixed(1)}%
              </div>
              <div className="sub">
                {run.matched} of {run.total} fields correct
              </div>
            </div>
            <div className="card">
              <div className="k">Matched</div>
              <div className="v ok">{run.matched}</div>
              <div className="sub">exact value and sign</div>
            </div>
            <div className="card">
              <div className="k">Needs work</div>
              <div className={`v ${problems > 0 ? "bad" : "ok"}`}>{problems}</div>
              <div className="sub">
                {run.mismatched} wrong value, {run.missing} not found
              </div>
            </div>
            <div className="card">
              <div className="k">Companies</div>
              <div className="v">{run.total / FIELD_IDS.length}</div>
              <div className="sub">{FIELD_IDS.length} fields each</div>
            </div>
            <div className="card">
              <div className="k">Run time</div>
              <div className="v">{(run.durationMs / 1000).toFixed(1)}s</div>
              <div className="sub">extractor v{run.extractorVersion}</div>
            </div>
          </div>
        )}

        <div className="layout">
          <aside style={{ display: "grid", gap: 20 }}>
            {run && (
              <section className="panel">
                <div className="panel-head">
                  <h2>By field</h2>
                </div>
                <div className="panel-body">
                  {FIELD_IDS.map((f) => {
                    const s = run.byField[f];
                    const pct = s.total ? (s.matched / s.total) * 100 : 0;
                    return (
                      <div className="fieldbar" key={f}>
                        <div className="top">
                          <span>{FIELD_LABELS[f]}</span>
                          <span>
                            {s.matched}/{s.total}
                          </span>
                        </div>
                        <div className="track">
                          <div
                            className={`fill ${pct === 100 ? "perfect" : ""}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <section className="panel">
              <div className="panel-head">
                <h2>Run history</h2>
                <span className="cite">{runs.length} saved</span>
              </div>
              {runs.length === 0 ? (
                <div className="panel-body cite">
                  No runs yet. Press <b>Run extraction</b>.
                </div>
              ) : (
                <ul className="runlist">
                  {runs.map((r) => (
                    <li key={r.runId}>
                      <button
                        className={`runitem ${run?.runId === r.runId ? "active" : ""}`}
                        onClick={() => openRun(r.runId)}
                      >
                        <span>
                          <span className="rid">{r.runId.slice(0, 7)}</span>
                          <span className="when">
                            {new Date(r.startedAt).toLocaleString()}
                          </span>
                        </span>
                        <span
                          className="rscore"
                          style={{
                            color:
                              r.accuracy === 1
                                ? "var(--ok)"
                                : r.accuracy >= 0.8
                                  ? "var(--text)"
                                  : "var(--warn)",
                          }}
                        >
                          {r.matched}/{r.total}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>

          <main className="stack">
            {/* Charts always show the full run, independent of the table's
                filter below, so the per-field picture stays stable while the
                table is narrowed to problems. */}
            {run && <ValueChart results={run.results} />}

            <section className="panel">
              <div className="panel-head">
                <h2>
                  Extraction vs ground truth
                  {run && <span className="cite"> &nbsp;{run.runId}</span>}
                </h2>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className={`btn ghost ${filter === "all" ? "on" : ""}`}
                    onClick={() => setFilter("all")}
                  >
                    All {run ? run.total : 0}
                  </button>
                  <button
                    className={`btn ghost ${filter === "problems" ? "on" : ""}`}
                    onClick={() => setFilter("problems")}
                  >
                    Problems {problems}
                  </button>
                </div>
              </div>

              {!run ? (
                <div className="empty">
                  No run loaded yet. Press <b>Run extraction</b> to scan the 10 PDFs.
                </div>
              ) : groups.length === 0 ? (
                <div className="empty">Nothing to show for this filter.</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="results">
                    <thead>
                      <tr>
                        <th>Field</th>
                        <th>Extracted</th>
                        <th>Expected</th>
                        <th>Verdict</th>
                        <th>PDF citation</th>
                        <th>How it was found</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => (
                        <FieldRows key={g.key} rows={g.rows} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </main>
        </div>
      </div>
    </>
  );
}

function FieldRows({ rows }: { rows: Comparison[] }) {
  const head = rows[0];
  return (
    <>
      <tr className="co-head">
        <td colSpan={6}>
          {head.companyName}
          <span className="fy">FY{head.fiscalYear}</span>
          <span className="pdf">{head.pdfFile}</span>
        </td>
      </tr>
      {rows.map((r) => (
        <tr key={`${r.companyId}-${r.fieldId}`}>
          <td>{FIELD_LABELS[r.fieldId as FieldId]}</td>
          <td>
            <span
              className={`num ${r.verdict === "match" ? "right" : "wrong"}`}
            >
              {formatValue(r.extracted.value, r.extracted.unit)}
            </span>
            {r.delta && <span className="delta" style={{ display: "block" }}>{r.delta}</span>}
          </td>
          <td>
            <span className="num">
              {formatValue(r.expected.value, r.expected.unit)}
            </span>
            {r.expected.row_label && (
              <span className="method">{r.expected.row_label}</span>
            )}
          </td>
          <td>
            <span className={`pill ${r.verdict}`}>{r.verdict}</span>
          </td>
          <td className="cite">
            {r.extracted.page !== null ? (
              <>
                <span className="loc">
                  p.{r.extracted.page} / line {r.extracted.line}
                </span>
                {r.extracted.snippet && (
                  <span className="snippet" title={r.extracted.snippet}>
                    {r.extracted.snippet}
                  </span>
                )}
              </>
            ) : (
              <span className="cite">not located</span>
            )}
          </td>
          <td>
            <span className="method">{r.extracted.method}</span>
            {r.extracted.error && (
              <span className="delta" style={{ display: "block" }}>
                {r.extracted.error}
              </span>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}
