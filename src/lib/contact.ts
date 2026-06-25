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

/** Which visual row of the centered card a field belongs to (#146): `identity`
 *  is the name heading, `contact` is the pipe-joined location/email/phone line,
 *  `link` is the slug links line. */
export type ContactGroup = "identity" | "contact" | "link";

export interface ContactDisplayField {
  key: string;
  label: string;
  /** Which row of the visual card this field renders into (#146). */
  group: ContactGroup;
  /** The displayable value. Empty string when absent; for a low-confidence
   *  field the parsed value is retained (so the card can show it subtly) even
   *  though `gated` is true. */
  value: string;
  /** True when the field should not count toward the detected total (absent or
   *  below the confidence floor). */
  gated: boolean;
  /** Present only when `gated` is true. */
  reason?: "absent" | "low_confidence";
}

const CONTACT_ROWS: readonly {
  key: keyof typeof FIELD_KEYS;
  label: string;
  group: ContactGroup;
  /** Optional rows surface only when actually detected. Not every candidate
   *  keeps a GitHub/portfolio/personal-site link, so its absence is not a gap —
   *  an optional row never renders a "not detected" marker nor counts against
   *  the detected/total ratio. Required rows (the rest) always render so the
   *  reader can spot a missing email/phone/etc. at a glance. */
  optional?: boolean;
}[] = [
  { key: "full_name", label: "Name", group: "identity" },
  { key: "email", label: "Email", group: "contact" },
  { key: "phone", label: "Phone", group: "contact" },
  { key: "linkedin_url", label: "LinkedIn", group: "link" },
  { key: "github_url", label: "GitHub", group: "link", optional: true },
  { key: "portfolio_url", label: "Portfolio", group: "link", optional: true },
  { key: "website_url", label: "Website", group: "link", optional: true },
  { key: "location", label: "Location", group: "contact" },
];

// TypeScript trick: enumerate the valid keys for indexing `parsed`.
const FIELD_KEYS = {
  full_name: true,
  email: true,
  phone: true,
  linkedin_url: true,
  github_url: true,
  portfolio_url: true,
  website_url: true,
  location: true,
} as const;

/**
 * Build the ordered contact display rows from a `CascadeResult`.
 *
 * Returns the required rows — Name, Email, Phone, LinkedIn, Location — each
 * always present (and `gated` when absent / below
 * `CONTACT_DISPLAY_CONFIDENCE_FLOOR`). Optional link rows (GitHub, Portfolio,
 * Website) are included only when confidently detected, so a candidate without
 * those profiles sees no gap and no penalty in the detected/total ratio. Each
 * row carries a `group` (`identity` | `contact` | `link`) so the visual card
 * (#146) can partition them into its name heading, contact line, and links line.
 */
export function buildContactFields(
  cascade: Pick<CascadeResult, "parsed" | "fieldConfidence">,
): ContactDisplayField[] {
  const rows: ContactDisplayField[] = [];
  for (const { key, label, group, optional } of CONTACT_ROWS) {
    const raw = cascade.parsed[key as keyof typeof FIELD_KEYS];
    const value = typeof raw === "string" ? raw : "";
    const conf = cascade.fieldConfidence[key as keyof typeof FIELD_KEYS] ?? 0;
    const detected = Boolean(value) && conf >= CONTACT_DISPLAY_CONFIDENCE_FLOOR;

    // An optional field is shown only when detected — its absence is not a gap.
    if (optional && !detected) continue;

    if (!value) {
      rows.push({ key, label, group, value: "", gated: true, reason: "absent" });
    } else if (conf < CONTACT_DISPLAY_CONFIDENCE_FLOOR) {
      // Retain the parsed value so the card can render it with a subtle
      // low-confidence treatment (#146); `gated` still keeps it out of the
      // detected count and the score-facing consumers (which check `gated`).
      rows.push({ key, label, group, value, gated: true, reason: "low_confidence" });
    } else {
      rows.push({ key, label, group, value, gated: false });
    }
  }
  return rows;
}

/**
 * Shorten a link URL to a compact, human-readable slug for the card's links
 * line (#146). Strips the protocol, a leading `www.`, and any trailing slash,
 * then collapses the two common profile hosts to a host-relative form:
 * `linkedin.com/in/<slug>` → `in/<slug>`, `github.com/<slug>` → `gh/<slug>`.
 * Anything else (portfolio / personal site) falls back to the stripped
 * host+path, which stays unambiguous. The original URL remains the `href`.
 */
export function formatLinkDisplay(url: string): string {
  const stripped = url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "");
  const linkedin = stripped.match(/^linkedin\.com\/in\/(.+)$/i);
  if (linkedin) return `in/${linkedin[1]}`;
  const github = stripped.match(/^github\.com\/(.+)$/i);
  if (github) return `gh/${github[1]}`;
  return stripped;
}
