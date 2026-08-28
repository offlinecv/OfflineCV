// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ExportDialog — the one place `/` hands the user something to leave with
 * (#823). Opened by the journey rail's `Download` stage.
 *
 * It replaces three buttons in one row above the reconstructed résumé — a
 * "Download report" ghost that opened its own dialog containing a FOURTH
 * Download button, a "Download as Markdown" ghost, and a "Download resume"
 * primary — plus, once opened, a second stacked overlay when the pre-download
 * gate fired. A user told by the header rail that Download is step 3 of their
 * journey then found three of them and no statement of which one was the
 * résumé. Each row here NAMES its artifact, which is also #680 item 5 ("the
 * download affordance doesn't say which résumé you get") and item 7 ("users
 * don't know the export already is the ATS-safe artifact").
 *
 * Reuse analysis (CLAUDE.md 3-tier rule). Two single-artifact surfaces already
 * existed — `DownloadGateDialog` (checklist, PDF only) and
 * `DownloadReportDialog`'s `ReportDownloadControl` (button + dialog, report
 * only). This is not a parallel surface beside them: it is the two of them
 * merged plus the Markdown row, and both were deleted into it.
 *   - Primitive: `Dialog` owns the modal chrome, focus trap, Esc and ARIA. No
 *     raw `<dialog>`.
 *   - Primitive: `Button` for every action. No raw `<button>`.
 *   - Primitive: `Checkbox` for the identity opt-in — the migration its own
 *     docblock said was a mechanical swap once `DownloadReportDialog`'s
 *     markup-querying tests were out of the way. They are: the file is gone.
 *   - All generation lives in the three lib-backed hooks; this owns only
 *     "which body am I showing" plus the report's format/identity choice.
 *
 * This file is the dialog shell and that state. The bodies are siblings —
 * `ExportGateBody` (the checklist and the `Fix now` jump) and `ExportRows` (the
 * row shell plus the audit-report row) — because CLAUDE.md decomposes a feature
 * component past ~200 LOC and both split along a seam that costs nothing: they
 * are display-only, and the report's two choices deliberately stay HERE, since
 * the format list unmounts whenever the gate takes its place.
 *
 * Two behaviours that are preserved EXACTLY and must stay that way:
 *
 *  1. **The PDF gate is soft, and it is re-derived per click.** `Fix now` /
 *     `Download anyway` mean what they meant in `DownloadGateDialog`; the
 *     checklist just renders in THIS dialog rather than opening a second
 *     overlay on top of it. Because the gate is recomputed from the current
 *     override-applied fields on every click, an edit made via `Fix now` clears
 *     the item on the next one with no extra plumbing.
 *  2. **The report's identity header is opt-in, default OFF** (#343). When off,
 *     no identity block reaches either renderer and the filename falls back to
 *     a generic one, so even the filename carries no PII.
 *
 * Each body swap moves focus into the body that arrives and announces it
 * (`aria-live`). The swap unmounts the button the user just activated, so
 * without that focus lands on `<body>` — outside the dialog's tab ring — while
 * the title silently changes and a blocker list appears with nothing said.
 *
 * The dialog does NOT close itself after a download. `useDownloadPdf` and
 * `useDownloadReport` report failure through an `error` string rendered in the
 * row that produced it, and closing on the click would unmount the message
 * before it rendered — the #421 defect. The browser's own download indicator is
 * the success signal; `Close` is the user's.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Button, Dialog } from "@design-system";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { ReportFormat } from "../../lib/analytics.ts";
import type { ContactOverrides } from "../../hooks/useEditableParse.ts";
import {
  applyContactOverrides,
  buildContactFields,
  criticalDownloadGate,
} from "../../lib/contact.ts";
import { ExportGateBody, fixFirstGap } from "./ExportGateBody.tsx";
import { ExportRow, ExportReportRow } from "./ExportRows.tsx";
import { ExportFindings } from "./ExportFindings.tsx";
import { useDownloadPdf } from "../../hooks/useDownloadPdf.ts";
import { useDownloadMarkdown } from "../../hooks/useDownloadMarkdown.ts";
import { useDownloadReport } from "../../hooks/useDownloadReport.ts";

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  /** The résumé being exported — the RECOVERED parse when an on-device pass has
   *  run, so the artifact matches what the page shows (see `useLlmRecovery`). */
  result: CascadeResult;
  score: AnonymousAtsScore;
  /** The inline-edit contact overrides, so the gate reads the same fields the
   *  ContactCard renders rather than the raw parse. */
  contactOverrides: ContactOverrides;
  /**
   * Any artifact reached the user (#826) — all three rows share one handler,
   * because the journey's `Download` stage is one stage: it records that the
   * user went through here, not which of the three files they took.
   *
   * Passed down to each hook rather than wrapped around the click, because the
   * click is not the success point: the PDF row can divert to the gate, and
   * every row can fail into an inline error without the dialog closing.
   */
  onExported?: () => void;
  /**
   * Fired only when the résumé itself — PDF or Markdown — downloads, never
   * the audit report (#900). Feeds `FeedbackDialog`'s automatic milestone
   * trigger, which cares about "you got your résumé" rather than every
   * artifact this dialog can produce.
   */
  onResumeExported?: () => void;
}

export function ExportDialog({
  open,
  onClose,
  result,
  score,
  contactOverrides,
  onExported,
  onResumeExported,
}: ExportDialogProps) {
  const [body, setBody] = useState<"formats" | "gate">("formats");
  // Focus for the half of the swap `ExportGateBody` cannot own. It focuses
  // itself when it mounts; coming BACK from it unmounts the checklist including
  // the `Download anyway` button that was just activated, which drops focus to
  // `<body>` — outside the dialog's tab ring — with nothing said about the
  // format list reappearing.
  const formatsBody = useRef<HTMLDivElement>(null);
  const cameFromGate = useRef(false);
  useEffect(() => {
    if (body !== "formats" || !cameFromGate.current) return;
    cameFromGate.current = false;
    formatsBody.current?.focus();
  }, [body]);
  const [reportFormat, setReportFormat] = useState<ReportFormat>("pdf");
  const [includeIdentity, setIncludeIdentity] = useState(false);
  const formatName = useId();

  // pdf/markdown fire BOTH callbacks — the shared Download-stage mark (#826)
  // and the résumé-only feedback milestone (#900). `report` fires only the
  // former: an audit report is not "you got your résumé".
  const pdf = useDownloadPdf(result, score, () => {
    onExported?.();
    onResumeExported?.();
  });
  const markdown = useDownloadMarkdown(result, score, () => {
    onExported?.();
    onResumeExported?.();
  });
  const report = useDownloadReport(result, score, onExported);

  // Re-derived every render, so the checklist reflects the edit the user just
  // made rather than the gaps that were there when the dialog opened.
  const criticalMissing = criticalDownloadGate(
    applyContactOverrides(buildContactFields(result.canonical), contactOverrides),
    result.canonical.fields.experience.length > 0,
  );

  // Every exit resets the body, so reopening never lands on a checklist the
  // user has already answered. Esc and the backdrop route here through
  // `Dialog`'s own `onClose`.
  function close() {
    // Not a swap the user stays to see — the dialog is going away, so nothing
    // should chase focus into it on the way out.
    cameFromGate.current = false;
    setBody("formats");
    onClose();
  }

  function handlePdf() {
    if (criticalMissing.length > 0) {
      cameFromGate.current = true;
      setBody("gate");
      return;
    }
    void pdf.download();
  }

  // Back to the format list rather than out of the dialog: `download()` reports
  // a failure through `pdf.error`, which renders on the PDF row.
  function handleDownloadAnyway() {
    setBody("formats");
    void pdf.download();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={body === "gate" ? "Missing before download" : "Download"}
      className="max-w-md"
    >
      {body === "gate" ? (
        <ExportGateBody
          missing={criticalMissing}
          onFixNow={() => {
            close();
            fixFirstGap(criticalMissing);
          }}
          onDownloadAnyway={handleDownloadAnyway}
        />
      ) : (
        <div
          ref={formatsBody}
          tabIndex={-1}
          aria-live="polite"
          className="flex flex-col gap-4 focus:outline-hidden"
        >
          <ExportRow
            title="Résumé (PDF)"
            description="A clean, single-column PDF built from the résumé on this page, including your edits. This is the ATS-safe artifact — there is no other version to pick."
            error={pdf.error}
          >
            <Button
              variant="primary"
              size="sm"
              onClick={handlePdf}
              disabled={pdf.isGenerating}
            >
              {pdf.isGenerating ? "Generating…" : "Download PDF"}
            </Button>
            {/* What the export could not draw cleanly (#621) — advisory, and
                renders NOTHING for the clean résumé that is the common case.
                It sits on the row that produced the file, beside the row's own
                `ErrorState`, because that is the surface already mounted. */}
            <ExportFindings findings={pdf.findings} />
          </ExportRow>

          <ExportRow
            title="Résumé (Markdown)"
            description="The same résumé as a plain-text cv.md file, for editing elsewhere or handing to another tool."
            error={markdown.error}
          >
            {/* No pre-download checklist here, unlike the PDF: cv.md is a
                plain-text interchange file, not an ATS-submitted artifact, so
                the missing-name/contact/experience nudge that protects the PDF
                does not apply. */}
            {/* `secondary`, not `ghost` — see `ExportRows`' report button for
                the ladder. Quieter than the PDF above it, but still a button. */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void markdown.download()}
              disabled={markdown.isGenerating}
            >
              {markdown.isGenerating ? "Generating…" : "Download Markdown"}
            </Button>
          </ExportRow>

          <ExportReportRow
            report={report}
            formatName={formatName}
            format={reportFormat}
            onFormatChange={setReportFormat}
            includeIdentity={includeIdentity}
            onIncludeIdentityChange={setIncludeIdentity}
          />

          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={close}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
