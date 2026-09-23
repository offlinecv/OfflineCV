// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * LocalAiFeedbackSection — the "Local AI feedback" disclosure and the gate that
 * decides whether it exists at all.
 *
 * Lifted out of `ResultDetail` by #955, which moved it into the score card's
 * details region: the critique is a reason the score is not 100, so it docks
 * with the score rather than sitting below a thousand lines of résumé. It is
 * its own module rather than three more branches inside `ParsedCard` because
 * the gate is the interesting part and it does not fit in a ternary — see
 * below. Display-only: the analysis controller, and every decision about when
 * to RUN it, stay with the caller.
 *
 * Reuse analysis (CLAUDE.md 3-tier rule): no new surface. `Disclosure` is the
 * shared collapsed section every sibling here uses, `ResumeQualityPanel` and
 * `WebGpuUnavailableNotice` are the existing bodies, and nothing below
 * styles anything.
 *
 * Two rules the gate encodes, both moved verbatim with the JSX:
 *
 *  1. **One offer at a time (#243).** While the degenerate-parse recovery
 *     offer stands, the wording critique is withheld — a critique of a parse
 *     the parser itself flagged as degenerate is close to worthless, and
 *     stacking the two put two model-loading CTAs on one screen. Since the
 *     offer is its own row rather than this section's body, withholding the
 *     panel leaves nothing to disclose, so the SECTION goes rather than
 *     opening onto an empty box.
 *
 *  2. **Unavailable is explained in place, not hidden (#276).** This is the
 *     canonical on-device-AI surface, so when WebGPU cannot run here it says
 *     so instead of silently vanishing. `capability === null` (still
 *     detecting) and "no text" both still leave it absent.
 *
 * The label is byte-identical to the tab it replaced — renaming belongs to
 * #680 item 4. "Local AI feedback", not "AI feedback": the word that matters
 * is the one saying the model runs here.
 */

import { Disclosure } from "@design-system";
import { ResumeQualityPanel } from "./ResumeQualityPanel.tsx";
import { WebGpuUnavailableNotice } from "./WebGpuUnavailableNotice.tsx";
import type { AnalysisController } from "../../hooks/useResumeAnalysisLlm.ts";
import type { CascadeResult } from "../../lib/heuristics/types.ts";

interface LocalAiFeedbackSectionProps {
  /** The combined on-device analysis (#262, #273) — critique plus "What an ATS
   *  misses", from one inference. Owned by the caller. */
  analysis: AnalysisController;
  /** The parse the critique is about — the RECOVERED one where there is one. */
  result: CascadeResult;
  /**
   * A degenerate-parse recovery offer is outstanding, so hold the critique
   * back (rule 1 above).
   *
   * The caller derives it as `escapeHatch.isAvailable && status.kind !==
   * "done"`, which is NOT the gate the offer itself renders on — the hatch
   * stays available after a successful pass so it can be re-run, and gating
   * the offer's own mount on this would unmount it in the render that fires
   * `onRecovered`. Two different questions, deliberately two expressions.
   */
  recoveryOffered: boolean;
  /** Scroll back to the résumé, where the per-role rewrite wand already lives
   *  (#3, #244, #273) — the panel links each flagged bullet to that affordance
   *  instead of building a parallel rewrite UI. */
  onGoToRewrite: () => void;
}

export function LocalAiFeedbackSection({
  analysis,
  result,
  recoveryOffered,
  onGoToRewrite,
}: LocalAiFeedbackSectionProps) {
  const unavailableCapability =
    analysis.hasText &&
    analysis.capability !== null &&
    analysis.capability !== "available"
      ? analysis.capability
      : null;

  if (recoveryOffered) return null;
  if (!analysis.isAvailable && unavailableCapability === null) return null;

  return (
    // Warn-marked only for the WebGPU case — nothing is broken in the browser
    // otherwise, and the recovery offer has a row of its own.
    <Disclosure
      summary="Local AI feedback"
      warn={!analysis.isAvailable}
      warnLabel="setup needed"
    >
      {analysis.isAvailable ? (
        <ResumeQualityPanel
          controller={analysis}
          result={result}
          onGoToRewrite={onGoToRewrite}
        />
      ) : (
        /* Guarded by the early return above, so this narrowing is the
           condition that opened the section rather than an extra one. */
        unavailableCapability && (
          <WebGpuUnavailableNotice capability={unavailableCapability} />
        )
      )}
    </Disclosure>
  );
}
