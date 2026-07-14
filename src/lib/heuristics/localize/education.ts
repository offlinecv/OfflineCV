// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Education-section localization (issue #469 step 4) — extracted from
 * `probe-education.test.ts` so a shared sweep (`/probe-resume`, a later
 * step) can reuse the SAME detector instead of a copy-pasted seventh
 * implementation.
 *
 * PURE: takes an already-parsed `CascadeResult`, never re-parses, never does
 * I/O. This is a refactor of the probe's inline logic, not a behavior
 * change — `probe-education.test.ts` must print byte-identical output after
 * switching to call this.
 *
 * The markdown header oracle lives in `./headers.ts` (shared with
 * `./skills.ts`). Read ITS header for why `HeaderOracle.unavailable` — a
 * scanned or sparse PDF with no markdown at all — is not the same fact as "no
 * education-like header was rejected", and why `education-no-section` refuses to
 * fire while it is true.
 */

import type { CascadeResult } from "../types.ts";
import { SECTION_KEYWORDS, DEGREE_RE } from "../regex.ts";
import { SECTION_ANCHORS } from "../sections.config.ts";
import type { DefectClass, DerivedSignals } from "../defect-classes.ts";
import type { MissedHeader } from "./headers.ts";
import { findMissedHeaders, looseHeaderReason } from "./headers.ts";

const EDUCATION_ALIASES: readonly string[] = SECTION_KEYWORDS.education ?? [];
const EDUCATION_ANCHORS: ReadonlySet<string> =
  SECTION_ANCHORS.education ?? new Set<string>();

/**
 * Every `DefectClass` this localizer can emit — see `SKILLS_DEFECT_CLASSES` in
 * `./skills.ts` for why the tuple exists and what pins it to the table.
 */
export const EDUCATION_DEFECT_CLASSES = [
  "education-extraction-miss",
  "education-header-unrecognized",
  "education-no-section",
  "education-under-chunked",
] as const satisfies readonly DefectClass[];

type EducationDefectClass = (typeof EDUCATION_DEFECT_CLASSES)[number];

/**
 * Loose education-header oracle — the shared `looseHeaderReason` bound to the
 * education alias/anchor sets.
 */
export function looseEducationReason(raw: string): string | null {
  return looseHeaderReason(
    raw,
    EDUCATION_ALIASES,
    EDUCATION_ANCHORS,
    "education",
  );
}

/** Count `DEGREE_RE` matches in `text` via a fresh global clone. `DEGREE_RE`
 *  is non-global to keep `lastIndex` state out of the field heuristics, so
 *  cloning here is the safe way to count without mutating the shared
 *  instance. */
export function countDegrees(text: string): number {
  const flags = DEGREE_RE.flags.includes("g")
    ? DEGREE_RE.flags
    : `${DEGREE_RE.flags}g`;
  return (text.match(new RegExp(DEGREE_RE.source, flags)) ?? []).length;
}

export interface EducationEntry {
  institution: string | null;
  degree: string | null;
  field: string | null;
  location: string | null;
  start_date: string | null;
  end_date: string | null;
  year: string | null;
  coursework: number;
}

/** Alias kept for the probe harness's existing field name. */
export type MissedEducationHeader = MissedHeader;

export interface EducationLocalization {
  /** OUTPUT: the parsed education entries. */
  entries: EducationEntry[];
  /** Per-entry field-presence sanity check (not a wrong-value oracle). */
  perEntry: { i: number; missing: string[] }[];
  /** INPUT (routed): the education region the chunker scanned, if any. */
  educationRegion: string[];
  regionPresent: boolean;
  /** DEGREE_RE token count inside the routed region (lower-bound oracle). */
  regionDegrees: number;
  /** Section-detection overview (all regions, line counts only). */
  sectionOverview: string[];
  headerCandidates: { text: string; strict: string | null }[];
  missedEducationHeaders: MissedEducationHeader[];
  orphanBlock: string[];
  /** TRUE when there was no markdown to run the header oracle over (scanned or
   *  sparse PDF) — so `missedEducationHeaders` being empty proves NOTHING. */
  headerOracleUnavailable: boolean;
  verdict: string;
  defects: DefectClass[];
  derived: Partial<DerivedSignals>;
}

/**
 * Localize the education section: OUTPUT (parsed entries) vs INPUT (routed
 * region + header candidates the strict router rejected) vs a DEGREE_RE
 * lower-bound oracle for entry chunking.
 */
export function localizeEducation(
  cascade: CascadeResult,
): EducationLocalization {
  const p = cascade.canonical.fields;

  const entries: EducationEntry[] = (p.education ?? []).map((e) => ({
    institution: e.institution || null,
    degree: e.degree || null,
    field: e.field ?? null,
    location: e.location ?? null,
    start_date: e.start_date ?? null,
    end_date: e.end_date ?? null,
    year: e.year ?? null,
    coursework: e.coursework?.length ?? 0,
  }));

  const educationRegion = [
    ...(cascade.canonical.sections.byName.get("education") ?? []),
  ];
  const regionPresent = educationRegion.length > 0;

  const sectionOverview = [...cascade.canonical.sections.byName.entries()].map(
    ([name, lines]) => `${name}(${lines.length})`,
  );

  const oracle = findMissedHeaders(
    cascade,
    EDUCATION_ALIASES,
    EDUCATION_ANCHORS,
    "education",
  );
  const missedEducationHeaders = oracle.missedHeaders;
  const educationHeaderCandidateRejected = missedEducationHeaders.length > 0;

  const regionDegrees = countDegrees(educationRegion.join("\n"));
  const educationEntriesFewerThanDegreeTokens = regionDegrees > entries.length;

  const perEntry = entries.map((e, i) => {
    const missing: string[] = [];
    if (!e.institution) missing.push("institution");
    if (!e.degree) missing.push("degree");
    if (!e.start_date && !e.end_date) missing.push("date");
    return { i, missing };
  });

  // ── Verdict and class are CO-EMITTED, in one branch chain (see skills.ts).
  // `education-no-section` is withheld when the header oracle could not run.
  let verdict: string;
  let defect: EducationDefectClass | null;
  if (entries.length === 0 && regionPresent) {
    verdict = `EXTRACTION-MISS (education region routed with ${educationRegion.length} lines but 0 entries)`;
    defect = "education-extraction-miss";
  } else if (entries.length === 0 && educationHeaderCandidateRejected) {
    verdict = `HEADER-UNRECOGNIZED (education-like header rejected by the strict router → ${missedEducationHeaders[0].reason})`;
    defect = "education-header-unrecognized";
  } else if (entries.length === 0) {
    verdict =
      "NO-EDUCATION-SECTION (no routed region and no education-like header candidate)";
    defect = oracle.unavailable ? null : "education-no-section";
  } else if (educationEntriesFewerThanDegreeTokens) {
    verdict = `UNDER-CHUNKED (${entries.length} entries < ${regionDegrees} DEGREE_RE tokens in region — a degree line likely merged with a neighbour)`;
    defect = "education-under-chunked";
  } else {
    verdict = `ok (${entries.length} education entries parsed)`;
    defect = null;
  }

  const derived: Partial<DerivedSignals> = {
    educationHeaderCandidateRejected,
    educationEntriesFewerThanDegreeTokens,
    headerOracleUnavailable: oracle.unavailable,
  };

  return {
    entries,
    perEntry,
    educationRegion,
    regionPresent,
    regionDegrees,
    sectionOverview,
    headerCandidates: oracle.headerCandidates,
    missedEducationHeaders,
    orphanBlock: oracle.orphanBlock,
    headerOracleUnavailable: oracle.unavailable,
    verdict,
    defects: defect ? [defect] : [],
    derived,
  };
}
