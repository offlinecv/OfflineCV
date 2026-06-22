// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Shared "dated entry block" primitive for entry-style resume sections.
 *
 * Experience, projects, achievements, and education are structurally the same
 * shape: a section is a run of entry blocks, where each block is a header
 * (one or more non-bullet lines, optionally carrying a date / date-range)
 * followed by an optional bullet body. Before this primitive, only
 * `extractExperience` knew how to split a section into such blocks; every
 * other section was bespoke or missing. `parseEntryBlocks` factors that
 * machinery out so a new section becomes a small `EntryBlockConfig`, not a
 * fresh parser.
 *
 * The primitive is deliberately field-agnostic: it returns `EntryBlock`s with
 * the raw header lines, the parsed date range, and the collected body — but it
 * does NOT decide which header line is a title vs a company vs an institution.
 * That mapping is the caller's job (e.g. `disambiguateCompanyTitle` for
 * experience), because it varies by section. The shared parts — anchor
 * detection, entry windowing, date parsing, bullet-body collection — live here
 * and only here.
 *
 * Reuses `parseDateRange` / `stripDateRange` / `isBulletLine` / `stripBullet`
 * from `extract-fields.ts` rather than re-implementing them, so all sections
 * agree on what a date range, a bullet, and a header line are.
 */

import type { PdfLine, PdfSection } from "./sections.ts";
import { DATE_RANGE_RE, PRESENT_RE, INSTITUTION_HINTS } from "./regex.ts";
import {
  parseDateRange,
  stripDateRange,
  isBulletLine,
  stripBullet,
} from "./line-primitives.ts";

/**
 * How a section's entry blocks are anchored — i.e. what marks the start of a
 * new entry.
 *
 *   - `"date_range"`  — a line containing a date range (or a bare "Present").
 *     The classic experience shape: each role's header carries its dates.
 *   - `"institution"` — a line containing an institution hint
 *     (University / College / Institute / ...). For education, where the
 *     school name is the reliable anchor and the date may be absent or
 *     loosely formatted. The date is still parsed off the block when present.
 *   - `"first_line"`  — the first non-bullet line after a bullet body starts a
 *     new entry. For projects, where a project name leads each block and a
 *     date is optional. Anchoring on the date would drop date-less projects
 *     entirely.
 *
 * Only `"date_range"` is exercised today (by `extractExperience`); the other
 * two are defined so the projects / achievements / education child issues can
 * plug in a config without touching this file's anchor logic. Their detailed
 * behavior is finalized when those issues land.
 */
export type EntryAnchor = "date_range" | "institution" | "first_line";

export interface EntryBlockConfig {
  /** What marks the start of a new entry block in this section. */
  anchor: EntryAnchor;
  /**
   * When true, bullet lines following the header are collected into
   * `EntryBlock.body` (joined with "\n"). When false, bullets are ignored —
   * for sections whose entries are header-only (no description). Defaults to
   * true at the call sites that need a body; experience sets it true.
   */
  collectBody: boolean;
  /**
   * How many non-bullet lines ABOVE a `"date_range"` anchor may belong to the
   * entry header (the "Title\nCompany <dates>" style). Ignored for the other
   * anchors, where the header is the anchor line itself plus the lines below
   * it. Experience uses 2.
   */
  headerLookback?: number;
}

/**
 * One parsed entry block — the section-agnostic intermediate the caller maps
 * into its own field shape.
 */
export interface EntryBlock {
  /**
   * The header text lines for this entry, in document order, already trimmed
   * and emptied of date tokens on the anchor line. The caller decides which
   * line is title / company / institution / project name.
   */
  headerLines: string[];
  /** Parsed start/end/is_current off the anchor line (empty object if none). */
  dates: ReturnType<typeof parseDateRange>;
  /**
   * Bullet body collected for this entry, joined with "\n", or undefined when
   * there were no bullets or `collectBody` was false.
   */
  body?: string;
  /** Number of bullet lines that fed `body` (0 when none / not collected). */
  bulletCount: number;
}

/** True if the line is an anchor for the given config. */
function isAnchorLine(line: PdfLine, anchor: EntryAnchor): boolean {
  switch (anchor) {
    case "date_range": {
      const hit = DATE_RANGE_RE.test(line.text) || PRESENT_RE.test(line.text);
      // DATE_RANGE_RE is non-global, but `.test` still advances lastIndex on
      // some engines; reset so repeated calls are idempotent. Mirrors the
      // reset extractExperience did inline.
      DATE_RANGE_RE.lastIndex = 0;
      return hit;
    }
    case "institution":
      return INSTITUTION_HINTS.test(line.text);
    case "first_line":
      // A non-bullet line is a potential entry header. The split logic in
      // `collectAnchors` only promotes the FIRST non-bullet line of each
      // header run to an anchor, so consecutive header lines don't each open
      // a new entry.
      return !isBulletLine(line);
  }
}

/**
 * Indices of the lines that start a new entry block, in document order.
 *
 * For `"date_range"` / `"institution"` this is simply every line that matches
 * the anchor predicate. For `"first_line"` it is the first non-bullet line of
 * each header run (a non-bullet line whose predecessor is a bullet, or the
 * first line of the section) — so a multi-line project header opens exactly
 * one entry, not one per line.
 */
function collectAnchors(lines: PdfLine[], anchor: EntryAnchor): number[] {
  const anchors: number[] = [];
  // Reference indent for the `first_line` anchor: the x of the bullet markers.
  // Entry headers sit at (or left of) this margin, but when a long bullet wraps
  // onto a second, marker-less line that continuation aligns with the bullet
  // *text* — i.e. to the RIGHT of the marker. That x relationship (not an
  // absolute point tolerance, which fails on tightly-indented layouts) is what
  // separates a wrapped continuation from a real new header. Only the
  // `first_line` anchor needs it, so the others skip the scan (Infinity).
  const markerX = anchor === "first_line" ? bulletMarkerX(lines) : Infinity;
  for (let i = 0; i < lines.length; i++) {
    if (!isAnchorLine(lines[i], anchor)) continue;
    if (anchor === "first_line" && i > 0) {
      // Indented past the bullet marker → a wrapped bullet line, not a header.
      if (lines[i].x > markerX) continue;
      // Directly below another header-level (marker-or-left) non-bullet line →
      // the 2nd line of a multi-line header ("Title" / "Company"), not a new
      // entry. (A header that follows a wrapped bullet or a bullet still opens
      // one, so real headers after a wrap aren't lost.)
      const prev = lines[i - 1];
      if (!isBulletLine(prev) && prev.x <= markerX) continue;
    }
    anchors.push(i);
  }
  return anchors;
}

/** Leftmost x of any bullet line in the section — the bullet *marker* margin.
 *  `Infinity` when the section has no bullets. */
function bulletMarkerX(lines: PdfLine[]): number {
  let x = Infinity;
  for (const l of lines) if (isBulletLine(l)) x = Math.min(x, l.x);
  return x;
}

/**
 * True when a non-bullet line is the marker-less continuation of a wrapped
 * bullet — it sits indented to the right of the bullet *marker* margin (where
 * bullet TEXT wraps), whereas a real entry header sits at or left of that
 * margin. This is the structural signal (also used by `collectAnchors`) that
 * keeps a wrapped bullet's tail ("…and informing / them of resources") from
 * contaminating the next entry's company / designation. A no-op when the
 * section has no bullets (markerX = Infinity) or carries no x positions
 * (markdown, all x = 0).
 */
function isWrappedContinuation(line: PdfLine, markerX: number): boolean {
  return Number.isFinite(markerX) && line.x > markerX + 2;
}

/**
 * Split a section into entry blocks per `cfg`. Returns an empty array for an
 * absent/empty section or one with no anchors.
 *
 * The windowing is the exact logic `extractExperience` used: for each anchor,
 * the entry spans from just after the previous anchor to just before the next.
 * Header lines are the (lookback) non-bullet lines above the anchor, the anchor
 * line itself with its dates stripped, and the consecutive non-bullet lines
 * below it; the body is the bullet lines after that header run.
 */
export function parseEntryBlocks(
  section: PdfSection | undefined,
  cfg: EntryBlockConfig,
): EntryBlock[] {
  if (!section || section.lines.length === 0) return [];

  const lines = section.lines;
  const anchors = collectAnchors(lines, cfg.anchor);
  if (anchors.length === 0) {
    // A `first_line` section with no anchorable header line is a flat bullet
    // list (an awards / achievements list where every item is itself a bullet,
    // so there is no name-led header for `collectAnchors` to latch onto). Rather
    // than drop the whole section, fall back to anchoring on the bullets. The
    // other anchors have no such list shape, so they keep returning [].
    return cfg.anchor === "first_line" ? parseBulletList(lines, cfg) : [];
  }

  const lookback = cfg.headerLookback ?? 0;
  return anchors.map((_, a) => buildEntryBlock(lines, anchors, a, cfg, lookback));
}

/**
 * Fallback parser for a `first_line` section that is a flat bullet list — every
 * entry is itself a bullet ("• Award name, 2023"), so `collectAnchors` found no
 * non-bullet header line and returned zero anchors. Each TOP-LEVEL bullet (one
 * sitting at the bullet-marker margin) becomes its own entry; any marker-less
 * lines below it (a year on its own line, a wrapped award name) fold into that
 * entry's title, and deeper-indented sub-bullets become its body.
 *
 * This assumes upstream column banding (`detectColumnBoundaries` in
 * `pdf-extract.ts`) has already separated a two-column layout into single-column
 * sections, so the lines here are one column's list — not two bullet margins
 * interleaved. That banding is what makes a single per-section bullet margin a
 * valid assumption (see #131).
 */
function parseBulletList(lines: PdfLine[], cfg: EntryBlockConfig): EntryBlock[] {
  const markerX = bulletMarkerX(lines);
  if (!Number.isFinite(markerX)) return [];
  const anchors: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Top-level bullets only: a deeper-indented bullet is a sub-item of the
    // entry above it, not a new entry.
    if (isBulletLine(lines[i]) && lines[i].x <= markerX + 2) anchors.push(i);
  }
  if (anchors.length === 0) return [];
  return anchors.map((_, a) => buildBulletEntry(lines, anchors, a, cfg));
}

/**
 * Build the single bullet-list `EntryBlock` anchored at `anchors[a]`. The entry
 * spans to just before the next top-level bullet: the anchor bullet's text plus
 * any marker-less continuation lines below it form the title (date stripped off,
 * parsed onto `dates`); deeper sub-bullets form the body. Extracted from
 * `parseBulletList` to keep each function below the cognitive-complexity bar.
 */
function buildBulletEntry(
  lines: PdfLine[],
  anchors: number[],
  a: number,
  cfg: EntryBlockConfig,
): EntryBlock {
  const anchorIdx = anchors[a];
  const nextIdx = a + 1 < anchors.length ? anchors[a + 1] : lines.length;

  const titleParts = [stripBullet(lines[anchorIdx].text)];
  const bodyBullets: PdfLine[] = [];
  for (let i = anchorIdx + 1; i < nextIdx; i++) {
    if (isBulletLine(lines[i])) bodyBullets.push(lines[i]);
    else titleParts.push(lines[i].text.trim());
  }

  const combined = titleParts.join(" ").replace(/\s+/g, " ").trim();
  const dates = parseDateRange(combined);
  const title = stripDateRange(combined);

  const body = cfg.collectBody
    ? bodyBullets
        .map((l) => stripBullet(l.text))
        .join("\n")
        .trim() || undefined
    : undefined;

  return {
    headerLines: title ? [title] : [],
    dates,
    body,
    bulletCount: cfg.collectBody ? bodyBullets.length : 0,
  };
}

/**
 * Build the single `EntryBlock` anchored at `anchors[a]`. The entry spans from
 * just after the previous anchor to just before the next: header lines are the
 * (lookback) non-bullet lines above the anchor, the anchor line with its dates
 * stripped, and the consecutive non-bullet lines below it; the body is the
 * bullet lines after that header run. Extracted from `parseEntryBlocks` so each
 * function stays below the cognitive-complexity threshold.
 */
function buildEntryBlock(
  lines: PdfLine[],
  anchors: number[],
  a: number,
  cfg: EntryBlockConfig,
  lookback: number,
): EntryBlock {
  const anchorIdx = anchors[a];
  const nextAnchorIdx = a + 1 < anchors.length ? anchors[a + 1] : lines.length;
  const prevAnchorIdx = a === 0 ? 0 : anchors[a - 1] + 1;
  const markerX = bulletMarkerX(lines);

  // Header candidates above the anchor (e.g. "Title\nCompany <dates>").
  // Bounded by the previous entry's window and the configured lookback; bullets
  // and wrapped-bullet tails (indented past the marker) from the previous entry
  // are skipped so they never leak into this entry's header (#boundary).
  const aboveStart = Math.max(prevAnchorIdx, anchorIdx - lookback);
  const aboveLines =
    lookback > 0
      ? lines
          .slice(aboveStart, anchorIdx)
          .filter((l) => !isBulletLine(l) && !isWrappedContinuation(l, markerX))
      : [];

  const anchorLine = lines[anchorIdx];
  const dates = parseDateRange(anchorLine.text);
  const anchorTextWithoutDates = stripDateRange(anchorLine.text);

  // Header candidates below the anchor (e.g. "Company <dates>\nTitle"):
  // consecutive non-bullet lines until the first bullet or the next anchor.
  // A wrapped-bullet tail is skipped (not a header) but does not end the run.
  const belowHeaderLines: PdfLine[] = [];
  for (let i = anchorIdx + 1; i < nextAnchorIdx; i++) {
    if (isBulletLine(lines[i])) break;
    if (isWrappedContinuation(lines[i], markerX)) continue;
    belowHeaderLines.push(lines[i]);
  }

  const headerLines = [
    ...aboveLines.map((l) => l.text),
    anchorTextWithoutDates,
    ...belowHeaderLines.map((l) => l.text),
  ]
    .map((t) => t.trim())
    .filter(Boolean);

  // Body: bullets after the below-header run, until the next anchor.
  const bodyStart = anchorIdx + 1 + belowHeaderLines.length;
  const bulletLines = cfg.collectBody
    ? lines.slice(bodyStart, nextAnchorIdx).filter((l) => isBulletLine(l))
    : [];
  const body = cfg.collectBody
    ? bulletLines
        .map((l) => stripBullet(l.text))
        .join("\n")
        .trim() || undefined
    : undefined;

  return { headerLines, dates, body, bulletCount: bulletLines.length };
}
