// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { HeuristicAchievement } from "../../score/types.ts";
import type { PdfSection } from "../sections.ts";
import { parseEntryBlocks } from "../entry-blocks.ts";
import type { EntryBlock } from "../entry-blocks.ts";
import { YEAR_RE } from "../regex.ts";
import { firstMatch, avgScore } from "./shared.ts";
import { liftHeaderLabel } from "./projects.ts";

// ── Achievements ──────────────────────────────────────────────────────────────

/**
 * Extract an Achievements / Accomplishments / Awards / Activities section into
 * `HeuristicAchievement[]`.
 *
 * Thin caller of the shared `parseEntryBlocks` primitive — the SAME extractor
 * shape as `extractProjects`, deliberately not a third bespoke implementation
 * (#96). Achievement items are name-led and often single-line, so we anchor on
 * `"first_line"` (anchoring on a date would drop the common date-less award);
 * `collectBody: true` so any bullets under an item become its description and
 * pool with experience/project bullets in the scorer.
 *
 * Each block becomes one achievement: `headerLines[0]` is the item title (a URL
 * on the header is lifted into `url`), any date the header carried is reduced to
 * a single lead `year` (achievements show a year, not a range), and the bullet
 * body is the description.
 *
 * Honest-by-construction (#96, option (a)): we emit only what a regex parser can
 * truthfully assert — a title, an optional year/url, and a bullet body. We do
 * NOT guess an `AchievementType`; the structured `Achievement[]` is the LLM
 * path's job.
 */
export function extractAchievements(
  achievements: PdfSection | undefined,
): { value: HeuristicAchievement[]; confidence: number } {
  const blocks = parseEntryBlocks(achievements, {
    anchor: "first_line",
    collectBody: true,
  });
  if (blocks.length === 0) return { value: [], confidence: 0 };
  const built = blocks.map(achievementFromBlock);
  return {
    value: built.map((b) => b.entry),
    confidence: avgScore(built.map((b) => b.score)),
  };
}

/** Map one entry block to a `HeuristicAchievement` and its confidence score.
 *  Extracted from `extractAchievements` to keep each function below the
 *  complexity threshold; mirrors `projectFromBlock`. */
function achievementFromBlock(block: EntryBlock): {
  entry: HeuristicAchievement;
  score: number;
} {
  const { dates } = block;
  const { label: title, url } = liftHeaderLabel(block.headerLines);

  // Reduce any date range the header carried to a single lead year.
  const year = dates.start_date
    ? firstMatch(YEAR_RE, dates.start_date)
    : undefined;
  const description = block.body;

  // Score the entry: a title (0.5) and at least one bullet (0.5). Achievements
  // have no company/title axis and the year is optional, so they don't earn a
  // date weight — a named, bulleted item is a fully-formed entry.
  let score = 0;
  if (title) score += 0.5;
  if (block.bulletCount >= 1) score += 0.5;

  return {
    entry: {
      title,
      ...(year ? { year } : {}),
      ...(url ? { url } : {}),
      ...(description ? { description } : {}),
    },
    score: Math.min(score, 1),
  };
}
