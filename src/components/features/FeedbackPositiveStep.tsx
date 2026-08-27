// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FeedbackPositiveStep — Step 2A of `FeedbackDialog` (#900), reached after a
 * 4-5★ rating. Delight, plus a chance to support the project: the OSS
 * mission in one line, the `GitHubStarCta` (never gated behind the star
 * itself — see its own docblock for the GitHub policy this observes), and an
 * optional written note with an opt-in "keep me posted" contact.
 *
 * Owns the `useGitHubStars` fetch itself rather than taking a `starCount`
 * prop from `FeedbackDialog` — that hook fires from a `[]`-dep effect, and
 * `FeedbackDialog` mounts unconditionally (`Dialog` renders children even
 * while closed), so hoisting the fetch there spent a GitHub API request on
 * every page load whether or not this step is ever reached. Mounting it here
 * means it only fires on the one branch that actually shows the CTA.
 *
 * Split out of `FeedbackDialog` so that file stays a thin step router — this
 * one owns its own form state, and `FeedbackConstructiveStep` (Step 2B)
 * mirrors the same split for the opposite sentiment.
 */

import { useState } from "react";
import { Button, EmailOptIn, GitHubStarCta, TextAreaField } from "@design-system";
import { useGitHubStars } from "../../hooks/useGitHubStars.ts";
import type { FeedbackArgs } from "../../lib/analytics.ts";

interface FeedbackPositiveStepProps {
  onSubmit: (fields: Omit<FeedbackArgs, "rating">) => void;
  /** Returns to Step 1 without losing the star rating — the only way a
   *  keyboard user who overshot 4-5★ (native radio: arrow keys select on
   *  the same keystroke that moves focus) can reach 1-3★ instead. */
  onBack: () => void;
  onClose: () => void;
}

export function FeedbackPositiveStep({
  onSubmit,
  onBack,
  onClose,
}: FeedbackPositiveStepProps) {
  const { count: starCount } = useGitHubStars();
  const [feedbackText, setFeedbackText] = useState("");
  const [wantsContact, setWantsContact] = useState(false);
  const [email, setEmail] = useState("");

  function handleSubmit() {
    onSubmit({
      feedbackText: feedbackText || undefined,
      wantsContact,
      // Email is PII — only forwarded when the user opted into updates.
      email: wantsContact ? email : undefined,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-content-secondary">
        OfflineCV is free, private, and runs in your browser. Starring our
        repo helps other job seekers discover it.
      </p>

      <TextAreaField
        value={feedbackText}
        onChange={setFeedbackText}
        label="Any thoughts on what worked well or what to add next? (optional)"
        placeholder="Any thoughts on what worked well or what to add next?"
        rows={3}
      />

      <EmailOptIn
        checkboxLabel="Keep me posted on major updates & new features"
        onChange={(next, nextEmail) => {
          setWantsContact(next);
          setEmail(nextEmail);
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <GitHubStarCta variant="inline" count={starCount} />
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          {/* Not "Submit & Close": submitting lands on the dialog's
              confirmation step, and the user closes from there. */}
          <Button variant="primary" size="sm" onClick={handleSubmit}>
            Submit
          </Button>
        </div>
      </div>
    </div>
  );
}
