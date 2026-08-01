// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobLetterIndicator — the per-row "this job has a cover letter" affordance
 * on the Saved jobs library (#715). Renders nothing when the job has no
 * letters, so an untouched tracked job carries no empty icon. Owns the
 * one-time egress acknowledgement gate; the actual reveal (draft picker,
 * plain-text body, copy) lives in the sibling `LetterRevealDialog`.
 *
 * Split from `JobTrackerEntry` rather than grown into it: that file is
 * already at the ~200 LOC feature-component guideline, and this indicator's
 * click → acknowledge → reveal state machine is a self-contained unit with
 * its own dialog, not a couple of lines of row markup.
 *
 * The acknowledgement text is about THIS app's custody claim, not about what
 * clicking the icon does: reading a stored letter or copying it to the
 * clipboard sends nothing anywhere. What already happened, before the letter
 * ever reached this store, is that whatever generated its text sent the résumé
 * and the job details somewhere to draft it. The copy names that DESTINATION,
 * not merely the access: today the only producer is a Claude Code skill
 * (`.claude/skills/cover-letter/SKILL.md`), which sends both to the Anthropic
 * API — the same fact that skill states in its own opening disclosure, so the
 * two surfaces cannot drift into telling the user different things. That is
 * what this dialog states, once, per browser (`letter-egress-ack.ts`).
 *
 * The "once" is a claim about storage, so it is worded as one: the flag lives
 * in `localStorage`, and where that is unavailable (private browsing, blocked
 * storage, a full quota) `letter-egress-ack.ts` fails closed and the dialog
 * returns next session. A flat "you only need to confirm this once" is false
 * whenever that happens.
 *
 * Reuse analysis: `Button` + `Dialog` from `@design-system`, no hand-rolled
 * modal or button. The letter glyph is a local, inline SVG rather than an
 * addition to the shared `TrustIcons` barrel — that module is re-exported
 * from `@design-system` and eagerly reaches every one of the three entry
 * chunks, and this icon only ever renders on `/jobs/`.
 */

import { useState } from "react";
import { Button, Dialog } from "@design-system";
import {
  hasAcknowledgedLetterEgress,
  recordLetterEgressAcknowledged,
} from "../../lib/letter-egress-ack.ts";
import { LetterRevealDialog } from "./LetterRevealDialog.tsx";
import type { LetterRecord } from "../../lib/storage/index.ts";

function LetterGlyph() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

interface JobLetterIndicatorProps {
  /** Every letter for this one job, most-recently-updated first. Empty (or
   *  omitted) renders nothing — no affordance for a job with no letter. */
  letters?: readonly LetterRecord[];
}

type Stage = "closed" | "ack" | "reveal";

export function JobLetterIndicator({ letters = [] }: JobLetterIndicatorProps) {
  const [stage, setStage] = useState<Stage>("closed");

  if (letters.length === 0) return null;

  const label =
    letters.length === 1
      ? "View cover letter"
      : `View cover letters (${letters.length})`;

  function open() {
    // Read fresh, not from a cached hook value: several rows' indicators are
    // mounted at once on this page, and the acknowledgement is meant to be
    // "once, ever" — not "once per row." See `letter-egress-ack.ts`.
    setStage(hasAcknowledgedLetterEgress() ? "reveal" : "ack");
  }

  function acknowledge() {
    recordLetterEgressAcknowledged();
    setStage("reveal");
  }

  return (
    <>
      {/* `min-h-6 min-w-6` sizes the VISIBLE box, which is not what the icon
          variant's fixed 24×24 `after:` overlay governs (see `Button.tsx` and
          `ReconstructedAdd`'s `RemoveButton`): the glyph is 16×16 and the
          variant adds only `p-0.5`, so without the minimum the hover surface
          and focus ring shrink to ~20×20 inside a `gap-1` row. */}
      <Button
        variant="icon"
        aria-label={label}
        title={label}
        onClick={open}
        className="min-h-6 min-w-6 shrink-0"
      >
        <LetterGlyph />
      </Button>

      <Dialog
        open={stage === "ack"}
        onClose={() => setStage("closed")}
        title="Before you view this letter"
        className="max-w-md"
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm leading-relaxed text-content-secondary">
            offlinecv stores this letter — it did not write it. To draft it,
            whatever generated the text sent your résumé and the job details
            out to a service: today that is a Claude Code skill, which sends
            them to the Anthropic API. That step happened outside this app's
            on-device guarantee. Reading the letter here, or copying it, sends
            nothing further.
          </p>
          <p className="text-2xs leading-relaxed text-content-tertiary">
            Your confirmation is saved in this browser, so you normally see
            this once. If this browser blocks that storage, it will ask again.
          </p>
          <div className="mt-1 flex justify-end">
            <Button variant="primary" size="sm" onClick={acknowledge}>
              Got it
            </Button>
          </div>
        </div>
      </Dialog>

      <LetterRevealDialog
        open={stage === "reveal"}
        onClose={() => setStage("closed")}
        letters={letters}
      />
    </>
  );
}
