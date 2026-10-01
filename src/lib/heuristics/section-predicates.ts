// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Pure recogniser predicates for the two-phase section router (#655).
 *
 * `section-router.ts`'s proposers and selector are built on top of these —
 * each predicate decides one narrow question about a single line (is it
 * visually a header? does it carry contact shape? does it repeat the
 * currently-open section?) without touching any cross-line routing state.
 * They moved out of `sections.ts` verbatim (docblocks included, no logic
 * changes) so `section-router.ts` and `sections.ts` can share them without
 * either importing the other: `sections.ts` still needs a handful of these
 * directly (`splitByLabelRail`'s rail-geometry cluster and the headerless-
 * experience recovery each predate this split and call a few of the same
 * primitives), and `section-router.ts` needs the rest for its proposers. This
 * module imports nothing from either, which is what keeps the dependency
 * graph one-way: `sections.ts` → `section-router.ts` → `section-predicates.ts`,
 * and `sections.ts` → `section-predicates.ts` directly.
 */

import type { PdfTextItem } from "./types.ts";
import {
  EMAIL_RE,
  PHONE_RE,
  LINKEDIN_RE,
  DATE_RANGE_RE,
  DEGREE_RE,
  INSTITUTION_HINTS,
  SECTION_KEYWORDS,
  type SectionName,
  MONTH,
  SEASON,
  OPEN_ENDED,
} from "./regex.ts";
import { bulletCharClass, PARSER_BULLET_GLYPHS } from "./bullet-glyphs.ts";
import { mergeItemText } from "./line-assembly.ts";
import type { PdfLine } from "./line-model.ts";

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
export type ColumnBand = "sidebar" | "body" | "unknown";

/** Which side of a split page's gutter the narrow sidebar rail sits on. */
export type SidebarSide = "left" | "right";

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
export function detectSidebarSides(
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
export function columnBandOf(
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
/** Leading bullet glyph — a header-shaped bullet is content, not a heading.
 *  Derived from {@link PARSER_BULLET_GLYPHS} (`bullet-glyphs.ts`, #915). */
const VISUAL_BULLET_RE = new RegExp(`^\\s*${bulletCharClass(PARSER_BULLET_GLYPHS)}`);

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
 * Header *shape* test, independent of font: short (≤ `VISUAL_HEADER_MAX_CHARS`
 * chars, ≤ `VISUAL_HEADER_MAX_WORDS` words), not a bullet line, and not ending
 * in terminal sentence punctuation. This is the structural half of
 * `isVisualHeader`; the column-gated sidebar-header recovery (#117) reuses the
 * exact same predicate so the two paths can never drift on what counts as
 * header-shaped.
 */
export function isHeaderShort(text: string): boolean {
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
 * and (in the section-router proposers) only past the leading name/contact
 * block — so a real header it fires on opens the boundary-only `other` sink,
 * terminating the prior section. Verified zero-regression against the full
 * corpus snapshot.
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
 * Character-weighted mode of the positive `gapAbove` values across lines — the
 * document's typical within-paragraph line-height, the baseline the
 * vertical-gap header cue (#216) measures against. Mirrors the weighting in
 * `computeBodyFontSize` (weight each gap bin by the line's character count) so
 * long body paragraphs dominate the mode and a handful of wider header gaps
 * never become the baseline. Gaps are binned to 0.5pt. Returns a 14pt default
 * for a document with no measurable gaps (≤1 line, or all first-on-page).
 */
export function computeBodyLineHeight(lines: PdfLine[]): number {
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
 * Caller (the section-router selector) applies the same name/contact-block
 * suppression and post-`matchSectionHeader` ordering as the other visual paths,
 * so a fired header opens the boundary-only `other` sink. It also gates this
 * path on the line NOT immediately following a boundary: the first content
 * line under a header inherits an inflated gap-above (measured against the
 * header line), so a column-reordered skills grid's lead token (`HTML` right
 * under `SKILLS`) would otherwise clear the ratio — the #112 inline-acronym FP
 * this guard keeps shut.
 */
export function isGapIsolatedSingleWordHeader(
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
 * NOT folded in here — it needs an adjacency guard only the selector holds (a
 * header never immediately follows another header), so it is proposed
 * separately. Keeping it out leaves this predicate (and its #112/#163 callers)
 * byte-identical.
 */
export function isVisualHeader(
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
export function hasContactShape(text: string): boolean {
  return (
    EMAIL_TEST_RE.test(text) ||
    PHONE_TEST_RE.test(text) ||
    LINKEDIN_TEST_RE.test(text)
  );
}

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
export function stripSidebarNoisePrefix(raw: string): string {
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
export function isInstitutionRepeat(
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
export function hasDateRange(line: PdfLine | undefined): boolean {
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
// headerless-cluster recovery, `sections.ts`). Both are recognising an
// experience entry with no header to check themselves against, so both need
// the bare-year span held out; sharing the token is what keeps them from
// drifting on what a "real role date" is.
//
// The month and season anchors REQUIRE an adjacent year: this rejects a bare
// year span with no month/season token ("2018 - 2022") — the coincidental-prose
// case above — and defuses the verb "may" and a stray "Marathon"/"March" NOT
// followed by a year. It does NOT, on its own, reject a month word that happens
// to be directly followed by a year ("Marathon 2018" still matches); that
// residual is held out by the two guards this token is AND-ed with — a real
// `DATE_RANGE_RE` span AND the leading alias being item[0]'s own text run — not
// by this regex alone. Non-global, so `.test` is stateless.
export const STRONG_DATE_TOKEN_RE = new RegExp(
  [
    // month-year: "Aug 2024", "August 2024", "Aug. '24", "Sep 20XX"
    `\\b${MONTH}\\.?\\s+(?:\\d{4}|'\\d{2}|20XX)`,
    // season-year: "Summer 2013"
    `\\b${SEASON}\\s+\\d{4}`,
    // numeric slash date: "06/2021", "6-2021"
    "\\d{1,2}[/-]\\d{4}",
    // open-ended present-family token
    `\\b${OPEN_ENDED}\\b`,
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

/** Build a `PdfLine` from a contiguous subset of another line's items (the row
 *  remainder after the leading rail label), inheriting the parent's `gapAbove`.
 *  Mirrors `groupLinesSingle`'s line builder so the retained remainder is a
 *  first-class content line downstream. */
export function buildLineFromItems(items: PdfTextItem[], parent: PdfLine): PdfLine {
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

export function matchLeadingTokenHeader(
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

// ── Label-rail partitioning helpers (#355) ──────────────────────────────────
//
// `matchExactAlias`, `RAIL_X_TOL`, and `buildLineFromItems` (above) are shared
// between `tryStackedRailLabel` below (the per-line, pre-proposer "same-row
// stacked label" recognizer the section-router selector runs) and
// `sections.ts`'s `splitByLabelRail` cluster (the whole-document rail
// partitioner, out of scope for this issue — it stays a pre-empting path, not
// a proposer). Keeping the shared geometry/alias primitives here is what lets
// both consult the same rules without either importing the other.

/** x tolerance (pt) for treating two lines' left edges as the same rail column. */
export const RAIL_X_TOL = 4;

/** Max length (chars) of one horizontal grid value cell — a skill token
 *  ("Python", "Kafka") is short; a prose clause is not. */
const GRID_CELL_MAX = 24;

/** Exact (non-anchor) alias match: the normalized text must equal one of a
 *  section's canonical aliases. Trailing `:`/`·`/`•` are stripped (a rail cell
 *  carries none, but a flatten can append one). Returns the section or null.
 *
 *  Intentional asymmetry vs. `matchLeadingTokenHeader` (which REJECTS a trailing
 *  colon so `"Experience:"` can't open on the inline path): here the alone-path
 *  alias is the WHOLE line text, so a bare `"Experience:"` rail cell is a real
 *  standalone section label and SHOULD open — there is no value welded onto it
 *  to worry about, unlike the inline "label: value" prose shape the colon guards. */
export function matchExactAlias(text: string): SectionName | null {
  const normalized = text.trim().toLowerCase().replace(/[:·•]+$/, "").trim();
  if (!normalized) return null;
  for (const [name, aliases] of Object.entries(SECTION_KEYWORDS) as Array<
    [SectionName, readonly string[]]
  >) {
    if (aliases.includes(normalized)) return name;
  }
  return null;
}

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
 * `splitByLabelRail` (`sections.ts`) to partition — this is its complement, not
 * a duplicate). The grid values (each row's remainder past its lead cell)
 * become the section's content. Scoped tightly — both lead cells sit in the
 * same rail column (same left x), and the joined lead tokens must EXACTLY
 * equal a canonical alias — so ordinary two-line body content can't mint a
 * false section. Returns null when the pair is not a stacked rail label.
 *
 * Called by the section-router selector as a selector-level pre-check ahead of
 * the ordered proposer list (#655) — not a proposer itself, since it consumes
 * TWO lines (`line`, `nextLine`) where a proposer's contract is one.
 */
export function tryStackedRailLabel(
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
