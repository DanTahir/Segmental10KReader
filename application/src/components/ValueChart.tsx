"use client";

import { useMemo, useState } from "react";
import { formatValue } from "@/lib/compare";
import {
  FIELD_IDS,
  FIELD_LABELS,
  FIELD_SHORT,
  type Comparison,
  type FieldId,
} from "@/lib/types";

/**
 * Per-run chart of extracted value vs ground truth, one selectable chart per
 * field.
 *
 * Two properties of this data drive the design:
 *
 * 1. The values span more than four orders of magnitude -- a $27M valuation
 *    allowance sits in the same field as a $15,895M one. On a linear axis the
 *    smaller half of the companies collapse into invisible slivers, so the
 *    axis is log10 and the decade gridlines are labelled to make that explicit.
 *
 * 2. One field is signed: most filers print the valuation allowance negative,
 *    but a filer presenting "(assets) and liabilities" prints it positive. A
 *    log axis cannot express sign geometrically, so bar LENGTH encodes
 *    magnitude only and the sign is carried by the numeric label's accounting
 *    parentheses plus an explicit marker when a run disagrees on sign.
 *
 * Bars are drawn from `valueUsd` so companies are comparable regardless of the
 * unit a filer chose, while the printed label uses the filing's own unit.
 */

interface Scale {
  min: number;
  max: number;
  decades: number[];
}

function decadeLabel(e: number): string {
  const v = Math.pow(10, e);
  if (v >= 1e12) return `$${v / 1e12}T`;
  if (v >= 1e9) return `$${v / 1e9}B`;
  if (v >= 1e6) return `$${v / 1e6}M`;
  if (v >= 1e3) return `$${v / 1e3}K`;
  return `$${v}`;
}

/** Build a log10 axis spanning whole decades around the data. */
function buildScale(values: number[]): Scale | null {
  const mags = values
    .filter((v) => Number.isFinite(v) && v !== 0)
    .map((v) => Math.abs(v));
  if (mags.length === 0) return null;

  const min = Math.floor(Math.log10(Math.min(...mags)));
  // Always at least one decade wide, otherwise every bar is full width.
  const max = Math.max(Math.ceil(Math.log10(Math.max(...mags))), min + 1);

  const decades: number[] = [];
  for (let e = min; e <= max; e++) decades.push(e);
  return { min, max, decades };
}

/** Position of a magnitude along the axis, as a 0-100 percentage. */
function widthPct(valueUsd: number, s: Scale): number {
  const mag = Math.abs(valueUsd);
  if (!Number.isFinite(mag) || mag <= 0) return 0;
  const frac = (Math.log10(mag) - s.min) / (s.max - s.min);
  // Floor at a sliver so a value sitting exactly on the axis minimum is still
  // visible as a bar rather than rendering as nothing.
  return Math.max(1.5, Math.min(100, frac * 100));
}

/** Trim legal suffixes so labels fit the narrow name column. */
function shortName(name: string): string {
  return name
    .replace(/^The\s+/i, "")
    .replace(/,?\s+(Inc\.?|Corporation|Corp\.?|Company|Platforms|Global|plc)$/gi, "")
    .replace(/,?\s+Inc\.?$/i, "")
    .trim();
}

export default function ValueChart({ results }: { results: Comparison[] }) {
  const [field, setField] = useState<FieldId>(FIELD_IDS[0]);

  const rows = useMemo(
    () =>
      results
        .filter((r) => r.fieldId === field)
        .slice()
        // Largest magnitude first: makes the axis read top-heavy and keeps the
        // eye on the decade the bulk of the data sits in.
        .sort(
          (a, b) =>
            Math.abs(b.expected.value_usd) - Math.abs(a.expected.value_usd)
        ),
    [results, field]
  );

  const scale = useMemo(() => {
    const vals: number[] = [];
    for (const r of rows) {
      vals.push(r.expected.value_usd);
      if (r.extracted.valueUsd !== null) vals.push(r.extracted.valueUsd);
    }
    return buildScale(vals);
  }, [rows]);

  const matched = rows.filter((r) => r.verdict === "match").length;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Extracted vs ground truth by company
          <span className="cite">
            {" "}
            &nbsp;{matched}/{rows.length} correct
          </span>
        </h2>
        <div className="chart-tabs">
          {FIELD_IDS.map((f) => (
            <button
              key={f}
              className={`btn ghost ${field === f ? "on" : ""}`}
              onClick={() => setField(f)}
              title={FIELD_LABELS[f]}
            >
              {FIELD_SHORT[f]}
            </button>
          ))}
        </div>
      </div>

      <div className="panel-body">
        <div className="chart-legend">
          <span className="lg">
            <i className="sw extracted" /> Extracted
          </span>
          <span className="lg">
            <i className="sw expected" /> Ground truth
          </span>
          <span className="lg">
            <i className="sw wrong" /> Mismatch
          </span>
          <span className="cite chart-note">
            log&#8321;&#8320; scale &mdash; bar length is magnitude, sign is shown in the value
          </span>
        </div>

        {scale === null || rows.length === 0 ? (
          <div className="empty">No values to chart for this field.</div>
        ) : (
          <div className="chart">
            {rows.map((r) => {
              const exp = r.expected.value_usd;
              const got = r.extracted.valueUsd;
              const bad = r.verdict !== "match";
              // A sign disagreement is invisible on a magnitude axis, so call
              // it out explicitly rather than letting two equal-length bars
              // imply agreement.
              const signFlip =
                got !== null && Math.sign(got) !== Math.sign(exp);

              return (
                <div className="crow" key={`${r.companyId}-${r.fieldId}`}>
                  <div className="cname" title={`${r.companyName} (FY${r.fiscalYear})`}>
                    {shortName(r.companyName)}
                    <span className="cfy">FY{r.fiscalYear}</span>
                  </div>

                  <div className="cplot">
                    <div className="cgrid">
                      {scale.decades.map((e, i) => (
                        <span
                          key={e}
                          className="cgl"
                          style={{
                            left: `${(i / (scale.decades.length - 1)) * 100}%`,
                          }}
                        />
                      ))}
                    </div>

                    <div className="cbars">
                      {got === null ? (
                        <div className="cmissing">not found in PDF</div>
                      ) : (
                        <div className="cbar-wrap">
                          <div
                            className={`cbar ${bad ? "wrong" : "extracted"}`}
                            style={{ width: `${widthPct(got, scale)}%` }}
                          />
                          <span className={`cval ${bad ? "wrong" : ""}`}>
                            {formatValue(r.extracted.value, r.extracted.unit)}
                            {signFlip && <b className="cflip">sign</b>}
                          </span>
                        </div>
                      )}

                      <div className="cbar-wrap">
                        <div
                          className="cbar expected"
                          style={{ width: `${widthPct(exp, scale)}%` }}
                        />
                        <span className="cval muted">
                          {formatValue(r.expected.value, r.expected.unit)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="cverdict">
                    <span className={`pill ${r.verdict}`}>{r.verdict}</span>
                    {r.delta && <span className="delta cdelta">{r.delta}</span>}
                  </div>
                </div>
              );
            })}

            <div className="caxis">
              <div className="cname" />
              <div className="cplot cticks">
                {scale.decades.map((e, i) => (
                  <span
                    key={e}
                    className="ctick"
                    style={{
                      left: `${(i / (scale.decades.length - 1)) * 100}%`,
                    }}
                  >
                    {decadeLabel(e)}
                  </span>
                ))}
              </div>
              <div className="cverdict" />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
