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
import {
  DATE_RANGE_RE,
  PRESENT_RE,
  INSTITUTION_HINTS,
  MONTH_YEAR_RE,
  NUMERIC_MONTH_YEAR_RE,
  YEAR_RE,
} from "./regex.ts";
import {
  parseDateRange,
  stripDateRange,
  isBulletLine,
  isProseLine,
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

/** True when `text` carries a complete, parseable date RANGE — i.e. it would
 *  anchor a `date_range` entry on its own. `DATE_RANGE_RE` is non-global but
 *  `.test` advances `lastIndex` on some engines; reset so calls are idempotent. */
function hasCompleteDateRange(text: string): boolean {
  const hit = DATE_RANGE_RE.test(text) || PRESENT_RE.test(text);
  DATE_RANGE_RE.lastIndex = 0;
  return hit;
}

/** Index of the earliest date-region token (month-year, numeric month/year, or
 *  a bare year) in `text`, or -1 if none. Marks where the right-hand date column
 *  begins so a wrapped header's left (org) and right (date) continuations fold
 *  back onto the correct side. The three source regexes are global; reset
 *  `lastIndex` before each scan so repeated calls are idempotent. */
function dateRegionStart(text: string): number {
  let idx = -1;
  for (const re of [MONTH_YEAR_RE, NUMERIC_MONTH_YEAR_RE, YEAR_RE]) {
    re.lastIndex = 0;
    const m = re.exec(text);
    re.lastIndex = 0;
    if (m && (idx === -1 || m.index < idx)) idx = m.index;
  }
  return idx;
}

/** A continuation fragment belongs to the right-hand date column when it sits
 *  past the bullet-marker margin (geometry) OR reads as a bare date tail — just
 *  a year / month-year / "Present" (content). The content test rescues the
 *  no-bullet case (`markerX` = Infinity) where geometry can't classify. */
function isDateColumnFragment(line: PdfLine, markerX: number): boolean {
  if (Number.isFinite(markerX) && line.x > markerX + 2) return true;
  const t = line.text.trim();
  return /^(?:\d{4}|'\d{2})$/.test(t) || hasCompleteDateRange(t) || PRESENT_RE.test(t);
}

/**
 * Fold a wrapped multi-line ROLE HEADER back into one logical header line so a
 * `date_range` entry block opens for it. The motivating shape (#166): a header
 * whose org and date span two physical rows, where the date's closing year
 * wraps onto its own far-right line —
 *
 *     "Docent … | Community Heritage   May 2023 - June"   ← anchor row (no full range)
 *     "Museum"                                            ← left-column org tail
 *     "2024"                                              ← right-column date tail
 *
 * Because the anchor row reads "… May 2023 - June" (an incomplete range),
 * `DATE_RANGE_RE` misses it, no anchor forms, no entry is built, and the role's
 * bullets fall into the unmatched "Other" group. This pass reassembles the three
 * rows into "… Community Heritage Museum   May 2023 - June 2024", which DOES
 * match, so the block opens normally and the bullets attribute to the role.
 *
 * The fold is the role-header analogue of {@link mergeWrappedContinuations}
 * (which folds wrapped *bullet bodies*). It fires ONLY when:
 *   - the candidate row is a non-bullet line that does NOT already carry a
 *     complete range (so a normal "Company Jan 2020 - Dec 2021" header, or a
 *     "Company Dates / Title / bullets" stack, never folds — no regression), and
 *   - it carries a date-region start (the dangling "… - June"), and
 *   - folding the continuation rows directly below it (consecutive non-bullet,
 *     non-anchor lines before the first bullet) yields text that NOW matches
 *     `DATE_RANGE_RE`.
 * The final match gate is the safety net: if the continuations don't complete a
 * range, the rows are left untouched.
 *
 * Left-column fragments (at/left of the bullet-marker margin, e.g. "Museum")
 * append to the text before the date; right-column fragments ("2024") append to
 * the date region — keyed off `dateRegionStart` so "June" and "2024" reassemble
 * adjacently rather than "June Museum 2024".
 */
export function mergeWrappedHeaderRows(lines: PdfLine[]): PdfLine[] {
  if (lines.length === 0) return lines;
  const markerX = bulletMarkerX(lines);
  const out: PdfLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const dateIdx = dateRegionStart(line.text);
    if (
      !isBulletLine(line) &&
      !hasCompleteDateRange(line.text) &&
      dateIdx >= 0
    ) {
      // Gather continuation rows directly below: non-bullet, non-anchor lines
      // before the first bullet / next complete-date anchor.
      const conts: PdfLine[] = [];
      let j = i + 1;
      while (
        j < lines.length &&
        !isBulletLine(lines[j]) &&
        !hasCompleteDateRange(lines[j].text)
      ) {
        conts.push(lines[j]);
        j++;
      }
      if (conts.length > 0) {
        const textPart = line.text.slice(0, dateIdx).trim();
        const datePart = line.text.slice(dateIdx).trim();
        const leftFrags: string[] = [];
        const rightFrags: string[] = [];
        for (const c of conts) {
          (isDateColumnFragment(c, markerX) ? rightFrags : leftFrags).push(
            c.text.trim(),
          );
        }
        const folded = [textPart, ...leftFrags, datePart, ...rightFrags]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (hasCompleteDateRange(folded)) {
          out.push({
            ...line,
            text: folded,
            items: [...line.items, ...conts.flatMap((c) => c.items)],
          });
          i = j;
          continue;
        }
      }
    }
    out.push(line);
    i++;
  }
  return out;
}

/**
 * A description paragraph begins after a vertical gap wider than this multiple
 * of the section's single line-height. Word/Office templates write the role
 * description as a glyph-less prose paragraph set off by paragraph spacing, so
 * the blank-line gap — not a bullet glyph or a sentence period — is the
 * structural signal that the header has ended and the body has begun.
 */
const BODY_GAP_FACTOR = 1.4;

/**
 * Median of the positive consecutive y-gaps in a section — its baseline single
 * line-height. Returns 0 when the lines carry no usable y (markdown / DOCX
 * extraction sets every `y` equal, so no positive gaps), which disables the
 * gap-based body signal and leaves `isProseLine` as the sole text fallback.
 */
function sectionLineHeight(lines: PdfLine[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i].y - lines[i - 1].y;
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

/**
 * True when line `i` starts a body paragraph by the y-gap signal: it is set off
 * from the line above by a paragraph-sized gap (> `BODY_GAP_FACTOR`× the section
 * line-height) and reads like prose (carries a lowercase letter). This is the
 * PDF-path primary for glyph-less descriptions — it catches a periodless
 * paragraph that `isProseLine` (which needs a sentence break) misses. A no-op
 * when `baseline` is 0 (no usable y data), so the DOCX/markdown path falls back
 * to `isProseLine` unchanged.
 */
function startsBodyByGap(lines: PdfLine[], i: number, baseline: number): boolean {
  if (baseline <= 0 || i <= 0) return false;
  const gap = lines[i].y - lines[i - 1].y;
  if (gap <= BODY_GAP_FACTOR * baseline) return false;
  return /[a-z]/.test(lines[i].text);
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

  // Fold wrapped multi-line role headers (an org/date that spilled onto extra
  // physical rows) back into one logical header BEFORE anchor detection, so a
  // header whose closing date-year wrapped still opens a `date_range` entry
  // (#166). Scoped to `date_range`: the other anchors key off an institution
  // hint / first line, not a date range that can wrap incomplete.
  const lines =
    cfg.anchor === "date_range"
      ? mergeWrappedHeaderRows(section.lines)
      : section.lines;
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
  const baseline = sectionLineHeight(lines);
  return anchors.map((_, a) =>
    buildEntryBlock(lines, anchors, a, cfg, lookback, baseline),
  );
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
  const bodyLines: string[] = []; // one entry per logical sub-bullet
  let sawBullet = false;
  for (let i = anchorIdx + 1; i < nextIdx; i++) {
    if (isBulletLine(lines[i])) {
      bodyLines.push(stripBullet(lines[i].text));
      sawBullet = true;
    } else if (sawBullet) {
      // A marker-less line *after* a sub-bullet is that bullet's wrapped tail —
      // keep it in the body, joined onto its bullet, not folded into the title.
      bodyLines[bodyLines.length - 1] += " " + lines[i].text.trim();
    } else {
      // A marker-less line *before* any sub-bullet is a continuation of the
      // top-level award header (e.g. a year on its own line, which is itself
      // indented like a wrapped bullet) — fold it into the title.
      titleParts.push(lines[i].text.trim());
    }
  }

  const combined = titleParts.join(" ").replace(/\s+/g, " ").trim();
  const dates = parseDateRange(combined);
  const title = stripDateRange(combined);

  const body = cfg.collectBody
    ? bodyLines.join("\n").trim() || undefined
    : undefined;

  return {
    headerLines: title ? [title] : [],
    dates,
    body,
    bulletCount: cfg.collectBody ? bodyLines.length : 0,
  };
}

/**
 * Index where the NEXT entry's header run begins — the boundary the current
 * entry's content window must not cross. Walks up from just below `nextAnchorIdx`,
 * claiming up to `lookback` consecutive header-shaped lines (non-bullet,
 * non-prose, non-wrapped) for the next entry. Returns `nextAnchorIdx` unchanged
 * for the last entry (no next header) or when `lookback` is 0 (anchors below
 * carry no above-header, e.g. institution/first_line styles).
 */
function nextHeaderStart(
  lines: PdfLine[],
  anchorIdx: number,
  nextAnchorIdx: number,
  lookback: number,
  markerX: number,
  baseline: number,
): number {
  if (lookback <= 0 || nextAnchorIdx >= lines.length) return nextAnchorIdx;
  let start = nextAnchorIdx;
  let claimed = 0;
  for (let i = nextAnchorIdx - 1; i > anchorIdx && claimed < lookback; i--) {
    const l = lines[i];
    if (isBulletLine(l) || isProseLine(l.text) || isWrappedContinuation(l, markerX)) {
      break;
    }
    // y-gap backstop: once a header line is claimed, a paragraph-sized gap
    // between this candidate and the line just claimed below it means we've
    // stepped up out of the next entry's tight header run into the previous
    // entry's description — stop before claiming a periodless body line that
    // `isProseLine` would not catch.
    if (claimed > 0 && baseline > 0) {
      const gapToClaimed = lines[i + 1].y - lines[i].y;
      if (gapToClaimed > BODY_GAP_FACTOR * baseline) break;
    }
    start = i;
    claimed++;
  }
  return start;
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
  baseline: number,
): EntryBlock {
  const anchorIdx = anchors[a];
  const nextAnchorIdx = a + 1 < anchors.length ? anchors[a + 1] : lines.length;
  const prevAnchorIdx = a === 0 ? 0 : anchors[a - 1] + 1;
  const markerX = bulletMarkerX(lines);

  // Header candidates above the anchor (e.g. "Title\nCompany <dates>").
  // Bounded by the previous entry's window and the configured lookback; bullets,
  // wrapped-bullet tails (indented past the marker), and prose description lines
  // from the previous entry are skipped so they never leak into this entry's
  // header (#boundary). The prose filter matters for glyph-less templates whose
  // description paragraph sits directly above the next role's date — and the
  // y-gap exclusion is its structural twin: a line set off from the line below
  // it (toward the anchor) by a paragraph-sized gap is the previous entry's
  // description tail, not this entry's header, even when it carries no period.
  const aboveStart = Math.max(prevAnchorIdx, anchorIdx - lookback);
  const aboveLines: PdfLine[] = [];
  if (lookback > 0) {
    for (let i = aboveStart; i < anchorIdx; i++) {
      const l = lines[i];
      if (
        isBulletLine(l) ||
        isWrappedContinuation(l, markerX) ||
        isProseLine(l.text)
      ) {
        continue;
      }
      if (baseline > 0) {
        const gapBelow = lines[i + 1].y - lines[i].y;
        if (gapBelow > BODY_GAP_FACTOR * baseline) continue;
      }
      aboveLines.push(l);
    }
  }

  // The next entry claims up to `lookback` header-shaped lines directly above
  // its anchor (the "Title\nCompany <dates>" lead). This entry's content window
  // must stop before them, or a glyph-less description would swallow the next
  // role's company/title as a trailing body line. Walk up from just below the
  // next anchor, claiming consecutive header-shaped lines for the next entry.
  const windowEnd = nextHeaderStart(
    lines,
    anchorIdx,
    nextAnchorIdx,
    lookback,
    markerX,
    baseline,
  );

  const anchorLine = lines[anchorIdx];
  const dates = parseDateRange(anchorLine.text);
  const anchorTextWithoutDates = stripDateRange(anchorLine.text);

  // Header candidates below the anchor (e.g. "Company <dates>\nTitle"):
  // consecutive non-bullet lines until the body begins or the next anchor. The
  // body begins at the first bullet OR the first prose paragraph — a glyph-less
  // description line (Word/Office templates write the description as prose, not
  // a bulleted list), which must not be folded into company/title. A
  // wrapped-bullet tail is skipped (not a header) but does not end the run.
  const belowHeaderLines: PdfLine[] = [];
  let bodyStart = windowEnd;
  for (let i = anchorIdx + 1; i < windowEnd; i++) {
    if (
      isBulletLine(lines[i]) ||
      isProseLine(lines[i].text) ||
      startsBodyByGap(lines, i, baseline)
    ) {
      bodyStart = i;
      break;
    }
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

  // Body: every bullet or prose paragraph from where the body began to the next
  // anchor. Bullet glyphs are stripped; a wrapped tail folds onto its bullet.
  // Two fold signals: an x-indent past the bullet marker (wrapped glyph bullet),
  // or — for marker-less prose, which has no marker to wrap past — a line that
  // sits a baseline (sub-paragraph) gap below its predecessor, i.e. the same
  // paragraph continued onto the next visual line. A paragraph-sized gap (or a
  // real bullet glyph) instead starts a new unit, so one prose blurb stays one
  // bullet rather than splitting mid-sentence.
  const bodyUnits: string[] = [];
  if (cfg.collectBody) {
    for (let i = bodyStart; i < windowEnd; i++) {
      const text = stripBullet(lines[i].text).trim();
      if (!text) continue;
      const foldsAsProseWrap =
        baseline > 0 &&
        i > bodyStart &&
        !isBulletLine(lines[i]) &&
        lines[i].y - lines[i - 1].y > 0 &&
        lines[i].y - lines[i - 1].y <= BODY_GAP_FACTOR * baseline;
      if (
        bodyUnits.length > 0 &&
        (isWrappedContinuation(lines[i], markerX) || foldsAsProseWrap)
      ) {
        bodyUnits[bodyUnits.length - 1] += " " + text;
      } else {
        bodyUnits.push(text);
      }
    }
  }
  const body = cfg.collectBody ? bodyUnits.join("\n").trim() || undefined : undefined;

  return { headerLines, dates, body, bulletCount: bodyUnits.length };
}
