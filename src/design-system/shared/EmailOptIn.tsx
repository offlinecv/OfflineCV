// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * EmailOptIn — a `Checkbox` that reveals a labelled email field when checked.
 *
 * Extracted out of `FeedbackPositiveStep` and `FeedbackConstructiveStep`
 * (#900), which each carried the identical eleven lines — the same pressure
 * `Checkbox` itself was extracted under. The retired `FeedbackPanel` gave the
 * email field a visible `<label>`; both copies had regressed to a placeholder
 * only, which fails WCAG 3.3.2 once the user starts typing and the hint text
 * vanishes. This restores the visible label.
 */

import { useId, useState } from "react";
import { Checkbox } from "../primitives/Checkbox.tsx";

interface EmailOptInProps {
  /** Checkbox label — differs by step ("Keep me posted…" vs "…follow up"). */
  checkboxLabel: string;
  /** Reported on every change: whether the box is checked and the current
   *  (possibly empty) email text. The caller decides what to forward on submit. */
  onChange: (wantsContact: boolean, email: string) => void;
}

export function EmailOptIn({ checkboxLabel, onChange }: EmailOptInProps) {
  const [checked, setChecked] = useState(false);
  const [email, setEmail] = useState("");
  const id = useId();

  function handleCheckedChange(next: boolean): void {
    setChecked(next);
    onChange(next, email);
  }

  function handleEmailChange(next: string): void {
    setEmail(next);
    onChange(checked, next);
  }

  return (
    <div className="flex flex-col gap-2">
      <Checkbox checked={checked} onChange={handleCheckedChange} label={checkboxLabel} />
      {checked && (
        <div className="flex flex-col gap-1">
          <label htmlFor={id} className="text-2xs text-content-muted">
            Your email
          </label>
          <input
            id={id}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => handleEmailChange(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded border border-border-light bg-surface-card px-2 py-1.5 text-sm text-content-primary placeholder:text-content-muted focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary"
          />
        </div>
      )}
    </div>
  );
}
