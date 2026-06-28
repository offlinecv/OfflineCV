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
      // A bullet line is never a role-header anchor — guard against PRESENT_RE
      // (or a stray date) matching an ordinary word inside bullet prose
      // ("learn about current issues" → "current"), which would split a bullet
      // off as a phantom role and strip the word from the bullet text.
      if (isBulletLine(line)) return false;
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
 *
 * For `"date_range"`, a second pass also recovers a DATELESS entry — a role
 * whose header carries no `MM/YYYY - MM/YYYY` range (so no date anchor formed)
 * yet which clearly opens a new entry because it introduces its own bullet run.
 * See {@link collectDatelessAnchors} for the precise, conservative signature.
 * Without this, a trailing dateless role (the page-2 "Early Career: …" shape,
 * #219) is folded into the previous dated role's body window and lost.
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

  if (anchor === "date_range" && anchors.length > 0) {
    // Merge in dateless-header anchors (a new role whose header has no date
    // range, #219). Gated on `anchors.length > 0` so a section with bullets but
    // ZERO real dates still returns [] (the "no date range ⇒ []" contract — a
    // truly date-optional section routes through the `first_line` anchor, not
    // here). The merged list is re-sorted so the generic windowing in
    // `buildEntryBlock` sees anchors in document order.
    const dateless = collectDatelessAnchors(lines, anchors);
    if (dateless.length > 0) {
      const merged = [...anchors, ...dateless];
      merged.sort((p, q) => p - q);
      return merged;
    }
  }
  return anchors;
}

/**
 * Extra `date_range` anchors for DATELESS role headers (#219).
 *
 * Signature of a dateless role header that must open its own entry — kept
 * deliberately strict, because the hazard is a WRAPPED-BULLET TAIL (a marker-less
 * continuation line of the previous role's last bullet) masquerading as a header:
 * such a tail also sits "non-bullet line between two bullets," so a loose rule
 * splits a sentence fragment off as a phantom role (empty title, a bullet-tail
 * fragment as company). All of these must hold:
 *   - a non-bullet, non-date line whose immediate predecessor is a bullet (the
 *     previous role's body just ended — not a header that's already mid-entry), and
 *   - it sits at or LEFT of the bullet-marker margin — a real header sits at the
 *     header margin, whereas a wrapped bullet tail indents past the marker
 *     ({@link isWrappedContinuation}); a no-op for markerless markdown/DOCX
 *     (markerX = Infinity), where the lead-capital + prose filters below carry it, and
 *   - it LEADS WITH A CAPITAL / digit — a role header is a proper noun
 *     ("Early Career: …", "Acme Co"); a wrapped bullet tail is lowercase-led
 *     sentence prose ("infrastructure cost by 28%", "and social change"). This is
 *     the decisive filter for the no-x DOCX path, and
 *   - it does NOT read as prose ({@link isProseLine} — a mid-thought sentence
 *     fragment), and
 *   - it introduces at least one bullet before the next anchor / section end (a
 *     header with no body is a stray line, not a recoverable role).
 *
 * Anchoring on the FIRST line of the run (predecessor is a bullet) and skipping
 * subsequent header lines (predecessor is a non-bullet header) means a two-line
 * dateless header ("Title" / "Company") opens exactly one entry, mirroring the
 * `first_line` anchor's run discipline. A dated role's own multi-line header is
 * unaffected: its lines sit between a date anchor with no bullets between them,
 * so the "introduces a bullet" gate rejects them.
 */
/** A bullet line that ends on a dangling conjunction / article / preposition
 *  ("…Board of Directors and", "…reported to") has WRAPPED onto the next line —
 *  that next line is its tail, not a new header. The decisive signal for the
 *  no-geometry x=0 DOCX path, where {@link isWrappedContinuation} is a no-op and
 *  a short capital-led wrap ("Senior Leadership on strategic planning") would
 *  otherwise be promoted as a phantom role (#219). A real role's last bullet ends
 *  on a metric / noun, not a dangling word, so genuine dateless headers survive. */
const DANGLING_BULLET_TAIL_RE =
  /\b(and|or|with|the|to|of|for|a|an|in|on|at|by|as|&)\s*$/i;

/** Whether the (non-bullet) header run starting at `i` introduces a bullet body
 *  before the next real date anchor — a header with no body is a stray line, not
 *  a recoverable role. Walks forward over the header run; reaching a date anchor
 *  first means that anchor owns the bullets, not this candidate. */
function introducesBulletBody(
  lines: PdfLine[],
  i: number,
  isDate: Set<number>,
): boolean {
  for (let j = i + 1; j < lines.length; j++) {
    if (isDate.has(j)) return false;
    if (isBulletLine(lines[j])) return true;
    // a non-bullet line continues the header run — keep walking
  }
  return false;
}

function collectDatelessAnchors(lines: PdfLine[], dateAnchors: number[]): number[] {
  const isDate = new Set(dateAnchors);
  const markerX = bulletMarkerX(lines);
  const out: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBulletLine(line) || isDate.has(i)) continue;
    // First non-bullet line of a header run: predecessor must be a bullet.
    if (!isBulletLine(lines[i - 1])) continue;
    // A predecessor bullet that ends on a dangling conjunction/article/prep has
    // wrapped — this line is its tail, not a header. Decisive when geometry is
    // degenerate (all x=0), where the indent filter below can't tell them apart.
    if (DANGLING_BULLET_TAIL_RE.test(lines[i - 1].text.trim())) continue;
    // Reject a wrapped-bullet tail (indented past the marker) or sentence prose.
    if (isWrappedContinuation(line, markerX) || isProseLine(line.text)) continue;
    // A role header is a proper noun (capital/digit lead); a bullet tail that
    // slipped past the geometry/prose filters is lowercase-led sentence prose.
    if (!/^[A-Z0-9]/.test(line.text.trim())) continue;
    // Must introduce a bullet body before the next header/anchor line.
    if (introducesBulletBody(lines, i, isDate)) out.push(i);
  }
  return out;
}

/** True when the whole trimmed line is JUST a "City, ST" location — a pure city
 *  (1–2 capitalized words) followed by a 2-letter state, nothing else. A
 *  two-column entry header bands the right-column location onto its own line,
 *  between the date anchor and the left-column company/title; such a line is
 *  never the company/title, so the header walks skip it without spending budget.
 *  Deliberately STRICTER than `US_LOCATION_RE` (which allows up to three leading
 *  words and matches anywhere): a merged "Northwind Labs Bellevue, WA" company +
 *  city line at the left margin must NOT be mistaken for a pure location and
 *  dropped — that would lose the company. */
const PURE_LOCATION_RE = /^[A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+)?,\s*[A-Z]{2}$/;
function isLocationLine(text: string): boolean {
  return PURE_LOCATION_RE.test(text.trim());
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

/** x tolerance (pt) for treating two lines as sitting at the same left margin. */
const MARGIN_TOL = 2;

/**
 * The entry-header left margin of a `date_range` section — the x at which the
 * dated anchor lines (and the company / title lines that band with them) sit.
 * Taken as the minimum x over the anchor lines: in a single-column résumé every
 * role header starts at the same left edge, so the dates mark it reliably.
 * `Infinity` when the section carries no usable x (markdown / DOCX, every x = 0
 * collapses to 0 → min 0, which is fine as a margin; only truly empty input
 * returns Infinity). Used only to derive {@link glyphlessBodyMarginX}.
 */
function entryHeaderMarginX(lines: PdfLine[], anchors: number[]): number {
  let x = Infinity;
  for (const a of anchors) x = Math.min(x, lines[a].x);
  return x;
}

/**
 * The body-text indent margin for a GLYPH-LESS section — one whose bullets carry
 * no leading marker (so `bulletMarkerX` is Infinity and the marker-based
 * {@link isWrappedContinuation} body signal is disabled), as produced by some
 * Google-Docs / PDF exporters that render bullets as plain indented paragraphs.
 *
 * It is the leftmost x among lines that sit strictly RIGHT of the entry-header
 * margin (`headerMarginX`) — i.e. the indented body run. A role's bullets are
 * indented past its company / title; this recovers that indent as the body
 * signal the missing glyph would otherwise provide. Returns `Infinity` (a no-op
 * predicate) when no line is indented past the header margin — markdown/DOCX
 * (all x equal) and single-indent layouts then fall back to the
 * `isProseLine` / y-gap signals unchanged, so the glyph and no-geometry paths
 * are untouched.
 */
function glyphlessBodyMarginX(lines: PdfLine[], headerMarginX: number): number {
  if (!Number.isFinite(headerMarginX)) return Infinity;
  let x = Infinity;
  for (const l of lines) {
    if (l.x > headerMarginX + MARGIN_TOL) x = Math.min(x, l.x);
  }
  return x;
}

/**
 * True when a non-bullet line is an indented body line in a glyph-less section —
 * it sits at or right of the derived body-indent margin. The marker-less analogue
 * of {@link isWrappedContinuation}, used to find where a role's body begins (and
 * ends, when the indent drops back to the header margin) when the bullets carry
 * no glyph. A no-op when `bodyMarginX` is Infinity (glyph sections, which use the
 * marker margin instead; and no-geometry markdown).
 */
function isGlyphlessBody(line: PdfLine, bodyMarginX: number): boolean {
  return Number.isFinite(bodyMarginX) && line.x >= bodyMarginX - MARGIN_TOL;
}

/** True when `text` carries a complete, parseable date RANGE — i.e. it would
 *  anchor a `date_range` entry on its own. `DATE_RANGE_RE` and `PRESENT_RE` are
 *  non-global and non-sticky, so `.test` leaves `lastIndex` at 0 per spec; the
 *  reset is a defensive no-op kept only in case the flags change later. */
function hasCompleteDateRange(text: string): boolean {
  const hit = DATE_RANGE_RE.test(text) || PRESENT_RE.test(text);
  DATE_RANGE_RE.lastIndex = 0;
  return hit;
}

/** True when a following line should STOP the continuation gather — it is a NEW
 *  standalone role anchor (a complete range PLUS its own header text), not a
 *  wrapped tail. A bare date tail ("Present", "2024", "Jan 2020") carries only
 *  the date once stripped, so it is consumed as a continuation rather than read
 *  as the next role — which is what lets a wrapped "… Jan 2022 -" / "Present"
 *  reassemble (without this, `hasCompleteDateRange("Present")` would halt the
 *  gather before the tail folds). */
function startsNewAnchor(text: string): boolean {
  if (!hasCompleteDateRange(text)) return false;
  return stripDateRange(text).replace(PRESENT_RE, "").trim().length > 0;
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
 *   - folding up to `maxConts` continuation rows directly below it (consecutive
 *     non-bullet lines that aren't a new standalone anchor, before the first
 *     bullet) yields text that NOW matches `DATE_RANGE_RE`.
 * The final match gate is the safety net: if the continuations don't complete a
 * range, the rows are left untouched. `maxConts` bounds how many physical rows a
 * single header may absorb (so a stray subtitle + description can't be vacuumed
 * into a header just because a bare year sits a few lines down) — it tracks the
 * section's `headerLookback`, the same bounded-window intent the above-anchor
 * header lookup already uses.
 *
 * Left-column fragments (at/left of the bullet-marker margin, e.g. "Museum")
 * append to the text before the date; right-column fragments ("2024", a wrapped
 * "Present") append to the date region — keyed off `dateRegionStart` so "June"
 * and "2024" reassemble adjacently rather than "June Museum 2024".
 */
function mergeWrappedHeaderRows(lines: PdfLine[], maxConts: number): PdfLine[] {
  if (lines.length === 0) return lines;
  const markerX = bulletMarkerX(lines);
  const out: PdfLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const folded = tryFoldHeaderAt(lines, i, markerX, maxConts);
    if (folded) {
      out.push(folded.line);
      i = folded.next;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out;
}

/**
 * Attempt to fold the wrapped header that starts at `lines[i]`. Returns the
 * folded header line plus the index just past the continuation rows it consumed,
 * or null when `lines[i]` is not a foldable dangling-date header. Extracted from
 * {@link mergeWrappedHeaderRows} to keep each function below the
 * cognitive-complexity threshold.
 */
function tryFoldHeaderAt(
  lines: PdfLine[],
  i: number,
  markerX: number,
  maxConts: number,
): { line: PdfLine; next: number } | null {
  const line = lines[i];
  const dateIdx = dateRegionStart(line.text);
  if (isBulletLine(line) || hasCompleteDateRange(line.text) || dateIdx < 0) {
    return null;
  }
  // Continuation rows directly below: up to `maxConts` non-bullet lines that
  // aren't a new standalone role anchor, before the first bullet. The cap stops
  // a fold from vacuuming a subtitle + description into the header when a bare
  // year happens to sit a few lines down; `startsNewAnchor` lets a bare wrapped
  // tail ("Present", "2024") through while still halting at the next real role.
  const conts: PdfLine[] = [];
  let j = i + 1;
  while (
    j < lines.length &&
    conts.length < maxConts &&
    !isBulletLine(lines[j]) &&
    !startsNewAnchor(lines[j].text)
  ) {
    conts.push(lines[j]);
    j++;
  }
  if (conts.length === 0) return null;

  const folded = foldHeaderText(line.text, dateIdx, conts, markerX);
  // Match gate: only commit the fold when it produced a complete range.
  if (!hasCompleteDateRange(folded)) return null;
  return {
    line: { ...line, text: folded, items: [...line.items, ...conts.flatMap((c) => c.items)] },
    next: j,
  };
}

/** Reassemble a dangling-date header at split point `dateIdx`: left-column
 *  continuations (org tail) append to the text before the date, right-column
 *  continuations (the wrapped year) append to the date region — so "June" and
 *  "2024" land adjacently rather than "June Museum 2024". */
function foldHeaderText(
  text: string,
  dateIdx: number,
  conts: PdfLine[],
  markerX: number,
): string {
  const textPart = text.slice(0, dateIdx).trim();
  const datePart = text.slice(dateIdx).trim();
  const leftFrags: string[] = [];
  const rightFrags: string[] = [];
  for (const c of conts) {
    (isDateColumnFragment(c, markerX) ? rightFrags : leftFrags).push(c.text.trim());
  }
  return [textPart, ...leftFrags, datePart, ...rightFrags]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fold every wrapped-bullet continuation line in a section into the `PdfLine`
 * it continues, returning a new line array where each bullet carries its full
 * text on one line. This is the upstream twin of the body-fold logic inside
 * {@link buildEntryBlock}, narrowed to the one fold signal that is
 * geometrically unambiguous across all section types: an x-indent past the
 * bullet *marker* margin (`isWrappedContinuation`), where a long glyph bullet's
 * tail wraps onto a marker-less second line that aligns with the bullet TEXT.
 *
 * Why a separate pass: `SectionedResume.byName` flattens each section's
 * `PdfLine`s to trimmed strings (`toSectionedResume`), discarding the x the
 * fold needs. Running the fold here — before that flatten — lets the
 * string-level bullet pool (`extractBulletsFromLines`, which keeps only
 * marker-led lines and would otherwise drop a glyph-less continuation, leaving
 * the bullet truncated at the wrap) recover the full bullet text for EVERY
 * section, including untyped ones (volunteer, coursework) that never reach
 * `experience[]`. By construction the pool then agrees with the merged
 * `experience[]/projects[].description` the entry-block parser produces. See
 * #162.
 *
 * The prose-wrap y-gap signal `buildEntryBlock` also uses is deliberately NOT
 * applied here: the bullet pool is bullet-marker-gated, so a marker-less prose
 * template never contributes pool lines for a prose continuation to extend —
 * the signal would add no pool benefit while collaterally collapsing
 * paragraph-spaced header/contact/education lines (which sit at or left of the
 * margin and are NOT continuations) into one another. The x-indent signal
 * touches only lines that wrapped past a real bullet marker, so headers, entry
 * titles, and contact blocks are left one-to-one.
 *
 * A no-op when the section has no bullets (markerX = Infinity) or carries no
 * usable x (markdown/DOCX, every x = 0 → nothing indents past the marker): the
 * array is returned one line per input, byte-identical to the pre-merge flatten.
 */
export function mergeWrappedContinuations(lines: PdfLine[]): PdfLine[] {
  if (lines.length === 0) return lines;
  const markerX = bulletMarkerX(lines);
  const out: PdfLine[] = [];
  for (const line of lines) {
    if (
      out.length > 0 &&
      !isBulletLine(line) &&
      isWrappedContinuation(line, markerX)
    ) {
      // Fold this continuation onto the line it wraps from: clone the previous
      // emitted line and append the continuation's text + items.
      const prev = out[out.length - 1];
      out[out.length - 1] = {
        ...prev,
        text: `${prev.text.trimEnd()} ${line.text.trim()}`.trim(),
        items: [...prev.items, ...line.items],
      };
    } else {
      out.push(line);
    }
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
      ? mergeWrappedHeaderRows(section.lines, cfg.headerLookback || 2)
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
  // Glyph-less body-indent margin (#215): in a section whose bullets carry no
  // leading marker, the role's bullets are recognizable only by their indent
  // past the role header. Derive that margin once so each block can window its
  // body on it. Infinity (a no-op) for glyph sections and no-geometry markdown.
  const bodyMarginX =
    cfg.anchor === "date_range" && !Number.isFinite(bulletMarkerX(lines))
      ? glyphlessBodyMarginX(lines, entryHeaderMarginX(lines, anchors))
      : Infinity;
  return anchors.map((_, a) =>
    buildEntryBlock(lines, anchors, a, cfg, lookback, baseline, bodyMarginX),
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
  bodyMarginX: number,
): number {
  if (lookback <= 0 || nextAnchorIdx >= lines.length) return nextAnchorIdx;
  let start = nextAnchorIdx;
  let claimed = 0;
  for (let i = nextAnchorIdx - 1; i > anchorIdx && claimed < lookback; i--) {
    const l = lines[i];
    // Blank spacer / pure-location lines belong to the next entry's header block
    // (a two-column header bands the location onto its own line above the date
    // anchor). Fold them into the next-header region so this entry's body window
    // stops below them — but don't spend the lookback budget, or the real
    // company/title above them would leak into this entry's description. Checked
    // BEFORE the wrapped-continuation break: a right-column location sits past
    // the bullet-marker margin, so `isWrappedContinuation` would otherwise
    // misread it as a wrapped bullet tail and halt the walk on it.
    const text = l.text.trim();
    if (!text || isLocationLine(text)) {
      start = i;
      continue;
    }
    if (
      isBulletLine(l) ||
      isProseLine(l.text) ||
      isWrappedContinuation(l, markerX) ||
      // Glyph-less body line (#215): an indented marker-less bullet of THIS
      // entry, sitting just above the next role's header. Stop — it belongs to
      // this entry's body, not the next entry's header run.
      isGlyphlessBody(l, bodyMarginX)
    ) {
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
  bodyMarginX: number,
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
  // Walk UP from just above the anchor, claiming up to `lookback` real header
  // lines (company / title). A bullet, prose paragraph, or paragraph-sized gap
  // marks the previous entry's body (or this entry's own description above a
  // bottom-anchored date) — stop. Blank spacer lines, wrapped-bullet tails, and
  // pure "City, ST" location lines are noise that never carry the company/title,
  // so skip them WITHOUT spending the lookback budget. A two-column header bands
  // as [Company, Title, blank, blank, Location, Date] — the date anchor landing
  // last, far from its title; a fixed index window of `lookback` lines would be
  // exhausted on the blanks and the location before reaching company/title.
  const aboveLines: PdfLine[] = [];
  if (lookback > 0) {
    let claimed = 0;
    let lastKeptY: number | null = null;
    for (let i = anchorIdx - 1; i >= prevAnchorIdx && claimed < lookback; i--) {
      const l = lines[i];
      // A bullet, a prose paragraph, or — for a glyph-less section — an indented
      // marker-less body line (#215) marks the previous entry's body. Stop: it is
      // never this entry's company/title.
      if (isBulletLine(l) || isProseLine(l.text) || isGlyphlessBody(l, bodyMarginX)) {
        break;
      }
      const text = l.text.trim();
      if (!text || isWrappedContinuation(l, markerX) || isLocationLine(text)) {
        continue;
      }
      if (baseline > 0 && lastKeptY !== null && lastKeptY - l.y > BODY_GAP_FACTOR * baseline) {
        break;
      }
      aboveLines.unshift(l);
      lastKeptY = l.y;
      claimed++;
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
    bodyMarginX,
  );

  const anchorLine = lines[anchorIdx];
  const dates = parseDateRange(anchorLine.text);
  const anchorTextWithoutDates = stripDateRange(anchorLine.text);

  // Header candidates below the anchor (e.g. "Company <dates>\nTitle"):
  // consecutive non-bullet lines until the body begins or the next anchor. The
  // body begins at the first bullet OR the first prose paragraph — a glyph-less
  // description line (Word/Office templates write the description as prose, not
  // a bulleted list), which must not be folded into company/title — OR, in a
  // glyph-less section, the first INDENTED marker-less bullet (#215: a role-first
  // Google-Docs export where the company/title sit at the header margin and the
  // bullets are plain paragraphs indented past it). A wrapped-bullet tail is
  // skipped (not a header) but does not end the run.
  const belowHeaderLines: PdfLine[] = [];
  let bodyStart = windowEnd;
  for (let i = anchorIdx + 1; i < windowEnd; i++) {
    if (
      isBulletLine(lines[i]) ||
      isProseLine(lines[i].text) ||
      startsBodyByGap(lines, i, baseline) ||
      isGlyphlessBody(lines[i], bodyMarginX)
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
      // Glyph-less body run ends when the indent drops back to the header margin
      // (#215): a non-bullet, non-indented line inside the window is a stray
      // header that leaked in (e.g. the next section's "Leadership and Work
      // Experience" title), not a bullet — stop collecting so it never becomes a
      // body unit. Guarded to the glyph-less mode (`bodyMarginX` finite) so glyph
      // sections and no-geometry markdown are unaffected.
      // A blank/whitespace-only spacer line (pdfjs emits zero-width or space-only
      // items, and `mergeItemText` trims them to "") must NOT end the body run —
      // it carries no x signal worth trusting and would otherwise truncate every
      // bullet after it. Skip it before the indent-drop break below.
      if (!lines[i].text.trim()) continue;
      if (
        Number.isFinite(bodyMarginX) &&
        !isBulletLine(lines[i]) &&
        !isGlyphlessBody(lines[i], bodyMarginX)
      ) {
        break;
      }
      const text = stripBullet(lines[i].text).trim();
      if (!text) continue;
      let foldsAsProseWrap =
        baseline > 0 &&
        i > bodyStart &&
        !isBulletLine(lines[i]) &&
        lines[i].y - lines[i - 1].y > 0 &&
        lines[i].y - lines[i - 1].y <= BODY_GAP_FACTOR * baseline;
      // Glyph-less new-bullet guard (#215): when the body is a run of marker-less
      // indented bullets at one indent and one line-height (no glyph, no
      // paragraph gap between bullets), the sub-paragraph y-gap above misreads
      // every following bullet as a wrap of the first and folds the whole role
      // into ONE bullet. A real wrap is a sentence cut mid-thought — a
      // lowercase-led tail, or a predecessor ending on a dangling connective; a
      // NEW bullet leads with a capital (an action verb: "Designed", "Reviewed").
      // So in glyph-less mode, only fold a capital-led continuation when its
      // predecessor dangles. Scoped to `bodyMarginX` finite, so the prose-template
      // wrap fold and glyph paths are unchanged.
      if (
        foldsAsProseWrap &&
        Number.isFinite(bodyMarginX) &&
        /^[A-Z0-9]/.test(text) &&
        !DANGLING_BULLET_TAIL_RE.test(stripBullet(lines[i - 1].text).trim())
      ) {
        foldsAsProseWrap = false;
      }
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
