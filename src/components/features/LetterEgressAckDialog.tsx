// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The one implementation of the letter-egress acknowledgement — the warning
 * shown before this app puts text an OUTSIDE producer wrote on screen (#711).
 *
 * Extracted from `JobLetterIndicator` because #767 adds a second door onto the
 * same class of text (`StandardLetterButton`), and a second hand-rolled copy of
 * a warning is exactly what the reuse rule is about: two copies drift in
 * wording, and — worse for this one — a surface that forgets to write the flag
 * would ask again on a browser where the user has already said yes. One
 * component, one wording, one flag.
 *
 * WHAT THE GATE IS ABOUT, restated because it decides what callers must pass:
 * egress that ALREADY HAPPENED to the text being shown. Whatever drafted the
 * letter sent the résumé and the job details out to a model's API; reading it
 * here sends nothing further. So the question is never "which scope holds this
 * letter" but "could a click from here put producer-written text on screen" —
 * which is why {@link letterEgressNeedsAck} takes everything a surface can
 * surface, inherited letters included, rather than one record.
 *
 * The flag is read FRESH on every call, never cached in a hook: several rows'
 * indicators are mounted at once on the library page, and the promise is "once,
 * ever" — not "once per row". `letter-egress-ack.ts` fails silent to ALWAYS ASK
 * AGAIN, so a browser blocking storage re-asks rather than silently skipping.
 */

import { Button, Dialog } from "@design-system";
import {
  hasAcknowledgedLetterEgress,
  recordLetterEgressAcknowledged,
} from "../../lib/letter-egress-ack.ts";
import type { LetterRecord } from "../../lib/storage/index.ts";

/**
 * Whether a surface about to reveal `letters` must warn first — true when any
 * of them carries a `producer` block AND this browser has no acknowledgement
 * recorded.
 *
 * `undefined` entries are accepted and skipped so a caller can pass an optional
 * record (`standardLetter`, `inherited?.letter`) without a guard at every call
 * site — an absent letter cannot be on screen, so it cannot need a warning.
 */
export function letterEgressNeedsAck(
  letters: readonly (LetterRecord | undefined)[],
): boolean {
  const outside = letters.some((letter) => letter?.producer !== undefined);
  return outside && !hasAcknowledgedLetterEgress();
}

interface LetterEgressAckDialogProps {
  open: boolean;
  onClose: () => void;
  /** Where the click that triggered the warning was going. Called after the
   *  acknowledgement is recorded, so the destination cannot diverge between the
   *  warned and unwarned paths. */
  onAcknowledged: () => void;
}

export function LetterEgressAckDialog({
  open,
  onClose,
  onAcknowledged,
}: LetterEgressAckDialogProps) {
  function acknowledge() {
    recordLetterEgressAcknowledged();
    onAcknowledged();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
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
  );
}
