// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Display-string formatters for the dates on reconstructed résumé entries.
 *
 * These live in `lib/` (not the component) so the date-collapsing logic is
 * unit-tested directly and kept out of the render path — the reconstructed
 * view just calls them. Both return "" when there is nothing to show, so the
 * caller can render the separator conditionally.
 */

import type { ResumeProject, ResumeEducation } from "./types.ts";

/** Compact "start–end" / "start–Present" / "start" date string for a project. */
export function buildProjectDates(project: ResumeProject): string {
  const { start_date, end_date, is_current } = project;
  if (start_date && (end_date || is_current)) {
    return `${start_date}–${is_current ? "Present" : end_date}`;
  }
  if (start_date) return start_date;
  if (is_current) return "Present";
  if (end_date) return end_date;
  return "";
}

/**
 * Compact "start–end" / "end" date string for an education entry, falling back
 * to the single `year` when no start/end was parsed (#97).
 */
export function buildEducationDates(edu: ResumeEducation): string {
  const { start_date, end_date } = edu;
  if (start_date && end_date) return `${start_date}–${end_date}`;
  if (end_date) return end_date;
  if (start_date) return start_date;
  return edu.year ?? "";
}
