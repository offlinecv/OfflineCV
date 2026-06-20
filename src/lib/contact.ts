// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Contact field display helper for the anonymous ATS check UI.
 *
 * Applies the same confidence floor the scoring layer uses for contact fields
 * so the displayed card and the completeness score agree: a field below 0.5
 * confidence is treated as absent.
 */

import type { CascadeResult } from "./heuristics/types.ts";

export const CONTACT_DISPLAY_CONFIDENCE_FLOOR = 0.5;

export interface ContactDisplayField {
  key: string;
  label: string;
  /** The displayable value. Empty string when `gated` is true. */
  value: string;
  /** True when the field should not be displayed (absent or low confidence). */
  gated: boolean;
  /** Present only when `gated` is true. */
  reason?: "absent" | "low_confidence";
}

const CONTACT_ROWS: readonly {
  key: keyof typeof FIELD_KEYS;
  label: string;
  /** Optional rows surface only when actually detected. Not every candidate
   *  keeps a GitHub profile, so its absence is not a gap — an optional row
   *  never renders a "not detected" chip nor counts against the detected/total
   *  ratio. Required rows (the rest) always render so the reader can spot a
   *  missing email/phone/etc. at a glance. */
  optional?: boolean;
}[] = [
  { key: "full_name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "linkedin_url", label: "LinkedIn" },
  { key: "github_url", label: "GitHub", optional: true },
  { key: "location", label: "Location" },
];

// TypeScript trick: enumerate the valid keys for indexing `parsed`.
const FIELD_KEYS = {
  full_name: true,
  email: true,
  phone: true,
  linkedin_url: true,
  github_url: true,
  location: true,
} as const;

/**
 * Build the ordered contact display rows from a `CascadeResult`.
 *
 * Returns the required rows in order — Name, Email, Phone, LinkedIn, Location —
 * each always present (and `gated` when absent / below
 * `CONTACT_DISPLAY_CONFIDENCE_FLOOR`). Optional rows (GitHub) are included only
 * when confidently detected, so a candidate without a GitHub profile sees no
 * "GitHub not detected" gap and no penalty in the detected/total ratio.
 */
export function buildContactFields(
  cascade: Pick<CascadeResult, "parsed" | "fieldConfidence">,
): ContactDisplayField[] {
  const rows: ContactDisplayField[] = [];
  for (const { key, label, optional } of CONTACT_ROWS) {
    const raw = cascade.parsed[key as keyof typeof FIELD_KEYS];
    const value = typeof raw === "string" ? raw : "";
    const conf = cascade.fieldConfidence[key as keyof typeof FIELD_KEYS] ?? 0;
    const detected = Boolean(value) && conf >= CONTACT_DISPLAY_CONFIDENCE_FLOOR;

    // An optional field is shown only when detected — its absence is not a gap.
    if (optional && !detected) continue;

    if (!value) {
      rows.push({ key, label, value: "", gated: true, reason: "absent" });
    } else if (conf < CONTACT_DISPLAY_CONFIDENCE_FLOOR) {
      rows.push({ key, label, value: "", gated: true, reason: "low_confidence" });
    } else {
      rows.push({ key, label, value, gated: false });
    }
  }
  return rows;
}
