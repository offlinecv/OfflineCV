// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * education-display — folding an education entry's field overrides into the
 * values the reconstructed résumé renders.
 *
 * Pure and UI-free by design: the resolution / clearing / date branches are the
 * risk-bearing part of the education edit surface, so they live in `lib/edit/`
 * beside the other override folds (`apply-overrides`, `experience-dates`) and
 * are unit tested directly, leaving `ReconstructedEducationEntry` render-only.
 */

import type { ResumeEducation } from "../score/types.ts";
import type { EducationFieldOverrides } from "../../hooks/useEditableParse.ts";
import { buildEducationDates } from "../score/entry-dates.ts";

/** Resolve a field's display value, applying the override ("" = cleared). */
export function resolveEduValue(
  parsed: string | undefined,
  override: string | undefined,
): string | undefined {
  if (override === undefined) return parsed || undefined;
  return override || undefined; // "" clears
}

/** The resolved education fields an entry renders, after applying overrides. */
export interface EducationDisplay {
  degree: string | undefined;
  /** Subject of study ("Computer Science & Engineering"); for a degree-less
   *  program (#238) this holds the program title and degree is absent. */
  field: string | undefined;
  institution: string | undefined;
  startDate: string | undefined;
  endDate: string | undefined;
  /** Compact display string (e.g. "2018 – 2022"), reflecting date edits. */
  dates: string;
  /** Grade as the résumé wrote it, scale included (#883) — never a number. */
  gpa: string | undefined;
  honors: string | undefined;
  coursework: string[];
}

/**
 * Fold an education entry's overrides into the display values. Pure (no JSX) so
 * the resolution/clearing/date branches are unit-tested directly — this is the
 * risk-bearing logic; the component is then render-only.
 */
export function resolveEducationDisplay(
  edu: ResumeEducation,
  overrides: EducationFieldOverrides | undefined,
): EducationDisplay {
  // Dates: the override fields feed buildEducationDates so the compact display
  // string reflects edits; the read-only display still falls back to `year`.
  const startDate = resolveEduValue(edu.start_date, overrides?.start_date);
  const endDate = resolveEduValue(edu.end_date, overrides?.end_date);
  return {
    degree: resolveEduValue(edu.degree, overrides?.degree),
    field: resolveEduValue(edu.field, overrides?.field),
    institution: resolveEduValue(edu.institution, overrides?.institution),
    startDate,
    endDate,
    dates: buildEducationDates({ ...edu, start_date: startDate, end_date: endDate }),
    gpa: resolveEduValue(edu.gpa, overrides?.gpa),
    honors: resolveEduValue(edu.honors, overrides?.honors),
    coursework: edu.coursework ?? [],
  };
}
