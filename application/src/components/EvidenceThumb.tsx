"use client";

import { useEffect, useState } from "react";
import type { Evidence, EvidenceRect } from "@/lib/types";

/**
 * Thumbnail + full-size viewer for a rendered PDF page, with the extracted
 * figure boxed on it.
 *
 * Two boxes are drawn, because they answer different questions: the tight amber
 * box says "this exact figure", the looser blue box says "read from this row",
 * which is what makes a wrong answer diagnosable -- a right number taken off
 * the wrong row looks identical without it.
 *
 * The thumbnail is a ZOOMED CROP rather than a shrunk page. A full Letter page
 * at 150px wide renders a table row about two pixels tall, which shows nothing;
 * cropping to a window around the figure keeps the surrounding rows legible
 * enough to recognise the table. Geometry is done in fractions of the page
 * (see evidence.ts), so the same rects position correctly in both views with no
 * per-view arithmetic.
 */

const THUMB_W = 150;
const THUMB_H = 84;
/** Width of the thumbnail's crop window, as a fraction of the page. */
const CROP_W_FRAC = 0.55;

function pctBox(r: EvidenceRect): React.CSSProperties {
  return {
    left: `${r.x * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.w * 100}%`,
    height: `${r.h * 100}%`,
  };
}

function imageSrc(file: string): string {
  return `/api/evidence?file=${encodeURIComponent(file)}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Size and offset of the scaled page inside the thumbnail viewport, centring
 * the figure and clamped so no blank space shows at the page edges.
 */
function thumbGeometry(ev: Evidence) {
  const focus = ev.value ?? ev.row;
  const fx = focus ? focus.x + focus.w / 2 : 0.5;
  const fy = focus ? focus.y + focus.h / 2 : 0.5;

  const k = THUMB_W / Math.max(1, ev.widthPx * CROP_W_FRAC);
  const pw = Math.round(ev.widthPx * k);
  const ph = Math.round(ev.heightPx * k);

  return {
    pw,
    ph,
    left: Math.round(clamp(THUMB_W / 2 - fx * pw, Math.min(0, THUMB_W - pw), 0)),
    top: Math.round(clamp(THUMB_H / 2 - fy * ph, Math.min(0, THUMB_H - ph), 0)),
  };
}

export default function EvidenceThumb({
  ev,
  label,
}: {
  ev?: Evidence | null;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Runs recorded before this feature existed have no evidence field at all,
  // and a value that was never located has no page to show. Both are normal.
  if (!ev) {
    return (
      <span className="ev-none" title="No page image was captured for this run">
        &mdash;
      </span>
    );
  }

  // Page images are committed, but a run's JSON can still outlive them: a run
  // recorded on a host with poppler and then pulled somewhere the PNG was
  // pruned, or any run predating this feature. Degrade to the same dash rather
  // than a broken image icon.
  if (failed) {
    return (
      <span className="ev-none" title="Page image is no longer on disk">
        &mdash;
      </span>
    );
  }

  const g = thumbGeometry(ev);

  return (
    <>
      <button
        className="ev-thumb"
        onClick={() => setOpen(true)}
        title={`Page ${ev.page} — click to enlarge`}
        aria-label={`View page ${ev.page} evidence for ${label}`}
      >
        <span
          className="ev-page"
          style={{ width: g.pw, height: g.ph, left: g.left, top: g.top }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageSrc(ev.image)}
            alt=""
            draggable={false}
            onError={() => setFailed(true)}
          />
          {ev.row && <span className="ev-hl row" style={pctBox(ev.row)} />}
          {ev.value && <span className="ev-hl val" style={pctBox(ev.value)} />}
        </span>
        <span className="ev-badge">p.{ev.page}</span>
      </button>

      {open && (
        <div
          className="ev-modal"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div className="ev-modal-inner" onClick={(e) => e.stopPropagation()}>
            <div className="ev-modal-head">
              <div className="ev-title">
                {label}
                <span className="cite"> &nbsp;page {ev.page}</span>
              </div>
              <div className="ev-meta">
                {ev.matchedText && (
                  <span className="loc" title="The word matched on the page">
                    {ev.matchedText}
                  </span>
                )}
                <span className={`ev-conf ${ev.confidence}`}>
                  {ev.confidence === "none" ? "not located" : `${ev.confidence} confidence`}
                </span>
                <button className="btn ghost" onClick={() => setOpen(false)}>
                  Close
                </button>
              </div>
            </div>

            <div className="ev-modal-body">
              <span className="ev-modal-page">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageSrc(ev.image)}
                  alt={`Page ${ev.page} of the filing`}
                  onError={() => setFailed(true)}
                />
                {ev.row && <span className="ev-hl row" style={pctBox(ev.row)} />}
                {ev.value && <span className="ev-hl val" style={pctBox(ev.value)} />}
              </span>
            </div>

            {ev.value === null ? (
              <div className="ev-warn">
                The page was rendered, but the figure could not be matched to a
                word on it, so nothing is boxed.
              </div>
            ) : (
              <div className="ev-legend">
                <span className="lg">
                  <i className="sw val" /> the figure
                </span>
                <span className="lg">
                  <i className="sw row" /> the row it was read from
                </span>
                {ev.confidence === "low" && (
                  <span className="cite">
                    this page prints the same amount more than once and the quoted
                    snippet did not disambiguate it &mdash; the box may be on the
                    wrong occurrence
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
