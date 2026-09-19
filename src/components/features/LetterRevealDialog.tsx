// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * LetterRevealDialog — the plain-text reveal for one job's cover letter(s)
 * (#715). Sibling of `JobLetterIndicator`, split out to keep that file's
 * click/acknowledgement wiring separate from this one's draft picker + copy
 * flow — together they would push a single file well past the ~200 LOC
 * feature-component guideline for no reuse benefit.
 *
 * Plain text, deliberately not markdown: `LetterRecord.body` is typed
 * markdown, but every letter this app holds is plain prose meant to be pasted
 * into an application form or email (`docs/cover-letter-contract.md` §1).
 * Rendering it through a
 * markdown renderer would show an employer literal `**bold**` asterisks the
 * moment a producer's prose happens to contain them — the exact failure this
 * issue exists to avoid. `whitespace-pre-wrap` preserves the `\n\n` paragraph
 * breaks the contract's example body uses, with zero markdown interpretation.
 *
 * Copy degrades LOUDLY, not silently. `navigator.clipboard` is undefined on an
 * insecure origin — `npm run dev:http`, a workflow this repo documents for LAN
 * demos — and `writeText` rejects outright when the permission is denied. A
 * caught-and-dropped failure leaves the button reading "Copy to clipboard"
 * with nothing on the clipboard, so the user pastes whatever was there before
 * and never learns why. That branch is no longer this file's to get right — it
 * moved into `useCopyToClipboard` (#609), which every clipboard call site in
 * the tree now shares. What stays here is the shape of the telling: the body is
 * a selectable text region, so the fallback ("select it yourself") is a real
 * instruction rather than a shrug, and it needs its own line beside the button
 * rather than a truncated label inside it.
 *
 * Reuse analysis: `Dialog` + `Button` from `@design-system`, no hand-rolled
 * modal. No `Card` — the dialog is already the surface. The copy-failure line
 * is inline status text (the token pattern `ChipListEditor` and
 * `TermQualityAdvisory` use), deliberately not an `ErrorState` banner: a full
 * banner for a recoverable clipboard miss would outweigh the letter it sits
 * under.
 */

import { useEffect, useState } from "react";
import { Button, Dialog, useCopyToClipboard } from "@design-system";
import type { LetterRecord } from "../../lib/storage/index.ts";
import { isCompanyLetter } from "../../lib/letters/resolve-letter.ts";
import { capitalizePhrase } from "../../lib/letters/scope-phrase.ts";

/** A letter this job INHERITS rather than owns (#767) — its company's, or the
 *  standard one — with the phrase that names where it came from. Also the
 *  shape of an unreachable duplicate at one of those tiers (#978), which is
 *  the same thing with a label saying it is not the one that resolves. */
export interface InheritedLetter {
  letter: LetterRecord;
  /** User-facing scope, e.g. "your standard letter" / "your Northwind letter".
   *  Built by the caller, which is the side that knows the company name. */
  label: string;
}

interface LetterRevealDialogProps {
  open: boolean;
  onClose: () => void;
  /** Every letter for one job, most-recently-updated first — the order
   *  `useJobLetters` already sorts into. Never empty while `open` is true;
   *  the caller (`JobLetterIndicator`) opens the editor instead when there are
   *  none, so this dialog is never opened empty. */
  letters: readonly LetterRecord[];
  /** The letter this job would inherit if it had none of its own (#767).
   *  Offered as one more entry in the picker, always LAST — the job's own
   *  drafts are what the row's glyph promised, and an inherited letter must
   *  never be what opens by default. Omitted when nothing is inherited. */
  inherited?: InheritedLetter;
  /**
   * Letters at the company/standard tiers that NO resolution chain can reach
   * (#978) — every record but the most recent at its own tier.
   *
   * Ordinarily empty, and that is the point: the chain surfaces one record per
   * rung by design (`mostRecent`), so a second record at a tier is invisible to
   * every surface in the app and, before this, had no delete path either. It
   * could arrive from a backup import, from the extension, or from a UI fork.
   * Offering it here is what makes it deletable; it is NOT an invitation to
   * re-pick a rung the chain already decided, which is why only the
   * unreachable records appear and never the resolved ones.
   */
  extras?: readonly InheritedLetter[];
  /** Revise the draft currently on screen. Never called for a scoped entry —
   *  editing one would change a letter this job does not own, which is what
   *  `onCustomize` exists to avoid. Optional: a caller listing letters that
   *  belong to no job (`StandardLetterButton`'s older-letters view) has no
   *  "this job's draft" to revise. */
  onEdit?: (letter: LetterRecord) => void;
  /** Start an additional draft for the same job. Optional for the same reason
   *  as {@link onEdit}. */
  onCompose?: () => void;
  /** Ask to delete whatever is on screen (#978). The caller runs the confirm
   *  and the write — `JobLetterIndicator` and `StandardLetterButton` both keep
   *  one dialog on screen at a time, so the confirm is a sibling stage rather
   *  than a modal nested inside this one. Omitted renders no Delete. */
  onDelete?: (letter: LetterRecord) => void;
  /** Copy the inherited letter into a new draft for THIS job (#767). Required
   *  alongside `inherited` for the offer to render. */
  onCustomize?: (source: LetterRecord) => void;
  /**
   * Copy whatever letter is on screen into a COMPANY-scoped draft (#767) — the
   * only write path to the company tier, so without it that rung of the
   * resolution chain can only ever hold a record an outside producer wrote.
   *
   * Offered for the job's own drafts too, not just the inherited entry, and
   * that is the point: "I wrote this for one posting and want it for every job
   * at this employer" is the way a company letter actually comes to exist.
   * Omitted when the job has no company name to derive a key from — a company
   * letter with no key is one nothing could look up.
   *
   * Takes the KEY rather than a finished label because the offer is two actions
   * wearing one button: a fork when the letter on screen belongs to some other
   * scope, and a plain edit when it already IS this company's letter. Only this
   * component knows which is selected, so only it can name the button — and the
   * handler re-tests the same predicate rather than trusting the label.
   */
  companyOffer?: {
    companyKey: string;
    /**
     * Whether the company tier already HOLDS a letter at `companyKey` (#767
     * review). It changes what the button promises, so it cannot be inferred
     * from the selection: with the tier occupied and some other letter
     * selected, this action REPLACES the company letter rather than creating
     * one, and a button still reading "Customize for this company" would
     * describe an insert while performing an overwrite.
     */
    occupied: boolean;
    onCustomize: (source: LetterRecord) => void;
  };
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The chip row. Its own component so the dialog's body reads as the four
 *  regions it is (picker, scope notice, letter, actions) rather than as one
 *  function holding every branch of all four. Hidden with a single entry —
 *  there is nothing to choose between. */
function DraftPicker({
  offered,
  selectedId,
  chipLabel,
  onPick,
}: {
  offered: readonly LetterRecord[];
  selectedId: string;
  chipLabel: (letter: LetterRecord) => string;
  onPick: (id: string) => void;
}) {
  if (offered.length <= 1) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      role="group"
      aria-label="Choose a draft"
    >
      {offered.map((letter) => (
        <Button
          key={letter.id}
          variant={letter.id === selectedId ? "primary" : "ghost"}
          // Which chip is showing, stated rather than drawn (#767 review).
          // Without it the only signal is the variant's colour and weight, so
          // every chip in this group sounds identical to a screen reader —
          // WCAG 1.4.1. `aria-pressed`, not `aria-current`: these are toggle
          // buttons choosing what the dialog displays, not navigation.
          //
          // Pre-existing from #715, widened materially here: `offered` now
          // appends the inherited letter and any unreachable duplicate, so the
          // picker renders for a job with ONE own draft plus anything
          // inherited — after #767 that is close to everyone, where before it
          // needed two drafts for the same job.
          aria-pressed={letter.id === selectedId}
          size="sm"
          onClick={() => onPick(letter.id)}
        >
          {chipLabel(letter)}
        </Button>
      ))}
    </div>
  );
}

/**
 * What the company offer's single button is about to DO, named.
 *
 * Three actions wear one button, and the label is the only thing telling them
 * apart — so it is derived here rather than inline, where the branch sat
 * inside `RevealActions`' JSX and pushed that function over `fallow`'s
 * complexity threshold (#767 review). A name also makes the middle case
 * reviewable: it is the one that changed.
 *
 *  - the selection IS this company's letter  → editing it in place
 *  - the tier is occupied by something else  → REPLACING that letter
 *  - the tier is empty                       → creating one
 *
 * "This company's letter" means the tier's HEAD, not any record at the key.
 * An unreachable duplicate (`unreachable`) matches `isCompanyLetter` too, but
 * the caller's handler revises the head seeded from it — a replace — so it
 * reads as one. Editing the duplicate in place would bump its `updatedAt` and
 * silently promote it over the letter every job at the company inherits.
 *
 * The middle case is why `occupied` is a prop rather than an inference: with
 * the tier taken and another letter selected, this used to insert a SECOND
 * record at the same key, and a button reading "Customize" described that
 * insert while the action is an overwrite.
 */
function companyOfferLabel(
  selected: LetterRecord,
  offer: NonNullable<LetterRevealDialogProps["companyOffer"]>,
  unreachable: boolean,
): string {
  if (!unreachable && isCompanyLetter(selected, offer.companyKey)) {
    return "Edit this company letter";
  }
  return offer.occupied
    ? "Replace this company letter"
    : "Customize for this company";
}

/** Everything offered for the letter currently on screen. Extracted for the
 *  same reason as {@link DraftPicker}: this row is where every optional
 *  handler branches, and folding it back into the dialog would put five
 *  independent conditionals in the same function as the selection logic. */
function RevealActions({
  selected,
  copyState,
  onCopy,
  isInherited,
  isUnreachable,
  onEdit,
  onCompose,
  onDelete,
  onCustomize,
  companyOffer,
}: {
  selected: LetterRecord;
  copyState: string;
  onCopy: () => void;
  isInherited: boolean;
  isUnreachable: boolean;
  onEdit?: (letter: LetterRecord) => void;
  onCompose?: () => void;
  onDelete?: (letter: LetterRecord) => void;
  onCustomize?: (source: LetterRecord) => void;
  companyOffer?: LetterRevealDialogProps["companyOffer"];
}) {
  return (
    /* `flex-wrap` + `justify-end`, not a fixed row: the copy-failure
       sentence is a full instruction, and on a narrow viewport it must
       take its own line rather than squeeze the buttons. */
    <div className="flex flex-wrap items-center justify-end gap-2">
      {copyState === "failed" && (
        <span role="status" className="text-2xs text-feedback-warning-text">
          Couldn&rsquo;t copy — select the text above and copy it yourself.
        </span>
      )}
      {onCompose && (
        <Button variant="ghost" size="sm" onClick={onCompose}>
          New draft
        </Button>
      )}
      {/* Offered for every entry, scoped ones included — deleting an
          unreachable duplicate is the entire reason it is listed here
          (#978). The confirm, and the sentence naming who else loses the
          letter, belong to the caller: only it knows whether this is the
          job's own draft or a letter the whole library inherits. */}
      {onDelete && (
        <Button variant="ghost" size="sm" onClick={() => onDelete(selected)}>
          Delete
        </Button>
      )}
      {/* Customize REPLACES Edit for an inherited letter rather than
          sitting beside it: editing in place would rewrite a letter this
          job does not own — the standard letter already submitted
          elsewhere — which is precisely the live-link failure #767's
          copy model exists to prevent. */}
      {isInherited ? (
        onCustomize && (
          <Button variant="ghost" size="sm" onClick={() => onCustomize(selected)}>
            Customize for this job
          </Button>
        )
      ) : (
        onEdit && (
          <Button variant="ghost" size="sm" onClick={() => onEdit(selected)}>
            Edit
          </Button>
        )
      )}
      {/* Beside the job/edit action rather than replacing either: lifting a
          letter to company scope is a third thing to do with the text on
          screen, available whether it is this job's own draft or the one it
          inherits. When the selection already IS this company's letter
          there is nothing to lift, so the same button edits it in place —
          the company tier's only edit path, and what stops the offer
          forking the letter from itself (#767 review). */}
      {companyOffer && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => companyOffer.onCustomize(selected)}
        >
          {companyOfferLabel(selected, companyOffer, isUnreachable)}
        </Button>
      )}
      <Button variant="primary" size="sm" onClick={onCopy}>
        {copyState === "copied" ? "Copied" : "Copy to clipboard"}
      </Button>
    </div>
  );
}

export function LetterRevealDialog({
  open,
  onClose,
  letters,
  inherited,
  extras,
  onEdit,
  onCompose,
  onDelete,
  onCustomize,
  companyOffer,
}: LetterRevealDialogProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(
    letters[0]?.id,
  );
  // The clipboard write itself comes from the shared `useCopyToClipboard`
  // (#609) — this file was the precedent for the absent-`navigator.clipboard`
  // branch that hook now enforces for every caller. The MARKUP stays here: the
  // failure is a full instruction sentence sitting beside the button, not a
  // label swap inside it, so `CopyButton` is the wrong half of the pair.
  const { state: copyState, copy, reset: resetCopy } = useCopyToClipboard();

  // Re-pick the most-recent draft and clear any stale copy result every time
  // the dialog opens — without this, reopening after picking an older draft
  // last time would silently show that draft again, and a "Copied" left over
  // from a previous open would claim a copy that never happened this time.
  // `letters` is a dep (not just `open`) because a future refresh could hand
  // the dialog a different array while it happens to be open — unlikely today
  // (nothing in this UI mutates letters), but a stale selection is the cheap
  // failure mode to guard against either way.
  useEffect(() => {
    if (open) {
      setSelectedId(letters[0]?.id);
      resetCopy();
    }
  }, [open, letters, resetCopy]);

  // Entries that are NOT this job's own: the one it inherits, then any
  // unreachable duplicates behind it. One list because they render alike — a
  // scope phrase for a chip, a notice saying the text was not written for this
  // job — and because the difference that matters downstream (can this be
  // edited in place?) is the same answer for both: no.
  const scoped: readonly InheritedLetter[] = [
    ...(inherited && onCustomize ? [inherited] : []),
    ...(extras ?? []),
  ];

  // The job's own drafts first, then the scoped entries. Appended rather than
  // merged-and-sorted: `letters` is already in most-recently-updated order and
  // an inherited letter is often the newest thing in the store, so sorting the
  // combined list would float someone else's letter above this job's own — the
  // opposite of what the row promised.
  const offered: readonly LetterRecord[] = [
    ...letters,
    ...scoped.map((entry) => entry.letter),
  ];

  const selected = offered.find((letter) => letter.id === selectedId) ?? offered[0];

  if (!selected) return null;

  const scopeOf = (id: string): InheritedLetter | undefined =>
    scoped.find((entry) => entry.letter.id === id);
  const selectedScope = scopeOf(selected.id);
  const isInherited = selectedScope !== undefined;
  // One of #978's duplicates rather than the tier's head — the company offer
  // must not call this "Edit this company letter" (see `companyOfferLabel`).
  const isUnreachable = (extras ?? []).some(
    (entry) => entry.letter.id === selected.id,
  );

  /** A picker chip's text. A scope phrase is a lowercase sentence fragment and
   *  a chip stands it alone, so it is capitalized here (`scope-phrase.ts`); a
   *  draft's label is the user's own string and is printed exactly as typed. */
  const chipLabel = (letter: LetterRecord): string => {
    const scope = scopeOf(letter.id);
    return scope
      ? capitalizePhrase(scope.label)
      : letter.label || "Untitled draft";
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={selected.label || "Cover letter"}
      className="max-w-lg"
    >
      <div className="flex flex-col gap-3">
        <DraftPicker
          offered={offered}
          selectedId={selected.id}
          chipLabel={chipLabel}
          onPick={(id) => {
            setSelectedId(id);
            resetCopy();
          }}
        />

        {/* Named whenever the letter is inherited, and nothing extra when it is
            the job's own (#767). An unlabelled inherited letter reads as one
            written for THIS employer — the user would paste it into an
            application believing it was tailored. */}
        {selectedScope && (
          <p className="text-2xs leading-relaxed text-feedback-info-text">
            This is {selectedScope.label}, not a letter for this job. Customize
            it to make a copy you can tailor.
          </p>
        )}

        <p className="text-2xs text-content-tertiary">
          {selected.producer?.producer && <>Generated by {selected.producer.producer} · </>}
          Updated {formatDate(selected.updatedAt)}
        </p>

        {/* `tabIndex={0}` + `role="region"` because this box SCROLLS: a cover
            letter routinely runs past `max-h-96`, and the only other focusable
            things in this modal are the draft chips and Copy — without a
            focusable scroll container a keyboard user can reach the dialog and
            still not read past the first 24rem of it. */}
        <div
          tabIndex={0}
          role="region"
          aria-label="Cover letter text"
          className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-border-light bg-surface-subtle p-3 text-sm text-content-primary"
        >
          {selected.body || (
            <span className="text-content-muted">Empty draft.</span>
          )}
        </div>

        <RevealActions
          selected={selected}
          copyState={copyState}
          onCopy={() => copy(selected.body)}
          isInherited={isInherited}
          isUnreachable={isUnreachable}
          onEdit={onEdit}
          onCompose={onCompose}
          onDelete={onDelete}
          onCustomize={onCustomize}
          companyOffer={companyOffer}
        />
      </div>
    </Dialog>
  );
}
