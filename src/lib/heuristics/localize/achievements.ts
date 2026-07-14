// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Achievements-section localization (issue #469 step 4) — extracted from
 * `probe-achievements.test.ts` so a shared sweep (`/probe-resume`, a later
 * step) can reuse the SAME detector instead of a copy-pasted seventh
 * implementation.
 *
 * PURE: takes an already-parsed `CascadeResult`, never re-parses, never does
 * I/O. This is a refactor of the probe's inline logic, not a behavior
 * change — `probe-achievements.test.ts` must print byte-identical output
 * after switching to call this.
 */

import type { CascadeResult } from "../types.ts";
import type { DefectClass, DerivedSignals } from "../defect-classes.ts";

/**
 * Every `DefectClass` this localizer can emit — see `SKILLS_DEFECT_CLASSES` in
 * `./skills.ts` for why the tuple exists and what pins it to the table.
 */
export const ACHIEVEMENTS_DEFECT_CLASSES = [
  "achievements-parser-miss",
  "achievements-under-segmented",
  "achievements-no-section",
] as const satisfies readonly DefectClass[];

type AchievementsDefectClass =
  (typeof ACHIEVEMENTS_DEFECT_CLASSES)[number];

/** Bullet/numbered lead markers — a line carrying one is a BODY line, not a
 *  candidate entry header (mirrors group-bullets' LEADING_MARKER_RE). */
const BULLET_LINE_RE = /^[\s ]*(?:[-*•●–▪◦‣▶►·]|\d+[.)])\s/;

export interface AchievementEntry {
  type: string | null;
  description: string;
  /** Whether the header carried a LABEL — i.e. whether the export bolds just
   *  the type (true) or the whole header line (false). */
  typeIsLabel: boolean;
  year: string | null;
  url: string | null;
  bullets: number;
}

export interface AchievementsLocalization {
  /** OUTPUT: the parsed achievement entries. */
  entries: AchievementEntry[];
  /** INPUT: the achievements region the entry segmenter scanned. */
  regionLines: string[];
  /** Section-detection overview (all regions, line counts only). */
  sectionOverview: string[];
  achievementsPlacement: unknown;
  /** VERIFY: non-bullet lines in the region — a lower-bound oracle for entries. */
  headerLines: string[];
  verdict: string;
  defects: DefectClass[];
  derived: Partial<DerivedSignals>;
}

/**
 * Localize the achievements section: OUTPUT (parsed entries) vs INPUT (the
 * region scanned) vs a header-shaped-line lower-bound oracle for entry
 * segmentation.
 */
export function localizeAchievements(
  cascade: CascadeResult,
): AchievementsLocalization {
  const p = cascade.canonical.fields;

  const entries: AchievementEntry[] = (p.heuristic_achievements ?? []).map(
    (a) => {
      const type = a.type ?? null;
      return {
        type,
        description: a.title,
        typeIsLabel: type !== null,
        year: a.year ?? null,
        url: a.url ?? null,
        bullets: a.description
          ? a.description.split("\n").filter((l) => l.trim()).length
          : 0,
      };
    },
  );

  const regionLines = [
    ...(cascade.canonical.sections.byName.get("achievements") ?? []),
  ];

  const sectionOverview = [...cascade.canonical.sections.byName.entries()].map(
    ([name, lines]) => `${name}(${lines.length})`,
  );

  const headerLines = regionLines.filter((l) => !BULLET_LINE_RE.test(l));

  const achievementsParsedEmpty = entries.length === 0;
  const achievementsEntriesFewerThanHeaderLines =
    entries.length < headerLines.length;

  // Verdict and class are CO-EMITTED, in one branch chain (see skills.ts).
  // `achievements-no-section` is ADVISORY, not a defect — see `DefectSpec.advisory`.
  let verdict: string;
  let defect: AchievementsDefectClass | null;
  if (achievementsParsedEmpty && regionLines.length > 0) {
    verdict = `PARSER-MISS (0 entries; the achievements region has ${regionLines.length} lines)`;
    defect = "achievements-parser-miss";
  } else if (achievementsEntriesFewerThanHeaderLines) {
    verdict = `UNDER-SEGMENTED (${entries.length} entries < ${headerLines.length} header-shaped lines — an achievement likely merged into a neighbor)`;
    // Unreachable with 0 entries: header lines are a subset of region lines, so
    // `0 < headerLines` implies a non-empty region, which PARSER-MISS claimed.
    defect = "achievements-under-segmented";
  } else if (achievementsParsedEmpty && regionLines.length === 0) {
    verdict =
      "no achievements region segmented (the résumé may carry none — check `Sections detected` for a mis-routed block)";
    defect = "achievements-no-section";
  } else {
    verdict = "ok";
    defect = null;
  }

  const derived: Partial<DerivedSignals> = {
    achievementsParsedEmpty,
    achievementsEntriesFewerThanHeaderLines,
  };

  const defects: DefectClass[] = defect ? [defect] : [];

  return {
    entries,
    regionLines,
    sectionOverview,
    achievementsPlacement: p.achievements_placement ?? null,
    headerLines,
    verdict,
    defects,
    derived,
  };
}
