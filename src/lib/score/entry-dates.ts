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
import {
  formatExperienceDateRange,
  type ExperienceDateFields,
} from "../edit/experience-dates.ts";

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
 * The date pair an education entry actually DRAWS, resolved from the four fields
 * it can carry (#882).
 *
 * `year` is a BACK-COMPAT MIRROR, not a fourth date: `parseEducationDates` sets
 * it to the end's year for a range, the lone date's year for a graduation date,
 * and — for an open-ended range — the START's year. So it is a fallback for the
 * END anchor and nothing else, and it has to refuse two shapes:
 *
 *   • a `year` the start already contains, or an ongoing "Sep 2022 – Present"
 *     entry whose mirror is "2022" draws "Sep 2022 – 2022";
 *   • a `year` beside a real `end_date`, which is the same value spelled worse.
 *
 * The hole this closes is that the old composition asked
 * `formatExperienceDateRange(...) || edu.year`, and that formatter returns the
 * START alone when there is no end — so the `||` short-circuited and `year` was
 * never consulted. An entry holding `start_date: "Sep 2020"` beside
 * `year: "2024"` exported and displayed as "Sep 2020": the graduation year
 * silently gone. It is reachable straight from the edit surface, whose education
 * card exposes `start_date` and `end_date` as separate cells over a parse that
 * may have produced only a `year`.
 */
export function educationDateAnchors(
  edu: ResumeEducation,
): ExperienceDateFields {
  const start = edu.start_date?.trim() || undefined;
  const explicitEnd = edu.end_date?.trim() || undefined;
  const year = edu.year?.trim() || undefined;
  const end =
    explicitEnd ?? (year && !(start && start.includes(year)) ? year : undefined);
  return {
    ...(start ? { start_date: start } : {}),
    ...(end ? { end_date: end } : {}),
    // An END DATE SAYS IT ENDED — the same rule `normalizeExperienceDates`
    // states for experience, applied here because education has no override
    // normaliser of its own. `parseEducationDates` never emits both (its
    // open-ended branch returns no `end_date`), so this only bites on the EDIT
    // path: a user who types a graduation date onto an in-progress entry would
    // otherwise watch `formatExperienceDateRange` let the flag win and draw
    // "Present" over the date they just typed.
    ...(edu.is_current && !explicitEnd ? { is_current: true } : {}),
  };
}

/**
 * The ONE date string an education entry renders — on the edit surface and in
 * the exported PDF alike (#882).
 *
 * Both surfaces call this, and that is the point: it used to be two formatters
 * that disagreed. This one joined with a TIGHT en dash ("2018–2022"), the
 * exporter's `formatExperienceDateRange` with a SPACED one ("2018 – 2022"), so
 * the same résumé showed one string on screen and drew a different one in the
 * file. The spaced form wins because it is the round-trip-tested shape: the
 * re-parser's `stripInstitutionDate` recognises and peels a spaced range off the
 * institution line, where the tight en-dash was left glued into `institution`
 * (#291).
 *
 * Falls back to the single `year` when no start/end was parsed (#97) and renders
 * "Present" for an ongoing entry, both via {@link educationDateFields}.
 */
export function buildEducationDates(edu: ResumeEducation): string {
  return formatExperienceDateRange(educationDateAnchors(edu));
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
 * emphasized the wrong run in the PDF and showed the wrong halves in the
 * JD-match view. The edit surface, the export projection, and the canonical model all read the
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

/**
 * Recompose a stored `type` + `title` into the one header string the source
 * wrote — the inverse of {@link splitAchievementType}, and the reason it lives
 * beside it: two call sites now need the composition (the PDF exporter's
 * credential title, and the certifications fold in `apply-overrides.ts` that
 * retires a legacy `type`), and a second spelling of the glue would be a second
 * definition of what a "Type · title" header IS.
 */
export function joinAchievementType(
  type: string | undefined,
  title: string | undefined,
): string {
  return [type?.trim(), title].filter(Boolean).join(" · ");
}
