// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FeedbackConstructiveStep — Step 2B of `FeedbackDialog` (#900), reached
 * after a 1-3★ rating. Category pills route the report to a rough area
 * without forcing a taxonomy pick; the rest — description, opt-in follow-up
 * contact — mirrors the retired inline panel's own fields.
 *
 * Split out of `FeedbackDialog` so that file stays a thin step router — this
 * one owns its own form state, and `FeedbackPositiveStep` (Step 2A) mirrors
 * the same split for the opposite sentiment.
 */

import { useState } from "react";
import { Button, EmailOptIn, TextAreaField } from "@design-system";
import type { FeedbackArgs } from "../../lib/analytics.ts";

const CATEGORIES = ["Parsing", "Scoring", "UI / Editor", "Export", "Other"] as const;
type Category = (typeof CATEGORIES)[number];

interface FeedbackConstructiveStepProps {
  onSubmit: (fields: Omit<FeedbackArgs, "rating">) => void;
  /** Returns to Step 1 without losing the star rating — the only way a
   *  keyboard user who overshot into 1-3★ (native radio: arrow keys select on
   *  the same keystroke that moves focus) can reach 4-5★ instead. */
  onBack: () => void;
  onClose: () => void;
}

export function FeedbackConstructiveStep({
  onSubmit,
  onBack,
  onClose,
}: FeedbackConstructiveStepProps) {
  const [category, setCategory] = useState<Category | "">("");
  const [feedbackText, setFeedbackText] = useState("");
  const [wantsContact, setWantsContact] = useState(false);
  const [email, setEmail] = useState("");

  function handleSubmit() {
    onSubmit({
      category: category || undefined,
      feedbackText: feedbackText || undefined,
      wantsContact,
      // Email is PII — only forwarded when the user opted into follow-up.
      email: wantsContact ? email : undefined,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-content-secondary">
          What area needs improvement? (optional)
        </span>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => {
            const selected = category === c;
            return (
              <Button
                key={c}
                type="button"
                variant={selected ? "primary" : "ghost"}
                aria-pressed={selected}
                onClick={() => setCategory(selected ? "" : c)}
                className="rounded-full border border-border-light px-3 py-1"
              >
                {c}
              </Button>
            );
          })}
        </div>
      </div>

      <TextAreaField
        value={feedbackText}
        onChange={setFeedbackText}
        label="Tell us what went wrong or what you'd change (optional)"
        placeholder="Tell us what went wrong or what you'd change…"
        rows={3}
      />

      <EmailOptIn
        checkboxLabel="I'd like the team to follow up on this"
        onChange={(next, nextEmail) => {
          setWantsContact(next);
          setEmail(nextEmail);
        }}
      />

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel / Skip
        </Button>
        <Button variant="primary" size="sm" onClick={handleSubmit}>
          Submit Feedback
        </Button>
      </div>
    </div>
  );
}
