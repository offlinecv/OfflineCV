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
 * something untrue about their own typing. {@link letterEgressNeedsAck} is the
 * test — shared with `StandardLetterButton` since #767 gave that surface its own
 * door onto the same class of text, so one wording and one flag serve both:
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
import { Button } from "@design-system";
import {
  LetterEgressAckDialog,
  letterEgressNeedsAck,
} from "./LetterEgressAckDialog.tsx";
import { isCompanyLetter } from "../../lib/letters/resolve-letter.ts";
import { ownDraftPhrase } from "../../lib/letters/scope-phrase.ts";
import { LetterRevealDialog, type InheritedLetter } from "./LetterRevealDialog.tsx";
import {
  LetterDeleteDialog,
  UNREACHABLE_CONSEQUENCE,
} from "./LetterDeleteDialog.tsx";
import {
  LetterEditorDialog,
  type LetterStartingPoint,
} from "./LetterEditorDialog.tsx";
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
   *  omitted) renders the "write one" state, not nothing.
   *
   *  THIS JOB'S OWN letters only, and that is what the glyph reports (#767). A
   *  company or standard letter existing must never flip a row to "has letter":
   *  the row would claim a letter the user never wrote for that employer, and
   *  the reveal would then show text they did not intend for it. Inheritance
   *  surfaces inside the dialogs, where there is room to say what it is. */
  letters?: readonly LetterRecord[];
  /** The letter this job would inherit — its company's, or the standard one
   *  (#767). Drives the reveal's extra entry and the editor's "Start from…"
   *  picker. Omitted when the user has written nothing this job can reach. */
  inherited?: InheritedLetter;
  /** Company/standard letters that no resolution chain can reach (#978) —
   *  every record but the most recent at its own tier. Ordinarily empty.
   *  Offered inside the reveal so an unreachable duplicate is at least
   *  visible, and therefore deletable. */
  extras?: readonly InheritedLetter[];
  /** This job's company as a DERIVED key (`deriveCompanyKey`), when it has one
   *  (#767). Present enables "Customize for this company", which is the only
   *  write path to the company tier — absent when the job's `company` is blank
   *  or all punctuation, which is exactly when a company letter would have no
   *  key to be found by. */
  companyKey?: string;
  /** Re-read the letter store after a write. Optional so a caller that only
   *  displays letters (a test, a future read-only view) need not supply one;
   *  without it a saved letter will not appear until the view remounts. */
  onSaved?: () => Promise<void> | void;
}

type Stage = "closed" | "ack" | "reveal" | "edit" | "delete";

/**
 * Who else loses `letter` when it is deleted — the sentence
 * `LetterDeleteDialog` prints under the title.
 *
 * An unreachable duplicate (`unreachable`, #978's `extras`) is checked first:
 * no job inherits it, so its scope keys would overstate the loss — "every job
 * at this company stops inheriting it" is false for a record the chain never
 * answers with. Otherwise the answer is read off the record's own scope keys,
 * which are what the store and the resolution chain actually read.
 */
function consequenceFor(letter: LetterRecord, unreachable: boolean): string {
  if (unreachable) return UNREACHABLE_CONSEQUENCE;
  if (letter.jobId !== undefined) return "No other job is affected.";
  if (letter.companyKey !== undefined)
    return "Every job at this company stops inheriting it.";
  return "Every job without a letter of its own stops inheriting it.";
}

export function JobLetterIndicator({
  jobId,
  letters = [],
  inherited,
  extras = [],
  companyKey,
  onSaved = () => {},
}: JobLetterIndicatorProps) {
  const [stage, setStage] = useState<Stage>("closed");
  // Which letter the delete confirm is about. A sibling stage rather than a
  // dialog nested inside the reveal: this component has kept one dialog on
  // screen at a time since #715, and `Dialog` drives `showModal()`.
  const [deleting, setDeleting] = useState<LetterRecord | undefined>(undefined);
  // Which letter the editor is revising. `undefined` composes a new draft,
  // which is also the empty-state path — one editor, both jobs.
  const [editing, setEditing] = useState<LetterRecord | undefined>(undefined);
  // Set only by a Customize click — the user picking a letter to copy. Every
  // other route into the editor clears it, which is what keeps a plain "Write a
  // cover letter" click opening an empty draft.
  const [seed, setSeed] = useState<LetterStartingPoint | undefined>(undefined);
  // Which scope the editor is composing FOR. "job" everywhere except
  // "Customize for this company", which is the only write path to the company
  // tier — see `openEditor`.
  const [composeScope, setComposeScope] = useState<"job" | "company">("job");
  // Whether the seed should land in the record being revised, rather than the
  // record winning. Set only by the occupied-company-tier route — see
  // `reviseFromSource`.
  const [seedReplaces, setSeedReplaces] = useState(false);

  const hasLetters = letters.length > 0;

  // What the editor may be started from. One entry, because `resolveLetterForJob`
  // already picked the single most specific inherited letter — offering both a
  // company and a standard letter here would ask the user to redo a decision the
  // chain exists to make. Empty while revising is enforced by the editor itself.
  // The label stays the lowercase FRAGMENT it arrives as; the editor's picker
  // capitalizes it for the chip and its copy notice embeds it mid-sentence.
  // See `scope-phrase.ts` for why the casing cannot be decided here.
  const startFrom: readonly LetterStartingPoint[] = inherited
    ? [{ letter: inherited.letter, label: inherited.label }]
    : [];
  const label = !hasLetters
    ? "Write a cover letter"
    : letters.length === 1
      ? "View cover letter"
      : `View cover letters (${letters.length})`;

  /** What to call a letter being copied FROM, in the editor's copy notice. The
   *  inherited letter has a scope phrase; one of this job's own drafts has only
   *  its user-set label, and falls back to the same wording the reveal titles
   *  an unlabelled draft with. */
  function labelFor(source: LetterRecord): string {
    if (inherited && source.id === inherited.letter.id) return inherited.label;
    const extra = extras.find((entry) => entry.letter.id === source.id);
    if (extra) return extra.label;
    return ownDraftPhrase(source.label);
  }

  /**
   * Open into an editor composing a fresh draft for `scope`, optionally seeded
   * from `from`. The ONE route into compose mode, so the three pieces of state
   * that define it can never drift apart: no `editing` record (which is what
   * makes a save an insert rather than an upsert over the source), the seed,
   * and the scope key the save will carry.
   */
  function openEditor(
    scope: "job" | "company",
    from?: LetterStartingPoint,
  ): void {
    setEditing(undefined);
    setSeed(from);
    setSeedReplaces(false);
    setComposeScope(scope);
    setStage("edit");
  }

  /**
   * The letter already occupying this job's company tier, or `undefined` when
   * the tier is empty (#767 review).
   *
   * Read off the records this component was handed rather than the selection:
   * the chain surfaces the tier's head as `inherited` when it resolves there,
   * and #978 hands the rest over as `extras`, so between them the answer is
   * here without asking the store. Keying the decision off what happens to be
   * SELECTED is what forked a second record — the guard only covered the case
   * where the company letter was the thing on screen.
   */
  function companyOccupant(): LetterRecord | undefined {
    if (companyKey === undefined) return undefined;
    if (inherited && isCompanyLetter(inherited.letter, companyKey)) {
      return inherited.letter;
    }
    return extras.find((entry) => isCompanyLetter(entry.letter, companyKey))
      ?.letter;
  }

  /**
   * Open into an editor REVISING `target` with `source`'s text already in the
   * box — "put this letter's words into that record".
   *
   * The company tier's occupied case. An insert here would mint a second
   * record at the same `companyKey`: the chain answers with only the most
   * recent (`mostRecent`), so the older one stops resolving anywhere. #978
   * made such a record visible and deletable through the reveal, so it is no
   * longer lost forever — but silently creating one and calling it "Customize"
   * is still the wrong action for the button.
   */
  function reviseFromSource(
    target: LetterRecord,
    source: LetterStartingPoint,
  ): void {
    setEditing(target);
    setSeed(source);
    setSeedReplaces(true);
    setComposeScope("company");
    setStage("edit");
  }

  /**
   * Open into an editor REVISING `letter` under `scope` — the counterpart of
   * {@link openEditor}, and the one route in, so the seed can never survive
   * from a previous Customize click into a revise that must not be a copy.
   */
  function editLetter(letter: LetterRecord, scope: "job" | "company"): void {
    setEditing(letter);
    setSeed(undefined);
    setSeedReplaces(false);
    setComposeScope(scope);
    setStage("edit");
  }

  function open() {
    // Gate on everything a click from here can put on screen, not just this
    // job's own letters. Since #767 the reveal offers the inherited letter as
    // an entry and the editor offers it as a starting point, so an
    // outside-produced STANDARD letter reaches the screen through a job whose
    // own letters are all hand-typed — and the warning is about egress that
    // already happened to the text being shown, whichever scope holds it.
    //
    // Read the acknowledgement fresh, not from a cached hook value: several
    // rows' indicators are mounted at once on this page, and it is meant to be
    // "once, ever" — not "once per row." See `letter-egress-ack.ts`.
    if (
      letterEgressNeedsAck([
        ...letters,
        inherited?.letter,
        ...extras.map((entry) => entry.letter),
      ])
    ) {
      setStage("ack");
      return;
    }
    reveal();
  }

  /** Where `open` lands once the warning (if any) is out of the way — the
   *  reveal for a job with its own drafts, the editor for one without. Shared
   *  with `acknowledge` so the post-warning destination cannot diverge from the
   *  no-warning one; before #767 the ack path hard-coded `"reveal"`, which was
   *  right only while the empty case could never warn. */
  function reveal() {
    // Unreachable duplicates open the reveal even on a job with no drafts of
    // its own (#978). The glyph still reports this job's own letters — that is
    // what the row promised — but a click has to be able to reach a record
    // nothing else in the app can see, and the reveal's "New draft" button is
    // the same editor this branch would otherwise have opened directly.
    if (!hasLetters && extras.length === 0) {
      openEditor("job");
      return;
    }
    setStage("reveal");
  }

  /** Open the confirm for `letter`, closing the reveal behind it. */
  function askDelete(letter: LetterRecord): void {
    setDeleting(letter);
    setStage("delete");
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

      <LetterEgressAckDialog
        open={stage === "ack"}
        onClose={() => setStage("closed")}
        onAcknowledged={reveal}
      />

      <LetterRevealDialog
        open={stage === "reveal"}
        onClose={() => setStage("closed")}
        letters={letters}
        inherited={inherited}
        extras={extras}
        onEdit={(letter) => editLetter(letter, "job")}
        onCompose={() => openEditor("job")}
        onDelete={askDelete}
        // Compose, NOT revise — `openEditor` leaves `editing` undefined so the
        // editor writes a new record with no id. Handing the source record to
        // `editing` would make Save OVERWRITE the letter being copied, which is
        // the one failure this whole flow is arranged to prevent.
        //
        // `source` is the letter the reveal actually has on screen, taken from
        // the argument rather than reached for in `startFrom` — the two are the
        // same record while there is one inherited entry, and taking the
        // argument keeps this correct if a second is ever offered.
        onCustomize={(source) =>
          openEditor("job", { letter: source, label: labelFor(source) })
        }
        // Insert, edit, or replace, decided by whether the company tier is
        // OCCUPIED — not by what happens to be on screen (#767 review). Keying
        // off the selection forked a second record at one key whenever the
        // company letter existed but something else was selected; the chain
        // surfaces only the newest, so the older one dropped out of every rung
        // and was reachable only as a #978 duplicate. `companyOccupant` uses
        // the predicate the chain reads the rung with, so the two cannot
        // disagree about what "the company's letter" is.
        companyOffer={
          companyKey !== undefined
            ? {
                companyKey,
                occupied: companyOccupant() !== undefined,
                onCustomize: (source) => {
                  const occupant = companyOccupant();
                  // Empty tier: lifting a letter to company scope is a genuine
                  // insert, which is the offer's original job.
                  if (!occupant) {
                    return openEditor("company", {
                      letter: source,
                      label: labelFor(source),
                    });
                  }
                  // The occupant IS what's on screen: a plain edit in place,
                  // with nothing to seed from.
                  if (occupant.id === source.id) {
                    return editLetter(occupant, "company");
                  }
                  // Occupied, and the user picked different text for it. Revise
                  // the occupant seeded from that text — the one move that
                  // neither loses their selection nor forks the tier.
                  return reviseFromSource(occupant, {
                    letter: source,
                    label: labelFor(source),
                  });
                },
              }
            : undefined
        }
      />

      {/* Re-reads through `onSaved` — the same refresh a write uses, because a
          delete changes the same thing a save does: which letters the library
          holds. Naming it `onSaved` at the prop boundary would be the only
          alternative to a second identical callback. */}
      <LetterDeleteDialog
        open={stage === "delete"}
        onClose={() => setStage("closed")}
        letter={deleting}
        consequence={
          deleting
            ? consequenceFor(
                deleting,
                extras.some((entry) => entry.letter.id === deleting.id),
              )
            : ""
        }
        onDeleted={onSaved}
      />

      <LetterEditorDialog
        open={stage === "edit"}
        onClose={() => setStage("closed")}
        // Exactly one scope key, never both — the contract refuses a record
        // carrying two. Composing for the company tier drops `jobId` entirely,
        // which is what makes the saved letter reachable from every job at that
        // employer rather than just this one.
        jobId={composeScope === "company" ? undefined : jobId}
        companyKey={composeScope === "company" ? companyKey : undefined}
        letter={editing}
        startFrom={startFrom}
        seed={seed}
        seedReplacesBody={seedReplaces}
        onSaved={onSaved}
      />
    </>
  );
}
