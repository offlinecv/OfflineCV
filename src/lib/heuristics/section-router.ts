// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Two-phase line router for `splitIntoSections` (#655).
 *
 * `sections.ts` used to route every assembled line through `classifyLine`, a
 * single greedy function with ten positional parameters and a fixed,
 * issue-numbered chain of recognisers (`if` / early-return / `continue`).
 * Every new layout added a parameter and a branch, and the suppression rule
 * between two recognisers existed only as "this `if` runs before that one" —
 * invisible to anything except a careful read of the whole function.
 *
 * This module replaces that chain with two phases:
 *
 *   1. **Proposal** — each former recogniser is now a pure `Proposer`:
 *      `(line, ctx) => Candidate | null`. A proposer reads the line plus a
 *      read-only {@link RouterContext} (everything the ten parameters used to
 *      carry) and either declines (`null`) or proposes one {@link Candidate}
 *      for opening a section. It never reads or mutates routing state.
 *   2. **Selection** — {@link selectLineAction}, the only stateful piece,
 *      walks the proposers in a fixed priority order (the old branch order,
 *      now an explicit array) and takes the first one that fires. Each
 *      proposer that can be suppressed carries a named **veto** —
 *      {@link resolveKeywordHeader} (#258/#310-311) and
 *      {@link resolveNameBlockHeader} (#112/#216) — so a suppression rule that
 *      used to live only in branch order now has a name, a docblock, and the
 *      issue number that motivated it.
 *
 * Stage 1 (this issue) keeps selection sequential and stateful, matching
 * `classifyLine`'s original control flow exactly: the suppression rules are
 * conditioned on evolving segmentation state (`currentSection`,
 * `prevLineOpenedBoundary`, `seenContactInProfile`), so a one-pass global
 * scored selection would change behaviour. `Candidate.score` is populated for
 * every candidate so a Stage 2 selector can rank across the whole document
 * without changing the `Candidate` type or the proposer signature — but
 * `selectLineAction` does not consult it; "first proposer to fire, in
 * priority order" is the whole algorithm here, same as `classifyLine` was.
 *
 * `splitByLabelRail` (the whole-document label-rail partitioner in
 * `sections.ts`) is NOT a proposer — it pre-empts the per-line loop entirely
 * and returns its own `PdfSection[]` before a single line reaches this
 * module. The SAME-ROW stacked rail label (#355 gap 2) it does *not* cover is
 * handled here instead, but also outside the ordered proposer list: it spans
 * TWO lines (`line` + `ctx.nextLine`), which no one-line proposer can
 * consume, so {@link selectLineAction} resolves it as a selector-level
 * pre-check and reports how many source lines it consumed rather than the
 * `splitIntoSections` loop mutating its own index.
 */

import type { SectionName } from "./regex.ts";
import { matchSectionHeaderDetailed, matchSectionAnchorToken } from "./regex.ts";
import type { PdfLine } from "./line-model.ts";
import {
  type ColumnBand,
  isVisualHeader,
  isGapIsolatedSingleWordHeader,
  isHeaderShort,
  hasContactShape,
  hasDateRange,
  isInstitutionRepeat,
  stripSidebarNoisePrefix,
  matchLeadingTokenHeader,
  tryStackedRailLabel,
} from "./section-predicates.ts";

/** What `selectLineAction` decided to do with one line — the same shape
 *  `classifyLine` used to return, generalised in one place: `retainLine`
 *  (singular) becomes `retainLines` (an array) so the selector-level stacked
 *  rail-label case (#355 gap 2, up to two remainder rows) and the ordinary
 *  single-remainder inline-leading-token case (#355 gap 1) share one field. */
export type LineAction =
  | {
      kind: "open";
      name: SectionName;
      rawHeading?: string;
      /**
       * Content lines to RETAIN in the newly-opened section — the row
       * remainder(s) that shared the header keyword's own visual row(s) (a
       * role/degree entry under an inline leading-token header, or the grid
       * values under a same-row stacked rail label). Absent for an ordinary
       * header, whose line is a pure label consumed by the boundary.
       */
      retainLines?: PdfLine[];
    }
  | { kind: "append"; marksContactEnd: boolean };

/**
 * Everything a proposer or the selector needs about the document and the
 * segmentation-in-progress, for one line — the single object that replaces
 * `classifyLine`'s nine non-`line` positional parameters. Built fresh by
 * `splitIntoSections` for every line; proposers only ever read it.
 */
export interface RouterContext {
  /** Index of `line` within the document's assembled line array — carried so
   *  a proposer can stamp `Candidate.lineIdx` without a third parameter. */
  lineIdx: number;
  /** Document body font-size baseline (`computeBodyFontSize`), the font-ratio
   *  header cue's denominator (#112). */
  bodyBaseline: number;
  /** Document body line-height mode (`computeBodyLineHeight`), the vertical-
   *  gap header cue's baseline (#216). */
  bodyLineHeight: number;
  /** True once the first non-profile section (keyword or visual) has opened. */
  openedRealSection: boolean;
  /** True once the leading name/title block has ended — signalled by the
   *  first contact-shaped line inside the profile region. */
  seenContactInProfile: boolean;
  /** True when the immediately-preceding line opened a section boundary —
   *  suppresses the gap-isolated single-word header path (#216) right after a
   *  boundary, and feeds the institution-repeat gate (#258/#310-311). */
  prevLineOpenedBoundary: boolean;
  /** This line's two-column band (`columnBandOf`), or `undefined` on a
   *  single-column page/document (#117/#574). */
  columnBand: ColumnBand | undefined;
  /** The name of the section currently open (the last entry in the
   *  in-progress `PdfSection[]`), or `"profile"` before the first header. */
  currentSection: SectionName | "profile";
  /** True when the document carries no detected two-column split anywhere. */
  singleColumn: boolean;
  /** The line immediately following `line`, or `undefined` at the document's
   *  end — used for the dated-entry lookahead (#354) and the stacked-label
   *  selector pre-check (#355 gap 2). */
  nextLine: PdfLine | undefined;
}

/**
 * One proposer's bid to open a section on `line`. `tier` + `evidence` are
 * documentation/debugging only — nothing downstream switches on them.
 * `score` is populated for Stage 2 (see the module docblock) but unused by
 * this issue's selector. The remaining optional fields are the payload a
 * `resolve` function needs to materialize the `LineAction` this candidate
 * implies — kept on `Candidate` rather than threaded separately so a proposer
 * stays a single pure return value.
 */
interface Candidate {
  lineIdx: number;
  /** `"other"` is already a member of `SectionName` — it's the boundary-only
   *  sink the visual/gap proposers open, not a separate case. */
  section: SectionName;
  tier: "keyword" | "visual" | "gap" | "anchor" | "rail";
  score: number;
  evidence: string;
  /** Verbatim heading text to record for the opened section, when it differs
   *  from the line's own trimmed text (`splitIntoSections` falls back to
   *  `line.text.trim()` when absent — unchanged from `classifyLine`). */
  rawHeading?: string;
  /** Content line(s) sharing this header's own visual row — see
   *  `LineAction`'s `retainLines`. */
  retainLines?: PdfLine[];
  /** #258/#310-311 payload for {@link resolveKeywordHeader}'s veto: whether
   *  this header matched via the head-noun anchor-fallback tier (qualified
   *  headers like "Relevant Experience") rather than an exact-alias or
   *  split-letter match. Only an anchor-fallback header can be an institution
   *  repeat; an exact/split-letter header always opens. */
  viaAnchorFallback?: boolean;
}

/** A pure line→candidate recogniser. Takes nothing beyond the line and the
 *  read-only {@link RouterContext}; never reads or mutates selector state. */
type Proposer = (line: PdfLine, ctx: RouterContext) => Candidate | null;

/**
 * Relative priority of each tier, for Stage 2's eventual global scoring.
 * Strictly descending in `classifyLine`'s original branch order so a future
 * `score`-ranking selector that happens to compare across tiers on one line
 * reproduces today's first-match order as a special case. Not consulted by
 * this issue's `selectLineAction` (see the module docblock).
 */
const TIER_SCORE = {
  keyword: 90,
  visual: 70,
  gap: 65,
  anchor: 50,
  rail: 40,
} as const satisfies Record<Candidate["tier"], number>;

// ── Proposers, in classifyLine's original chain order ───────────────────────

/** #56/#163/#414/#462/… keyword header match (`matchSectionHeaderDetailed`):
 *  L1 exact-alias / split-letter / compound "X & Y", or the L2 head-noun
 *  anchor-fallback tier for a qualified header ("Relevant Experience"). */
function proposeKeywordHeader(line: PdfLine, ctx: RouterContext): Candidate | null {
  const header = matchSectionHeaderDetailed(line.text);
  if (!header) return null;
  return {
    lineIdx: ctx.lineIdx,
    section: header.section,
    tier: "keyword",
    score: TIER_SCORE.keyword,
    evidence: `matchSectionHeaderDetailed:${header.section}`,
    viaAnchorFallback: header.viaAnchorFallback,
  };
}

/** #112/#163 visual header: header-shaped and meaningfully larger than the
 *  body baseline, or a font-metadata-independent clean multi-word ALL-CAPS
 *  line. Always proposes the boundary-only `other` sink — the keyword
 *  proposer has already declined by the time this one is even consulted. */
function proposeVisualHeader(line: PdfLine, ctx: RouterContext): Candidate | null {
  if (!isVisualHeader(line, ctx.bodyBaseline)) return null;
  return {
    lineIdx: ctx.lineIdx,
    section: "other",
    tier: "visual",
    score: TIER_SCORE.visual,
    evidence: "isVisualHeader",
  };
}

/** #216 single-word, ALL-CAPS, vertical-gap-isolated header — the narrow
 *  relaxation of the visual proposer's multi-word gate for renderers that
 *  flatten font size. Suppressed immediately after a boundary (the first
 *  content line under a header inherits an inflated gap-above). */
function proposeGapIsolatedHeader(line: PdfLine, ctx: RouterContext): Candidate | null {
  if (ctx.prevLineOpenedBoundary) return null;
  if (!isGapIsolatedSingleWordHeader(line, ctx.bodyLineHeight)) return null;
  return {
    lineIdx: ctx.lineIdx,
    section: "other",
    tier: "gap",
    score: TIER_SCORE.gap,
    evidence: "isGapIsolatedSingleWordHeader",
  };
}

/** #117/#574 sidebar-band anchor-token recovery: an unguarded trailing-anchor
 *  lookup, licensed only inside the narrow sidebar rail of a detected
 *  two-column layout, for a glued sidebar artifact ("20% Projects"). Holds
 *  out a dated ENTRY line (a sidebar institution/employer whose date sits on
 *  or under it) — the contextual guards #258/#354 apply on the text-only
 *  path, which this branch bypasses. */
function proposeSidebarAnchor(line: PdfLine, ctx: RouterContext): Candidate | null {
  if (ctx.columnBand !== "sidebar") return null;
  if (hasDateRange(line) || hasDateRange(ctx.nextLine)) return null;
  if (!isHeaderShort(line.text)) return null;
  const recovered = matchSectionAnchorToken(line.text);
  if (!recovered) return null;
  return {
    lineIdx: ctx.lineIdx,
    section: recovered,
    tier: "anchor",
    score: TIER_SCORE.anchor,
    evidence: `matchSectionAnchorToken:${recovered}`,
    rawHeading: stripSidebarNoisePrefix(line.text),
  };
}

/** #355 gap 1 single-column INLINE leading-token header: the section keyword
 *  leads a merged content row carrying the section's first entry. Gated to a
 *  page with no column split and to past the leading name/contact block
 *  (mirrors the visual-header name-block veto) so a keyword-led tagline in
 *  the header cluster can't open a section. */
function proposeInlineLeadingToken(line: PdfLine, ctx: RouterContext): Candidate | null {
  if (ctx.columnBand !== undefined) return null;
  if (!ctx.openedRealSection && !ctx.seenContactInProfile) return null;
  const inline = matchLeadingTokenHeader(line);
  if (!inline) return null;
  return {
    lineIdx: ctx.lineIdx,
    section: inline.section,
    tier: "rail",
    score: TIER_SCORE.rail,
    evidence: `matchLeadingTokenHeader:${inline.section}`,
    rawHeading: inline.alias,
    retainLines: [inline.remainder],
  };
}

// ── Named vetoes / resolutions ───────────────────────────────────────────────

/** No suppression rule applies to this tier — open exactly what was proposed. */
function resolveOpenAsIs(candidate: Candidate): LineAction {
  return {
    kind: "open",
    name: candidate.section,
    rawHeading: candidate.rawHeading,
    retainLines: candidate.retainLines,
  };
}

/**
 * **Veto: institution repeat (#258/#310-311).** A keyword match against the
 * CURRENTLY-open section is normally an institution/company entry sitting
 * under its own real header, not a second label — see
 * `isInstitutionRepeat`'s own docblock (`section-predicates.ts`) for the full
 * gate, including the experience-only adjacency relaxation (#311) and the
 * #354 dated-entry carve-out.
 *
 * When the veto fires, this returns `append` DIRECTLY rather than letting the
 * line fall through to the next proposer in the priority order: a clean
 * multi-word ALL-CAPS institution name ("ACME PROFESSIONAL EDUCATION") would
 * otherwise be re-promoted to an `other` boundary by the visual proposer right
 * below this one in priority — re-dropping the very line this veto exists to
 * keep. `selectLineAction` stops at the first proposer to fire, so returning
 * here (instead of declining back to the loop) is what encodes that stop.
 */
function resolveKeywordHeader(
  candidate: Candidate,
  line: PdfLine,
  ctx: RouterContext,
): LineAction {
  const suppressed = isInstitutionRepeat(
    {
      section: candidate.section,
      viaAnchorFallback: candidate.viaAnchorFallback ?? false,
    },
    ctx.currentSection,
    ctx.singleColumn,
    ctx.prevLineOpenedBoundary,
    hasDateRange(line) || hasDateRange(ctx.nextLine),
  );
  if (suppressed) {
    return { kind: "append", marksContactEnd: false };
  }
  return resolveOpenAsIs(candidate);
}

/**
 * **Veto: name/contact-block suppression (#112 font path, #216 gap path).**
 * Inside the leading name/title block — no contact line seen yet, no section
 * open — a font-distinct or vertical-gap-isolated line is the name itself or
 * a title/tagline stacked under it, never a section header: keep it in the
 * profile, and record whether it was the contact line that ends the block.
 * Past the name block (a contact line has been seen, or a real section has
 * already opened), the same signal is a genuine boundary-only `other`.
 *
 * Shared by both the visual and gap-isolated proposers: in `classifyLine`
 * these two recognisers were OR'd into one `if`, so whichever fired led to
 * the identical suppression check and the identical two outcomes — splitting
 * them into two proposers (so each has its own tier/evidence) does not change
 * that, since this resolver is what both are paired with.
 */
function resolveNameBlockHeader(
  candidate: Candidate,
  line: PdfLine,
  ctx: RouterContext,
): LineAction {
  if (!ctx.openedRealSection && !ctx.seenContactInProfile) {
    return { kind: "append", marksContactEnd: hasContactShape(line.text) };
  }
  return resolveOpenAsIs(candidate);
}

interface ProposerEntry {
  propose: Proposer;
  resolve: (candidate: Candidate, line: PdfLine, ctx: RouterContext) => LineAction;
}

/**
 * The priority list — `classifyLine`'s original branch order, now explicit
 * data instead of implicit in the function's control flow. `selectLineAction`
 * takes the first entry whose `propose` fires; everything after it is never
 * consulted for that line, matching the early-return semantics the old chain
 * had.
 */
const PROPOSER_ORDER: readonly ProposerEntry[] = [
  { propose: proposeKeywordHeader, resolve: resolveKeywordHeader },
  { propose: proposeVisualHeader, resolve: resolveNameBlockHeader },
  { propose: proposeGapIsolatedHeader, resolve: resolveNameBlockHeader },
  { propose: proposeSidebarAnchor, resolve: resolveOpenAsIs },
  { propose: proposeInlineLeadingToken, resolve: resolveOpenAsIs },
];

/** {@link selectLineAction}'s result: the `LineAction` to apply, plus how many
 *  lines of the document it consumed (1, except the stacked-label selector
 *  pre-check, which consumes 2). */
export interface RouterDecision {
  action: LineAction;
  consumedLines: number;
}

/**
 * Decide whether `line` opens a section boundary or appends to the current
 * section — the single function boundary behind which all per-line routing
 * sits (the Stage-2-ready selector the issue calls for). `splitIntoSections`
 * calls this once per line (skipping ahead by `consumedLines` when greater
 * than 1) instead of running the ten-parameter `classifyLine` chain inline.
 */
export function selectLineAction(line: PdfLine, ctx: RouterContext): RouterDecision {
  // Selector-level pre-check (#355 gap 2): a same-row STACKED rail label spans
  // TWO lines ("Technical" over "Skills"), which no one-line proposer can
  // consume. Checked before the ordered proposer list, exactly where
  // `classifyLine`'s caller ran it today — gated to single-column, past the
  // leading name/contact block, and only when this row isn't itself an
  // already-recognized header (so an ordinary two-line profile pair can't
  // mint a false section).
  if (
    ctx.singleColumn &&
    (ctx.openedRealSection || ctx.seenContactInProfile) &&
    ctx.nextLine &&
    !matchSectionHeaderDetailed(line.text)
  ) {
    const stacked = tryStackedRailLabel(line, ctx.nextLine);
    if (stacked) {
      return {
        action: {
          kind: "open",
          name: stacked.section,
          rawHeading: stacked.rawHeading,
          retainLines: stacked.remainders,
        },
        consumedLines: 2,
      };
    }
  }

  for (const { propose, resolve } of PROPOSER_ORDER) {
    const candidate = propose(line, ctx);
    if (!candidate) continue;
    return { action: resolve(candidate, line, ctx), consumedLines: 1 };
  }

  return {
    action: {
      kind: "append",
      marksContactEnd: !ctx.openedRealSection && hasContactShape(line.text),
    },
    consumedLines: 1,
  };
}
