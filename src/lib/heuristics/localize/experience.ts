// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Experience-section localization (issue #469 step 4) — extracted from
 * `probe-experience.test.ts` so a shared sweep (`/probe-resume`, a later
 * step) can reuse the SAME detector instead of a copy-pasted seventh
 * implementation.
 *
 * PURE: takes an already-parsed `CascadeResult`, never re-parses, never does
 * I/O. This is a refactor of the probe's inline logic, not a behavior
 * change — `probe-experience.test.ts` must print byte-identical output after
 * switching to call this.
 */

import type { CascadeResult } from "../types.ts";
import { DATE_RANGE_RE } from "../regex.ts";
import type { DefectClass, DerivedSignals } from "../defect-classes.ts";

/**
 * Every `DefectClass` this localizer can emit — see `SKILLS_DEFECT_CLASSES` in
 * `./skills.ts` for why the tuple exists and what pins it to the table.
 */
export const EXPERIENCE_DEFECT_CLASSES = [
  "experience-parser-miss",
  "experience-under-segmented",
] as const satisfies readonly DefectClass[];

type ExperienceDefectClass = (typeof EXPERIENCE_DEFECT_CLASSES)[number];

export interface ExperienceEntry {
  title: string | null;
  company: string | null;
  location: string | null;
  start_date: string | null;
  end_date: string | null;
  bullets: number;
}

export interface ExperienceLocalization {
  /** OUTPUT: the parsed role entries. */
  entries: ExperienceEntry[];
  /** INPUT: the experience region the entry segmenter scanned. */
  regionLines: string[];
  /** Section-detection overview (all regions, line counts only). */
  sectionOverview: string[];
  /** VERIFY: date-range lines inside the region (lower-bound oracle). */
  dateRangeLines: string[];
  verdict: string;
  defects: DefectClass[];
  derived: Partial<DerivedSignals>;
}

/**
 * Localize the experience section: OUTPUT (parsed role entries) vs INPUT (the
 * region scanned) vs an independent date-range re-scan that is a lower-bound
 * oracle for how many roles should have segmented.
 */
export function localizeExperience(
  cascade: CascadeResult,
): ExperienceLocalization {
  const p = cascade.canonical.fields;

  const entries: ExperienceEntry[] = (p.experience ?? []).map((e) => ({
    title: e.title || null,
    company: e.company || null,
    location: e.location ?? null,
    start_date: e.start_date ?? null,
    end_date: e.end_date ?? (e.is_current ? "Present" : null),
    bullets: e.description
      ? e.description.split("\n").filter((l) => l.trim()).length
      : 0,
  }));

  const regionLines = [
    ...(cascade.canonical.sections.byName.get("experience") ?? []),
  ];

  const sectionOverview = [...cascade.canonical.sections.byName.entries()].map(
    ([name, lines]) => `${name}(${lines.length})`,
  );

  const dateRangeLines = regionLines.filter((l) => DATE_RANGE_RE.test(l));

  const experienceRegionHasDateRangeLines = dateRangeLines.length > 0;
  const experienceEntriesFewerThanDateRangeLines =
    entries.length < dateRangeLines.length;

  // Verdict and class are CO-EMITTED, in one branch chain (see skills.ts).
  let verdict: string;
  let defect: ExperienceDefectClass | null;
  if (entries.length === 0 && experienceRegionHasDateRangeLines) {
    verdict = `PARSER-MISS (0 entries; region has ${dateRangeLines.length} date-range lines)`;
    defect = "experience-parser-miss";
  } else if (experienceEntriesFewerThanDateRangeLines) {
    verdict = `UNDER-SEGMENTED (${entries.length} entries < ${dateRangeLines.length} date-range lines — a role likely merged into a neighbor)`;
    // Unreachable with 0 entries: that case is claimed by PARSER-MISS above
    // (0 entries and `entries < dateRangeLines` implies date-range lines exist).
    defect = "experience-under-segmented";
  } else {
    verdict = "ok";
    defect = null;
  }

  const derived: Partial<DerivedSignals> = {
    experienceRegionHasDateRangeLines,
    experienceEntriesFewerThanDateRangeLines,
  };

  return {
    entries,
    regionLines,
    sectionOverview,
    dateRangeLines,
    verdict,
    defects: defect ? [defect] : [],
    derived,
  };
}
