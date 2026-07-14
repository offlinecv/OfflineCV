// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Contact-section localization (issue #469 step 4) — extracted from
 * `probe-contact.test.ts` so a shared sweep (`/probe-resume`, a later step)
 * can reuse the SAME detector instead of a copy-pasted seventh implementation.
 *
 * PURE: takes an already-parsed `CascadeResult`, never re-parses, never does
 * I/O. This is a refactor of the probe's inline logic, not a behavior change —
 * `probe-contact.test.ts` must print byte-identical output after switching to
 * call this.
 */

import type { CascadeResult } from "../types.ts";
import { EMAIL_RE, US_LOCATION_RE, INTL_LOCATION_RE } from "../regex.ts";
import { findFirstPhone } from "../phone.ts";
import type { DefectClass, DerivedSignals } from "../defect-classes.ts";

/** The contact scalar/URL fields the extractor produces. */
export const CONTACT_FIELDS = [
  "full_name",
  "email",
  "phone",
  "location",
  "linkedin_url",
  "github_url",
  "portfolio_url",
  "website_url",
] as const;

export type ContactField = (typeof CONTACT_FIELDS)[number];

/**
 * Every `DefectClass` this localizer can emit — see `SKILLS_DEFECT_CLASSES` in
 * `./skills.ts` for why the tuple exists and what pins it to the table.
 */
export const CONTACT_DEFECT_CLASSES = [
  "contact-email-parser-miss",
  "contact-phone-parser-miss",
  "contact-location-parser-miss",
] as const satisfies readonly DefectClass[];

type ContactDefectClass = (typeof CONTACT_DEFECT_CLASSES)[number];

/** The verified fields, and the class a PARSER-MISS on each one names. Total
 *  over the three — a new verified field cannot be added without deciding its
 *  class, which must exist in the table. */
const CONTACT_MISS_CLASS: Readonly<
  Record<"email" | "phone" | "location", ContactDefectClass>
> = {
  email: "contact-email-parser-miss",
  phone: "contact-phone-parser-miss",
  location: "contact-location-parser-miss",
};

/** Independent re-scan of rawText for the fields that most often drop when a
 *  region filter mis-fires. Returns the first candidate for each, or
 *  undefined. Deliberately loose — this is the "is it anywhere in the doc?"
 *  oracle, not the precise extractor. */
export function rawTextCandidates(rawText: string): {
  email?: string;
  phone?: string;
  location?: string;
} {
  // EMAIL_RE is a module-global /gi regex, so `.exec()` ADVANCES its
  // `lastIndex`. Reset on BOTH sides: before, so we start at 0 regardless of who
  // ran last; after, so we hand the shared instance back rewound. `corpus.test.ts`
  // now calls this 45× interleaved with `runCascade()` (which itself does
  // `EMAIL_RE.test(...)` in `extract/name.ts`), so the two are on one event loop
  // and a left-behind `lastIndex` is a cross-test action-at-a-distance bug.
  EMAIL_RE.lastIndex = 0;
  const email = EMAIL_RE.exec(rawText)?.[0];
  EMAIL_RE.lastIndex = 0;
  const phone = findFirstPhone(rawText, "US")?.formatted;
  const us = US_LOCATION_RE.exec(rawText)?.[0];
  const intl = INTL_LOCATION_RE.exec(rawText)?.[0];
  return { email, phone, location: us ?? intl };
}

export interface ContactFieldVerify {
  field: "email" | "phone" | "location";
  field_value: string | null;
  rawText_candidate: string | null;
  verdict: string;
}

export interface ContactLocalization {
  /** OUTPUT: the structured contact fields + their per-field confidence. */
  extracted: Record<ContactField, { value: unknown; confidence: number }>;
  /** INPUT: the profile region the contact extractor scanned. */
  profileLines: string[];
  /** VERIFY: independent rawText re-scan for the drop-prone fields. */
  verify: ContactFieldVerify[];
  /** Classes this parse exhibits (`contact-{email,phone,location}-parser-miss`). */
  defects: DefectClass[];
  /** The `derived.*InRawTextButNotParsed` signals this localizer can compute. */
  derived: Partial<DerivedSignals>;
}

/**
 * Localize the contact section: OUTPUT (extracted fields) vs INPUT (profile
 * region) vs an independent rawText re-scan that tells a genuine absence from
 * a parser drop.
 */
export function localizeContact(cascade: CascadeResult): ContactLocalization {
  const p = cascade.canonical.fields as Record<string, unknown>;

  const extracted = Object.fromEntries(
    CONTACT_FIELDS.map((k) => [
      k,
      {
        value: p[k] ?? null,
        confidence:
          cascade.canonical.fieldConfidence[
            k as keyof typeof cascade.canonical.fieldConfidence
          ] ?? 0,
      },
    ]),
  ) as Record<ContactField, { value: unknown; confidence: number }>;

  const profileLines = [
    ...(cascade.canonical.sections.byName.get("profile") ?? []),
  ];

  const candidates = rawTextCandidates(cascade.rawText);

  // Verdict and class are CO-EMITTED per field, in one branch chain: a verdict
  // branch cannot exist without deciding a class (or an explicit `null` — "not a
  // defect"). `verify` keeps exactly the shape the probe harness prints; the
  // class rides alongside it and never reaches the console or the JSON report.
  const verified = (["email", "phone", "location"] as const).map((k) => {
    const got = (p[k] as string | undefined) ?? null;
    const cand = candidates[k] ?? null;
    let verdict: string;
    let defect: ContactDefectClass | null;
    if (got) {
      verdict = "ok";
      defect = null;
    } else if (cand) {
      verdict = "PARSER-MISS (in rawText, not in field)";
      defect = CONTACT_MISS_CLASS[k];
    } else {
      verdict = "absent-in-pdf";
      defect = null;
    }
    return {
      verify: {
        field: k,
        field_value: got,
        rawText_candidate: cand,
        verdict,
      } satisfies ContactFieldVerify,
      defect,
    };
  });

  const verify = verified.map((v) => v.verify);
  const missed = (k: "email" | "phone" | "location"): boolean =>
    verified.some((v) => v.verify.field === k && v.defect !== null);

  const derived: Partial<DerivedSignals> = {
    emailInRawTextButNotParsed: missed("email"),
    phoneInRawTextButNotParsed: missed("phone"),
    locationInRawTextButNotParsed: missed("location"),
  };

  const defects: DefectClass[] = verified
    .map((v) => v.defect)
    .filter((c): c is ContactDefectClass => c !== null);

  return { extracted, profileLines, verify, defects, derived };
}
