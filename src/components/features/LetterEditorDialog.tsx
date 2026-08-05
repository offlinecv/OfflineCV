// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * LetterEditorDialog — write or revise one cover letter, in the app.
 *
 * #711 built the letter STORE for a producer it could not see, and #715 gave
 * the library a read-only reveal; neither shipped a way to author or fix a
 * letter here, so a user whose draft had one wrong sentence had no move except
 * to re-run whatever wrote it. This is that missing half: the same dialog
 * serves the empty case (no letter yet — type one) and the revise case (a
 * producer's draft the user wants to finish), because they are the same act on
 * the same record and splitting them would mean two surfaces for one job.
 *
 * A letter written HERE carries no `producer` block, and that absence is
 * meaningful rather than incidental: `docs/cover-letter-contract.md` §6 reads
 * an absent `producer` as "written by offlinecv itself". So this dialog must
 * never synthesize one — `saveLetter` is handed `id`/`jobId`/`label`/`body`
 * and nothing else, and an existing record's own provenance survives the edit
 * untouched (`saveLetter` spreads the input over the stored record, so keys it
 * does not name are preserved). What that buys is the egress rule in
 * `JobLetterIndicator`: a hand-typed letter sent nothing anywhere, so it must
 * not be gated behind a warning that says it did.
 *
 * Save is DISABLED on an empty body rather than silently writing one.
 * `saveLetter` requires `body` at the type level but accepts `""`, and a blank
 * record would render as "Empty draft." in the reveal — a row that claims a
 * letter exists and shows nothing is worse than no row. Whitespace-only counts
 * as empty for the same reason.
 *
 * Reuse analysis: this ADDS a workflow surface (it creates and edits a
 * `LetterRecord`), so the gate applies. Searched the tree for an existing one:
 * `useJobLetters`' own docblock records that "#715 explicitly excludes in-app
 * authoring/editing", `letters.ts` says "nothing in this build writes a letter
 * yet", and the only write path in the tree is the backup importer. So there
 * is no surface to extend — this is the first. Built from `Dialog`, `Button`,
 * `TextAreaField` and `EditableField` off `@design-system`; no hand-rolled
 * modal, textarea, or button.
 */

import { useEffect, useState } from "react";
import { Button, Dialog, TextAreaField } from "@design-system";
import { saveLetter } from "../../lib/storage/index.ts";
import type { LetterRecord } from "../../lib/storage/index.ts";

interface LetterEditorDialogProps {
  open: boolean;
  onClose: () => void;
  /** The job this letter belongs to. Required even when editing, because a
   *  letter with no `jobId` is unreachable from every surface. */
  jobId: string;
  /** The letter being revised. Omitted = compose a new draft. */
  letter?: LetterRecord;
  /** Called after a successful write, so the caller can re-read the store.
   *  Awaited before the dialog closes — closing first would race the refresh
   *  and flash the pre-save state. */
  onSaved: () => Promise<void> | void;
}

export function LetterEditorDialog({
  open,
  onClose,
  jobId,
  letter,
  onSaved,
}: LetterEditorDialogProps) {
  const [body, setBody] = useState(letter?.body ?? "");
  const [label, setLabel] = useState(letter?.label ?? "");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  // Reseed from the record every time the dialog opens. Without this, closing
  // a half-typed draft and reopening it — or opening a DIFFERENT letter from
  // the same mounted indicator — would show the previous edit, which reads as
  // the store having kept something it did not. `letter` is a dep, not just
  // `open`, for that second case.
  useEffect(() => {
    if (open) {
      setBody(letter?.body ?? "");
      setLabel(letter?.label ?? "");
      setFailed(false);
    }
  }, [open, letter]);

  const isBlank = body.trim().length === 0;

  async function save() {
    if (isBlank || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await saveLetter({
        ...(letter?.id ? { id: letter.id } : {}),
        jobId,
        body,
        // A blank label is stored as absent, not as `""`: the reveal falls back
        // to "Cover letter" on a missing label, and an empty string would make
        // the draft picker render a nameless chip instead.
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      await onSaved();
      onClose();
    } catch {
      // The write can fail for reasons the user can act on — a full quota, a
      // browser blocking storage. Say so and KEEP the text on screen; closing
      // the dialog here would discard what they typed along with the error.
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={letter ? "Edit cover letter" : "Write a cover letter"}
      className="w-[min(36rem,90vw)]"
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-2xs text-content-tertiary">
            Draft name (optional)
          </span>
          {/* Raw `<input>` matches the neighbours (`ReconstructedSkillControls`,
              `ReconstructedAdd`) and their token set — there is no single-line
              text primitive in `@design-system`, and adding one for an optional
              draft name would be the parallel-component the reuse rule warns
              about. `EditableField` is the wrong shape here: it is a read→edit
              affordance over a committed value, and this is a blank form. */}
          <input
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="e.g. Short version"
            className="min-w-0 rounded border border-border bg-surface-card px-2 py-1 text-sm text-content-primary outline-hidden focus:ring-1 focus:ring-accent-primary"
          />
        </label>

        <TextAreaField
          value={body}
          onChange={setBody}
          label="Cover letter text"
          placeholder="Dear Hiring Manager,"
          rows={12}
          autoGrow={false}
        />

        <p className="text-2xs leading-relaxed text-content-tertiary">
          Saved on this device, with your other letters for this job. offlinecv
          does not write it for you and sends nothing anywhere.
        </p>

        <div className="flex items-center justify-end gap-2">
          {failed && (
            <span role="status" className="text-2xs text-feedback-warning-text">
              Couldn&rsquo;t save — your text is still here, try again.
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            disabled={isBlank || saving}
          >
            {saving ? "Saving…" : "Save letter"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
