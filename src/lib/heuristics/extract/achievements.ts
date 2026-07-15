// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { HeuristicAchievement } from "../../score/types.ts";
import type { PdfLine, PdfSection } from "../sections.ts";
import { parseEntryBlocks } from "../entry-blocks.ts";
import type { EntryBlock } from "../entry-blocks.ts";
import { YEAR_RE } from "../regex.ts";
import { splitAchievementType } from "../../score/entry-dates.ts";
import {
  dateSeparator,
  isBulletLine,
  isPageFurniture,
  parseDateRange,
  stripDateRange,
} from "../line-primitives.ts";
import { firstMatch, finalizeEntries } from "./shared.ts";
import { liftHeaderLabel } from "./projects.ts";

// ── Achievements ──────────────────────────────────────────────────────────────

// Page running-header/footer furniture detection (`isPageFurniture`) lives in
// `line-primitives.ts` (#283) so the achievements path and the entry-block
// parser share one copy — see that module for the regex rationale.

/**
 * Extract an Achievements / Accomplishments / Awards / Activities section into
 * `HeuristicAchievement[]`.
 *
 * Two shapes share this extractor:
 *
 *   1. Entry-with-body — an award header line followed by a bullet body
 *      ("Best Paper Award 2021" / "• Cited 100+ times"). Routed through the
 *      shared `parseEntryBlocks` primitive (anchor `"first_line"`,
 *      `collectBody: true`) so the header groups its bullets into one entry,
 *      exactly as projects do (#96).
 *
 *   2. Flat award list — every item is its own one-line award with NO bullet
 *      body, the common Honors/Awards shape. When such a list is grouped under
 *      sub-headings ("International Awards" / "Domestic Awards") AND split by a
 *      page break, `parseEntryBlocks` collapses every line into a SINGLE entry:
 *      the `first_line` anchor treats consecutive non-bullet lines as one
 *      multi-line header, so only the first line anchors and the rest are
 *      dropped or mashed into one description blob — page footer included
 *      (#225). To keep every award, a section with no bullet lines is parsed
 *      one-entry-per-line instead (see `parseFlatAwardList`).
 *
 * Page running-header/footer furniture (a repeated name + "Résumé"/"CV" line a
 * continuation page carries) is stripped first, so it never becomes a title or
 * leaks into an award's description.
 *
 * Honest-by-construction (#96): we emit only what a regex parser can truthfully
 * assert — a title, an optional verbatim type label, year/url, and a bullet
 * body. The label is lifted off the header, never invented, and stays free text:
 * we do NOT guess the closed `AchievementType` enum; the structured
 * `Achievement[]` is the LLM path's job.
 */
export function extractAchievements(
  achievements: PdfSection | undefined,
): { value: HeuristicAchievement[]; confidence: number } {
  if (!achievements || achievements.lines.length === 0) {
    return { value: [], confidence: 0 };
  }

  // Strip page running-header/footer furniture (#225) before any parsing — it
  // is neither an award nor part of one, on either path below.
  const lines = achievements.lines.filter((l) => !isPageFurniture(l));
  if (lines.length === 0) return { value: [], confidence: 0 };

  // A flat award list (no bullet lines anywhere) is parsed one-entry-per-line so
  // a multi-subheading, page-split Honors section keeps every award (#225). A
  // section that DOES carry bullets routes through the shared entry-block parser
  // so a header line still groups its bullet body into one entry.
  const blocks = lines.some(isBulletLine)
    ? parseEntryBlocks({ ...achievements, lines }, {
        anchor: "first_line",
        collectBody: true,
      })
    : parseFlatAwardList(lines);

  // Drop any date-only / title-less block (#145) before scoring.
  return finalizeEntries(
    blocks.map(achievementFromBlock),
    (e) => e.title !== "",
  );
}

/**
 * A line that CONTINUES the award above it rather than opening a new one. An
 * award item leads with a proper noun or a date — a capital letter or a digit
 * ("2021 2nd Place, …", "Finalist, DEFCON 28 …", "Dean's List"). A line that
 * leads with anything else is a wrapped tail of the previous award: a
 * lowercase-led sentence fragment ("learning to plan paths …"), a bracketed
 * citation marker ("[2] T. Stone …"), or a bare superscript ordinal the PDF
 * split onto its own line ("st", "nd", "rd", "th"). Folding these back keeps a
 * two-column LaTeX export's wrapped award from fragmenting into noise entries
 * (#225), while every clean single-line award in a flat list still opens its
 * own entry.
 */
function isAwardContinuation(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  if (/^(?:st|nd|rd|th)$/i.test(t)) return true; // stray superscript ordinal
  // Opens a new award when it leads with a letter in ANY script (`Lu`/`Lt`
  // upper-/title-case, `Lo` for caseless scripts like CJK) or a digit; anything
  // else — a lowercase wrapped tail, a "[2]" citation marker, bare punctuation —
  // is a continuation. ASCII-only `^[A-Z0-9]` wrongly folded an accented
  // proper-noun award ("École …", "Üniversitäts-Preis") into the line above.
  return !/^[\p{Lu}\p{Lt}\p{Lo}\p{N}]/u.test(t);
}

/**
 * Parse a bullet-less flat award list into one `EntryBlock` per award. Each
 * award-leading line ("2021 2nd Place, AWS …") opens a block; a following
 * continuation line (see {@link isAwardContinuation}) folds into the block's
 * header rather than opening a new one, so a wrapped award stays one entry. The
 * date is parsed off and stripped from the title by the shared
 * `achievementFromBlock` mapping, exactly as the entry-block path does. A line
 * that reduces to nothing but a date is emitted as a title-less block and
 * dropped downstream by `finalizeEntries` (#145), preserving the date-only-drop
 * contract.
 */
function parseFlatAwardList(lines: PdfLine[]): EntryBlock[] {
  const blocks: EntryBlock[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (blocks.length > 0 && isAwardContinuation(text)) {
      const prev = blocks[blocks.length - 1];
      prev.headerLines[0] = `${prev.headerLines[0]} ${text}`.trim();
    } else {
      blocks.push({ headerLines: [text], dates: {}, bulletCount: 0 });
    }
  }
  return blocks;
}

/** Map one entry block to a `HeuristicAchievement` and its confidence score.
 *  Extracted from `extractAchievements` to keep each function below the
 *  complexity threshold; mirrors `projectFromBlock`. */
function achievementFromBlock(block: EntryBlock): {
  entry: HeuristicAchievement;
  score: number;
} {
  // A flat-list block carries its date inside the header line (it was never run
  // through the entry-block date-anchor pass), so parse it off here. The
  // entry-block path already stripped the date onto `block.dates`, leaving the
  // header clean — so re-parsing it is a harmless no-op there.
  const headerText = block.headerLines[0] ?? "";
  const dates = block.dates.start_date ? block.dates : parseDateRange(headerText);
  const cleanedHeader = block.dates.start_date
    ? block.headerLines
    : [stripDateRange(headerText), ...block.headerLines.slice(1)];
  // Same fork as the dates: the entry-block path already stripped the date (and
  // with it the punctuation that set it off), so it carries the separator on the
  // block; the flat-list path still has the raw header, so read it off that.
  const separator = block.dates.start_date
    ? block.dateSeparator
    : dateSeparator(headerText);
  const { label, url } = liftHeaderLabel(cleanedHeader);

  // Lift the leading "Patent · …" type label off the header into its own field
  // — the ONE place that split happens (#456). Storing it here is what lets the
  // edit surface and the PDF exporter agree on the emphasized run without
  // re-splitting a composed string (which is not a round-trip).
  const split = splitAchievementType(label);
  const type = split?.type;
  const title = split ? split.rest : label;

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
      ...(type ? { type } : {}),
      title,
      ...(year ? { year } : {}),
      ...(year && separator ? { year_separator: separator } : {}),
      ...(url ? { url } : {}),
      ...(description ? { description } : {}),
    },
    score: Math.min(score, 1),
  };
}
