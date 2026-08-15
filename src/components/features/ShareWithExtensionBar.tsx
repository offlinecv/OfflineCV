// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ShareWithExtensionBar — hand this résumé to the browser extension, so the
 * postings it captures on job boards can be rated against it.
 *
 * Sits under the parsed result as a quiet secondary bar for a follow-on action,
 * never a banner competing with the user's own score. It is the last of that
 * shape on this surface: `SaveResumeBar`, which used to sit beside it, moved
 * into `ParsedHeader` in #824 — persistence state belongs above the fold, and
 * this does not (nothing is lost by a user who never scrolls to it).
 * It lives on `/` rather than on `/jobs/`
 * for two reasons that both point the same way — this is the only surface that
 * knows the résumé's **file name**, which is the label the extension's panel
 * shows when it names what it rated against, and it is where a user sent here
 * by the extension ("no résumé shared yet") actually lands. `/jobs/` needs a
 * handoff before it holds a résumé at all, so the control would be missing on
 * exactly the visit that came looking for it.
 *
 * **Renders nothing unless an extension answers a probe** (see
 * `useExtensionPresence`). The large majority of visitors run no extension, and
 * a permanent bar offering them an integration they do not have is an
 * advertisement, not an affordance.
 *
 * Every outcome is surfaced, including the two that are not success:
 *
 *  - a **refusal** carries the extension's own reason verbatim, because the one
 *    that can actually happen ("`corpus` is empty; there is nothing to rate
 *    against") names a fixable state of the résumé, and paraphrasing it here
 *    would put a second wording of the extension's rule in this repo;
 *  - **no reply** is reported as no reply. Nothing sends a negative
 *    acknowledgement, so this surface cannot tell "not installed" from
 *    "installed after this tab opened" — and the second is the likelier one
 *    here, since the probe already answered, which is why the copy offers a
 *    reload rather than an install.
 *
 * Stop sharing is offered unconditionally rather than only after a share. This
 * page cannot know whether the extension holds a profile — there is no message
 * that asks — and a control hidden on a guess is a control missing exactly when
 * a user who shared in an earlier session comes back to undo it. `cleared:
 * false` is a real answer and says so.
 */

import { useState } from "react";
import { Button, ErrorState, InlineResult } from "@design-system";
import { useExtensionPresence } from "../../hooks/useExtensionPresence.ts";
import {
  buildSharedResumeProfile,
  clearSharedResumeProfile,
  shareResumeProfile,
  type ClearOutcome,
  type ShareOutcome,
} from "../../lib/extension-profile.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";

interface ShareWithExtensionBarProps {
  /**
   * The parse the page is showing: edited AND recovered. The user's corrections
   * are what they want rated, and so is a degenerate parse repaired by the
   * on-device pass — `App` passes `recovery.activeResult.canonical.fields`, the
   * same value the score card, the export dialog, the autosave and both
   * `/jobs/` routes read (see `useLlmRecovery`). This surface hands the résumé
   * to something OUTSIDE the page, where a divergence has nothing on screen to
   * reveal it, so it must not be the one consumer left on the pre-recovery
   * fields.
   */
  parsed: HeuristicParsedResume;
  /** Becomes the profile's label, so the extension's panel can name the résumé
   *  it is rating against instead of implying it knows which one this is. */
  fileName: string;
}

type BarOutcome = ShareOutcome | ClearOutcome;

interface Feedback {
  tone: "success" | "warning" | "error";
  message: string;
}

function feedbackFor(outcome: BarOutcome, fileName: string): Feedback {
  switch (outcome.kind) {
    case "stored":
      return {
        tone: "success",
        message: `Shared. The extension will rate the jobs you capture against ${fileName}.`,
      };
    case "refused":
      return { tone: "error", message: `The extension refused this resume: ${outcome.reason}` };
    case "cleared":
      return outcome.cleared
        ? { tone: "success", message: "Stopped sharing — the extension has dropped this resume." }
        : { tone: "warning", message: "Nothing to stop: the extension held no resume from this app." };
    case "no-reply":
      return {
        tone: "warning",
        message:
          "No extension answered. If you installed or updated it while this tab was open, reload the page and try again.",
      };
  }
}

/** The outcome strip. Its own component so the bar's render stays readable and
 *  the success/failure split lives in one place: `InlineResult` is this repo's
 *  success chrome and `ErrorState` its warning/error chrome, the same pairing
 *  `ResumeLibrary` uses for its import result. */
function ShareFeedback({ feedback }: { feedback: Feedback }) {
  return (
    <div aria-live="polite">
      {feedback.tone === "success" ? (
        <InlineResult tone="success">
          <span className="text-sm text-content-secondary">{feedback.message}</span>
        </InlineResult>
      ) : (
        <ErrorState tone={feedback.tone === "warning" ? "warning" : "error"}>
          {feedback.message}
        </ErrorState>
      )}
    </div>
  );
}

export function ShareWithExtensionBar({ parsed, fileName }: ShareWithExtensionBarProps) {
  const present = useExtensionPresence();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<BarOutcome | null>(null);

  // After the hooks, never before: an early return above them would change the
  // hook order between renders the moment the probe answers.
  if (!present) return null;

  // One flag for both buttons: the reply vocabularies are disjoint, but a share
  // and a clear in flight together would still race each other's write.
  const run = async (action: () => Promise<BarOutcome>) => {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await action());
    } finally {
      setBusy(false);
    }
  };

  const feedback = outcome === null ? null : feedbackFor(outcome, fileName);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border-light bg-surface-subtle px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-content-secondary">
          Share this resume with the browser extension so it can rate the jobs
          you capture. Nothing is uploaded from this page — the extension keeps
          its own copy, on this device.
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() => shareResumeProfile(buildSharedResumeProfile(parsed, fileName)))
            }
          >
            {busy ? "Working…" : "Share with extension"}
          </Button>
          <Button
            variant="link"
            size="sm"
            disabled={busy}
            onClick={() => void run(clearSharedResumeProfile)}
          >
            Stop sharing
          </Button>
        </div>
      </div>
      {feedback !== null && <ShareFeedback feedback={feedback} />}
    </div>
  );
}
