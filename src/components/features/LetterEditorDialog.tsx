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
 * ## Three scopes, one editor (#767)
 *
 * Since #766 a letter is scoped to a job, to a company, or to nothing at all,
 * and this dialog authors all three — `jobId` and `companyKey` are both
 * optional, and passing neither composes the standard letter. Extended rather
 * than joined by a sibling editor, per #767's reuse analysis: they are the same
 * act on the same record type, and a second editor would be a parallel surface
 * to keep in step for no gain. Passing BOTH is a caller bug the contract would
 * refuse at the store, so the prop docs say so and `save` sends only what it
 * was given.
 *
 * ## Start-from is a COPY, and says so
 *
 * The picker seeds `body` from an existing letter and carries **no `id`**, so
 * saving writes a NEW record. That is the whole model: a live link would mean
 * editing job B's letter rewrote the standard letter already submitted for job
 * A, and for prose there is no merge that makes that safe (#765 — it is why
 * letters ship before résumés). A seeded editor therefore states the copy
 * plainly at the moment of copying; "Starting from your Northwind letter" on
 * its own reads as a link.
 *
 * It never seeds automatically. An unpicked editor opens empty even when there
 * is something to start from, because pre-filling would put words the user did
 * not choose into a letter addressed to an employer.
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

/** One offer in the "Start from…" picker (#767) — a letter to copy the body
 *  from, and what to call it on screen. The caller builds the label because it
 *  is the side that knows the company's display name; this dialog only needs
 *  something to print. */
export interface LetterStartingPoint {
  letter: LetterRecord;
  /** User-facing, e.g. "Your standard letter" / "Your Northwind letter". */
  label: string;
}

interface LetterEditorDialogProps {
  open: boolean;
  onClose: () => void;
  /** The job this letter is for. Absent composes a company or standard letter
   *  instead — see `companyKey`. Exactly one of the two, or neither: a record
   *  carrying both is refused by `validateLetterRecord`, so passing both here
   *  is a caller bug that surfaces as a failed save. */
  jobId?: string;
  /** The company this letter is for, ALREADY normalised through
   *  `deriveCompanyKey` (#766). Absent alongside an absent `jobId` composes the
   *  standard letter, which is the scope with no key at all. Raw free text
   *  here would store a key nothing can look up. */
  companyKey?: string;
  /** The letter being revised. Omitted = compose a new draft. */
  letter?: LetterRecord;
  /** Letters this draft may be started FROM (#767). Rendered as a picker only
   *  while composing, and only when non-empty; picking copies the body into
   *  the editor and nothing else. Never seeds on its own — see the docblock. */
  startFrom?: readonly LetterStartingPoint[];
  /** A starting point the CALLER already chose, seeded on open. This is not a
   *  loophole in "never seeds automatically": the pick happened, it just
   *  happened one dialog earlier — "Customize for this job" in the reveal is
   *  the user selecting this letter. Absent for an editor opened to compose
   *  from scratch, which still opens empty however many offers `startFrom`
   *  carries. */
  seed?: LetterStartingPoint;
  /** Called after a successful write, so the caller can re-read the store.
   *  Awaited before the dialog closes — closing first would race the refresh
   *  and flash the pre-save state. */
  onSaved: () => Promise<void> | void;
}

/** Dialog title per scope. A table rather than a nested ternary in the JSX
 *  because there are six cases and the standard/company wording is the only
 *  thing that tells the user which letter they are about to write — a wrong
 *  title here means editing the standard letter thinking it is this job's. */
const TITLES = {
  job: { compose: "Write a cover letter", edit: "Edit cover letter" },
  company: { compose: "Write a company letter", edit: "Edit company letter" },
  standard: { compose: "Write your standard letter", edit: "Edit your standard letter" },
} as const;

/** Where the letter lands, per scope — the first half of the storage line.
 *  "with your other letters for this job" is false for the other two scopes,
 *  and a letter the user thinks is job-specific is the one failure this whole
 *  surface is arranged to prevent. */
const STORAGE_LINE = {
  job: "Saved on this device, with your other letters for this job.",
  company: "Saved on this device as your letter for this company — offered as a starting point for any job there.",
  standard: "Saved on this device as your standard letter — offered as a starting point for any job.",
} as const;

/** What this dialog is composing, for the title and the storage line. Derived
 *  from which scope key it was handed, so the copy can never disagree with the
 *  record that gets written. */
function scopeOf(
  jobId: string | undefined,
  companyKey: string | undefined,
): "job" | "company" | "standard" {
  if (jobId !== undefined) return "job";
  return companyKey !== undefined ? "company" : "standard";
}

export function LetterEditorDialog({
  open,
  onClose,
  jobId,
  companyKey,
  letter,
  startFrom = [],
  seed,
  onSaved,
}: LetterEditorDialogProps) {
  const [body, setBody] = useState(letter?.body ?? "");
  const [label, setLabel] = useState(letter?.label ?? "");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // The label of the letter this draft was seeded from, or undefined for one
  // typed from scratch. Display only — it names the source in the copy notice
  // and is deliberately NOT stored, because the record has no link to it.
  const [seededFrom, setSeededFrom] = useState<string | undefined>(undefined);

  // Reseed from the record every time the dialog opens. Without this, closing
  // a half-typed draft and reopening it — or opening a DIFFERENT letter from
  // the same mounted indicator — would show the previous edit, which reads as
  // the store having kept something it did not. `letter` is a dep, not just
  // `open`, for that second case.
  useEffect(() => {
    if (open) {
      // Revising wins over seeding: an existing letter's own body is never
      // replaced by a starting point, whatever the caller passed.
      setBody(letter?.body ?? seed?.letter.body ?? "");
      setLabel(letter?.label ?? "");
      setFailed(false);
      // Re-derived on every open rather than merely cleared, so a pick made in
      // a previous session of this dialog cannot leave the copy notice claiming
      // a source this draft wasn't started from.
      setSeededFrom(letter === undefined ? seed?.label : undefined);
    }
    // Deps hand-audited (`exhaustive-deps` is NOT enforced here — CLAUDE.md):
    // `seed` joins `open` and `letter` because reopening the same dialog with a
    // DIFFERENT starting point must reseed — the reveal can hand this a company
    // letter on one row and the standard letter on the next without unmounting.
  }, [open, letter, seed]);

  const scope = scopeOf(jobId, companyKey);
  const isBlank = body.trim().length === 0;
  // Composing only, and only until a starting point has been taken.
  //
  // Revising an existing letter has nothing to start FROM — it already has a
  // body. And once a seed IS in place, the picker retires rather than staying
  // available: `startFromLetter` replaces the whole body unconditionally, a
  // controlled `<textarea>` has no undo across a re-render, so a mis-click on a
  // still-present chip after writing five hundred words would discard them with
  // no recovery. Retiring it costs the ability to swap starting points — there
  // is only ever one offer today — and buys back the typed draft.
  const offers = letter === undefined && seededFrom === undefined ? startFrom : [];

  function startFromLetter(option: LetterStartingPoint) {
    setBody(option.letter.body);
    setSeededFrom(option.label);
  }

  async function save() {
    if (isBlank || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await saveLetter({
        // No `id` when composing — including on a draft seeded from another
        // letter. That absence is what makes start-from a copy: `saveLetter`
        // upserts, so carrying the source's id would OVERWRITE the source.
        ...(letter?.id ? { id: letter.id } : {}),
        // Only the key this scope owns. Sending `jobId: undefined` explicitly
        // would be harmless today (`checkDeclaredFields` reads an explicit
        // `undefined` as absent), but spreading only what exists keeps the
        // written record the exact shape the scope claims.
        ...(jobId !== undefined ? { jobId } : {}),
        ...(companyKey !== undefined ? { companyKey } : {}),
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
      title={TITLES[scope][letter ? "edit" : "compose"]}
      className="w-[min(36rem,90vw)]"
    >
      <div className="flex flex-col gap-3">
        {offers.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-2xs text-content-tertiary">
              Start from… (optional)
            </span>
            <div
              className="flex flex-wrap items-center gap-1"
              role="group"
              aria-label="Start from an existing letter"
            >
              {offers.map((option) => (
                <Button
                  key={option.letter.id}
                  variant="ghost"
                  size="sm"
                  onClick={() => startFromLetter(option)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        )}

        {seededFrom !== undefined && (
          // The copy said plainly, once, at the moment of copying (#767). The
          // second sentence is the load-bearing half: without it "Started from
          // your standard letter" reads as a live link, and the user would
          // expect an edit here to follow the source — or worse, expect the
          // source to be safe from an edit here.
          <p role="status" className="text-2xs leading-relaxed text-content-secondary">
            Started from {seededFrom}. This is a <strong>copy</strong> — saving
            writes a new letter, and editing it later leaves {seededFrom} exactly
            as it is.
          </p>
        )}

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
          {STORAGE_LINE[scope]} offlinecv does not write it for you and sends
          nothing anywhere.
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
