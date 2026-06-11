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

const CONTACT_ROWS: readonly { key: keyof typeof FIELD_KEYS; label: string }[] =
  [
    { key: "full_name", label: "Name" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "linkedin_url", label: "LinkedIn" },
    { key: "location", label: "Location" },
  ];

// TypeScript trick: enumerate the valid keys for indexing `parsed`.
const FIELD_KEYS = {
  full_name: true,
  email: true,
  phone: true,
  linkedin_url: true,
  location: true,
} as const;

/**
 * Build the ordered contact display rows from a `CascadeResult`.
 *
 * Always returns exactly 5 rows in the order: Name, Email, Phone, LinkedIn,
 * Location. A row is `gated` when its value is absent or its confidence is
 * below `CONTACT_DISPLAY_CONFIDENCE_FLOOR`.
 */
export function buildContactFields(
  cascade: Pick<CascadeResult, "parsed" | "fieldConfidence">,
): ContactDisplayField[] {
  return CONTACT_ROWS.map(({ key, label }) => {
    const raw = cascade.parsed[key as keyof typeof FIELD_KEYS];
    const value = typeof raw === "string" ? raw : "";
    const conf = cascade.fieldConfidence[key as keyof typeof FIELD_KEYS] ?? 0;

    if (!value) {
      return { key, label, value: "", gated: true, reason: "absent" as const };
    }
    if (conf < CONTACT_DISPLAY_CONFIDENCE_FLOOR) {
      return {
        key,
        label,
        value: "",
        gated: true,
        reason: "low_confidence" as const,
      };
    }
    return { key, label, value, gated: false };
  });
}
