// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The whole-parse sweep (issue #469) — the ONE place a `DerivedSignals` bag and
 * a defect list are assembled from the six localizers.
 *
 * Two callers need exactly this and must never drift apart:
 *   - `probe-resume.test.ts` (the `/probe-resume` harness) — over a REAL résumé.
 *   - `corpus.test.ts`'s bake — over each of the 45 synthetic fixtures.
 * If those two computed `derived` differently, the sweep would be comparing a
 * résumé to fixtures on DIFFERENT axes, and every coverage answer it printed
 * would be meaningless. So they both call `sweepParse()`.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE ORACLE GATE — the reason this module exists rather than a merge spread│
 * │ across two call sites.                                                    │
 * │                                                                           │
 * │ A `DerivedSignals` bit computed from an ABSENT input reads `false`, and   │
 * │ `false` there means UNKNOWABLE, not "observed absent" (see                │
 * │ `defect-classes.ts`'s `DERIVED_SIGNAL_KEYS` header). Three inputs can be  │
 * │ absent — the extracted TEXT, the markdown HEADERS, the round-trip `after` │
 * │ parse — so three `*OracleUnavailable` bits record it, each `DefectSpec`   │
 * │ declares which oracles it `requires`, and this module applies the gate    │
 * │ ONCE: whatever the localizers emitted, a class whose oracle was blind      │
 * │ lands in `withheld`, never in `defects`.                                  │
 * │                                                                           │
 * │ `defects: []` therefore means "clean" ONLY when `withheld: []` too. A     │
 * │ consumer that prints an affirmative "no defects" without checking         │
 * │ `withheld` (and `unreadable`) is reporting a dead parse as a healthy one. │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * PURE: takes an already-parsed `CascadeResult` and an already-run
 * `RoundtripHop`. Never parses, renders, or does I/O — the caller performs both.
 */

import type { CascadeResult } from "./types.ts";
import type { RoundtripHop } from "./roundtrip-hop.ts";
import type { DefectClass, DerivedSignals } from "./defect-classes.ts";
import {
  DEFECT_CLASSES,
  EMPTY_DERIVED_SIGNALS,
  isWithheld,
} from "./defect-classes.ts";
import { localizeContact, type ContactLocalization } from "./localize/contact.ts";
import { localizeSkills, type SkillsLocalization } from "./localize/skills.ts";
import {
  localizeExperience,
  type ExperienceLocalization,
} from "./localize/experience.ts";
import {
  localizeEducation,
  type EducationLocalization,
} from "./localize/education.ts";
import {
  localizeAchievements,
  type AchievementsLocalization,
} from "./localize/achievements.ts";
import { localizeRoundtripHop } from "./localize/roundtrip.ts";

/**
 * TRUE when the parse produced NO readable text: the layout probe called the PDF
 * `scanned` (the cascade short-circuits before Tier 1) or `rawText` came back
 * empty. EVERY derived signal except the round-trip ones is read out of that
 * text — or out of the sections cut from it — so on such a parse they are all
 * `false` because there was nothing to read.
 *
 * This is offlinecv's single most severe failure mode. It must never be
 * reported as "no defect class is exhibited by this parse".
 */
export function isTextOracleUnavailable(cascade: CascadeResult): boolean {
  return (
    cascade.triggers.includes("scanned") || cascade.rawText.trim().length === 0
  );
}

/**
 * TRUE when the parse produced nothing readable at all — the definition of
 * "⛔ PARSE UNREADABLE" that gates the `/probe-resume` harness's defect report
 * and corpus coverage. Lives here, not in the harness, for the same reason
 * `sweepParse()` does: the harness and `npm run bake-fixtures` must never
 * compute "unreadable" on different terms, or a corpus coverage claim would be
 * comparing a résumé and a fixture that don't agree on what "readable" means.
 *
 * `derived.textOracleUnavailable` catches a scanned PDF or empty `rawText`;
 * `extractedCharCount === 0` catches a parse that produced text but the
 * extractor pulled nothing structured out of it. Either way, every oracle
 * below the round-trip was blind, so no defect claim over this parse can be
 * trusted.
 */
export function isParseUnreadable(
  derived: DerivedSignals,
  extractedCharCount: number,
): boolean {
  return derived.textOracleUnavailable || extractedCharCount === 0;
}

/** The six localizations, plus the merged, gated verdict. */
export interface ResumeSweep {
  contact: ContactLocalization;
  skills: SkillsLocalization;
  experience: ExperienceLocalization;
  education: EducationLocalization;
  achievements: AchievementsLocalization;
  roundtrip: { defects: DefectClass[]; derived: Partial<DerivedSignals> };
  /** The full, merged bag — including the three `*OracleUnavailable` bits. */
  derived: DerivedSignals;
  /** Classes the localizers emitted AND whose required oracles all ran, in
   *  `DEFECT_CLASSES` order. Deduplicated. */
  defects: DefectClass[];
  /** Classes whose verdict this parse could not decide — the oracle they need
   *  did not run. NOT "clean": undecided. Print these, never swallow them. */
  withheld: DefectClass[];
  /** `name(lineCount)` per routed section — PII-free, and the ONE thing that
   *  tells a reader whether a "no such section" advisory means "the résumé has
   *  none" or "the block was mis-routed into another bucket". */
  sectionOverview: string[];
}

/**
 * Run every localizer off ONE parse and ONE hop, merge their `DerivedSignals`
 * slices, and apply the oracle gate to what they claimed.
 */
export function sweepParse(
  cascade: CascadeResult,
  hop: RoundtripHop,
): ResumeSweep {
  const contact = localizeContact(cascade);
  const skills = localizeSkills(cascade);
  const experience = localizeExperience(cascade);
  const education = localizeEducation(cascade);
  const achievements = localizeAchievements(cascade);
  const roundtrip = localizeRoundtripHop(cascade, hop.after, hop.renderError);

  const derived: DerivedSignals = {
    ...EMPTY_DERIVED_SIGNALS,
    ...contact.derived,
    ...skills.derived,
    ...experience.derived,
    ...education.derived,
    ...achievements.derived,
    ...roundtrip.derived,
    // The cross-cutting oracle a localizer cannot own: it gates ALL of them.
    textOracleUnavailable: isTextOracleUnavailable(cascade),
  };

  const claimed = new Set<DefectClass>([
    ...contact.defects,
    ...skills.defects,
    ...experience.defects,
    ...education.defects,
    ...achievements.defects,
    ...roundtrip.defects,
  ]);

  const defects = DEFECT_CLASSES.filter(
    (c) => claimed.has(c) && !isWithheld(c, derived),
  );
  const withheld = DEFECT_CLASSES.filter((c) => isWithheld(c, derived));

  return {
    contact,
    skills,
    experience,
    education,
    achievements,
    roundtrip,
    derived,
    defects,
    withheld,
    sectionOverview: skills.sectionOverview,
  };
}
