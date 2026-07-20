// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Contact field display helper for the anonymous ATS check UI.
 *
 * Applies the same confidence floor the scoring layer uses for contact fields
 * so the displayed card and the completeness score agree: a field below 0.5
 * confidence is treated as absent.
 */

import type { CanonicalResume } from "./heuristics/canonical.ts";
import type { ContactOverrides } from "../hooks/useEditableParse.ts";

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
  // Brand-neutral required row (#335): a "Professional profile" gap, satisfied
  // by any social (LinkedIn) OR code (GitHub) link — see the github-satisfies
  // check in `buildContactFields`. Keyed on `linkedin_url` so the existing
  // fixed-key edit/override plumbing is unchanged this phase; Phase 2 flips the
  // whole links block to read `profiles[]` directly.
  { key: "linkedin_url", label: "Professional profile", group: "link" },
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
  canonical: Pick<CanonicalResume, "fields" | "fieldConfidence">,
): ContactDisplayField[] {
  // A code profile (GitHub) satisfies the brand-neutral required "Professional
  // profile" row (#335) — so a candidate who links GitHub but not LinkedIn sees
  // no gap. The github value keeps rendering via its own optional row.
  const githubConf =
    canonical.fieldConfidence.github_url ?? 0;
  const githubSatisfies =
    Boolean(canonical.fields.github_url) &&
    githubConf >= CONTACT_DISPLAY_CONFIDENCE_FLOOR;

  const rows: ContactDisplayField[] = [];
  for (const { key, label, group, optional } of CONTACT_ROWS) {
    const raw = canonical.fields[key as keyof typeof FIELD_KEYS];
    const value = typeof raw === "string" ? raw : "";
    const conf = canonical.fieldConfidence[key as keyof typeof FIELD_KEYS] ?? 0;
    const detected = Boolean(value) && conf >= CONTACT_DISPLAY_CONFIDENCE_FLOOR;

    // An optional field is shown only when detected — its absence is not a gap.
    if (optional && !detected) continue;

    // The required "Professional profile" row is not a gap when a code profile
    // (GitHub) is present — social OR code satisfies it (#335).
    if (key === "linkedin_url" && !detected && githubSatisfies) continue;

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
 * Apply the inline-edit overrides onto the parsed display fields — the single
 * source of truth shared by the ContactCard (which renders the fields) and the
 * AttentionStrip (which counts the gaps). A non-empty override replaces the
 * parsed value and marks it detected; an empty string is an explicit clear →
 * revert to the gated "absent" state; `undefined` keeps the parsed value.
 *
 * Field keys map 1:1 onto `ContactOverrides` keys, so a field is override-
 * applicable iff its key exists on the overrides object. Pass `undefined` for a
 * pure-display card (no overrides) and the fields pass through untouched.
 */
export function applyContactOverrides(
  fields: ContactDisplayField[],
  overrides: ContactOverrides | undefined,
): ContactDisplayField[] {
  if (overrides === undefined) return fields;
  return fields.map((field): ContactDisplayField => {
    const ov = overrides[field.key as keyof ContactOverrides];
    if (ov === undefined) return field;
    if (ov === "")
      return { ...field, value: "", gated: true, reason: "absent" };
    return { ...field, value: ov, gated: false, reason: undefined };
  });
}

export interface ContactCompleteness {
  detected: number;
  total: number;
  /** Required rows still gated (absent / low-confidence). Optional link rows
   *  never appear here — they don't render when absent, so they're not a gap. */
  missing: ContactDisplayField[];
}

/** Derive the detected/total ratio and the list of missing required fields from
 *  override-resolved display fields. */
export function contactCompleteness(
  displayFields: ContactDisplayField[],
): ContactCompleteness {
  const missing = displayFields.filter((f) => f.gated);
  return {
    detected: displayFields.length - missing.length,
    total: displayFields.length,
    missing,
  };
}

/** One gap in the pre-download critical-field checklist (#312). */
export interface CriticalMissingItem {
  key: "full_name" | "contact" | "experience";
  label: string;
}

/**
 * Pre-download gate predicate (#312) — the "is this résumé too broken to
 * export" check, distinct from `contactCompleteness`'s per-row display gaps:
 *
 *   1. Name    — `full_name` gated (absent or low-confidence).
 *   2. Contact — flagged only when BOTH email and phone are gated; either one
 *                present is enough (unlike the AttentionStrip, which lists
 *                email/phone as two separate gaps).
 *   3. Experience — flagged when `hasExperience` is false (caller passes
 *                   `parsed.experience.length > 0`, which already reflects
 *                   any user-added entries merged in by `applyOverrides`).
 *
 * Returns an empty array when nothing critical is missing — the caller's
 * signal to skip the checklist popover and download immediately.
 */
export function criticalDownloadGate(
  displayFields: ContactDisplayField[],
  hasExperience: boolean,
): CriticalMissingItem[] {
  const items: CriticalMissingItem[] = [];

  const name = displayFields.find((f) => f.key === "full_name");
  if (name?.gated) items.push({ key: "full_name", label: "Name" });

  const email = displayFields.find((f) => f.key === "email");
  const phone = displayFields.find((f) => f.key === "phone");
  const emailGated = email?.gated ?? true;
  const phoneGated = phone?.gated ?? true;
  if (emailGated && phoneGated) {
    items.push({ key: "contact", label: "Contact (email or phone)" });
  }

  if (!hasExperience) {
    items.push({ key: "experience", label: "Experience" });
  }

  return items;
}

/**
 * Score-reveal predicate (#313) — shared by the upload-path result view
 * (`Result`/`AtsScoreReadout`) and the from-scratch authoring surface
 * (`App`'s "authoring" branch): the score ring/verdict stays hidden until the
 * résumé clears the same critical-field bar `criticalDownloadGate` already
 * enforces before a PDF export (name present, email-or-phone present, at
 * least one experience entry). The score itself keeps computing
 * unconditionally elsewhere (feeding `AttentionStrip` + `useDownloadPdf`) —
 * this predicate only gates the ring/verdict's PRESENTATION, and is meant to
 * be re-evaluated on every render so it live-updates as the user edits.
 */
export function isScoreRevealed(
  canonical: Pick<CanonicalResume, "fields" | "fieldConfidence">,
  contactOverrides: ContactOverrides | undefined,
): boolean {
  const displayFields = applyContactOverrides(
    buildContactFields(canonical),
    contactOverrides,
  );
  const hasExperience = canonical.fields.experience.length > 0;
  return criticalDownloadGate(displayFields, hasExperience).length === 0;
}

/**
 * Shorten a link URL to a compact, human-readable slug for the card's links
 * line (#146). Strips the protocol, a leading `www.`, and any trailing slash,
 * leaving the host + path — e.g. `https://www.linkedin.com/in/jane-doe` →
 * `linkedin.com/in/jane-doe`, `https://github.com/janedoe` → `github.com/janedoe`,
 * `https://jane.dev/` → `jane.dev`. Keeping the host makes the platform obvious
 * at a glance while staying compact; the original URL remains the `href`.
 */
export function formatLinkDisplay(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "");
}
