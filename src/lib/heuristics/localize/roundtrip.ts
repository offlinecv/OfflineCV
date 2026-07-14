// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Round-trip localization (issue #469 step 4) — extracted from
 * `corpus-roundtrip.test.ts` so a shared sweep (`/probe-resume`, a later
 * step) can reuse the SAME detector instead of a copy-pasted seventh
 * implementation. `/probe-roundtrip`'s harness IS the `RL_RT_PDF`-gated block
 * at the bottom of `corpus-roundtrip.test.ts` — there is no
 * `probe-roundtrip.test.ts` (issue #469's table is wrong on that row).
 *
 * PURE: every export here is a total function of two already-parsed
 * `CascadeResult`s (or their diffs). Nothing re-parses, renders, or does I/O —
 * the render→re-parse hop is the CALLER's job. `corpus-roundtrip.test.ts`
 * does that hop for both the corpus gate and the RL_RT_PDF harness, and
 * passes the resulting parses in here.
 *
 * This module is shared by TWO different consumers with different PII
 * postures over the SAME underlying comparison:
 *   - the corpus round-trip invariant gate (#293, top of
 *     `corpus-roundtrip.test.ts`) — fixtures only (synthetic personas), field
 *     MAPPING diffs (`entryListFails`) plus a values-included contact diff
 *     (`contactFails` — safe here because fixture PDFs carry no real PII).
 *   - the `RL_RT_PDF` dev harness (bottom of the same file) — an arbitrary,
 *     possibly PII-bearing résumé, values-included diffs throughout
 *     (`entryValueFails`, `skillsValueFails`, `harnessDiff`) so a maintainer
 *     can see exactly what corrupted. That output is scratch-only by the
 *     harness's own guardrail (gitignored `internal/roundtrip/`), never this
 *     module's concern.
 *
 * `localizeRoundtripHop` is the only export that produces `DefectClass[]` /
 * `DerivedSignals` — the PII-free half a future sweep consumes. It derives
 * strictly from BOOLEAN field-level comparisons, never from the value-diff
 * strings above (which may carry résumé text) — see `defect-classes.ts`'s
 * header for why that separation is load-bearing.
 */

import type { CascadeResult, HeuristicParsedResume } from "../types.ts";
import type { DefectClass, DerivedSignals } from "../defect-classes.ts";

export type RoundtripCategory =
  | "contact"
  | "experience"
  | "education"
  | "skills"
  | "summary"
  // `render` = renderAtsResumePdf threw before any re-parse could run.
  | "render";

/**
 * The probe-roundtrip verdict↔class pin.
 *
 * This harness has no single verdict string: a CATEGORY with a non-empty diff IS
 * its verdict. So the pin is a TOTAL `Record<RoundtripCategory, DefectClass>` —
 * adding a category to the union without a class here is a COMPILE error, and
 * `localizeRoundtripHop` reads its classes from this map rather than restating
 * them. `defect-classes.test.ts` pins its image against the table's
 * `probe: "probe-roundtrip"` rows.
 */
export const ROUNDTRIP_CATEGORY_CLASS: Readonly<
  Record<RoundtripCategory, DefectClass>
> = {
  contact: "roundtrip-contact-value-changed",
  experience: "roundtrip-experience-value-changed",
  education: "roundtrip-education-value-changed",
  skills: "roundtrip-skills-value-changed",
  summary: "roundtrip-summary-value-changed",
  render: "roundtrip-render-crash",
};

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Contact scalar-field diffs (name/email/phone/location/linkedin), VALUES
 *  included in the message. Safe over fixtures (synthetic personas); the
 *  RL_RT_PDF harness's own guardrail routes its output to gitignored scratch
 *  when the input is a real résumé. */
function contactFails(
  c1: HeuristicParsedResume,
  c3: HeuristicParsedResume,
): string[] {
  const out: string[] = [];
  for (const k of [
    "full_name",
    "email",
    "phone",
    "location",
    "linkedin_url",
  ] as const) {
    if (!same(c1[k], c3[k]))
      out.push(`${k}: ${JSON.stringify(c1[k])} → ${JSON.stringify(c3[k])}`);
  }
  return out;
}

/** Per-field boolean contact diff — the PII-free half `contactFails` cannot
 *  give: `derived.*ChangedAcrossRoundtrip` reads booleans only, never a
 *  `contactFails` string (which carries values). */
export function contactFieldChanges(
  c1: HeuristicParsedResume,
  c3: HeuristicParsedResume,
): {
  fullName: boolean;
  email: boolean;
  phone: boolean;
  location: boolean;
  linkedin: boolean;
} {
  return {
    fullName: !same(c1.full_name, c3.full_name),
    email: !same(c1.email, c3.email),
    phone: !same(c1.phone, c3.phone),
    location: !same(c1.location, c3.location),
    linkedin: !same(c1.linkedin_url, c3.linkedin_url),
  };
}

/** Ordered-entry-list diff skeleton: a count mismatch short-circuits, else
 *  each index/key inequality is rendered by `formatMismatch`. The mapping and
 *  value callers below differ ONLY in that formatter. */
function entryListDiff<T>(
  a1: readonly T[],
  a3: readonly T[],
  keys: readonly (keyof T)[],
  label: string,
  formatMismatch: (
    i: number,
    k: keyof T,
    v1: T[keyof T],
    v3: T[keyof T] | undefined,
  ) => string,
): string[] {
  if (a1.length !== a3.length)
    return [`${label} count ${a1.length} → ${a3.length}`];
  const out: string[] = [];
  a1.forEach((r, i) => {
    for (const k of keys)
      if (!same(r[k], a3[i]?.[k])) out.push(formatMismatch(i, k, r[k], a3[i]?.[k]));
  });
  return out;
}

/** Ordered-entry-list diff (experience/education): a count mismatch, else
 *  per-field inequality at each index. Prints field NAMES only, so it stays
 *  PII-free (used by the corpus gate). */
function entryListFails<T>(
  a1: readonly T[],
  a3: readonly T[],
  keys: readonly (keyof T)[],
  label: string,
): string[] {
  return entryListDiff(a1, a3, keys, label, (i, k) => `${label}[${i}].${String(k)}`);
}

/** Ordered-entry VALUE diff (experience/education): a count mismatch, else
 *  the changed field VALUES `before → after` at each index. Harness-only —
 *  never used by the PII-free corpus gate. */
function entryValueFails<T>(
  a1: readonly T[],
  a3: readonly T[],
  keys: readonly (keyof T)[],
  label: string,
): string[] {
  return entryListDiff(
    a1,
    a3,
    keys,
    label,
    (i, k, v1, v3) =>
      `${label}[${i}].${String(k)}: ${JSON.stringify(v1)} → ${JSON.stringify(v3)}`,
  );
}

/** Summary length drift ≥ 5% (the round-trip truncation signal, #292). */
function summaryFails(s1: string, s3: string): string[] {
  if (s1.length === 0) return [];
  const deltaPct = (100 * Math.abs(s1.length - s3.length)) / s1.length;
  return deltaPct >= 5
    ? [`|Δ| ${deltaPct.toFixed(1)}% (${s1.length} → ${s3.length})`]
    : [];
}

/** Skills value diff: the count delta plus the added/removed tokens.
 *  Harness-only — never used by the PII-free corpus gate. */
function skillsValueFails(
  s1: readonly string[],
  s3: readonly string[],
): string[] {
  const set1 = new Set(s1);
  const set3 = new Set(s3);
  const removed = s1.filter((s) => !set3.has(s));
  const added = s3.filter((s) => !set1.has(s));
  if (removed.length === 0 && added.length === 0) return [];
  const out = [`count ${s1.length} → ${s3.length}`];
  if (removed.length) out.push(`removed: ${JSON.stringify(removed)}`);
  if (added.length) out.push(`added: ${JSON.stringify(added)}`);
  return out;
}

/** Per-category before → after MAPPING diff for one hop — used by the corpus
 *  gate's ratchet. Field names only for experience/education/skills/summary;
 *  `contactFails` includes values (see its own doc — safe over fixtures). */
export function invariantFailures(
  p1: CascadeResult,
  p3: CascadeResult,
): Record<Exclude<RoundtripCategory, "render">, string[]> {
  const c1 = p1.canonical.fields;
  const c3 = p3.canonical.fields;
  const sk1 = (c1.skills ?? []).length;
  const sk3 = (c3.skills ?? []).length;
  return {
    contact: contactFails(c1, c3),
    experience: entryListFails(
      c1.experience ?? [],
      c3.experience ?? [],
      ["title", "company", "start_date", "end_date"] as const,
      "role",
    ),
    education: entryListFails(
      c1.education ?? [],
      c3.education ?? [],
      ["degree", "field", "institution"] as const,
      "entry",
    ),
    skills: sk1 !== sk3 ? [`count ${sk1} → ${sk3}`] : [],
    summary: summaryFails(c1.summary ?? "", c3.summary ?? ""),
  };
}

/** Per-category before → after VALUE diff for one hop — used by the RL_RT_PDF
 *  dev harness. */
export function harnessDiff(
  before: CascadeResult,
  after: CascadeResult,
): Record<Exclude<RoundtripCategory, "render">, string[]> {
  const c1 = before.canonical.fields;
  const c3 = after.canonical.fields;
  return {
    contact: contactFails(c1, c3),
    experience: entryValueFails(
      c1.experience ?? [],
      c3.experience ?? [],
      ["title", "company", "start_date", "end_date"] as const,
      "role",
    ),
    education: entryValueFails(
      c1.education ?? [],
      c3.education ?? [],
      ["degree", "field", "institution"] as const,
      "entry",
    ),
    skills: skillsValueFails(c1.skills ?? [], c3.skills ?? []),
    summary: summaryFails(c1.summary ?? "", c3.summary ?? ""),
  };
}

/**
 * The PII-free half: given one hop's before/after parse (`after` absent when
 * `renderError` pre-empted the hop), the `DefectClass[]` it localizes and the
 * `derived.*ChangedAcrossRoundtrip` / `renderThrewOnRoundtrip` booleans a
 * sweep can merge into one `DerivedSignals`. Reads ONLY boolean field-level
 * comparisons — never a `harnessDiff`/`invariantFailures` string, which may
 * carry résumé values.
 */
export function localizeRoundtripHop(
  before: CascadeResult,
  after: CascadeResult | undefined,
  renderError?: string,
): { defects: DefectClass[]; derived: Partial<DerivedSignals> } {
  if (!after || renderError) {
    // The hop produced no `after`, so the nine `*ChangedAcrossRoundtrip` bits are
    // NOT COMPUTABLE. Leaving them false would say "no value changed across the
    // round-trip" about a round-trip that never happened — the unknowable-reads-
    // false bug this whole layer exists to prevent. `roundtripOracleUnavailable`
    // is the honest report: the five `roundtrip-*-value-changed` classes are
    // WITHHELD (`defect-classes.ts`'s oracle gate), and only the observed fact —
    // the crash — is claimed.
    return {
      defects: [ROUNDTRIP_CATEGORY_CLASS.render],
      derived: { renderThrewOnRoundtrip: true, roundtripOracleUnavailable: true },
    };
  }

  const c1 = before.canonical.fields;
  const c3 = after.canonical.fields;
  const contactChanges = contactFieldChanges(c1, c3);

  const experienceChanged =
    entryValueFails(
      c1.experience ?? [],
      c3.experience ?? [],
      ["title", "company", "start_date", "end_date"] as const,
      "role",
    ).length > 0;
  const educationChanged =
    entryValueFails(
      c1.education ?? [],
      c3.education ?? [],
      ["degree", "field", "institution"] as const,
      "entry",
    ).length > 0;
  const skillsChanged =
    skillsValueFails(c1.skills ?? [], c3.skills ?? []).length > 0;
  const summaryChanged =
    summaryFails(c1.summary ?? "", c3.summary ?? "").length > 0;

  const derived: Partial<DerivedSignals> = {
    fullNameChangedAcrossRoundtrip: contactChanges.fullName,
    emailChangedAcrossRoundtrip: contactChanges.email,
    phoneChangedAcrossRoundtrip: contactChanges.phone,
    locationChangedAcrossRoundtrip: contactChanges.location,
    linkedinUrlChangedAcrossRoundtrip: contactChanges.linkedin,
    experienceChangedAcrossRoundtrip: experienceChanged,
    educationChangedAcrossRoundtrip: educationChanged,
    skillsChangedAcrossRoundtrip: skillsChanged,
    summaryChangedAcrossRoundtrip: summaryChanged,
    renderThrewOnRoundtrip: false,
    roundtripOracleUnavailable: false,
  };

  // Category → verdict (a non-empty diff) → class, straight through the pin.
  const changedByCategory: Record<Exclude<RoundtripCategory, "render">, boolean> =
    {
      contact:
        contactChanges.fullName ||
        contactChanges.email ||
        contactChanges.phone ||
        contactChanges.location ||
        contactChanges.linkedin,
      experience: experienceChanged,
      education: educationChanged,
      skills: skillsChanged,
      summary: summaryChanged,
    };

  const defects: DefectClass[] = (
    ["contact", "experience", "education", "skills", "summary"] as const
  )
    .filter((c) => changedByCategory[c])
    .map((c) => ROUNDTRIP_CATEGORY_CLASS[c]);

  return { defects, derived };
}
