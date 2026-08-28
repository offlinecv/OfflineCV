// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * StandardLetterButton — the one panel-level way to write and edit the standard
 * cover letter (#767).
 *
 * Per #765, the standard letter is the SOURCE the other two tiers are tailored
 * from, not a fallback beneath them: it holds the candidate-specific material
 * that has no place on a résumé — a career-change narrative, a relocation or
 * visa fact, a reason for a gap. That makes it the one letter with no job to
 * hang off, so it needs an affordance that is not a row.
 *
 * Reuse analysis (#767's, restated because this is the file the gate is about):
 * every OTHER letter affordance is per-row — `JobLetterIndicator` is mounted
 * once per tracked job and is reached through a job. Nothing in the tree owns a
 * panel-level letter control, so there is no surface to extend; folding this
 * into `JobTracker` would push a file already past the ~200 LOC guideline
 * further past it. Authoring itself is NOT duplicated — this delegates to
 * `LetterEditorDialog` with no `jobId` and no `companyKey`, which is exactly
 * the shape that writes a letter with neither scope key.
 *
 * Company letters get no equivalent entry point here, deliberately: one is
 * created by **"Customize for this company"** in `LetterRevealDialog`, reached
 * from a job row, where the company is already known and its key already
 * derived. A panel-level "write a company letter" would have to ask WHICH
 * company, which means inventing a company picker for an app that has no
 * company entity (#766).
 *
 * That asymmetry is the whole reason this file exists and its company sibling
 * does not: the standard letter is the one scope with nothing to hang off, so
 * it is the one that needs a control of its own.
 *
 * `Button` + the existing dialog off `@design-system` and the sibling feature
 * file; no hand-rolled control.
 */

import { useState } from "react";
import { Button } from "@design-system";
import { LetterEditorDialog } from "./LetterEditorDialog.tsx";
import type { LetterRecord } from "../../lib/storage/index.ts";

interface StandardLetterButtonProps {
  /** The existing standard letter, if the user has written one. Absent renders
   *  the compose affordance; present renders the edit one and hands the record
   *  to the editor. */
  letter?: LetterRecord;
  /** Re-read the letter store after a write, so the tracker's rows pick up a
   *  newly written standard letter without a remount. */
  onSaved?: () => Promise<void> | void;
}

export function StandardLetterButton({
  letter,
  onSaved = () => {},
}: StandardLetterButtonProps) {
  const [open, setOpen] = useState(false);

  // The label carries the state, not a separate badge: this is one control in a
  // header row of them, and "Standard letter" alone would leave the user to
  // click to find out whether they have one.
  const label = letter ? "Edit standard letter" : "Write a standard letter";

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      {/* No `jobId` and no `companyKey` — the absence of both IS the standard
          scope (#766), not a defaulted value the editor fills in. */}
      <LetterEditorDialog
        open={open}
        onClose={() => setOpen(false)}
        letter={letter}
        onSaved={onSaved}
      />
    </>
  );
}
