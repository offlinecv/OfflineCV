// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { ResumeExperience } from "../../score/types.ts";
import type { PdfSection } from "../sections.ts";
import { parseEntryBlocks } from "../entry-blocks.ts";
import type { EntryBlock } from "../entry-blocks.ts";
import { finalizeEntries } from "./shared.ts";
import { disambiguateCompanyTitle } from "./experience-disambiguate.ts";

// ── Experience ──────────────────────────────────────────────────────────────

/**
 * Split the experience section into entry blocks and extract a
 * `ResumeExperience` row per block. The grouping heuristic:
 *
 *   - A line containing a date range anchors an entry header.
 *   - Non-bullet lines in the 0..2 lines ABOVE the anchor = company / title.
 *   - Bullet lines after the anchor, until the next anchor or section end,
 *     = the description.
 *
 * Fallback for a DATELESS section (#309): when the section carries no date
 * ranges at all, the `date_range` anchor finds nothing and yields zero blocks
 * (the "no date range ⇒ []" contract in `parseEntryBlocks`), collapsing the
 * whole section to zero roles. Re-run with the date-optional `"first_line"`
 * anchor so each `header + bullets` group becomes one dateless role.
 *
 * Confidence is per-entry, then averaged: we report the average of the
 * per-entry confidence as the section-level `experience` confidence.
 */
export function extractExperience(
  experience: PdfSection | undefined,
): { value: ResumeExperience[]; confidence: number } {
  // Split the section into dated entry blocks using the shared primitive, then
  // map each block's header lines into title/company/team and score it. The
  // windowing, date parsing, and bullet-body collection live in
  // `parseEntryBlocks`; this function owns only the experience-specific field
  // mapping (`disambiguateCompanyTitle`) and scoring.
  let blocks = parseEntryBlocks(experience, {
    anchor: "date_range",
    collectBody: true,
    headerLookback: 2,
  });
  // A dateless experience section yields zero `date_range` blocks. Fall back to
  // the `"first_line"` anchor so each header-run + bullet-group is recovered as
  // one dateless role instead of the whole section collapsing to nothing (#309).
  // A résumé with ANY dated role produced ≥1 block above and never reaches here,
  // so `date_range` stays the primary path and dated résumés cannot regress. The
  // date-only-phantom drop and the `title || company` non-empty filter below
  // apply to both paths uniformly.
  if (blocks.length === 0) {
    blocks = parseEntryBlocks(experience, {
      anchor: "first_line",
      collectBody: true,
    });
  }
  // Drop a date-only phantom — a block with neither title nor company (#145).
  // Experience has no single title axis, so we keep a role that has either.
  return finalizeEntries(
    blocks.map(experienceFromBlock),
    (e) => e.title !== "" || e.company !== "",
  );
}

/** Map one dated entry block to a `ResumeExperience` and its confidence score.
 *  Extracted from `extractExperience` to keep each function below the
 *  complexity threshold; mirrors `projectFromBlock` / `achievementFromBlock`. */
function experienceFromBlock(block: EntryBlock): {
  entry: ResumeExperience;
  score: number;
} {
  const { dates } = block;
  const { title, company, team, location } = disambiguateCompanyTitle(
    block.headerLines,
    block.anchorHeaderIndex,
  );
  const description = block.body;

  // Score the entry.
  let score = 0;
  if (dates.start_date) score += 0.25;
  if (dates.end_date || dates.is_current) score += 0.15;
  if (company) score += 0.25;
  if (title) score += 0.2;
  if (block.bulletCount >= 1) score += 0.15;

  return {
    entry: {
      title: title ?? "",
      company: company ?? "",
      ...(team ? { team } : {}),
      ...(location ? { location } : {}),
      ...(dates.start_date ? { start_date: dates.start_date } : {}),
      ...(dates.end_date ? { end_date: dates.end_date } : {}),
      ...(dates.is_current ? { is_current: true } : {}),
      description: description || undefined,
    },
    score: Math.min(score, 1),
  };
}
