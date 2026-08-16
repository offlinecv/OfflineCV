// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Group positional PDF items into logical "lines" and "sections".
 *
 * PDF coordinates are bottom-origin (y grows upward). We flip once at
 * extraction time so the rest of the pipeline sees top-origin coordinates
 * (y grows downward) — consistent with how readers actually scan.
 *
 * A "line" is a cluster of items whose y-centers agree within `LINE_Y_EPS`
 * *and* that share a page. A "section" is a contiguous run of lines that
 * share a canonical header name ("experience", "education", etc.) — plus
 * an implicit `profile` section at the top before the first header.
 *
 * The line/section *types* (`PdfLine`/`PdfSection`/`SectionedResume`) and the
 * item→line assembly helpers (`groupIntoLines`, `orderItemsByColumn`,
 * `mergeItemText`, …) live in `line-model.ts` / `line-assembly.ts` (#650) and
 * are re-exported here for existing importers. This module now owns only the
 * header-classification logic that turns assembled lines into sections.
 */

import type { PdfTextItem } from "./types.ts";
import {
  matchSectionHeader,
  matchSectionHeaderDetailed,
  matchSectionAnchorToken,
  EMAIL_RE,
  PHONE_RE,
  LINKEDIN_RE,
  DATE_RANGE_RE,
  DEGREE_RE,
  INSTITUTION_HINTS,
  SECTION_KEYWORDS,
  type SectionName,
} from "./regex.ts";
import { isEntryHeaderShape, mergeWrappedContinuations } from "./entry-blocks.ts";
import { isBulletLine } from "./line-primitives.ts";
import { LINE_Y_EPS, mergeItemText } from "./line-assembly.ts";
import type { PdfLine, PdfSection, SectionedResume } from "./line-model.ts";
import { ACCOMPLISHMENT_SECTION_NAMES } from "./line-model.ts";

export type { PdfLine, PdfSection, SectionedResume } from "./line-model.ts";
export { ACCOMPLISHMENT_SECTION_NAMES } from "./line-model.ts";
export {
  orderItemsByColumn,
  groupIntoLines,
  collapseLetterSpacing,
  mergeItemText,
} from "./line-assembly.ts";

/**
 * Build the typed {@link SectionedResume} view from the raw `PdfSection[]` the
 * heuristic parser holds. Each section's lines are trimmed and emptied-out,
 * exactly as the retired `skillsSectionLines` slice was
 * (`lines.map(l => l.text.trim()).filter(t => t.length > 0)`) — so the
 * skills-exclusion set the scorer derives is byte-for-byte what it derived from
 * `skillsSectionText`, keeping the corpus goldens unchanged (#132).
 */
export function toSectionedResume(
  sections: PdfSection[],
  source: "markdown" | "regex",
): SectionedResume {
  // Accumulate (don't overwrite) when a name repeats — a resume can split one
  // logical section across continuation headers, and `findSection` flattened
  // all matches' lines in document order. Mirroring that here keeps
  // `byName.get("skills")` byte-identical to the retired `skillsSectionLines`.
  const byName = new Map<SectionName | "profile", string[]>();
  // First occurrence wins — a resume can split one logical section across
  // continuation headers (e.g. "EXPERIENCE" repeated across a page break); the
  // first header's wording is the representative one for display.
  const sectionHeadings = new Map<SectionName, string>();
  for (const section of sections) {
    // Fold wrapped-continuation lines (a long bullet that wrapped onto a
    // second, marker-less line indented past the bullet marker) into the line
    // they continue BEFORE flattening to strings — the x the fold needs is gone
    // once these are trimmed text. This makes the string-level bullet pool
    // (`extractBulletsFromLines`, which drops a glyph-less continuation as
    // truncation) agree by construction with the merged
    // `experience[]/projects[].description` the entry-block parser produces, for
    // every section incl. untyped ones (volunteer/coursework). See #162.
    const lines = mergeWrappedContinuations(section.lines)
      .map((l) => l.text.trim())
      .filter((t) => t.length > 0);
    const existing = byName.get(section.name);
    if (existing) existing.push(...lines);
    else byName.set(section.name, lines);
    if (
      section.name !== "profile" &&
      section.rawHeading &&
      !sectionHeadings.has(section.name)
    ) {
      sectionHeadings.set(section.name, section.rawHeading);
    }
  }
  return {
    byName,
    accomplishmentSections: ACCOMPLISHMENT_SECTION_NAMES,
    source,
    sectionHeadings,
  };
}

// ── Visual-header detection (L3 / #112) ─────────────────────────────────────

/**
 * Font-size ratio (line `maxFontSize` ÷ document body baseline) at which a line
 * is "meaningfully larger" than body text and therefore visually a header.
 *
 * Sits deliberately between the markdown emitter's `H3_RATIO` (1.12) and
 * `H2_RATIO` (1.25): a job title or company name rendered bold but only
 * slightly larger than body (≈1.05–1.15×) must NOT promote to a boundary, or it
 * would split mid-experience and strand every following role into the `other`
 * sink. 1.15 clears the slightly-bold-title FP class (≈1.1× titles) while still
 * catching the genuinely-larger invented-label headers ("Career Journey") this
 * path exists to segment.
 *
 * Lowered 1.2 → 1.15 in #163: the Skia/Chrome renderer (Google Docs → PDF)
 * flattens an h2 down to ≈1.09–1.18× body, so a real invented header can sit
 * just under 1.2. 1.15 still sits safely above the pinned ≈1.1× bold-title FP
 * (`sections.test.ts`), so no role-stranding regression — verified against the
 * full corpus snapshot.
 *
 * Font distinction is the PRIMARY visual signal here, but not the only one: a
 * font-metadata-independent text-pattern fallback (`isTextPatternHeader`, #163)
 * runs alongside it for renderers that strip or flatten font size below even
 * 1.15. The #112 note that bare body-size all-caps is dominated by NON-headers
 * (single-token acronyms/skill tokens "HTML"/"CSS"/"C++", inline values
 * "GPA: 3.5") still holds — so that fallback is tightly shaped (multi-word,
 * clean, ALL CAPS only; see `isTextPatternHeader`) to exclude exactly those
 * classes. Genuine all-caps *section* headers ("OBJECTIVE", "EDUCATION") are
 * still caught by the keyword/anchor path first, before either visual branch
 * runs.
 */
const VISUAL_HEADER_FONT_RATIO = 1.15;

/** Max characters for a line to still read as a header (not a prose line). */
const VISUAL_HEADER_MAX_CHARS = 40;
/** Max whitespace-separated words for a header (qualifier(s) + head noun). */
const VISUAL_HEADER_MAX_WORDS = 4;

/** Terminal sentence punctuation marks prose, not a heading. */
const TERMINAL_PUNCT_RE = /[.!?]$/;
/** Leading bullet glyph — a header-shaped bullet is content, not a heading. */
const VISUAL_BULLET_RE = /^\s*[•‣▪●◦⁃*\-–—]/;

/**
 * Character-weighted mode of `maxFontSize` across lines — the document body
 * baseline used by the visual-header test. Mirrors
 * `markdown-emit.ts::computeBodyFontSize`, but reads `PdfLine.maxFontSize`
 * (this module's line shape) rather than that module's `PdfLine.fontSize`;
 * weighting by character count keeps multi-line headers from dominating the
 * mode, so the long body paragraphs win. Returns 10pt for an empty document.
 */
function computeBodyBaseline(lines: PdfLine[]): number {
  if (lines.length === 0) return 10;
  const bins = new Map<number, number>();
  for (const line of lines) {
    const bin = Math.round(line.maxFontSize * 10) / 10;
    bins.set(bin, (bins.get(bin) ?? 0) + line.text.trim().length);
  }
  let mode = 10;
  let maxChars = 0;
  for (const [size, chars] of bins.entries()) {
    if (chars > maxChars) {
      maxChars = chars;
      mode = size;
    }
  }
  return mode;
}

/**
 * Ratio of a line's gap-above to the document body line-height at which the gap
 * reads as a *paragraph break* (a section boundary cue), not ordinary
 * within-paragraph leading (#216). Calibrated against the two font-flattening
 * `nonstandard-headers` fixtures: body line-height there is ≈18pt, real section
 * headers sit at a gap-above of ≈26–29.5pt (ratio ≈1.44–1.64), while the
 * tightest non-header cue — the company/role line directly under a header —
 * sits at ≈21.5–22.5pt (ratio ≈1.19–1.25). 1.4 (threshold ≈25.2pt) clears every
 * real header with margin while staying above that sub-header band, so the gap
 * cue never fires on a role/company/degree line.
 */
const HEADER_GAP_RATIO = 1.4;

/**
 * Character-weighted mode of the positive `gapAbove` values across lines — the
 * document's typical within-paragraph line-height, the baseline the
 * vertical-gap header cue (#216) measures against. Mirrors the weighting in
 * `computeBodyBaseline` (weight each gap bin by the line's character count) so
 * long body paragraphs dominate the mode and a handful of wider header gaps
 * never become the baseline. Gaps are binned to 0.5pt. Returns a 14pt default
 * for a document with no measurable gaps (≤1 line, or all first-on-page).
 */
function computeBodyLineHeight(lines: PdfLine[]): number {
  const bins = new Map<number, number>();
  for (const line of lines) {
    if (line.gapAbove <= 0) continue;
    const bin = Math.round(line.gapAbove * 2) / 2;
    bins.set(bin, (bins.get(bin) ?? 0) + line.text.trim().length);
  }
  let mode = 0;
  let maxChars = 0;
  for (const [gap, chars] of bins.entries()) {
    if (chars > maxChars) {
      maxChars = chars;
      mode = gap;
    }
  }
  return mode > 0 ? mode : 14;
}

/**
 * Header *shape* test, independent of font: short (≤ `VISUAL_HEADER_MAX_CHARS`
 * chars, ≤ `VISUAL_HEADER_MAX_WORDS` words), not a bullet line, and not ending
 * in terminal sentence punctuation. This is the structural half of
 * `isVisualHeader`; the column-gated sidebar-header recovery (#117) reuses the
 * exact same predicate so the two paths can never drift on what counts as
 * header-shaped.
 */
function isHeaderShort(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > VISUAL_HEADER_MAX_CHARS) return false;
  if (VISUAL_BULLET_RE.test(t)) return false;
  if (TERMINAL_PUNCT_RE.test(t)) return false;
  const words = t.split(/\s+/).filter((w) => w.length > 0);
  return words.length <= VISUAL_HEADER_MAX_WORDS;
}

/**
 * Max whitespace-separated words for the font-metadata-independent text-pattern
 * header (#163). Slightly looser than the font path's `VISUAL_HEADER_MAX_WORDS`
 * (4) because invented multi-word labels ("VOLUNTEER EXPERIENCE & SERVICE")
 * run a touch longer than the qualifier+head-noun shape the anchor fallback
 * targets; capped at 6 so a short prose fragment can't slip through.
 */
const TEXT_PATTERN_HEADER_MAX_WORDS = 6;

/**
 * Characters that mark a line as content rather than a bare section label:
 * digits (dates / metrics / GPA), commas and pipes / mid-dots / dashes / slashes
 * (company–location, "ACME CORP | REMOTE", "SEP 2024 - JULY 2025"), and colons
 * (inline labels "GPA: 3.5"). A genuine invented header ("VOLUNTEER WORK",
 * "ADDITIONAL INFORMATION") carries none of these.
 */
const TEXT_PATTERN_DIRTY_RE = /[0-9,:·|—–/]/;

/**
 * Font-metadata-independent header test (#163). Some renderers (Skia/Chrome via
 * Google Docs → PDF) strip or flatten a section header's font-size lift so far
 * it doesn't clear even the lowered `VISUAL_HEADER_FONT_RATIO` (1.15). This
 * detects a header purely from text *shape* — independent of font size: a short
 * (≤ `VISUAL_HEADER_MAX_CHARS` chars, 2–`TEXT_PATTERN_HEADER_MAX_WORDS` words),
 * non-bullet, non-terminal-punctuation, ALL-CAPS line carrying none of the
 * `TEXT_PATTERN_DIRTY_RE` content markers.
 *
 * ALL CAPS *only* — deliberately NOT Title Case. The #112 corpus pass showed
 * Title-Case shape is dominated on the regex path by NON-header content a
 * boundary must never split on: job titles ("Sr Software Engineer", "Staff
 * Software Engineer"), company names ("Globex Corporation", "Acme Corp"), and
 * institutions ("Springfield State University") — all Title Case, all rendered
 * at or barely above body size, so neither a font-ratio floor nor a column gate
 * separates them from a real flattened header (the coursework reproducers sit
 * mid-band among them). Promoting any of them opens an `other` sink that strands
 * the role/degree beneath it. ALL CAPS multi-word lines, by contrast, are
 * reliably section labels in this corpus — the only all-caps clean ≥2-word
 * non-keyword lines are institution names on the *markdown* path
 * ("CORNELL UNIVERSITY"), which never reaches this splitter. So the title-cased
 * "Relevant Coursework" reproducer is fixed by its `education` keyword alias
 * (#163 sub-problem 1), and this path generalizes the boundary-termination to
 * any unknown ALL-CAPS header a metadata-stripping renderer flattens.
 *
 * The remaining gates kill the FP classes the bare-all-caps #112 experiment
 * tripped on: ≥ 2 words excludes single-token skill/acronym tokens ("HTML",
 * "CSS", "C++", "PHP"); `TEXT_PATTERN_DIRTY_RE` excludes date / location-comma /
 * separator / colon-bearing inline values ("GPA: 3.5").
 *
 * Like the font path it only runs after `matchSectionHeader` declines the line,
 * and (in `classifyLine`) only past the leading name/contact block — so a real
 * header it fires on opens the boundary-only `other` sink, terminating the prior
 * section. Verified zero-regression against the full corpus snapshot.
 */
function isTextPatternHeader(text: string): boolean {
  const t = text.trim();
  const words = textPatternCleanWords(t);
  if (words === null) return false;
  // ≥ 2 words: a single token is a skill/acronym ("HTML", "GRADUATE"), not a
  // section header — bare single-token all-caps is the FP class #112 dropped.
  // The single-word case is handled separately, gated on a vertical-gap cue
  // (`isGapIsolatedSingleWordHeader`, #216), so it is excluded here.
  return words >= 2 && words <= TEXT_PATTERN_HEADER_MAX_WORDS;
}

/**
 * Shared shape gate for the font-metadata-independent ALL-CAPS header tests:
 * a short, non-bullet, non-terminal-punctuation, dirty-marker-free, ALL-CAPS
 * line. Returns its whitespace-word count when the shape passes, else `null`.
 * Both the multi-word `isTextPatternHeader` and the single-word, gap-gated
 * `isGapIsolatedSingleWordHeader` derive their word-count rule from this one
 * predicate so the two can never drift on what "clean ALL-CAPS header shape"
 * means.
 */
function textPatternCleanWords(text: string): number | null {
  const t = text.trim();
  if (t.length === 0 || t.length > VISUAL_HEADER_MAX_CHARS) return null;
  if (VISUAL_BULLET_RE.test(t)) return null;
  if (TERMINAL_PUNCT_RE.test(t)) return null;
  if (TEXT_PATTERN_DIRTY_RE.test(t)) return null;
  if (!isAllCapsHeader(t)) return null;
  return t.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Single-word, ALL-CAPS, unknown-vocabulary header recovered by a vertical-gap
 * cue (#216). This is the narrow relaxation of `isTextPatternHeader`'s `≥2
 * words` gate (the #112 single-token FP guard) for the one renderer class where
 * it loses a real boundary: a font-flattening renderer (Google Docs/Skia,
 * WeasyPrint/Cairo) emits a real single-word header like `INTERNSHIPS` at body
 * font size, so neither the font-ratio path nor the multi-word text-pattern path
 * fires, and the header is silently absorbed into the section above it.
 *
 * The `≥2 words` gate stays the default precisely because a bare single ALL-CAPS
 * token is dominated by NON-headers — skill/acronym tokens ("HTML", "CSS",
 * "PHP", "AWS") and lone words ("GRADUATE"). Those appear *inside* a packed
 * section (skills list, a bullet's lead word), so they carry an ordinary
 * within-paragraph gap above. A genuine section header sits below a paragraph
 * break, so its gap-above runs ≥ `HEADER_GAP_RATIO`× the body line-height. That
 * orthogonal geometric cue — not vocabulary, not font, not casing — is what
 * separates the two, so it (and ONLY it) re-admits the single-word case while
 * keeping the #112 FP class closed: an inline acronym never clears the gate.
 *
 * Caller (`classifyLine`) applies the same name/contact-block suppression and
 * post-`matchSectionHeader` ordering as the other visual paths, so a fired
 * header opens the boundary-only `other` sink. It also gates this path on the
 * line NOT immediately following a boundary: the first content line under a
 * header inherits an inflated gap-above (measured against the header line), so a
 * column-reordered skills grid's lead token (`HTML` right under `SKILLS`) would
 * otherwise clear the ratio — the #112 inline-acronym FP this guard keeps shut.
 */
function isGapIsolatedSingleWordHeader(
  line: PdfLine,
  bodyLineHeight: number,
): boolean {
  if (textPatternCleanWords(line.text) !== 1) return false;
  return line.gapAbove >= bodyLineHeight * HEADER_GAP_RATIO;
}

/** True when every letter-bearing char is uppercase (and at least one exists). */
function isAllCapsHeader(t: string): boolean {
  const letters = t.replace(/[^A-Za-z]/g, "");
  return letters.length > 0 && letters === letters.toUpperCase();
}

/**
 * True when a line is *visually* a header. Two orthogonal signals, either of
 * which qualifies (after `matchSectionHeader` has already declined the line, so
 * a pass opens the boundary-only `other` sink that terminates the prior section):
 *   - font path: header-shaped (`isHeaderShort`) AND meaningfully larger than
 *     the body baseline (≥ `VISUAL_HEADER_FONT_RATIO`); or
 *   - text-pattern path (#163): font-metadata-independent — a short clean-shaped
 *     multi-word ALL-CAPS line (`isTextPatternHeader`), for renderers that
 *     flatten font size below the ratio gate.
 *
 * The single-word vertical-gap path (#216, `isGapIsolatedSingleWordHeader`) is
 * NOT folded in here — it needs an adjacency guard the caller holds (a header
 * never immediately follows another header), so `classifyLine` checks it
 * separately. Keeping it out leaves this predicate (and its #112/#163 callers)
 * byte-identical.
 */
function isVisualHeader(
  line: PdfLine,
  bodyBaseline: number,
): boolean {
  if (isHeaderShort(line.text) &&
      line.maxFontSize >= bodyBaseline * VISUAL_HEADER_FONT_RATIO) {
    return true;
  }
  return isTextPatternHeader(line.text);
}

// Non-global clones of the contact REs for stateless boolean checks. The
// exported forms are `/g` and carry `lastIndex` across calls — calling
// `.test()` on them here would mutate state any future `.exec()`/`.test()`
// caller would inherit. Dropping the `g` flag makes `.test()` stateless; the
// pattern source stays single-sourced in regex.ts (we clone `.source`).
const EMAIL_TEST_RE = new RegExp(EMAIL_RE.source, EMAIL_RE.flags.replace("g", ""));
const PHONE_TEST_RE = new RegExp(PHONE_RE.source, PHONE_RE.flags.replace("g", ""));
const LINKEDIN_TEST_RE = new RegExp(
  LINKEDIN_RE.source,
  LINKEDIN_RE.flags.replace("g", ""),
);

/**
 * True when a line carries name/contact shape — an email, phone, or LinkedIn
 * URL. Used to keep a large contact line in the leading profile region from
 * being promoted to a section boundary. Uses non-global clones so no shared
 * regex `lastIndex` state is touched.
 */
function hasContactShape(text: string): boolean {
  return (
    EMAIL_TEST_RE.test(text) ||
    PHONE_TEST_RE.test(text) ||
    LINKEDIN_TEST_RE.test(text)
  );
}

// ── Two-column band model (#117 / #574) ─────────────────────────────────────

/**
 * Which band of a detected two-column page a line sits in.
 *
 *   - `"sidebar"` — the NARROW rail (contact / languages / skill bars). The only
 *     band the unguarded trailing-anchor recovery (#117) may run on.
 *   - `"body"`    — the WIDE column carrying the résumé's entry content.
 *   - `"unknown"` — the page splits into two columns of comparable width, so
 *     neither is a sidebar. Fails closed: no band-gated recovery runs.
 *
 * `undefined` (not a `ColumnBand`) means the line's page carries no split at all
 * — a single-column page, where the single-column-only recoveries apply instead.
 */
type ColumnBand = "sidebar" | "body" | "unknown";

/** Which side of a split page's gutter the narrow sidebar rail sits on. */
type SidebarSide = "left" | "right";

/**
 * Fraction of the WIDER column's width that the narrower one must not exceed for
 * a split page to read as sidebar + body rather than two peer columns. Across
 * the labeled two-column corpus every page's narrow band measures 0.37–0.55 of
 * its wide band, so 0.7 clears all of them while leaving a balanced 50/50
 * two-column layout (ratio ≈ 1.0) classified `"unknown"` — where the unguarded
 * recovery, which trades its prose guards for a sidebar-membership signal, has
 * no sidebar to lean on and must not fire.
 */
const SIDEBAR_MAX_WIDTH_RATIO = 0.7;

/**
 * Per-page sidebar SIDE for every page carrying a column split — the signal that
 * replaces the side-blind `line.x >= columnSplitX` gate (#574).
 *
 * `detectColumnBoundaries` reports only WHERE the gutter is, not which side of it
 * holds the sidebar. Reading `x >= split` as "sidebar" silently assumes a
 * sidebar-RIGHT layout; on a sidebar-LEFT résumé the polarity inverts and the
 * whole résumé BODY lands above the split, handing every body line — role
 * headers, company names, wrapped bullet fragments — to a matcher that carries no
 * prose guards at all. One anchor-ending line then opens a spurious section that
 * swallows the rest of the document.
 *
 * The side-independent tell is width: a sidebar is the NARROW rail, whichever
 * side it sits on. Both widths are measured against the page's own ink box — the
 * leftmost line start and the rightmost item edge on that page — so a full-width
 * banner spanning the gutter shifts the box, never the verdict. A page whose two
 * bands are of comparable width has no sidebar and is left out of the map.
 */
function detectSidebarSides(
  lines: PdfLine[],
  columnBoundaries: Map<number, number>,
): Map<number, SidebarSide> {
  const inkBox = new Map<number, { minX: number; maxX: number }>();
  for (const line of lines) {
    if (!columnBoundaries.has(line.page)) continue;
    const right = Math.max(...line.items.map((it) => it.x + it.width));
    const box = inkBox.get(line.page);
    if (box) {
      box.minX = Math.min(box.minX, line.x);
      box.maxX = Math.max(box.maxX, right);
    } else {
      inkBox.set(line.page, { minX: line.x, maxX: right });
    }
  }

  const sides = new Map<number, SidebarSide>();
  for (const [page, box] of inkBox) {
    const split = columnBoundaries.get(page)!;
    const leftWidth = split - box.minX;
    const rightWidth = box.maxX - split;
    if (leftWidth <= 0 || rightWidth <= 0) continue;
    if (leftWidth <= rightWidth * SIDEBAR_MAX_WIDTH_RATIO) sides.set(page, "left");
    else if (rightWidth <= leftWidth * SIDEBAR_MAX_WIDTH_RATIO)
      sides.set(page, "right");
  }
  return sides;
}

/**
 * The band a single line sits in: `undefined` when its page carries no split,
 * `"unknown"` when the page splits into two peer columns (no sidebar), else
 * `"sidebar"`/`"body"` by which side of the split the line starts on.
 */
function columnBandOf(
  line: PdfLine,
  columnBoundaries: Map<number, number> | undefined,
  sidebarSides: Map<number, SidebarSide>,
): ColumnBand | undefined {
  const splitX = columnBoundaries?.get(line.page);
  if (splitX === undefined) return undefined;
  const side = sidebarSides.get(line.page);
  if (side === undefined) return "unknown";
  const inLeftBand = line.x < splitX;
  return (side === "left") === inLeftBand ? "sidebar" : "body";
}

// ── Section splitting ───────────────────────────────────────────────────────

/**
 * Scan the lines top-to-bottom, mark lines that open a section, and bucket
 * everything between headers. Content above the first header lands in the
 * synthetic `profile` section.
 *
 * A line opens a section boundary when ANY of:
 *   - keyword path: `matchSectionHeader` (L1 exact alias → L2 head-noun anchor)
 *     returns a canonical name → label = that section; or
 *   - visual path (L3 / #112): the line is visually a header (`isVisualHeader`)
 *     and is not a leading name/contact line → open an `other` boundary. The
 *     keyword path has already declined the line by this point, so the label is
 *     always `other` — the boundary-only sink that terminates the prior section
 *     without rendering (`regex.ts` keeps `other` out of the anchor path and out
 *     of every `findSection` lookup in `openresume.ts`); or
 *   - column-gated sidebar recovery (#117 / #574): a body-size, header-shaped,
 *     un-dated line in the SIDEBAR band of a detected two-column layout
 *     (`columnBoundaries` + `detectSidebarSides`) whose trailing token is a
 *     fallback-enabled section anchor → label = that section. This recovers a
 *     real header that a two-column flatten glued a sidebar bar-value onto
 *     ("20% Projects"). The sidebar signal stands in for the prose guards the
 *     unguarded `matchSectionAnchorToken` lookup drops, so it never fires on
 *     body-column prose ("5 Years Experience") or single-column docs.
 *
 * Name/contact disambiguation: the leading profile region opens with a cluster
 * of large-font name / title / tagline lines (a résumé header), then the
 * contact line(s). A genuine invented-label heading always comes *after* that
 * cluster. So while still in the profile region, a visual header is suppressed
 * (kept in profile) until a contact-shaped line (email / phone / LinkedIn) has
 * been seen — that contact line marks the end of the name block. This is what
 * stops the largest-font line at the top (the name), and any title/tagline
 * stacked under it, from becoming a section header and shattering the parse,
 * while still letting a font-distinct invented header below the contact block
 * open a boundary. Once any section has opened, the disambiguation no longer
 * applies (a visual header is then unconditionally a real boundary).
 *
 * `columnBoundaries` is the per-page split-x map from `detectColumnBoundaries`
 * (present only for detected two-column pages; undefined/empty otherwise). Paired
 * with `detectSidebarSides` it resolves each line to a {@link ColumnBand}, which
 * feeds the sidebar-header recovery branch in `classifyLine` (#117): a glued
 * sidebar artifact like `"20% Projects"` in the sidebar rail recovers its real
 * section name. For single-column docs the map is absent and that branch never
 * fires — output stays byte-identical to the pre-#117 behavior.
 */
export function splitIntoSections(
  lines: PdfLine[],
  columnBoundaries?: Map<number, number>,
): PdfSection[] {
  // Single-column docs enable the #310/#311 second-experience-header boundary
  // (see the adjacency note in `classifyLine`). Two-column layouts keep the
  // stricter #258 suppression: a sidebar flatten interleaves recovered anchors
  // mid-column, where a relaxed boundary would mint spurious sections.
  const singleColumn = !columnBoundaries || columnBoundaries.size === 0;
  // Which side of each split page holds the narrow sidebar rail (#574). Computed
  // once here — it is a page-level property, not a per-line one.
  const sidebarSides =
    columnBoundaries && columnBoundaries.size > 0
      ? detectSidebarSides(lines, columnBoundaries)
      : new Map<number, SidebarSide>();

  // Single-column LABEL-RAIL layout (#355): the section keywords live in a
  // narrow left rail (x ≈ rail margin) while ALL body content — role headers,
  // bullets, the skills grid — sits well to the right. `detectColumnBoundaries`
  // correctly finds no gutter (the rail is too narrow / low-coverage), so this
  // is genuinely single column, but the per-line splitter below can't see the
  // rail structure: the rail labels never share a row with the content they
  // head, the skills grid fragments into one PdfLine per cell (irregular
  // per-cell baselines), and the tokens scatter into whatever section is open.
  // `splitByLabelRail` partitions by the rail geometry instead, routing the
  // body between rail labels; it returns null (fall through to the per-line
  // splitter) whenever the tight rail signature isn't present, so no non-rail
  // corpus layout is affected.
  if (singleColumn) {
    const railSections = splitByLabelRail(lines);
    if (railSections) return railSections;
  }

  const sections: PdfSection[] = [{ name: "profile", lines: [] }];
  const bodyBaseline = computeBodyBaseline(lines);
  const bodyLineHeight = computeBodyLineHeight(lines);
  // True until the first non-profile section (keyword or visual) opens.
  let openedRealSection = false;
  // True once the leading name/title block has ended — signalled by the first
  // contact-shaped line inside the profile region.
  let seenContactInProfile = false;
  // True when the immediately-preceding line opened a section boundary. The
  // single-word gap-cue header path (#216) is suppressed right after a boundary:
  // a real header never directly follows another header, and the first content
  // line under a header inherits an inflated gap-above (it's measured against the
  // header), e.g. the first ALL-CAPS skill token `HTML` directly under `SKILLS`
  // in a column-reordered skills grid — the #112 inline-acronym FP this guard
  // keeps closed.
  let prevLineOpenedBoundary = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Single-column SAME-ROW stacked grid rail label (#355 gap 2): a section
    // keyword split vertically across two consecutive rail rows ("Technical"
    // over "Skills") whose grid VALUES share the label's row (no separated rail,
    // so `splitByLabelRail` above declines). Checked before `classifyLine`,
    // gated to single column and to past the leading name/contact block, and
    // only when this row is not itself an already-recognized header — so an
    // ordinary two-line profile pair can't mint a false section. Opens the
    // section and routes both rows' grid remainders into it, consuming the
    // second row.
    if (
      singleColumn &&
      (openedRealSection || seenContactInProfile) &&
      i + 1 < lines.length &&
      !matchSectionHeaderDetailed(line.text)
    ) {
      const stacked = tryStackedRailLabel(line, lines[i + 1]);
      if (stacked) {
        sections.push({
          name: stacked.section,
          rawHeading: stacked.rawHeading,
          lines: [...stacked.remainders],
        });
        openedRealSection = true;
        prevLineOpenedBoundary = true;
        i++; // consume the second stacked-label row
        continue;
      }
    }

    // Per-line two-column band (undefined for single-column pages / docs).
    const columnBand = columnBandOf(line, columnBoundaries, sidebarSides);
    const action = classifyLine(
      line,
      bodyBaseline,
      bodyLineHeight,
      openedRealSection,
      seenContactInProfile,
      prevLineOpenedBoundary,
      columnBand,
      sections[sections.length - 1].name,
      singleColumn,
      lines[i + 1],
    );
    if (action.kind === "open") {
      const opened: PdfSection = {
        name: action.name,
        rawHeading: action.rawHeading ?? line.text.trim(),
        lines: [],
      };
      // #355 gap 1: retain the inline header row's remainder as the section's
      // first content line (the role/degree entry that shared the keyword's row).
      if (action.retainLine) opened.lines.push(action.retainLine);
      sections.push(opened);
      openedRealSection = true;
      prevLineOpenedBoundary = true;
      continue;
    }
    prevLineOpenedBoundary = false;
    if (action.marksContactEnd) seenContactInProfile = true;
    sections[sections.length - 1].lines.push(line);
  }

  return sections;
}

/** What `classifyLine` decided to do with one line. */
type LineAction =
  | {
      kind: "open";
      name: SectionName;
      rawHeading?: string;
      /**
       * A content line to RETAIN in the newly-opened section (the #355
       * single-column leading-token recovery: the row's non-header remainder,
       * which carries the section's first entry — a role title + dates, a
       * degree + institution). Absent for ordinary headers, whose line is a pure
       * label consumed by the boundary.
       */
      retainLine?: PdfLine;
    }
  | { kind: "append"; marksContactEnd: boolean };

/**
 * Strip a leading sidebar-value token glued onto a recovered header by the
 * two-column flatten (#117's `matchSectionAnchorToken` recovery, e.g.
 * `"20% Projects"`). Reuses Guard 7's own casing rule (regex.ts) — a genuine
 * header word starts with an uppercase letter, so drop leading words that
 * don't (the glued bar-value, "20%", "5", "10+", …) and keep the rest,
 * always leaving at least the final (anchor) word. This both cleans up the
 * `#285` verbatim-heading display and keeps the round-trip closed: the
 * cleaned heading, re-emitted verbatim into the reconstructed single-column
 * PDF (`ats-resume-model.ts`), no longer carries a digit-lead token that
 * would fail Guard 7 on re-parse (#324) — the column signal that justified
 * the unguarded recovery is gone in the reconstruction, so the stored
 * heading must be guard-clean on its own.
 */
function stripSidebarNoisePrefix(raw: string): string {
  const words = raw.trim().split(/\s+/).filter((w) => w.length > 0);
  let i = 0;
  while (i < words.length - 1 && !/^\p{Lu}/u.test(words[i])) i++;
  return words.slice(i).join(" ");
}

/**
 * #258 / #310-311 institution-repeat gate. A head-noun-anchor (L2) line that
 * re-matches the CURRENTLY-open section is normally an institution/company
 * entry sitting under its own real header ("ACME PROFESSIONAL EDUCATION" under
 * an open EDUCATION header) — the boundary is suppressed so the line is
 * RETAINED as content rather than consumed as a second label (which drops the
 * institution name).
 *
 * The ADJACENCY relaxation (#310/#311, single-column only) — a same-canonical
 * L2 header that is NOT the immediate first content line
 * (`!prevLineOpenedBoundary`, i.e. a full entry block has intervened) opens a
 * genuinely NEW group — is EXPERIENCE-only: only there does a second category
 * header ("Teaching Experience" after a role under "Performance Experience")
 * legitimately start its own section (#311). Every OTHER section type keeps the
 * strict #258 suppression regardless of adjacency; otherwise a 2nd+ entry whose
 * institution name ends in a section-anchor word ("... School of Education")
 * wrongly opens a new section and the entry's content is lost (#258 regression).
 * Two-column layouts also keep the strict suppression (`!singleColumn`): a
 * sidebar flatten interleaves recovered anchors mid-column where the relaxation
 * would mint spurious sections.
 *
 * L1 exact-alias / split-letter headers (incl. multi-page "EXPERIENCE"
 * continuation headers) are not `viaAnchorFallback` and always open — they
 * short-circuit to `false` here.
 *
 * The single-column experience relaxation needs a signal STRONGER than
 * `prevLineOpenedBoundary` (which only inspects the immediately-preceding line):
 * a full entry block having intervened is necessary but NOT sufficient to open a
 * new group. A later role's COMPANY name that happens to end in an anchor word
 * ("Global Teaching Experience Inc.") also sits after an intervening block, yet
 * must stay in the same section — consuming it as a heading would drop the
 * company (#354, the residual #258-shape edge). `lineLooksLikeDatedEntry`
 * separates the two: a genuine bare category header ("Teaching Experience", #311)
 * is followed by its role's TITLE line, never a date, whereas an anchor-ending
 * company/role line carries a date range on itself or the line immediately below
 * it — so it reads as an entry and keeps the strict suppression.
 */
function isInstitutionRepeat(
  header: { section: SectionName; viaAnchorFallback: boolean },
  currentSection: SectionName | "profile",
  singleColumn: boolean,
  prevLineOpenedBoundary: boolean,
  lineLooksLikeDatedEntry: boolean,
): boolean {
  if (!header.viaAnchorFallback || header.section !== currentSection) {
    return false;
  }
  // Non-experience sections: strict #258 suppression, adjacency ignored.
  if (header.section !== "experience") return true;
  // Two-column flatten: strict #258 suppression (a sidebar flatten interleaves
  // recovered anchors mid-column where a relaxed boundary mints spurious groups).
  if (!singleColumn) return true;
  // The institution/company line that is the immediate first content line under
  // the header is always an entry, never a 2nd header — suppress.
  if (prevLineOpenedBoundary) return true;
  // A full entry block has intervened. Open a NEW experience group only for a
  // genuine bare category header (#311); an anchor-ending company/role line that
  // reads as a dated entry stays suppressed so its company is not lost (#354).
  return lineLooksLikeDatedEntry;
}

/**
 * True when a line carries a date range — the tell that separates a dated
 * company/role ENTRY line from a bare section-category HEADER (#354). Uses the
 * shared `DATE_RANGE_RE` (non-global, so `.test` is stateless). A `undefined`
 * line (past the end of the document) carries no date.
 */
function hasDateRange(line: PdfLine | undefined): boolean {
  return line !== undefined && DATE_RANGE_RE.test(line.text);
}

// ── Single-column label-rail header recovery (#355) ─────────────────────────
//
// A "section-label rail" résumé (single column — `detectColumnBoundaries` finds
// no gutter) puts the section keyword in a left rail cell that pdfjs merges onto
// the SAME line as the section's first entry. Two shapes slip past every
// existing recognizer:
//
//   1. INLINE / leading-token header — the keyword LEADS a long merged content
//      row ("Experience  Staff Engineer, Platform  Aug 2024 - Present").
//      `matchSectionHeaderDetailed` bails (`normalized.length > 40`), the
//      head-noun anchor fallback needs the head noun LAST, and the visual paths
//      need a short header-shaped line — so the row never opens its section.
//   2. STACKED grid rail label — the keyword is split VERTICALLY across two rows
//      ("Technical" over "Skills"), each the lead cell of a skills grid, so
//      neither single row's lead token equals the `technical skills` alias.
//
// Both recoveries are gated to SINGLE-COLUMN only (`columnBand === undefined`
// / `singleColumn`): the unguarded trailing-anchor path (`matchSectionAnchorToken`)
// is the two-column analogue, and loosening recognition on the labeled two-column
// corpus regresses it. Neither path here calls that forbidden text-only-unsafe
// lookup.

/**
 * Sections whose inline leading-token header we recover on the single-column
 * text-only path — restricted to the two with a strong, closed-shape "first
 * entry" tell (a date range for experience; a degree/institution for
 * education). `skills`/`summary`/etc. have no comparably tight remainder shape,
 * so admitting them here would reopen prose false positives — they stay out.
 */
const LEADING_TOKEN_SECTIONS: readonly SectionName[] = ["experience", "education"];

// A strong date anchor that a bare `YYYY - YYYY` span lacks: a month-year, a
// season-year, a numeric slash-date, an apostrophe-year, a `20XX` redaction
// stub, or an open-ended "Present"-family token. Requiring one inside the
// remainder is what separates a real role date tail ("Aug 2024 - Present",
// "06/2021 - 09/2023") from a coincidental bare year span buried in prose
// ("Marathon running club, 2018 - 2022").
//
// Two consumers, for the same reason: `remainderLooksLikeEntry` (#355, the
// leading-token rail header) and `looksLikeHeaderlessRoleHeader` (#492, the
// headerless-cluster recovery). Both are recognising an experience entry with
// no header to check themselves against, so both need the bare-year span held
// out; sharing the token is what keeps them from drifting on what a "real role
// date" is.
//
// The month and season anchors REQUIRE an adjacent year: this rejects a bare
// year span with no month/season token ("2018 - 2022") — the coincidental-prose
// case above — and defuses the verb "may" and a stray "Marathon"/"March" NOT
// followed by a year. It does NOT, on its own, reject a month word that happens
// to be directly followed by a year ("Marathon 2018" still matches); that
// residual is held out by the two guards this token is AND-ed with — a real
// `DATE_RANGE_RE` span AND the leading alias being item[0]'s own text run — not
// by this regex alone. Non-global, so `.test` is stateless.
const STRONG_DATE_TOKEN_RE = new RegExp(
  [
    // month-year: "Aug 2024", "August 2024", "Aug. '24", "Sep 20XX"
    "\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+(?:\\d{4}|'\\d{2}|20XX)",
    // season-year: "Summer 2013"
    "\\b(?:Spring|Summer|Fall|Autumn|Winter)\\s+\\d{4}",
    // numeric slash date: "06/2021", "6-2021"
    "\\d{1,2}[/-]\\d{4}",
    // open-ended present-family token
    "\\b(?:Present|Current|Ongoing|Now)\\b",
    // apostrophe-year / redaction stub, standalone
    "'\\d{2}\\b",
    "\\b20XX\\b",
  ].join("|"),
  "i",
);

// Longest leading slice of an education remainder in which the degree/institution
// tell must appear. A real first entry LEADS with the degree or the school name,
// so a credential word buried deep in a sentence ("… a member of the Broad
// Institute alumni network") is rejected — only a lead-anchored tell counts.
const EDU_LEAD_WINDOW = 64;

/**
 * True when `remainder` (the row text after the leading section keyword) reads
 * like that section's FIRST entry — the guard that separates a real inline rail
 * header from a coincidental keyword-led PROSE line (#355 FP defense).
 *
 * Two prose rejections apply to BOTH sections, because a real rail first entry
 * is a proper-noun / title-cased run (a job title, a degree, a school):
 *   1. It must LEAD with an uppercase letter. A lowercase connective lead
 *      ("spanning …", "focused …") or a numeric lead ("8 years …") is prose.
 *   2. It must not END as a sentence (terminal `.`/`!`/`?`).
 *
 * Then the section-specific tell:
 *   - experience: a STRONG date range — a real month/season/slash/Present-anchored
 *     tail, NOT a bare `YYYY - YYYY` span (many prose lines carry a bare year
 *     pair, so `DATE_RANGE_RE` alone over-admits).
 *   - education: a degree credential OR institution name anchored in the LEADING
 *     portion (the entry leads with it; a hint buried mid-sentence does not count).
 * All regexes are non-global, so `.test` is stateless here.
 */
function remainderLooksLikeEntry(section: SectionName, remainder: string): boolean {
  const trimmed = remainder.trim();
  if (!trimmed) return false;
  // Prose guards (both sections).
  if (!/^[A-Z]/.test(trimmed)) return false; // lowercase / numeric lead → prose
  if (/[.!?]\s*$/.test(trimmed)) return false; // terminal sentence mark → prose
  if (section === "experience") {
    // Strong, closed-shape tell: a real role date tail, not a bare year span.
    return DATE_RANGE_RE.test(trimmed) && STRONG_DATE_TOKEN_RE.test(trimmed);
  }
  // education: degree/institution, anchored in the leading portion.
  const lead = trimmed.slice(0, EDU_LEAD_WINDOW);
  return DEGREE_RE.test(lead) || INSTITUTION_HINTS.test(lead);
}

// ── Headerless experience recovery (#492) ───────────────────────────────────
//
// Every path above recognises the experience section from a HEADER — a keyword
// alias, a trailing anchor word, a font/gap cue, a leading rail token. A résumé
// that writes no header at all over its work history therefore has no path to
// `experience`: the role lines land in whatever bucket is open (the leading
// `profile`, a `summary` blurb, or an `other` sink an unrelated header opened)
// and `extractExperience` — which only ever reads a routed `experience` region
// — parses zero entries. The whole employment history is dropped silently.
//
// The signal that has to stand in for the missing header is the ENTRY SHAPE
// itself, which is why this runs as a POST-pass over the finished section list
// rather than as another branch in `classifyLine`:
//
//   - it needs to know that NO experience section exists anywhere in the
//     document, which a top-to-bottom per-line classifier cannot know yet;
//   - a cluster is a property of several lines together, not of one line; and
//   - leaving the per-line loop untouched means the recovery cannot perturb the
//     routing of any résumé it does not actually fire on.
//
// It is also the reason it lives on the SECTION list and not on `PdfLine[]`:
// `splitIntoSectionsWithMarkdown` is the path a real résumé usually takes (the
// #492 reproducer routes `markdown`), and both splitters converge here through
// `buildHeuristicResult` in `openresume.ts` — the single call site.

/**
 * The buckets a headerless work-history cluster can legitimately be sitting in.
 *
 * All three are sections that own NO entry content in the canonical model:
 * `profile` is everything above the first header, `summary` is a prose blurb,
 * and `other` is the boundary-only sink (`regex.ts` keeps it out of the anchor
 * path and out of every `findSection` lookup in `openresume.ts`). Nothing
 * downstream extracts dated entries from any of them, so re-labelling a run of
 * their lines `experience` can only add information.
 *
 * Every OTHER section is deliberately excluded, and `education` / `projects` /
 * `certifications` / `achievements` are the reason: each of those legitimately
 * owns a cluster of dated entries, so a shape-only rule let loose on them would
 * not recover a dropped work history — it would steal a correctly-routed one.
 */
const HEADERLESS_EXPERIENCE_HOSTS: readonly (SectionName | "profile")[] = [
  "profile",
  "summary",
  "other",
];

/**
 * How many dated role headers must appear in one host bucket before it reads as
 * a work history rather than a coincidence.
 *
 * Two is the whole structural half of the rule. A single dated, title-cased,
 * non-prose line is an ordinary thing to find in a highlights or summary block
 * ("Speaker, QCon London, Mar 2019"); a *run* of them, each naming a different
 * employer, is a work history and nothing else. Raising this to 3 would drop
 * the very common two-job résumé; lowering it to 1 deletes the only signal that
 * separates the cluster from its neighbours.
 */
const HEADERLESS_ROLE_CLUSTER_MIN = 2;

/**
 * True when a line reads as an employment-entry header STRONGLY ENOUGH to open
 * a section on its own — i.e. with no header above it vouching for it.
 *
 * This is a deliberately higher bar than `isAnchorLine`'s `date_range` test in
 * `entry-blocks.ts`, which only has to segment entries INSIDE a region the
 * router already vouched for. Here the line is the only evidence there is, so
 * every gate below is a false-positive guard first and a recogniser second:
 *
 *   1. Not a bullet — a bullet is body text, and bullet prose routinely carries
 *      a date range ("Owned the 2021 - 2023 replatform").
 *   2. A date range on the line, and it must be a STRONG one
 *      ({@link STRONG_DATE_TOKEN_RE}: month-year, season-year, slash-date, or a
 *      Present-family token). This single gate does most of the work. A bare
 *      `YYYY - YYYY` span is what prose, award lists, membership lines and
 *      degree entries carry ("Marathon running club, 2018 - 2022"), and
 *      admitting it is how a shape rule turns into a section-stealing rule.
 *   3. A non-empty HEAD before the date that leads with an uppercase letter.
 *      The head is the part that would be the title/company, so an empty head
 *      (a date-led or date-only line) has nothing to identify a role with.
 *   4. That head reads as an entry header, not prose — {@link isEntryHeaderShape},
 *      the same shared shape test the entry segmenter uses.
 *   5. That head is not an EDUCATION entry. Guard 2 already rejects the common
 *      bare-year degree line, but a month-dated one ("B.S. in Computer Science,
 *      Ridgemont State University (Aug 2012 - May 2016)") clears it, and an
 *      education cluster with no `EDUCATION` header is exactly as plausible as
 *      a work history with no `EXPERIENCE` header. Reading a degree list as
 *      employment is worse than leaving it where it was.
 *
 * Guard 5's degree half is ANCHORED TO THE LEAD, and that is not a stylistic
 * choice: `DEGREE_RE`'s abbreviation alternatives are two-letter tokens, and
 * four of them are also US state codes — `MA`, `MD`, `MS`, `ME`. Tested anywhere
 * in the head, "Marathon Running Club, Boston, MA" reads as a master's degree
 * and every Massachusetts / Maryland / Mississippi / Maine role header is
 * rejected out of hand. A real education entry LEADS with its degree, so the
 * anchor costs nothing and closes the whole class. The institution half is
 * NOT anchored, and that half does have a cost: `University` / `College` /
 * `Institute` / `School` / `Academy` / `Polytechnic` are all real EMPLOYERS
 * too, so "Research Engineer, Stanford University (Sep 2018 - Jun 2021)" is
 * rejected as a degree line. A whole headerless cluster of such roles recovers
 * ZERO of them. The trade is deliberate and one-directional: this predicate is
 * the only thing standing between a headerless bucket and a section relabel,
 * it has no header to check itself against, and a degree list read as
 * employment is worse than a school-employed role left where it was — so it
 * fails CLOSED. Anchoring the institution half the way the degree half is
 * anchored (a real education entry leads with its DEGREE, not its school) is a
 * plausible follow-up, but it widens what the rule will relabel and so needs
 * its own repro and corpus measurement rather than riding this guard.
 *
 * The residue the anchor leaves is a title that LEADS with one of `DEGREE_RE`'s
 * full words ("Associate Product Manager", "Master Data Engineer"): that line is
 * rejected. It costs a role only when it is the FIRST of the cluster, since the
 * others still match and the split simply starts at one of them — and erring
 * toward leaving content where it was is the correct direction for a rule with
 * no header to check itself against.
 *
 * The head is taken BEFORE the date rather than testing the whole line because
 * a role header may carry its scope sentence glued on after the date range
 * ("… (Mar 2021 - Present) Leads the automation guild."). Testing the whole
 * line would reject that on the terminal `.` — which is why this predicate is
 * a sibling of {@link remainderLooksLikeEntry} (#355) rather than a caller of
 * it: that one tests a whole remainder and must reject a sentence outright.
 */
function looksLikeHeaderlessRoleHeader(line: PdfLine): boolean {
  if (isBulletLine(line)) return false;
  const text = line.text.trim();
  const match = DATE_RANGE_RE.exec(text);
  DATE_RANGE_RE.lastIndex = 0;
  if (!match) return false;
  if (!STRONG_DATE_TOKEN_RE.test(text)) return false;
  const head = text.slice(0, match.index).trim();
  if (!/^\p{Lu}/u.test(head)) return false;
  if (!isEntryHeaderShape(head)) return false;
  if (INSTITUTION_HINTS.test(head)) return false;
  const degree = DEGREE_RE.exec(head);
  return degree === null || degree.index !== 0;
}

/**
 * Open an `experience` section on ENTRY SHAPE when the résumé wrote no header
 * over its work history (#492).
 *
 * The rule, stated whole:
 *
 *   On a single-column document that routed NO experience section at all, the
 *   FIRST bucket among `profile` / `summary` / `other` that contains at least
 *   {@link HEADERLESS_ROLE_CLUSTER_MIN} lines passing
 *   {@link looksLikeHeaderlessRoleHeader} is split at the FIRST of those lines:
 *   everything from there to the end of the bucket becomes a new `experience`
 *   section, and everything above it stays where it was.
 *
 * Four scoping decisions carry the risk, and each is a "must not fire" case:
 *
 *   - **Single-column only.** On a two-column page the band model (#574) is what
 *     tells a sidebar rail from the résumé body, and an unguarded shape rule
 *     running across a flattened two-column body is the false-positive class
 *     #574 spent its whole diff closing. A headerless two-column work history
 *     stays dropped; that is the conservative side of the trade.
 *   - **Only when no `experience` section exists.** If the router already found
 *     one, a later dated cluster is a continuation, a second experience group
 *     (#311), or a projects/volunteer block — never a missing section.
 *   - **Only the three content-free hosts** — see {@link HEADERLESS_EXPERIENCE_HOSTS}.
 *   - **Split, never relabel.** The reproducing shape puts the cluster BELOW two
 *     lines of prose inside the same `other` bucket; renaming the whole bucket
 *     `experience` would feed that prose to the entry segmenter as a role.
 *
 * Known residue, stated rather than guessed at: a headerless role whose header
 * is STACKED across two lines ("Senior QA Engineer" / "Northwind Systems  Mar
 * 2021 - Present") opens at the dated line, so the first role's title line is
 * left in the host bucket. Reaching back for it would mean admitting the line
 * directly above the cluster, which on the reproducing fixture is a sentence of
 * highlights prose — a false positive traded for a residue, on a shape no repro
 * pins. Roles 2..N in the same cluster are unaffected: they sit inside the
 * recovered region, where the segmenter's own `headerLookback` already claims
 * their title line.
 */
export function recoverHeaderlessExperience(
  sections: PdfSection[],
  singleColumn: boolean,
): PdfSection[] {
  if (!singleColumn) return sections;
  if (sections.some((s) => s.name === "experience")) return sections;

  for (let i = 0; i < sections.length; i++) {
    const host = sections[i];
    if (!HEADERLESS_EXPERIENCE_HOSTS.includes(host.name)) continue;
    const roleAt: number[] = [];
    host.lines.forEach((l, at) => {
      if (looksLikeHeaderlessRoleHeader(l)) roleAt.push(at);
    });
    if (roleAt.length < HEADERLESS_ROLE_CLUSTER_MIN) continue;
    const start = roleAt[0];
    const recovered: PdfSection = {
      name: "experience",
      // No `rawHeading`: the résumé wrote none, and inventing one would put a
      // label the document never carried into `sectionHeadings` (#285) and from
      // there into the reconstructed export.
      lines: host.lines.slice(start),
    };
    const next = [...sections];
    next[i] = { ...host, lines: host.lines.slice(0, start) };
    next.splice(i + 1, 0, recovered);
    return next;
  }
  return sections;
}

/** Build a `PdfLine` from a contiguous subset of another line's items (the row
 *  remainder after the leading rail label), inheriting the parent's `gapAbove`.
 *  Mirrors `groupLinesSingle`'s line builder so the retained remainder is a
 *  first-class content line downstream. */
function buildLineFromItems(items: PdfTextItem[], parent: PdfLine): PdfLine {
  const text = mergeItemText(items);
  const ys = items.map((i) => i.y);
  return {
    page: items[0].page,
    y: ys.reduce((a, b) => a + b, 0) / ys.length,
    x: items[0].x,
    items: [...items],
    text,
    maxFontSize: Math.max(...items.map((i) => i.fontSize)),
    allCaps: text.replace(/[^A-Za-z]/g, "").length > 0 && text === text.toUpperCase(),
    gapAbove: parent.gapAbove,
  };
}

/**
 * Minimum horizontal gap (pt) between an inline alias's right edge and the
 * remainder's left edge for the alias to read as a STANDALONE rail label rather
 * than the first word of a compound title. In a genuine label-rail inline header
 * the alias sits in the rail and the entry in the body, so the remainder's left
 * edge is a LARGE rail→body jump (≥~20pt in tests, ~26pt+ observed on real rail
 * résumés); a compound job title ("Experience Designer") has ordinary inter-word
 * spacing (~2–5pt). 12pt sits well above that word-space band yet below every
 * observed rail→body gap, so it splits the two without weakening rail recovery.
 */
const STANDALONE_ALIAS_MIN_GAP = 12;

/**
 * Recover an INLINE leading-token header (#355 gap 1). Matches the section alias
 * against a whole-ITEM prefix of the line — NOT a sub-word split of the merged
 * text. Requiring the alias to align to item boundaries is the first FP guard: a
 * rail label is drawn as its own positioned text run (its own item), whereas a
 * job title rendered as one continuous run has item[0] = the whole title, which
 * never equals a bare alias.
 *
 * That guard has a residual (Rohith, #355): a compound title whose FIRST WORD is
 * itself a bare alias AND renders as its own item (bold first word / heavy
 * tracking / a ligature split) — "Experience Designer", "Education Specialist" —
 * satisfies the item-boundary check. The {@link STANDALONE_ALIAS_MIN_GAP} guard
 * below closes the common case: it rejects a TIGHTLY-SPACED title-case
 * continuation (the next word of the same phrase), admitting only a standalone
 * alias with a real rail→body gap before the entry.
 *
 * A narrower residual is left DELIBERATELY: a same-x split (a compound title
 * whose first word is drawn with an unusually WIDE ≥12pt tracking gap, or stacked
 * at the same x) could still slip. Blast radius is bounded — `education` is
 * additionally protected by its degree/institution `remainderLooksLikeEntry`
 * tell, and a spurious `experience` re-open merges back into the real section via
 * `byName` (`toSectionedResume`), so no content is stranded.
 *
 * The remainder items (past the alias) become the section's retained first
 * content line. Returns null when no guarded match is found.
 */
/**
 * Match the `k`-item leading prefix of `line` against a {@link
 * LEADING_TOKEN_SECTIONS} alias, returning the header split when the remainder
 * reads like that section's first entry. Extracted from {@link
 * matchLeadingTokenHeader} so the prefix-scan loop body stays flat.
 */
function matchAliasPrefix(
  line: PdfLine,
  k: number,
): { section: SectionName; alias: string; remainder: PdfLine } | null {
  const items = line.items;
  const aliasTrim = mergeItemText(items.slice(0, k)).trim();
  // Reject a trailing colon on the label run (#355 FP): "Experience:" leads an
  // inline "label: value" prose/summary line ("Experience: 8 years …"), never a
  // clean rail cell header. A rail label carries no colon — reject rather than
  // normalize the colon away.
  if (aliasTrim.endsWith(":")) return null;
  const normalized = aliasTrim.toLowerCase().replace(/[·•]+$/, "").trim();
  const section = LEADING_TOKEN_SECTIONS.find((s) =>
    SECTION_KEYWORDS[s].includes(normalized),
  );
  if (!section) return null;
  const remItems = items.slice(k);
  if (!remainderLooksLikeEntry(section, mergeItemText(remItems))) return null;
  // Standalone-alias gap guard: a tightly-spaced title-case continuation
  // ("Experience" ‖ "Designer") is the same compound title, not a rail label
  // over a body entry — reject it. Only a large rail→body gap (or a
  // non-title-case remainder, already excluded above) qualifies as standalone.
  const aliasEnd = items[k - 1];
  const gap = remItems[0].x - (aliasEnd.x + aliasEnd.width);
  if (gap < STANDALONE_ALIAS_MIN_GAP && /^[A-Z]/.test(remItems[0].str.trim())) {
    return null;
  }
  return { section, alias: aliasTrim, remainder: buildLineFromItems(remItems, line) };
}

function matchLeadingTokenHeader(
  line: PdfLine,
): { section: SectionName; alias: string; remainder: PdfLine } | null {
  const items = line.items;
  if (items.length < 2) return null; // need alias prefix + a non-empty remainder
  // Aliases are ≤3 words; a rail label is ≤3 items. Try the shortest matching
  // prefix first so a longer alias's own prefix ("work" of "work experience")
  // is only consulted when the short form isn't itself an alias.
  const maxPrefix = Math.min(3, items.length - 1);
  for (let k = 1; k <= maxPrefix; k++) {
    const match = matchAliasPrefix(line, k);
    if (match) return match;
  }
  return null;
}

// ── Label-rail partitioning (#355) ──────────────────────────────────────────
//
// This SUPERSEDES the brittle `tryStackedRailLabel` grid-adjacency recognizer.
// That helper required the two stacked label rows ("Technical" over "Skills")
// to be CONSECUTIVE PdfLines and each to be a clean horizontal grid row — both
// assumptions break on a real rail résumé where the skills grid has irregular
// per-cell baselines, so pdfjs emits ~one PdfLine per cell and a stray single
// cell sits between the two label rows. Rather than pattern-match adjacent
// lines, we detect the rail from geometry and partition the body by y-band,
// which is immune to grid fragmentation and pdfjs emission order.

/** x tolerance (pt) for treating two lines' left edges as the same rail column. */
const RAIL_X_TOL = 4;

/** Max length (chars) of one horizontal grid value cell — a skill token
 *  ("Python", "Kafka") is short; a prose clause is not. */
const GRID_CELL_MAX = 24;

/**
 * True when a row PAST its lead cell reads like a horizontal grid of value
 * tokens — ≥2 cells, each short and not a sentence — rather than prose (#355
 * gap-2 finding #2 FP guard). A real SAME-ROW stacked rail label ("Technical"
 * over "Skills") sits atop a skills grid whose value cells are single short
 * tokens; two consecutive prose lines whose leads coincidentally join to an
 * alias ("Technical debt …" over "Skills matrix …") do not form such a grid.
 */
function isGridValueRow(row: PdfLine): boolean {
  // pdfjs emits whitespace-only items between separately-drawn cells; drop them
  // so they don't masquerade as (empty) value cells.
  const values = row.items
    .slice(1)
    .map((it) => it.str.trim())
    .filter((t) => t.length > 0);
  if (values.length < 2) return false;
  return values.every((t) => t.length <= GRID_CELL_MAX && !/[.!?]$/.test(t));
}

/**
 * Recover a SAME-ROW STACKED grid rail label (#355 gap 2): two consecutive
 * single-column lines whose LEADING items, joined, form a section alias
 * ("Technical" + "Skills" → `technical skills` → skills) AND whose grid VALUES
 * share the label's own row (so there is no separated rail for
 * {@link splitByLabelRail} to partition — this is its complement, not a
 * duplicate). The grid values (each row's remainder past its lead cell) become
 * the section's content. Scoped tightly — both lead cells sit in the same rail
 * column (same left x), and the joined lead tokens must EXACTLY equal a
 * canonical alias — so ordinary two-line body content can't mint a false
 * section. Returns null when the pair is not a stacked rail label.
 */
function tryStackedRailLabel(
  a: PdfLine,
  b: PdfLine,
): { section: SectionName; rawHeading: string; remainders: PdfLine[] } | null {
  if (a.items.length < 1 || b.items.length < 1) return null;
  if (a.page !== b.page) return null;
  const leadA = a.items[0];
  const leadB = b.items[0];
  // Same rail column: both lead cells share a left edge.
  if (Math.abs(leadA.x - leadB.x) > RAIL_X_TOL) return null;
  // Join the two lead cells with an explicit space — they are STACKED (same x,
  // different y), so `mergeItemText` (which infers spacing from a same-line
  // left-to-right gap) would compute a negative gap and weld them.
  const joined = `${mergeItemText([leadA])} ${mergeItemText([leadB])}`.trim();
  const matched = matchExactAlias(joined);
  if (!matched) return null;
  // Finding #2 FP guard: require each row to be a real grid (≥2 short value
  // cells past its lead), so two prose lines whose leads happen to join to an
  // alias can't mint a spurious section.
  if (!isGridValueRow(a) || !isGridValueRow(b)) return null;
  const remainders: PdfLine[] = [];
  for (const row of [a, b]) {
    if (row.items.length > 1) remainders.push(buildLineFromItems(row.items.slice(1), row));
  }
  return { section: matched, rawHeading: joined.trim(), remainders };
}

/**
 * Minimum horizontal gap (pt) between the rail's left edge and the body's left
 * edge for a layout to count as a label rail. A normal left-aligned résumé
 * indents bullets only ~15–25pt past the header/role margin, so 40pt sits well
 * above that while comfortably below the #355 rail gap (~73pt). This is the
 * primary guard against the partitioner hijacking an ordinary single-column
 * résumé whose name/headers share the left margin with role titles.
 */
const RAIL_BODY_MIN_GAP = 40;

/** A body line counts as sharing a rail label's ROW when their baselines agree
 *  within this tolerance (pt) — the "label + first entry on one visual row"
 *  signature that distinguishes a true rail from an ordinary header (which sits
 *  alone on its row with content strictly below it). A hair looser than
 *  `LINE_Y_EPS` to absorb the ~1–2pt per-cell baseline jitter of a grid row. */
const RAIL_SAMEROW_EPS = 4.5;

/**
 * Vertical tolerance (pt) by which a body line may sit ABOVE its rail label's
 * top row and still belong to that section. Rail labels are top-aligned (or,
 * when stacked, their rows interleave with the block), so the block's first body
 * row can render a POINT OR TWO above the label baseline (grid top-alignment
 * jitter) — that is all this absorbs. It MUST stay well under one line-height:
 * a rail layout commonly places the next section's label ~one line-height
 * (~11–14pt) below the previous section's last bullet, so a tolerance near a
 * full line would reach back up and STEAL that bullet into the next section (an
 * experience-bullet undercount — the exact failure this parser exists to fix).
 * So this is sub-line jitter only, in line with `RAIL_SAMEROW_EPS`.
 */
const RAIL_BAND_OVERLAP_TOL = 5;

/** Exact (non-anchor) alias match: the normalized text must equal one of a
 *  section's canonical aliases. Trailing `:`/`·`/`•` are stripped (a rail cell
 *  carries none, but a flatten can append one). Returns the section or null.
 *
 *  Intentional asymmetry vs. `matchLeadingTokenHeader` (which REJECTS a trailing
 *  colon so `"Experience:"` can't open on the inline path): here the alone-path
 *  alias is the WHOLE line text, so a bare `"Experience:"` rail cell is a real
 *  standalone section label and SHOULD open — there is no value welded onto it
 *  to worry about, unlike the inline "label: value" prose shape the colon guards. */
function matchExactAlias(text: string): SectionName | null {
  const normalized = text.trim().toLowerCase().replace(/[:·•]+$/, "").trim();
  if (!normalized) return null;
  for (const [name, aliases] of Object.entries(SECTION_KEYWORDS) as Array<
    [SectionName, readonly string[]]
  >) {
    if (aliases.includes(normalized)) return name;
  }
  return null;
}

/** Rail sections whose downstream parser is date-anchored entry-block based
 *  (`extractExperience`/`extractEducation`/…), so reassembling each fragmented
 *  "header … date" visual row into one PdfLine helps. Deliberately EXCLUDES
 *  `skills`/`summary`/`other`, whose token/prose lists a row-merge would weld. */
const ROW_MERGE_SECTIONS: readonly SectionName[] = [
  "experience",
  "education",
  "projects",
  "achievements",
];

/** A section label recovered from the rail. Its band start is the compound key
 *  (`page`, `boundaryY` = the min y of its label row(s)) — page is the PRIMARY
 *  key so a label only ever owns body lines on its OWN page (multi-page résumés
 *  restart y per page, so a bare-y band would scramble page-2 content into
 *  page-1 sections). `parentRows` are the rail lines consumed as the label itself
 *  (excluded from content); `remainders` are content lines carried on the
 *  label's OWN row(s) — the first entry after an inline leading-token keyword, or
 *  the grid VALUE cells that pdfjs merged onto a same-row stacked label
 *  ("Technical Java Python …"). They are re-injected at the label's position so
 *  they are never lost with the excluded label rows. */
interface RailLabel {
  section: SectionName;
  display: string;
  page: number;
  boundaryY: number;
  parentRows: PdfLine[];
  remainders: PdfLine[];
}

/** The content remainder carried on a rail label's own row — its items past the
 *  leading label cell — as a PdfLine, or null when the row is the label alone
 *  (the fragmented-grid case, where the values sit on their own separate lines). */
function railRowRemainder(row: PdfLine): PdfLine | null {
  return row.items.length > 1
    ? buildLineFromItems(row.items.slice(1), row)
    : null;
}

/**
 * Partition a single-column LABEL-RAIL résumé (#355) into sections by rail
 * geometry, or return null when the tight rail signature is absent (the caller
 * then falls through to the per-line splitter, so non-rail layouts are
 * untouched).
 *
 * Model: the section keywords sit in a narrow left rail; every body line lives
 * well to the right of it. We (1) find the rail (min left edge, a set of lines
 * within `RAIL_X_TOL` of it), (2) walk the rail top-to-bottom recovering each
 * label — a keyword ALONE ("Experience"), two stacked rail rows joined
 * ("Technical"+"Skills" → "technical skills"), or an inline leading-token row
 * ("Education  State University …" via `matchLeadingTokenHeader`) — and (3)
 * assign every non-label line to the label whose band it falls in — keyed on
 * `(page, y)` so a label owns only same-page body below it (or a later page with
 * no earlier label of its own); a page-2 line before any page-2 label continues
 * the last page-1 section, never scrambles into a page-1 band by y-value alone.
 * Assignment is by absolute `(page, y)`, so grid fragmentation and column-reorder
 * emission order don't matter; body lines keep their document (array) order.
 *
 * Guards against firing on an ordinary résumé: a large rail→body gap
 * (`RAIL_BODY_MIN_GAP`), ≥2 recovered labels, ≥1 label carrying body on its own
 * row (`RAIL_SAMEROW_EPS` — a header sitting alone on its row fails this), and
 * ≥2 sections that actually receive content.
 */
function splitByLabelRail(lines: PdfLine[]): PdfSection[] | null {
  if (lines.length < 4) return null;

  // Global min left edge defines the rail. A stray far-left glyph or page-number
  // could pull `railX` too far left, but that can't mint a spurious partition:
  // the `labels.length >= 2` EXACT-alias gate (plus the same-row-body signature
  // and ≥2-contentful check) is what admits a layout, and a stray glyph is not a
  // section alias — at worst it widens the rail band harmlessly.
  const railX = Math.min(...lines.map((l) => l.x));
  const railLines: PdfLine[] = [];
  const nonRail: PdfLine[] = [];
  for (const l of lines) {
    if (l.x - railX <= RAIL_X_TOL) railLines.push(l);
    else nonRail.push(l);
  }
  if (nonRail.length === 0) return null;
  const bodyMinX = Math.min(...nonRail.map((l) => l.x));
  if (bodyMinX - railX < RAIL_BODY_MIN_GAP) return null;

  const labels = recoverRailLabels(railLines, computeBodyLineHeight(lines));
  if (labels.length < 2) return null;

  // Rail signature: at least one label carries body content on its own row (the
  // rail's tell — an ordinary header sits alone, content strictly below it). An
  // inline label satisfies this by construction (its remainder shares the row).
  const hasSameRowBody = labels.some(
    (lbl) =>
      lbl.remainders.length > 0 ||
      lbl.parentRows.some((row) =>
        nonRail.some(
          (body) =>
            body.page === row.page &&
            Math.abs(body.y - row.y) <= RAIL_SAMEROW_EPS,
        ),
      ),
  );
  if (!hasSameRowBody) return null;

  return buildRailSections(lines, labels);
}

/**
 * Try to consume `railByY[i]` (and possibly `railByY[i+1]`) as a stacked rail
 * label — two same-page, same-column, vertically adjacent rows whose lead cells
 * join to an exact alias ("Technical" over "Skills"). Returns the label plus how
 * many rows it consumed (2), or null when the pair isn't a stacked alias.
 */
function tryStackedLabel(
  a: PdfLine,
  b: PdfLine | null,
  stackedMaxDy: number,
): { label: RailLabel; consumed: number } | null {
  if (
    !b ||
    b.page !== a.page ||
    Math.abs(b.x - a.x) > RAIL_X_TOL ||
    b.y - a.y > stackedMaxDy
  ) {
    return null;
  }
  const joined = `${mergeItemText([a.items[0]])} ${mergeItemText([b.items[0]])}`.trim();
  const section = matchExactAlias(joined);
  if (!section) return null;
  // Grid values that pdfjs merged onto either label row (the same-row shape) are
  // recovered as content; the fragmented shape carries none here (the values sit
  // on their own lines, routed by y-band below).
  const remainders = [railRowRemainder(a), railRowRemainder(b)].filter(
    (r): r is PdfLine => r !== null,
  );
  return {
    label: {
      section,
      display: joined,
      page: a.page,
      boundaryY: Math.min(a.y, b.y),
      parentRows: [a, b],
      remainders,
    },
    consumed: 2,
  };
}

/**
 * Recover section labels from the rail lines in reading order (page, then y). A
 * rail line becomes a label when it joins its next neighbour into a stacked
 * alias, when its own text is an exact alias, or when its leading token(s) form
 * an inline header (`matchLeadingTokenHeader`).
 */
function recoverRailLabels(
  railLines: PdfLine[],
  bodyLineHeight: number,
): RailLabel[] {
  const stackedMaxDy = Math.max(bodyLineHeight * 2, 20);
  const railByY = [...railLines].sort((a, b) => a.page - b.page || a.y - b.y);
  const labels: RailLabel[] = [];
  for (let i = 0; i < railByY.length; i++) {
    const a = railByY[i];
    const b = i + 1 < railByY.length ? railByY[i + 1] : null;

    const stacked = tryStackedLabel(a, b, stackedMaxDy);
    if (stacked) {
      labels.push(stacked.label);
      i += stacked.consumed - 1; // consume the extra stacked-label row(s)
      continue;
    }

    // Alone: the rail line's whole text is an exact alias ("Experience").
    const aloneSection = matchExactAlias(a.text);
    if (aloneSection) {
      labels.push({
        section: aloneSection,
        display: a.text.trim(),
        page: a.page,
        boundaryY: a.y,
        parentRows: [a],
        remainders: [],
      });
      continue;
    }

    // Inline leading-token (#355 gap 1): the keyword LEADS a merged row that
    // also carries the section's first entry ("Education  State University …").
    // Reuses the guarded recognizer, so its FP defenses (item-boundary alias,
    // `remainderLooksLikeEntry`) apply here too.
    const inline = matchLeadingTokenHeader(a);
    if (inline) {
      labels.push({
        section: inline.section,
        display: inline.alias,
        page: a.page,
        boundaryY: a.y,
        parentRows: [a],
        remainders: [inline.remainder],
      });
    }
  }
  return labels;
}

/**
 * Partition `lines` into a `profile` section plus one section per recovered
 * label, assigning each body line to the label whose `(page, y)` band it falls
 * in. Returns null when fewer than 2 sections end up with content. Extracted from
 * {@link splitByLabelRail} so the geometry gates and this assembly stay separate.
 */
function buildRailSections(
  lines: PdfLine[],
  labels: RailLabel[],
): PdfSection[] | null {
  // Bands are the labels sorted by the compound `(page, boundaryY)` key, with
  // `profile` (page/y −∞) catching everything above the first label on page 1.
  const labelRows = new Set<PdfLine>();
  for (const lbl of labels) for (const row of lbl.parentRows) labelRows.add(row);

  const sortedLabels = [...labels].sort(
    (a, b) => a.page - b.page || a.boundaryY - b.boundaryY,
  );
  const profile: PdfSection = { name: "profile", lines: [] };
  const bands: Array<{ page: number; boundaryY: number; section: PdfSection }> = [
    { page: -Infinity, boundaryY: -Infinity, section: profile },
  ];
  const sectionOf = new Map<RailLabel, PdfSection>();
  for (const lbl of sortedLabels) {
    const section: PdfSection = {
      name: lbl.section,
      rawHeading: lbl.display,
      lines: [],
    };
    bands.push({ page: lbl.page, boundaryY: lbl.boundaryY, section });
    sectionOf.set(lbl, section);
  }

  for (const line of lines) {
    if (labelRows.has(line)) {
      // The label row itself is not content; any remainders it carries (an inline
      // first entry, or same-row grid values) are injected once, at the FIRST
      // parent row's position, so a stacked pair doesn't double-count.
      const owner = labels.find((lbl) => lbl.parentRows[0] === line);
      if (owner) for (const rem of owner.remainders) sectionOf.get(owner)!.lines.push(rem);
      continue;
    }
    bandFor(bands, profile, line.page, line.y).lines.push(line);
  }

  const contentful = bands
    .slice(1)
    .filter((b) => b.section.lines.length > 0).length;
  if (contentful < 2) return null;

  mergeRailEntryRows(sortedLabels, sectionOf);
  return [profile, ...sortedLabels.map((lbl) => sectionOf.get(lbl)!)];
}

/**
 * The section owning a body line at `(page, y)`: the LAST band (in page-then-y
 * order — `bands` is pre-sorted) that starts at or before `(page, y + TOL)`. An
 * earlier-page band always qualifies (page is primary), so a page-N line before
 * any page-N label continues the last page-(N-1) section rather than falling
 * back into `profile`.
 */
function bandFor(
  bands: Array<{ page: number; boundaryY: number; section: PdfSection }>,
  profile: PdfSection,
  page: number,
  y: number,
): PdfSection {
  let chosen = profile;
  for (const band of bands) {
    const starts =
      band.page < page ||
      (band.page === page && band.boundaryY <= y + RAIL_BAND_OVERLAP_TOL);
    if (starts) chosen = band.section;
  }
  return chosen;
}

/**
 * Reassemble each visual ROW inside an ENTRY-PARSED rail section.
 * `groupIntoLines` split a "title … date" role row at the 50pt column gap (#9),
 * so the date landed on its own far-right PdfLine, away from the title — which
 * strands the `date_range` anchor in the date column and disables glyphless-
 * bullet detection (both keyed on the entry-header left margin). Merging same-
 * baseline lines back into one PdfLine restores the visual row the entry-block
 * parser expects. Scoped to the date-anchored entry sections (`ROW_MERGE_SECTIONS`):
 * the skills token list must NOT be merged — its splitter (`SKILL_SPLIT_RE`)
 * treats a single space as intra-token, so welding grid cells with a single
 * space would collapse many skills into one.
 */
function mergeRailEntryRows(
  sortedLabels: RailLabel[],
  sectionOf: Map<RailLabel, PdfSection>,
): void {
  for (const lbl of sortedLabels) {
    if (!ROW_MERGE_SECTIONS.includes(lbl.section)) continue;
    const section = sectionOf.get(lbl)!;
    section.lines = mergeRowsByBaseline(section.lines);
  }
}

/**
 * Merge PdfLines that share a page and baseline (within `LINE_Y_EPS`) into one
 * PdfLine per visual row, in reading order (page, then y). Reverses the
 * column-gap line split (`COLUMN_GAP_THRESHOLD`) for a rail section, where a
 * single logical row (role title on the left, date on the far right) was
 * fragmented into separate lines. Each merged row's items are re-sorted by x and
 * concatenated with `mergeItemText`, so a wide title→date gap becomes a single
 * space. `gapAbove` is not consumed downstream of the rail path, so it resets.
 */
function mergeRowsByBaseline(lines: PdfLine[]): PdfLine[] {
  const sorted = [...lines].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return a.y - b.y;
  });
  const out: PdfLine[] = [];
  let bucket: PdfTextItem[] = [];
  let bucketPage = -1;
  let bucketY = 0;
  const flush = () => {
    if (bucket.length === 0) return;
    const items = [...bucket].sort((a, b) => a.x - b.x);
    const ys = items.map((i) => i.y);
    out.push({
      page: items[0].page,
      y: ys.reduce((a, b) => a + b, 0) / ys.length,
      x: items[0].x,
      items,
      text: mergeItemText(items),
      maxFontSize: Math.max(...items.map((i) => i.fontSize)),
      allCaps:
        mergeItemText(items).replace(/[^A-Za-z]/g, "").length > 0 &&
        mergeItemText(items) === mergeItemText(items).toUpperCase(),
      gapAbove: 0,
    });
    bucket = [];
  };
  for (const line of sorted) {
    if (
      bucket.length > 0 &&
      (line.page !== bucketPage || Math.abs(line.y - bucketY) > LINE_Y_EPS)
    ) {
      flush();
    }
    if (bucket.length === 0) {
      bucketPage = line.page;
      bucketY = line.y;
    }
    bucket.push(...line.items);
  }
  flush();
  return out;
}

/**
 * Decide whether a single line opens a section boundary or appends to the
 * current section — the per-line core of `splitIntoSections`, extracted as a
 * pure function of the line plus the two carry-forward state flags so the
 * splitter loop stays flat. `marksContactEnd` reports back that an appended
 * line is the contact line that ends the leading name block (the caller flips
 * `seenContactInProfile`).
 */
function classifyLine(
  line: PdfLine,
  bodyBaseline: number,
  bodyLineHeight: number,
  openedRealSection: boolean,
  seenContactInProfile: boolean,
  prevLineOpenedBoundary: boolean,
  columnBand: ColumnBand | undefined,
  currentSection: SectionName | "profile",
  singleColumn: boolean,
  nextLine: PdfLine | undefined,
): LineAction {
  // A line carrying a date range on itself or directly below it reads as an
  // ENTRY (a company/role/institution line), never as a bare section header.
  // Consumed by the #258/#310-311 institution-repeat gate below and by the
  // sidebar-header recovery further down. Memoized rather than computed up
  // front: both consumers sit behind gates far narrower than this function
  // (a keyword-header match; a sidebar band on a two-column page), so an
  // eager hoist would run `hasDateRange` twice on EVERY line of the document
  // to serve two rare branches. Sharing the value is still the point — the
  // thunk just keeps it lazy.
  let datedEntry: boolean | undefined;
  const lineLooksLikeDatedEntry = () =>
    (datedEntry ??= hasDateRange(line) || hasDateRange(nextLine));

  const header = matchSectionHeaderDetailed(line.text);
  if (header) {
    // #258 Layer B / #310-311: a head-noun-anchor (L2) line re-matching the
    // CURRENTLY-open section is an institution entry under its own real header,
    // not a second header — suppress the boundary and RETAIN it as content. The
    // full gate (current-section safety, the experience-only adjacency
    // relaxation, the two-column carve-out, and the #354 dated-entry guard)
    // lives in `isInstitutionRepeat`. A dated entry line is one carrying a date
    // range on itself or the line immediately below it (a company whose role's
    // date follows) — the tell of a company/role entry vs. a bare category header.
    if (
      !isInstitutionRepeat(
        header,
        currentSection,
        singleColumn,
        prevLineOpenedBoundary,
        lineLooksLikeDatedEntry(),
      )
    ) {
      return { kind: "open", name: header.section };
    }
    // Suppressed: retain the institution line as content. Return append
    // directly rather than falling through to the visual-header path, which
    // would re-promote a clean multi-word ALL-CAPS institution name ("ACME
    // PROFESSIONAL EDUCATION") to an `other` boundary via isTextPatternHeader —
    // re-dropping the very line this guard exists to keep. A section is already
    // open here, so this line is never the contact line that ends a name block.
    return { kind: "append", marksContactEnd: false };
  }

  const contactShaped = hasContactShape(line.text);

  // Visual header (font path #112 / multi-word ALL-CAPS text-pattern #163), OR
  // the single-word vertical-gap path (#216) — the latter suppressed when the
  // previous line opened a boundary, so the first content line under a header
  // (an inflated gap-above artifact, e.g. `HTML` under `SKILLS`) is never
  // mis-promoted (keeps the #112 inline-acronym FP class closed).
  if (
    isVisualHeader(line, bodyBaseline) ||
    (!prevLineOpenedBoundary &&
      isGapIsolatedSingleWordHeader(line, bodyLineHeight))
  ) {
    // Inside the leading name/title block (no contact line seen yet, no section
    // open) — a font-distinct line here is the name or a title/tagline, never a
    // section header. Keep it in the profile; the contact line ends the block.
    if (!openedRealSection && !seenContactInProfile) {
      return { kind: "append", marksContactEnd: contactShaped };
    }
    // Past the name block (contact seen, or a real section already opened): a
    // visual header with no keyword match opens a boundary-only `other`.
    return { kind: "open", name: "other" };
  }

  // Two-column sidebar artifact: a flatten can glue a sidebar bar-value onto a
  // real header in the sidebar rail ("20% Projects"). The line is body-size (no
  // visual signal, so the branch above did not fire) and a single glued run (no
  // x-gap), so the only signal that separates it from body-column prose like
  // "5 Years Experience" is that it sits in the SIDEBAR band of a detected
  // two-column layout. Gate the unguarded trailing-anchor lookup on that band
  // signal + a header-short shape, and hold out a dated ENTRY line (a sidebar
  // institution/employer whose date sits on or under it) — the contextual guard
  // #258/#354 already apply on the text-only path, which this branch bypasses.
  //
  // `columnBand` is `"sidebar"` ONLY for the narrow rail, whichever side of the
  // gutter it occupies (#574). On a sidebar-LEFT layout the résumé body sits
  // above the split, so the earlier `line.x >= columnSplitX` reading handed the
  // entire body to this guard-free matcher and one anchor-ending company name
  // swallowed the document. Single-column pages (`undefined`) and balanced
  // two-column pages (`"unknown"`) skip the branch entirely.
  if (
    columnBand === "sidebar" &&
    !lineLooksLikeDatedEntry() &&
    isHeaderShort(line.text)
  ) {
    const recovered = matchSectionAnchorToken(line.text);
    if (recovered)
      return {
        kind: "open",
        name: recovered,
        rawHeading: stripSidebarNoisePrefix(line.text),
      };
  }

  // Single-column INLINE leading-token header (#355 gap 1): the keyword leads a
  // merged content row carrying the section's first entry. Gated to a page with
  // no column split (`columnBand === undefined`) and to past the leading
  // name/contact block (mirrors the visual-header suppression) so a keyword-led
  // tagline in the header cluster can't open a section. The item-boundary +
  // remainder-entry guards live in `matchLeadingTokenHeader`.
  if (
    columnBand === undefined &&
    (openedRealSection || seenContactInProfile)
  ) {
    const inline = matchLeadingTokenHeader(line);
    if (inline) {
      return {
        kind: "open",
        name: inline.section,
        rawHeading: inline.alias,
        retainLine: inline.remainder,
      };
    }
  }

  return { kind: "append", marksContactEnd: !openedRealSection && contactShaped };
}

/**
 * Helper: look up a section by name. Returns undefined if absent.
 *
 * A section header can legitimately repeat — most often EXPERIENCE, which
 * carries a "E XPERIENCE" continuation header at the top of page 2 on
 * multi-page two-column résumés. Both section splitters open a fresh section
 * each time a header matches (see `splitIntoSections` /
 * `splitIntoSectionsWithMarkdown`), so a repeated header yields two sections of
 * the same name. We merge their lines in document order here so the caller sees
 * the whole section; returning only the first occurrence (the old behavior)
 * silently dropped every role after the continuation header, stranding those
 * bullets in the unmatched "Other" group downstream.
 */
export function findSection(
  sections: PdfSection[],
  name: SectionName | "profile",
): PdfSection | undefined {
  const matches = sections.filter((s) => s.name === name);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return {
    name,
    rawHeading: matches.find((s) => s.rawHeading)?.rawHeading,
    lines: matches.flatMap((s) => s.lines),
  };
}

// ── Markdown-anchored section splitting ──────────────────────────

/**
 * ATX heading at the start of a line — captures the heading payload. The
 * PDF markdown emitter (`markdown-emit.ts`) promotes lines to `#`/`##`/`###`
 * based on font-size ratio, so every heading we match here corresponds to
 * a line that cleared the promotion gate in the original PDF.
 */
const MARKDOWN_HEADING_RE = /^\s*#{1,3}\s+(.+?)\s*#*\s*$/;

/**
 * Split `lines` into sections using the markdown's heading structure as the
 * boundary signal, rather than running `matchSectionHeader` against every
 * line. Returns `null` when the markdown yielded fewer than two canonical
 * sections — the caller falls back to the regex-on-line splitter.
 *
 * Why this is tighter than the regex-on-line splitter: the line splitter
 * matches *any* line whose text equals a section keyword (e.g. a line that
 * just says "Skills" in the middle of a profile paragraph would open a new
 * section). The markdown splitter only treats a line as a header when the
 * PDF markdown emitter already promoted it via font-size ratio — filtering
 * out the body-font-size false positives the line splitter cannot avoid.
 *
 * Matching is done by normalized text equality between the markdown heading
 * payload and the PDF line text. Both sides are trimmed and lowercased and
 * have trailing `:` / `·` / `•` stripped (mirroring `matchSectionHeader`).
 * Lines without a corresponding markdown-heading match fall into the
 * current section.
 */
/**
 * Header-shape gate for a two-line-wrap fold half (#374).
 *
 * A wrapped-header fragment is short, header-cased, and unpunctuated — the same
 * shape that separates a heading from prose in `matchAnchorFallback` (Guard 7).
 * Requiring it on BOTH halves keeps the fold from gluing two lowercase prose
 * fragments together even when their concatenation happens to spell an alias:
 *   - length ≤ 30 and 1–3 whitespace tokens (a header fragment, not a sentence),
 *   - no terminal `.`/`!`/`?` (sentence punctuation marks prose),
 *   - every alphabetic-leading word is Title Case or ALL CAPS (uppercase lead).
 *     A non-alpha lead (e.g. the `&` in "Awards" / "& Honors") is exempt so a
 *     legitimately wrapped `&`-joined header still qualifies.
 */
function isWrapHeaderShape(raw: string): boolean {
  const t = raw.trim().replace(/[:·•]+$/, "").trim();
  if (t.length === 0 || t.length > 30) return false;
  if (/[.!?]$/.test(t)) return false;
  const words = t.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0 || words.length > 3) return false;
  for (const w of words) {
    const first = w[0];
    if (/[A-Za-z]/.test(first) && !/[A-Z]/.test(first)) return false;
  }
  return true;
}

/**
 * Two-line-wrapped-header recovery for the markdown-anchored splitter (#374).
 *
 * Returns the section a `prev` + `cur` line pair reconstructs when — and only
 * when — both halves are header-shaped (`isWrapHeaderShape`) AND their
 * space-joined text resolves via `matchSectionHeader` — i.e. an exact multi-word
 * alias ("technical skills", "core competencies", …) OR a guarded qualified
 * header via the anchor-fallback tier ("relevant experience", "awards honors").
 * Returns null otherwise.
 *
 * The join is what bounds the false-positive surface. A join of two lines is
 * always ≥ 2 tokens, so it can never match a bare single-word section name; it
 * resolves only to a multi-word alias or to a qualified header whose last token
 * is a real section anchor (with matchSectionHeader's Guards 7/8/9 on the raw
 * text). For a résumé, matching one of those is definitionally a wrapped header
 * rather than coincidental adjacent prose. This is strictly tighter than the
 * issue's Option 2 (admit a bare "Skills" after a "Core"/"Key"/… qualifier),
 * which would also open on non-aliases like "Core Skills" and only ever covered
 * the skills section.
 */
function matchWrappedHeader(prev: PdfLine, cur: PdfLine): SectionName | null {
  if (!isWrapHeaderShape(prev.text) || !isWrapHeaderShape(cur.text)) return null;
  const joined = `${prev.text.trim()} ${cur.text.trim()}`;
  return matchSectionHeader(joined);
}

export function splitIntoSectionsWithMarkdown(
  lines: PdfLine[],
  markdown: string,
): PdfSection[] | null {
  const headerTexts = extractCanonicalHeadingTexts(markdown);
  if (headerTexts.size === 0) return null;

  const sections: PdfSection[] = [{ name: "profile", lines: [] }];
  // Immediately-preceding line that was APPENDED to the current section (not a
  // header). Reset to null whenever a section opens, so the two-line-wrap fold
  // below only ever considers two consecutive body lines. See `matchWrappedHeader`.
  let prevAppended: PdfLine | null = null;
  for (const line of lines) {
    const key = normalizeHeaderText(line.text);
    const section = headerTexts.get(key);
    if (section && matchSectionHeader(line.text) === section) {
      sections.push({
        name: section,
        rawHeading: line.text.trim(),
        lines: [],
      });
      prevAppended = null;
      continue;
    }
    // #374 two-line-wrapped-header recovery. A header that wraps across two
    // visual lines ("Technical" / "Skills") is emitted by the markdown emitter
    // as two body lines glued into the flattened content grid, so NEITHER half
    // reaches `headerTexts` as a promoted heading — the map-gated branch above
    // never fires and the whole section is stranded in the profile. When this
    // line plus the line immediately appended before it reconstruct an EXACT
    // known multi-word section alias, treat the pair as one header: drop the
    // first half from the current section and open the reconstructed one. The
    // exact-alias + header-shape gate (see `matchWrappedHeader`) is what keeps
    // this from folding ordinary adjacent short lines into a false section.
    if (prevAppended) {
      const wrapped = matchWrappedHeader(prevAppended, line);
      if (wrapped) {
        // `prevAppended` is, by construction, the last line pushed to the
        // current (last) section — pop it back off as the header's first half.
        const current = sections[sections.length - 1];
        current.lines.pop();
        sections.push({
          name: wrapped,
          rawHeading: `${prevAppended.text.trim()} ${line.text.trim()}`,
          lines: [],
        });
        prevAppended = null;
        continue;
      }
    }
    sections[sections.length - 1].lines.push(line);
    prevAppended = line;
  }

  // Count only non-profile sections — a markdown with zero canonical
  // headings that somehow survived the empty-map check still falls back.
  const canonicalCount = sections.filter((s) => s.name !== "profile").length;
  if (canonicalCount < 2) return null;

  return sections;
}

/**
 * Scan a markdown document for `#`/`##`/`###` headings whose payload matches
 * a canonical section keyword. Returns a `normalizedText → SectionName` map
 * so the splitter can look up each PDF line by its own normalized text.
 *
 * Duplicates (same heading text appearing twice, e.g. two "EDUCATION"
 * headings) collapse to a single entry; the splitter opens a new section
 * each time it sees the normalized text on a PDF line, so both PDF-side
 * occurrences still produce section breaks.
 */
function extractCanonicalHeadingTexts(
  markdown: string,
): Map<string, SectionName> {
  const out = new Map<string, SectionName>();
  const rawLines = markdown.split(/\r?\n/);
  for (const raw of rawLines) {
    const m = MARKDOWN_HEADING_RE.exec(raw);
    if (!m) continue;
    const payload = m[1];
    const section = matchSectionHeader(payload);
    if (!section) continue;
    out.set(normalizeHeaderText(payload), section);
  }
  return out;
}

/**
 * Normalize a candidate heading text for equality comparison. Mirrors the
 * pre-matching normalization in `matchSectionHeader` (trim, lowercase,
 * strip trailing `:` / `·` / `•`) so both sides collide when equivalent.
 */
function normalizeHeaderText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[:·•]+$/, "")
    .trim();
}
