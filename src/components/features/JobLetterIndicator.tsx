// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobLetterIndicator — the per-row cover-letter affordance on the Saved jobs
 * library (#715). Every tracked job gets one, in one of two states:
 *
 *   letters ≥ 1 → an envelope, "View cover letter" → reveal (read, copy, edit)
 *   letters = 0 → an envelope with a "+", "Write a cover letter" → editor
 *
 * It used to render NOTHING on a job with no letters, on the reasoning that an
 * untouched job should carry no empty icon. That held only while the app could
 * not write a letter: with an editor in the tree, the empty state is the entry
 * point to the feature, and hiding it means the only way to get a cover letter
 * into offlinecv is an outside producer. Two distinct glyphs rather than one
 * conditional label because the states differ in what a click DOES — read
 * versus author — and the icon is what the user reads at a glance across a
 * list of rows.
 *
 * Split from `JobTrackerEntry` rather than grown into it: that file is
 * already at the ~200 LOC feature-component guideline, and this indicator's
 * click → acknowledge → reveal/edit state machine is a self-contained unit
 * with its own dialogs, not a couple of lines of row markup.
 *
 * The acknowledgement gate is about EGRESS THAT ALREADY HAPPENED, so it is
 * scoped to the letters that had any. Drafting a letter through a model sends
 * the résumé and the job details to that model's API, and the user deserves to
 * be told once. A letter typed into `LetterEditorDialog` sent nothing
 * anywhere, so gating it behind that warning would be telling the user
 * something untrue about their own typing. `hasOutsideProducer` is the test:
 * `docs/cover-letter-contract.md` §6 reads an absent `producer` block as
 * "written by offlinecv itself", and the editor never writes one. That marker
 * is self-reported and optional, so it is used ONLY in this direction — a
 * present block means warn, an absent one means this app wrote it. It is never
 * evidence that no egress happened for a record that came in some other way,
 * which is why the import path still lands letters carrying their producer's
 * own block.
 *
 * The wording of the warning used to lean on co-location — the sole producer
 * was a skill in this repo, so its disclosure and this one could not drift.
 * That stopped being true when the skill moved out, and the copy must not
 * depend on a producer's own honesty. So it names the class (a model's API),
 * not a vendor, and holds without reading any producer's source.
 *
 * The "once" is a claim about storage, so it is worded as one: the flag lives
 * in `localStorage`, and where that is unavailable (private browsing, blocked
 * storage, a full quota) `letter-egress-ack.ts` fails closed and the dialog
 * returns next session. A flat "you only need to confirm this once" is false
 * whenever that happens.
 *
 * Reuse analysis: `Button` + `Dialog` from `@design-system`, no hand-rolled
 * modal or button; authoring is delegated to `LetterEditorDialog` rather than
 * duplicated here. The letter glyphs are local, inline SVGs rather than an
 * addition to the shared `TrustIcons` barrel — that module is re-exported
 * from `@design-system` and eagerly reaches every one of the three entry
 * chunks, and these icons only ever render on `/jobs/`.
 */

import { useState } from "react";
import { Button, Dialog } from "@design-system";
import {
  hasAcknowledgedLetterEgress,
  recordLetterEgressAcknowledged,
} from "../../lib/letter-egress-ack.ts";
import { LetterRevealDialog } from "./LetterRevealDialog.tsx";
import { LetterEditorDialog } from "./LetterEditorDialog.tsx";
import type { LetterRecord } from "../../lib/storage/index.ts";

/** Shared frame for both glyphs, so the two states differ only in the mark
 *  inside the envelope and never in weight, size, or alignment on the row. */
function Glyph({ children }: { children: React.ReactNode }) {
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
      {children}
    </svg>
  );
}

function LetterGlyph() {
  return (
    <Glyph>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </Glyph>
  );
}

/** The empty state. The envelope is clipped to the left so the "+" sits in
 *  free space rather than on top of the flap — at 16px an overlapping mark
 *  reads as noise, not as "add". */
function LetterAddGlyph() {
  return (
    <Glyph>
      <path d="M21 11V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h7" />
      <path d="m3 7 9 6 6-4" />
      <path d="M18 15v6" />
      <path d="M15 18h6" />
    </Glyph>
  );
}

interface JobLetterIndicatorProps {
  /** The job these letters belong to — needed to write a new one. */
  jobId: string;
  /** Every letter for this one job, most-recently-updated first. Empty (or
   *  omitted) renders the "write one" state, not nothing. */
  letters?: readonly LetterRecord[];
  /** Re-read the letter store after a write. Optional so a caller that only
   *  displays letters (a test, a future read-only view) need not supply one;
   *  without it a saved letter will not appear until the view remounts. */
  onSaved?: () => Promise<void> | void;
}

type Stage = "closed" | "ack" | "reveal" | "edit";

/** True when any letter here was written OUTSIDE this app — the only case the
 *  egress warning is about. See the docblock on why this is read one-way. */
function hasOutsideProducer(letters: readonly LetterRecord[]): boolean {
  return letters.some((letter) => letter.producer !== undefined);
}

export function JobLetterIndicator({
  jobId,
  letters = [],
  onSaved = () => {},
}: JobLetterIndicatorProps) {
  const [stage, setStage] = useState<Stage>("closed");
  // Which letter the editor is revising. `undefined` composes a new draft,
  // which is also the empty-state path — one editor, both jobs.
  const [editing, setEditing] = useState<LetterRecord | undefined>(undefined);

  const hasLetters = letters.length > 0;
  const label = !hasLetters
    ? "Write a cover letter"
    : letters.length === 1
      ? "View cover letter"
      : `View cover letters (${letters.length})`;

  function open() {
    if (!hasLetters) {
      setEditing(undefined);
      setStage("edit");
      return;
    }
    // Read the acknowledgement fresh, not from a cached hook value: several
    // rows' indicators are mounted at once on this page, and it is meant to be
    // "once, ever" — not "once per row." See `letter-egress-ack.ts`.
    const mustWarn =
      hasOutsideProducer(letters) && !hasAcknowledgedLetterEgress();
    setStage(mustWarn ? "ack" : "reveal");
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
        {hasLetters ? <LetterGlyph /> : <LetterAddGlyph />}
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
            out to a model&rsquo;s API. That step happened outside this
            app&rsquo;s on-device guarantee. Reading the letter here, or
            copying it, sends nothing further.
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
        onEdit={(letter) => {
          setEditing(letter);
          setStage("edit");
        }}
        onCompose={() => {
          setEditing(undefined);
          setStage("edit");
        }}
      />

      <LetterEditorDialog
        open={stage === "edit"}
        onClose={() => setStage("closed")}
        jobId={jobId}
        letter={editing}
        onSaved={onSaved}
      />
    </>
  );
}
