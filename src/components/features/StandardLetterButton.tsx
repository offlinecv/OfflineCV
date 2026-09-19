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
 * company entity (#766). The same button edits that letter in place once it
 * exists — the company tier's only edit path, and deliberately reached from a
 * row rather than from here for the same "which company" reason.
 *
 * That asymmetry is the whole reason this file exists and its company sibling
 * does not: the standard letter is the one scope with nothing to hang off, so
 * it is the one that needs a control of its own.
 *
 * ## The older-letters door (#978)
 *
 * The standard tier is the one scope with a SINGLE window onto it: the chain
 * surfaces `mostRecent`, this button holds `standard[0]`, and nothing else in
 * the app enumerates the tier. So a second unscoped record — from a backup
 * import, from the extension, or from a compose that raced the store read (see
 * `JobTracker`'s `lettersReady`) — is invisible everywhere and, before #978,
 * had no delete path either. It is also the one tier that needs a door HERE
 * rather than on a row: a job's reveal can only be reached through a job, and
 * a library with no tracked jobs still has a standard letter.
 *
 * That door is the existing reveal, not a new list: `LetterRevealDialog` already
 * renders a picker over several letters, shows the body, and copies — the three
 * things someone deciding which duplicate to keep actually needs. It is handed
 * no `onEdit`, deliberately. Editing an unreachable copy would bump its
 * `updatedAt` and silently PROMOTE it over the letter the user has been using,
 * which is a scope change wearing an edit's clothes; copy-then-paste into the
 * real standard letter is the same recovery with the promotion made explicit.
 *
 * `Button` + the existing dialog off `@design-system` and the sibling feature
 * file; no hand-rolled control.
 */

import { useState } from "react";
import { Button } from "@design-system";
import { LetterEditorDialog } from "./LetterEditorDialog.tsx";
import { LetterRevealDialog } from "./LetterRevealDialog.tsx";
import {
  LetterDeleteDialog,
  UNREACHABLE_CONSEQUENCE,
} from "./LetterDeleteDialog.tsx";
import {
  LetterEgressAckDialog,
  letterEgressNeedsAck,
} from "./LetterEgressAckDialog.tsx";
import type { LetterRecord } from "../../lib/storage/index.ts";

type Stage = "closed" | "ack" | "edit" | "others" | "delete";

interface StandardLetterButtonProps {
  /** The existing standard letter, if the user has written one. Absent renders
   *  the compose affordance; present renders the edit one and hands the record
   *  to the editor. */
  letter?: LetterRecord;
  /** Every OTHER unscoped record — `standard.slice(1)` (#978). Ordinarily
   *  empty; non-empty means the store holds standard letters no resolution
   *  chain can reach, and this component is the only surface that can show
   *  them. */
  others?: readonly LetterRecord[];
  /** Re-read the letter store after a write, so the tracker's rows pick up a
   *  newly written standard letter without a remount. */
  onSaved?: () => Promise<void> | void;
}

export function StandardLetterButton({
  letter,
  others = [],
  onSaved = () => {},
}: StandardLetterButtonProps) {
  const [stage, setStage] = useState<Stage>("closed");
  // Which older copy the confirm is about, and where to return afterwards.
  const [deleting, setDeleting] = useState<LetterRecord | undefined>(undefined);
  // Where the egress acknowledgement should land — this control has two doors
  // onto letter text now, and the gate must not send both to the editor.
  const [afterAck, setAfterAck] = useState<Stage>("edit");

  // The label carries the state, not a separate badge: this is one control in a
  // header row of them, and "Standard letter" alone would leave the user to
  // click to find out whether they have one.
  const label = letter ? "Edit standard letter" : "Write a standard letter";

  /**
   * The SAME egress gate the row indicator applies, for the same reason (#767
   * review). The standard letter is precisely the record shape #766 created and
   * an outside producer can write: `letter-contract.ts` makes both scope keys
   * optional and `producer` an allowed field, so a backup import lands a
   * producer-written standard letter, and this button then puts it on screen.
   * Before #767 the editor was reachable only through the gated indicator; this
   * is the second door, so the gate has to be here too — shared rather than
   * copied, so the two cannot drift in wording or forget to write the flag.
   */
  function open() {
    go("edit", [letter]);
  }

  /** Enter `next`, passing the egress gate first when any of `shown` had it. */
  function go(next: Stage, shown: readonly (LetterRecord | undefined)[]): void {
    setAfterAck(next);
    if (letterEgressNeedsAck(shown)) {
      setStage("ack");
      return;
    }
    setStage(next);
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={open}>
        {label}
      </Button>
      {/* Only when the store actually holds unreachable copies. A control that
          is always present and usually says "(0)" would be permanent noise in a
          header row for a state that should never occur. */}
      {others.length > 0 && (
        <Button variant="ghost" size="sm" onClick={() => go("others", others)}>
          Older standard letters ({others.length})
        </Button>
      )}
      <LetterEgressAckDialog
        open={stage === "ack"}
        onClose={() => setStage("closed")}
        onAcknowledged={() => setStage(afterAck)}
      />
      {/* No `onEdit` and no `onCompose` — see the docblock. Copy and Delete are
          the two things this view is for. */}
      <LetterRevealDialog
        open={stage === "others"}
        onClose={() => setStage("closed")}
        letters={others}
        onDelete={(target) => {
          setDeleting(target);
          setStage("delete");
        }}
      />
      <LetterDeleteDialog
        open={stage === "delete"}
        onClose={() => setStage("closed")}
        letter={deleting}
        consequence={UNREACHABLE_CONSEQUENCE}
        onDeleted={onSaved}
      />
      {/* No `jobId` and no `companyKey` — the absence of both IS the standard
          scope (#766), not a defaulted value the editor fills in. */}
      <LetterEditorDialog
        open={stage === "edit"}
        onClose={() => setStage("closed")}
        letter={letter}
        onSaved={onSaved}
      />
    </>
  );
}
