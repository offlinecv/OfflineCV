// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Skills-section localization (issue #469 step 4) — extracted from
 * `probe-skills.test.ts` so a shared sweep (`/probe-resume`, a later step) can
 * reuse the SAME detector instead of a copy-pasted seventh implementation.
 *
 * PURE: takes an already-parsed `CascadeResult`, never re-parses, never does
 * I/O. This is a refactor of the probe's inline logic, not a behavior change —
 * `probe-skills.test.ts` must print byte-identical output after switching to
 * call this.
 *
 * The markdown header oracle lives in `./headers.ts` (shared with
 * `./education.ts`). Read ITS header for why `HeaderOracle.unavailable` — a
 * scanned or sparse PDF with no markdown at all — is not the same fact as "no
 * skills-like header was rejected", and why `skills-no-section` refuses to fire
 * while it is true.
 */

import type { CascadeResult } from "../types.ts";
import { SECTION_KEYWORDS } from "../regex.ts";
import { SECTION_ANCHORS } from "../sections.config.ts";
import type { DefectClass, DerivedSignals } from "../defect-classes.ts";
import type { MissedHeader } from "./headers.ts";
import { findMissedHeaders, looseHeaderReason } from "./headers.ts";

const SKILLS_ALIASES = SECTION_KEYWORDS.skills ?? [];
const SKILLS_ANCHORS: ReadonlySet<string> = SECTION_ANCHORS.skills ?? new Set();

/**
 * Every `DefectClass` this localizer can emit. Declared as a tuple so the
 * verdict chain below is TYPED to it: a verdict branch cannot exist without
 * naming a class (or an explicit `null` — "not a defect"), and
 * `defect-classes.test.ts` pins this tuple against the table's `probe:
 * "probe-skills"` rows. A class in the table with no branch here — or a branch
 * here for a class not in the table — is a test failure, not a silent gap.
 */
export const SKILLS_DEFECT_CLASSES = [
  "skills-extraction-miss",
  "skills-header-unrecognized",
  "skills-no-section",
] as const satisfies readonly DefectClass[];

type SkillsDefectClass = (typeof SKILLS_DEFECT_CLASSES)[number];

/**
 * Loose skills-header oracle — the shared `looseHeaderReason` bound to the
 * skills alias/anchor sets. Kept as a named export because it IS the #414
 * oracle, and reads better at the call sites (and in its tests) than the
 * four-argument generic.
 */
export function looseSkillsReason(raw: string): string | null {
  return looseHeaderReason(raw, SKILLS_ALIASES, SKILLS_ANCHORS, "skills");
}

export type { MissedHeader };

export interface SkillsLocalization {
  /** OUTPUT: the parsed skills list. */
  skills: string[];
  /** INPUT (routed): the skills region the extractor scanned, if any. */
  skillsRegion: string[];
  skillsRegionPresent: boolean;
  /** Section-detection overview (all regions, line counts only). */
  sectionOverview: string[];
  headerCandidates: { text: string; strict: string | null }[];
  /** Skills-like headers the strict router did NOT map to skills. */
  missedSkillsHeaders: MissedHeader[];
  /** The markdown block under the first missed header, up to the next header. */
  orphanBlock: string[];
  /** TRUE when there was no markdown to run the header oracle over (scanned or
   *  sparse PDF) — so `missedSkillsHeaders` being empty proves NOTHING. */
  headerOracleUnavailable: boolean;
  verdict: string;
  defects: DefectClass[];
  derived: Partial<DerivedSignals>;
}

/**
 * Localize the skills section: OUTPUT (parsed skills) vs INPUT (routed region +
 * header candidates the strict router rejected).
 */
export function localizeSkills(cascade: CascadeResult): SkillsLocalization {
  const p = cascade.canonical.fields;

  const skills = [...(p.skills ?? [])];

  const skillsRegion = [
    ...(cascade.canonical.sections.byName.get("skills") ?? []),
  ];
  const skillsRegionPresent = skillsRegion.length > 0;

  const sectionOverview = [...cascade.canonical.sections.byName.entries()].map(
    ([name, lines]) => `${name}(${lines.length})`,
  );

  const oracle = findMissedHeaders(
    cascade,
    SKILLS_ALIASES,
    SKILLS_ANCHORS,
    "skills",
  );
  const missedSkillsHeaders = oracle.missedHeaders;
  const skillsHeaderCandidateRejected = missedSkillsHeaders.length > 0;

  // ── Verdict and class are CO-EMITTED, in one branch chain. A new branch
  // cannot print a verdict without deciding a class (or explicitly `null`).
  // `skills-no-section` is withheld when the oracle could not run: the pair
  // {header-unrecognized, no-section} is then undecidable, and guessing it is
  // exactly the false-COVER the sweep exists to prevent (see headers.ts).
  let verdict: string;
  let defect: SkillsDefectClass | null;
  if (skills.length > 0) {
    verdict = `ok (${skills.length} skill entries parsed)`;
    defect = null;
  } else if (skillsRegionPresent) {
    verdict = `EXTRACTION-MISS (skills region routed with ${skillsRegion.length} lines but 0 skills parsed)`;
    defect = "skills-extraction-miss";
  } else if (skillsHeaderCandidateRejected) {
    verdict = `HEADER-UNRECOGNIZED (skills-like header rejected by the strict router → ${missedSkillsHeaders[0].reason})`;
    defect = "skills-header-unrecognized";
  } else {
    verdict =
      "NO-SKILLS-SECTION (no routed region and no skills-like header candidate)";
    defect = oracle.unavailable ? null : "skills-no-section";
  }

  const derived: Partial<DerivedSignals> = {
    skillsHeaderCandidateRejected,
    headerOracleUnavailable: oracle.unavailable,
  };

  return {
    skills,
    skillsRegion,
    skillsRegionPresent,
    sectionOverview,
    headerCandidates: oracle.headerCandidates,
    missedSkillsHeaders,
    orphanBlock: oracle.orphanBlock,
    headerOracleUnavailable: oracle.unavailable,
    verdict,
    defects: defect ? [defect] : [],
    derived,
  };
}
