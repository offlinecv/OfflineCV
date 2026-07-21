// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ReportGapSection — "Report a parsing gap" affordance (#245).
 *
 * Generates a structure-only, PII-redacted repro artifact (see
 * `lib/heuristics/repro-artifact.ts`) and downloads it LOCALLY so the user can
 * attach it to a GitHub issue by hand. NOTHING is uploaded — the copy says so,
 * and the implementation has no network path. Renders regardless of analytics
 * (the download is local); only `trackGapReported` (count-only) is env-gated.
 *
 * Home (#242 follow-up): lives at the bottom of the "What an ATS misses" tab —
 * the surface where parsing gaps are characterized — rather than the score
 * header. It was extracted out of `FeedbackPanel` (which is now rating-only) so
 * the gap report sits next to the disagreements it describes. The optional
 * `disagreements` prop folds the characterized gaps (kinds only) into the
 * artifact when the user has run the on-device comparison.
 *
 * Progressive disclosure: a quiet one-line trigger that unfolds into the
 * explainer + download button, mirroring the rating form's collapsed-first feel.
 * Built from `Card`/`Button` primitives; semantic tokens only.
 */

import { useId, useState } from "react";
import { Card, Button } from "@design-system";
import { useReportGap } from "../../hooks/useReportGap.ts";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { ParseDisagreement } from "../../lib/heuristics/disagreement.ts";

export function ReportGapSection({
  result,
  disagreements,
  headingLevel = 2,
}: {
  result: CascadeResult;
  disagreements?: readonly ParseDisagreement[];
  /**
   * Heading rank for "Report a parsing gap" (#273). Defaults to `2`; pass `3`
   * when nested under an `h3` section (as in `ResumeQualityPanel`'s "What an
   * ATS misses" subsection) so screen-reader heading navigation doesn't jump
   * backward from h3 to h2.
   */
  headingLevel?: 2 | 3;
}) {
  const [open, setOpen] = useState(false);
  const { report, reported, error } = useReportGap(result, disagreements ?? []);
  const headingId = useId();
  const Heading = headingLevel === 3 ? "h3" : "h2";

  if (!open) {
    return (
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="link"
          size="sm"
          onClick={() => setOpen(true)}
          aria-expanded={false}
        >
          Parser missed something? Report a parsing gap
        </Button>
      </div>
    );
  }

  return (
    <Card className="flex flex-col gap-3 border-l-4 border-l-accent-primary bg-accent-forward-bg shadow-sm">
      <div className="flex flex-col gap-1">
        <Heading
          id={headingId}
          className="text-sm font-semibold text-content-primary"
        >
          Report a parsing gap
        </Heading>
        <p className="max-w-prose text-sm text-content-tertiary">
          Download a small, <strong>structure-only</strong> diagnostic file —
          section boundaries, counts, and layout flags. It carries{" "}
          <strong>none of your résumé text</strong> (no name, email, phone, or
          bullet content), so it's safe to attach to a public issue. Nothing is
          uploaded; the download stays in this browser until you attach it
          yourself.
        </p>
      </div>

      {reported ? (
        <div
          role="status"
          className="flex flex-col gap-1 rounded border border-border-light bg-surface-subtle p-3"
        >
          <p className="text-sm font-medium text-content-primary">
            Diagnostic file downloaded.
          </p>
          <p className="text-sm text-content-tertiary">
            Attach it to a new issue at{" "}
            <a
              href="https://github.com/offlinecv/OfflineCV/issues/new"
              target="_blank"
              rel="noreferrer noopener"
              className="underline decoration-dotted hover:decoration-solid"
            >
              github.com/offlinecv/OfflineCV
            </a>{" "}
            describing what the parser got wrong.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            onClick={report}
            aria-describedby={headingId}
          >
            Download diagnostic file
          </Button>
          {disagreements && disagreements.length > 0 && (
            <span className="text-xs text-content-muted">
              Includes {disagreements.length} characterized gap
              {disagreements.length === 1 ? "" : "s"} from the on-device
              comparison (kinds only — no recovered text).
            </span>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-feedback-error-text">
          {error}
        </p>
      )}
    </Card>
  );
}
