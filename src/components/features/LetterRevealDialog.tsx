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

/** A letter this job INHERITS rather than owns (#767) — its company's, or the
 *  standard one — with the phrase that names where it came from. */
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
  /** Revise the draft currently on screen. Never called for the inherited
   *  entry — editing that would change a letter this job does not own, which
   *  is what `onCustomize` exists to avoid. */
  onEdit: (letter: LetterRecord) => void;
  /** Start an additional draft for the same job. */
  onCompose: () => void;
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
   */
  companyOffer?: {
    label: string;
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

export function LetterRevealDialog({
  open,
  onClose,
  letters,
  inherited,
  onEdit,
  onCompose,
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

  // The job's own drafts first, then the inherited one if there is a handler
  // to act on it. Appended rather than merged-and-sorted: `letters` is already
  // in most-recently-updated order and an inherited letter is often the newest
  // thing in the store, so sorting the combined list would float someone
  // else's letter above this job's own — the opposite of what the row promised.
  const offered: readonly LetterRecord[] =
    inherited && onCustomize ? [...letters, inherited.letter] : letters;

  const selected = offered.find((letter) => letter.id === selectedId) ?? offered[0];

  if (!selected) return null;

  const isInherited = inherited !== undefined && selected.id === inherited.letter.id;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={selected.label || "Cover letter"}
      className="max-w-lg"
    >
      <div className="flex flex-col gap-3">
        {offered.length > 1 && (
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Choose a draft"
          >
            {offered.map((letter) => (
              <Button
                key={letter.id}
                variant={letter.id === selected.id ? "primary" : "ghost"}
                size="sm"
                onClick={() => {
                  setSelectedId(letter.id);
                  resetCopy();
                }}
              >
                {inherited && letter.id === inherited.letter.id
                  ? inherited.label
                  : letter.label || "Untitled draft"}
              </Button>
            ))}
          </div>
        )}

        {/* Named whenever the letter is inherited, and nothing extra when it is
            the job's own (#767). An unlabelled inherited letter reads as one
            written for THIS employer — the user would paste it into an
            application believing it was tailored. */}
        {isInherited && (
          <p className="text-2xs leading-relaxed text-feedback-info-text">
            This is {inherited.label}, not a letter for this job. Customize it
            to make a copy you can tailor.
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

        {/* `flex-wrap` + `justify-end`, not a fixed row: the copy-failure
            sentence is a full instruction, and on a narrow viewport it must
            take its own line rather than squeeze the three buttons. */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {copyState === "failed" && (
            <span role="status" className="text-2xs text-feedback-warning-text">
              Couldn&rsquo;t copy — select the text above and copy it yourself.
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={onCompose}>
            New draft
          </Button>
          {/* Customize REPLACES Edit for an inherited letter rather than
              sitting beside it: editing in place would rewrite a letter this
              job does not own — the standard letter already submitted
              elsewhere — which is precisely the live-link failure #767's
              copy model exists to prevent. */}
          {isInherited ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onCustomize?.(selected)}
            >
              Customize for this job
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => onEdit(selected)}>
              Edit
            </Button>
          )}
          {/* Beside the job/edit action rather than replacing either: lifting a
              letter to company scope is a third thing to do with the text on
              screen, available whether it is this job's own draft or the one it
              inherits. */}
          {companyOffer && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => companyOffer.onCustomize(selected)}
            >
              {companyOffer.label}
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={() => copy(selected.body)}
          >
            {copyState === "copied" ? "Copied" : "Copy to clipboard"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
