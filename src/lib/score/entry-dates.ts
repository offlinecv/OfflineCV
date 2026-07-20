// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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

/** The separator an achievement header falls back to between its title and its
 *  year when the source used none of its own (whitespace only). */
export const DEFAULT_ACHIEVEMENT_YEAR_SEPARATOR = "·";

/** True when a separator glyph binds TIGHT to the word before it — a comma, a
 *  semicolon, a colon take no space in front ("Award, 2021"), where a dash or a
 *  pipe takes one on both sides ("Award – 2021"). The one place that rule is
 *  written down: the edit surface renders the separator as its own flex child
 *  and the exporter joins it into a string, and the two must not disagree about
 *  the spacing of the same résumé (#380). */
export function isTightYearSeparator(separator: string): boolean {
  return /^[,;:]$/.test(separator);
}

/** The exact string that joins an achievement's header text to its trailing year
 *  — the source's own separator ({@link isTightYearSeparator} decides its
 *  spacing), or the middot fallback. Used by the PDF exporter; the edit surface
 *  renders the same glyph with the same spacing. */
export function achievementYearJoiner(separator?: string): string {
  if (!separator) return ` ${DEFAULT_ACHIEVEMENT_YEAR_SEPARATOR} `;
  return isTightYearSeparator(separator) ? `${separator} ` : ` ${separator} `;
}

/** Longest a leading achievement segment can be and still read as a "type"
 *  label ("Patent", "Publication", "Exit", "Best Paper Award") rather than a
 *  full sentence — guards against emphasizing an entire prose title that merely
 *  happens to carry a " · ". */
export const ACHIEVEMENT_TYPE_MAX_LEN = 28;

/**
 * Split a raw achievement header into its leading "type" label + the rest, when
 * the header carries the canonical "Type · title" shape and the label is short
 * enough to read as a label (see {@link ACHIEVEMENT_TYPE_MAX_LEN}). Returns null
 * when there is no qualifying type segment (the whole header is prose).
 *
 * PARSE-TIME ONLY. This runs exactly once, in `extractAchievements`, and its
 * result is stored as `HeuristicAchievement.type` (#456). Nothing downstream may
 * re-derive the label by re-splitting a composed string: the split is lossy in
 * the direction that matters (a label over the length cap, or a title carrying
 * its own `" · "`, re-splits into a DIFFERENT pair), so a consumer that re-split
 * emphasized the wrong run in the PDF and showed the wrong halves on `/jd-fit`.
 * The edit surface, the export projection, and the canonical model all read the
 * stored field.
 */
export function splitAchievementType(
  title: string,
): { type: string; rest: string } | null {
  const idx = title.indexOf(" · ");
  if (idx < 0) return null;
  const type = title.slice(0, idx).trim();
  if (!type || type.length > ACHIEVEMENT_TYPE_MAX_LEN) return null;
  return { type, rest: title.slice(idx + 3) };
}
