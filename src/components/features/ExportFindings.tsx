// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ExportFindings — what the exporter could not render cleanly, shown on the row
 * that produced the file (#621).
 *
 * Reuse analysis (CLAUDE.md Golden Rule). This is NOT a new banner primitive.
 * The design-system barrel deliberately ships no Toast/Snackbar, and its house
 * pattern for "an action finished and has something to say" is to confirm IN the
 * surface already mounted rather than open a new one — so this swaps content
 * into `ExportRow`, beside the `ErrorState` that already reports a failed
 * export, and carries its status on the shared `StatusBadge`. Nothing new is
 * added to the design system.
 *
 * Three rules it exists to keep:
 *
 *  1. **Zero findings renders NOTHING.** Not an empty "0 issues" panel, not a
 *     green all-clear. Most résumés are clean, and a permanent status strip on
 *     the download row would teach every user to stop reading it.
 *  2. **Never colour alone.** The badge carries the WORD, the sentence states
 *     the count, and every finding names its own field — the tone is
 *     reinforcement.
 *  3. **Advisory, never a blocker.** The user already has their PDF by the time
 *     this renders; the copy says so. Refusing a download is `useDownloadPdf`'s
 *     #664 font gate and stays there.
 *
 * `aria-live="polite"` announces the swap. The parent format list is itself a
 * polite live region, so the announcement would happen regardless; declaring it
 * here keeps the guarantee attached to the component that needs it rather than
 * to a container that could be restructured.
 */

import { StatusBadge } from "@design-system";
import type { RenderFinding } from "../../lib/pdf/render-findings.ts";

/**
 * How many findings are listed before the rest are counted. A résumé pasted from
 * a source full of arrows can produce one finding per bullet; forty rows in a
 * dialog is a wall, and the first few already say what kind of thing is wrong
 * and where to start.
 */
const MAX_LISTED = 5;

export function ExportFindings({
  findings,
}: {
  findings: readonly RenderFinding[];
}) {
  if (findings.length === 0) return null;
  const listed = findings.slice(0, MAX_LISTED);
  const rest = findings.length - listed.length;
  // `warning` when anything was actually destroyed; `info` when every finding is
  // a substitution that still reads correctly (an arrow drawn as "->").
  const tone = findings.some((f) => f.severity === "warning") ? "warning" : "info";

  return (
    <div aria-live="polite" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={tone}>Check the export</StatusBadge>
        <p className="text-sm text-content-secondary">
          Your PDF downloaded, but{" "}
          {findings.length === 1
            ? "one thing"
            : `${findings.length} things`}{" "}
          did not come out as written.
        </p>
      </div>
      <ul className="flex flex-col gap-1">
        {listed.map((finding, idx) => (
          <li
            key={`${finding.kind}:${finding.sourceField}:${finding.detail}:${idx}`}
            className="text-sm text-content-tertiary"
          >
            <span className="font-medium text-content-secondary">
              {finding.sourceField}
            </span>{" "}
            — {finding.detail}
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <p className="text-sm text-content-tertiary">
          …and {rest} more like {rest === 1 ? "this" : "these"}.
        </p>
      )}
    </div>
  );
}
