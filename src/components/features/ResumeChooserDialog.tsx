// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ResumeChooserDialog — "which saved résumé did you mean?", asked at the one
 * moment the answer is needed: a journey-rail stage was clicked with nothing on
 * the page and more than one résumé in the local library (#826).
 *
 * Reuse analysis (CLAUDE.md's Reuse Gate). The gate's default answer is "extend
 * the surface that already owns this", and that surface exists: the
 * Saved-resumes card (`ResumeLibrary.tsx`) lists every entry with Load, rename
 * and delete, and is already on screen in exactly the `idle` state where this
 * fires. Scroll to it and focus its first Load button; no new surface. That was
 * the first design, and it fails on two of the three stages that reach here.
 * **Download** and **Match jobs** both need a résumé IN MEMORY to act on, so
 * scroll-and-pick abandons the click that started it — the user asked to
 * export and got scrolled to a list. Only a modal can load the pick and then
 * resume the original intent, because only a modal knows what the user was
 * trying to do when it opened. That intent resumption is the whole
 * justification for this file existing, and a change that drops it should
 * delete the file rather than keep it.
 *
 * So: a new surface built from existing pieces. The `Dialog` primitive owns the
 * modal chrome, focus trap, Esc and ARIA; `Button` owns every action; the rows
 * carry the fields `ResumeLibraryEntry` already renders.
 *
 * **Read-only, deliberately: no rename, no delete, no import.** Those stay the
 * Saved-resumes card's job. Duplicating them is precisely what would make this
 * a second library surface rather than a picker, and a destructive action
 * inside a "pick one" modal is a mis-click away from data loss.
 *
 * A scrolling list, not a dropdown, at every N ≥ 2. A dropdown is a poor
 * control for options carrying two lines of metadata each, and one list handles
 * 3 entries or 30 with a single code path.
 */

import { Button, Dialog, StatusBadge } from "@design-system";
import { timeAgo } from "../../lib/date-utils.ts";
import type { ResumeLibraryEntry } from "../../lib/resume-library.ts";
import type { JourneyStage } from "../../lib/journey.ts";

/**
 * What picking a résumé is about to do — the second half of the sentence the
 * dialog opens with, so the modal states the intent it is going to resume
 * rather than asking a bare "which one?".
 */
const INTENT: Partial<Record<JourneyStage["id"], string>> = {
  fix: "open it here so you can fix it",
  download: "open the download options for it",
  match: "search jobs against it",
  tailor: "open it here so you can tailor it",
};

interface ResumeChooserDialogProps {
  /** The stage whose click opened this, or null when nothing is pending.
   *  Doubles as the open flag so the two can never disagree. */
  stage: JourneyStage | null;
  entries: readonly ResumeLibraryEntry[];
  /** Picked — the caller loads it and then finishes the original click. */
  onPick: (id: string) => void;
  /** Closed without picking. The caller drops the stashed intent here. */
  onClose: () => void;
}

export function ResumeChooserDialog({
  stage,
  entries,
  onPick,
  onClose,
}: ResumeChooserDialogProps) {
  return (
    <Dialog
      open={stage !== null}
      onClose={onClose}
      title="Which resume?"
      className="max-w-md"
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-content-secondary">
          {stage === null
            ? null
            : `Nothing is open right now. Pick one of your saved resumes and we'll ${
                INTENT[stage.id] ?? "open it here"
              }.`}
        </p>

        {/* Capped height + its own scroller: the library is unbounded, and a
            modal that grows past the viewport puts its own Cancel button off
            screen. `overflow-y-auto` on the list rather than the dialog keeps
            the heading and the footer in place while the options scroll. */}
        <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          {entries.map((entry) => (
            <li key={entry.id}>
              {/* The whole row is the control — a row with a separate "Load"
                  button would make the metadata beside it dead space in a
                  dialog whose only verb IS load. `tab` is the variant that
                  gives a full-width, left-aligned, non-shouting target. */}
              <Button
                variant="tab"
                onClick={() => onPick(entry.id)}
                className="w-full border border-border-light bg-surface-subtle py-2.5 text-left hover:bg-surface-hover"
              >
                {/* One full-width child rather than two, so the button keeps
                    `Button`'s own `items-center justify-center` — those are
                    base classes a caller cannot reliably override from the
                    class attribute, since Tailwind's emitted order decides the
                    winner, not the order they are written in. */}
                <span className="flex w-full min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-content-primary">
                    {entry.filename || "Untitled resume"}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-xs font-normal text-content-muted">
                    <span className="uppercase tracking-wider">
                      {entry.sourceKind}
                    </span>
                    <span aria-hidden>·</span>
                    {entry.hasCachedParse ? (
                      <span>score {entry.scoreOverall}</span>
                    ) : (
                      // Never `score 0` for a record with no cached parse
                      // (#757) — it reads as a genuine zero. Still loadable:
                      // the load path re-parses it from the stored bytes.
                      <StatusBadge tone="info">Not parsed yet</StatusBadge>
                    )}
                    <span aria-hidden>·</span>
                    <span>
                      saved {timeAgo(new Date(entry.savedAt).toISOString())}
                    </span>
                  </span>
                </span>
              </Button>
            </li>
          ))}
        </ul>

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
