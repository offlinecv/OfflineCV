// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { ResumeExperience } from "../../score/types.ts";
import type { PdfSection } from "../sections.ts";
import { parseEntryBlocks } from "../entry-blocks.ts";
import type { EntryBlock } from "../entry-blocks.ts";
import { finalizeEntries, looksLikeCompany } from "./shared.ts";
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
  // Map each block, then carry a shared-employer banner down to the roles that
  // sit under it (#382) before dropping phantoms and packaging.
  const built = blocks.map(experienceFromBlock);
  propagateSharedEmployer(blocks, built);
  // Drop a date-only phantom — a block with neither title nor company (#145).
  // Experience has no single title axis, so we keep a role that has either.
  return finalizeEntries(built, (e) => e.title !== "" || e.company !== "");
}

/**
 * The employer this block names as a BANNER above its dated role line, if any —
 * i.e. the value a following contiguous run of banner-less roles should inherit
 * as their `company` (#382).
 *
 * A banner sits on a dateless header line ABOVE the date anchor, so the company
 * must have been mapped from an above-anchor header line (not the anchor/title
 * line). We recognize that by the resolved `company` matching an above-anchor
 * header line — either verbatim, or as its lead once a trailing location was
 * stripped off ("Globex Inc, Austin, TX" → company "Globex Inc"). A company that
 * came from the anchor line itself (the "Title \n Company Dates" shape, where the
 * anchor line is the employer) is NOT a banner: it carries its own date and heads
 * no run.
 */
function bannerEmployer(
  block: EntryBlock,
  entry: ResumeExperience,
): string | undefined {
  const anchorIdx = block.anchorHeaderIndex;
  if (anchorIdx === undefined || anchorIdx <= 0) return undefined;
  const { company } = entry;
  if (!company) return undefined;
  const aboveTexts = block.headerLines.slice(0, anchorIdx);
  return aboveTexts.some((t) => t === company || t.startsWith(company))
    ? company
    : undefined;
}

/**
 * True when the role is a bare `Title, Team` continuation with NO employer of its
 * own — so, under an active banner, its `company` should be inherited (#382).
 *
 * The `team` requirement is load-bearing, not decorative: it pins the predicate
 * to the exact shape #382 targets — a role whose header comma-split put the role
 * in `title` and an internal team/sub-org in `team`, leaving `company` with no
 * real employer (it collapses onto the title, or stays empty). A plain
 * "Title"-only role (no post-comma team) is deliberately EXCLUDED: such a role
 * may sit under its OWN employer line that the segmenter dropped or failed to
 * recognize (a bare, suffix-less "Freelance" banner), so inheriting a previous
 * group's employer would mis-attribute it. Requiring the team keeps the
 * propagation to the comma shape the issue scopes to.
 *
 * A role whose header carries a genuine employer signal — a company-suffixed /
 * institution name mapped to `company` — returns false and BREAKS the run,
 * mirroring the observed real-résumé case where the final role, whose header
 * bore its own distinct employer, kept its own company.
 */
function isBannerContinuation(entry: ResumeExperience): boolean {
  if (!entry.title || !entry.team) return false;
  return (
    entry.company === "" ||
    entry.company === entry.title ||
    !looksLikeCompany(entry.company)
  );
}

/**
 * Shared-employer-banner propagation (#382).
 *
 * When one employer is named once as a BANNER above a contiguous run of roles —
 * each role's own header being a bare `Title, Team` line with no employer of its
 * own — only the FIRST role's block captures the banner (as the
 * dateless line above its dated header, which `disambiguateCompanyTitle` maps to
 * `company`). Roles 2..N sit below, their headers reduced to the `Title, Team`
 * anchor line alone, so they resolve to no real employer. This pass carries the
 * banner employer down to each such continuation role, leaving its `title` /
 * `team` (already correct from the per-block map) intact.
 *
 * A role that names its own employer ends the run: a fresh banner above its
 * anchor RE-OPENS a run (its own company is already that banner), and a
 * company-suffixed employer on its own header line CLOSES the run.
 */
function propagateSharedEmployer(
  blocks: EntryBlock[],
  built: { entry: ResumeExperience; score: number }[],
): void {
  let banner: string | undefined;
  for (let i = 0; i < blocks.length; i++) {
    const { entry } = built[i];
    const own = bannerEmployer(blocks[i], entry);
    if (own) {
      // This role names the employer as a banner above its dated header: it
      // opens (or re-opens) a run. Its own company is already the banner.
      banner = own;
      continue;
    }
    if (banner && isBannerContinuation(entry)) {
      // A bare "Title, Team" continuation: inherit the shared employer, keeping
      // the per-block `title` / `team` intact. The prior `company` was a title
      // duplicate (already truthy), so the entry's confidence score is unchanged.
      built[i].entry = { ...entry, company: banner };
      continue;
    }
    // No active banner, or a role that states its own employer — end the run.
    banner = undefined;
  }
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
