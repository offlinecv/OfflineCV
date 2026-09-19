// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * LetterDeleteDialog — the confirm between a letter and `deleteLetter` (#978).
 *
 * `deleteLetter` has existed in the store since #711 and, until this file, had
 * **zero callers anywhere in `src/`**. The only deletion that ran was the
 * cascade — `deleteLettersForJob`, reached from `deleteJob` — so a letter was
 * removable only by deleting the job it named, and a letter naming no job (the
 * company and standard tiers #766 added) was not removable at all. That was
 * survivable while every letter was job-scoped and every job's drafts were
 * listed; it stopped being survivable the moment a scope existed that no
 * surface enumerates.
 *
 * One dialog for all three scopes rather than one per surface. What differs
 * between them is a single sentence — who else loses the letter — and that
 * sentence is the caller's to write, because the caller is the side that knows
 * whether this is a job's own draft, the company's, or the standard one. The
 * rest (the confirm, the in-flight lock, the failure line) is identical, and a
 * second copy of it is how one scope would quietly end up without a confirm.
 *
 * Deletion is a **tombstone**, not an erase (`softDeleteRecord`, #730), so this
 * is recoverable from a backup taken before it — but there is no undo in the
 * app, which is exactly why the confirm names the consequence instead of
 * asking "are you sure?". The user authored this prose; losing it silently is
 * the app discarding their work.
 *
 * Reuse analysis: `Dialog` + `Button` from `@design-system`, no hand-rolled
 * modal. It is the sibling of `LetterEditorDialog` — that one owns the write,
 * this one owns the delete — and it mirrors that file's failure handling
 * deliberately: the write can fail for reasons the user can act on (blocked
 * storage, a browser that lost the database), so the dialog says so and stays
 * open rather than closing on an action that did not happen.
 */

import { useEffect, useState } from "react";
import { Button, Dialog } from "@design-system";
import { deleteLetter } from "../../lib/storage/index.ts";
import type { LetterRecord } from "../../lib/storage/index.ts";

/**
 * The consequence for deleting an UNREACHABLE duplicate (#978) — a company or
 * standard record behind the one its tier resolves to. No job inherits it, so
 * no job loses anything. One sentence shared by both doors onto such a record
 * (a job row's reveal, `StandardLetterButton`'s older-letters view), so the same
 * record is never described two ways depending on how the user reached it.
 */
export const UNREACHABLE_CONSEQUENCE =
  "No job is affected — this copy is already unreachable.";

interface LetterDeleteDialogProps {
  open: boolean;
  onClose: () => void;
  /** The record to delete. Absent renders nothing — the caller may mount this
   *  before a selection exists. */
  letter?: LetterRecord;
  /**
   * One sentence naming who else loses this letter, written by the caller.
   *
   * A job draft affects only that job; the standard letter is inherited by
   * every job that has none of its own; a company letter by every job at that
   * employer. Only the calling surface knows which, and the difference is the
   * whole reason a user would hesitate — so it is stated rather than left to a
   * generic "this cannot be undone".
   */
  consequence: string;
  /** Re-read the letter store. Awaited before the dialog closes, so the
   *  surface behind it never repaints still holding the deleted record. */
  onDeleted: () => Promise<void> | void;
}

export function LetterDeleteDialog({
  open,
  onClose,
  letter,
  consequence,
  onDeleted,
}: LetterDeleteDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);

  // Clear a previous failure every time the dialog opens. Without this, a user
  // who hit a blocked-storage error, closed, and came back would be told the
  // delete failed before they had asked for one.
  useEffect(() => {
    if (open) setFailed(false);
  }, [open]);

  if (!letter) return null;

  async function confirm() {
    // `letter` is narrowed above, but `confirm` is a closure the compiler
    // re-widens; the guard is also the double-click lock.
    if (!letter || deleting) return;
    setDeleting(true);
    setFailed(false);
    try {
      // The boolean answer is deliberately not branched on. `deleteLetter`
      // returns false when there was no LIVE record to tombstone — a second
      // click, or a record another surface already deleted — and in both cases
      // the user's intent ("this letter should be gone") is satisfied. Treating
      // false as an error would report a failure for the one outcome that is
      // indistinguishable from success.
      await deleteLetter(letter.id);
    } catch {
      setFailed(true);
      setDeleting(false);
      return;
    }
    // The letter IS gone from here on, so a failed refresh must not print
    // "Nothing was removed" — that would be false about the user's data. The
    // refresh is the caller's re-read; if it fails, the next read catches up.
    try {
      await onDeleted();
    } catch {
      // Deliberately not surfaced — see above.
    }
    setDeleting(false);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Delete this letter?"
      className="max-w-sm"
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-content-primary">
          {letter.label || "This draft"} will be removed. {consequence}
        </p>
        <p className="text-2xs text-content-tertiary">
          There is no undo. A backup exported before now still holds it.
        </p>

        {failed && (
          <span role="status" className="text-2xs text-feedback-warning-text">
            Couldn&rsquo;t delete it — your browser may be blocking storage.
            Nothing was removed.
          </span>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={deleting}
            onClick={() => void confirm()}
          >
            {deleting ? "Deleting…" : "Delete letter"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
