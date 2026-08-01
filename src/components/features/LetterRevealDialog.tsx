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
 * into an application form or email (`docs/cover-letter-contract.md` §1,
 * `.claude/skills/cover-letter/SKILL.md` Phase 4). Rendering it through a
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
 * and never learns why. `WebGpuUnavailableNotice`'s `CopyablePath` is this
 * repo's precedent for the same degrade; the difference here is that the body
 * is a selectable text region, so the fallback ("select it yourself") is a real
 * instruction rather than a shrug.
 *
 * Reuse analysis: `Dialog` + `Button` from `@design-system`, no hand-rolled
 * modal. No `Card` — the dialog is already the surface. The copy-failure line
 * is inline status text (the token pattern `ChipListEditor` and
 * `TermQualityAdvisory` use), deliberately not an `ErrorState` banner: a full
 * banner for a recoverable clipboard miss would outweigh the letter it sits
 * under.
 */

import { useEffect, useState } from "react";
import { Button, Dialog } from "@design-system";
import type { LetterRecord } from "../../lib/storage/index.ts";

interface LetterRevealDialogProps {
  open: boolean;
  onClose: () => void;
  /** Every letter for one job, most-recently-updated first — the order
   *  `useJobLetters` already sorts into. Never empty while `open` is true;
   *  the caller (`JobLetterIndicator`) renders nothing when there are none. */
  letters: readonly LetterRecord[];
}

/** Idle, or the outcome of the last copy attempt. A boolean cannot hold
 *  "tried and failed" apart from "not tried", which is what made the failure
 *  invisible — the button simply kept offering to copy. */
type CopyState = "idle" | "copied" | "failed";

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
}: LetterRevealDialogProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(
    letters[0]?.id,
  );
  const [copyState, setCopyState] = useState<CopyState>("idle");

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
      setCopyState("idle");
    }
  }, [open, letters]);

  const selected = letters.find((letter) => letter.id === selectedId) ?? letters[0];

  async function onCopy() {
    if (!selected) return;
    // Read the API off `navigator` explicitly rather than optional-chaining the
    // call: `navigator.clipboard?.writeText(…)` yields `undefined` on an
    // insecure origin, which awaits cleanly and would report a copy that never
    // happened. The absence has to be its own branch.
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setCopyState("failed");
      return;
    }
    try {
      await clipboard.writeText(selected.body);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  if (!selected) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={selected.label || "Cover letter"}
      className="max-w-lg"
    >
      <div className="flex flex-col gap-3">
        {letters.length > 1 && (
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Choose a draft"
          >
            {letters.map((letter) => (
              <Button
                key={letter.id}
                variant={letter.id === selected.id ? "primary" : "ghost"}
                size="sm"
                onClick={() => {
                  setSelectedId(letter.id);
                  setCopyState("idle");
                }}
              >
                {letter.label || "Untitled draft"}
              </Button>
            ))}
          </div>
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

        <div className="flex items-center justify-end gap-2">
          {copyState === "failed" && (
            <span role="status" className="text-2xs text-feedback-warning-text">
              Couldn&rsquo;t copy — select the text above and copy it yourself.
            </span>
          )}
          <Button variant="primary" size="sm" onClick={() => void onCopy()}>
            {copyState === "copied" ? "Copied" : "Copy to clipboard"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
