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
 * are re-exported here for existing importers. This module now owns the
 * whole-document label-rail partitioner (`splitByLabelRail`), the headerless-
 * experience recovery post-pass, and the markdown-anchored splitter — the
 * per-line header-classification logic that used to live here as
 * `classifyLine` is now the two-phase proposer/selector router in
 * `section-router.ts`, built on the recogniser predicates in
 * `section-predicates.ts` (#655).
 */

import type { PdfTextItem } from "./types.ts";
import {
  matchSectionHeader,
  DATE_RANGE_RE,
  DEGREE_RE,
  INSTITUTION_HINTS,
  type SectionName,
} from "./regex.ts";
import { mergeWrappedContinuations } from "./entry-blocks.ts";
import { isBulletLine, isEntryHeaderShape } from "./line-primitives.ts";
import {
  LINE_Y_EPS,
  computeBodyFontSize,
  mergeItemText,
} from "./line-assembly.ts";
import type { PdfLine, PdfSection, SectionedResume } from "./line-model.ts";
import { ACCOMPLISHMENT_SECTION_NAMES } from "./line-model.ts";
import {
  computeBodyLineHeight,
  detectSidebarSides,
  columnBandOf,
  buildLineFromItems,
  matchExactAlias,
  matchLeadingTokenHeader,
  RAIL_X_TOL,
  STRONG_DATE_TOKEN_RE,
  type SidebarSide,
} from "./section-predicates.ts";
import { selectLineAction, type RouterContext } from "./section-router.ts";

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
 * with `detectSidebarSides` it resolves each line to a `ColumnBand`, which
 * feeds the sidebar-header recovery proposer in `section-router.ts` (#117): a
 * glued sidebar artifact like `"20% Projects"` in the sidebar rail recovers its
 * real section name. For single-column docs the map is absent and that
 * proposer never fires — output stays byte-identical to the pre-#117 behavior.
 *
 * The per-line decision itself (open a boundary vs. append) is delegated to
 * `selectLineAction` (`section-router.ts`, #655) — this function's job is
 * building the per-line `RouterContext`, applying the resulting `LineAction`,
 * and owning the two whole-document paths (`splitByLabelRail`) and
 * cross-line state (`sections`, `openedRealSection`, `seenContactInProfile`,
 * `prevLineOpenedBoundary`) that no single-line router call can see.
 */
export function splitIntoSections(
  lines: PdfLine[],
  columnBoundaries?: Map<number, number>,
): PdfSection[] {
  // Single-column docs enable the #310/#311 second-experience-header boundary
  // (see the adjacency note on `isInstitutionRepeat` in `section-predicates.ts`).
  // Two-column layouts keep the stricter #258 suppression: a sidebar flatten
  // interleaves recovered anchors mid-column, where a relaxed boundary would
  // mint spurious sections.
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
  const bodyBaseline = computeBodyFontSize(lines);
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
    // Per-line two-column band (undefined for single-column pages / docs).
    const columnBand = columnBandOf(line, columnBoundaries, sidebarSides);
    const ctx: RouterContext = {
      lineIdx: i,
      bodyBaseline,
      bodyLineHeight,
      openedRealSection,
      seenContactInProfile,
      prevLineOpenedBoundary,
      columnBand,
      currentSection: sections[sections.length - 1].name,
      singleColumn,
      nextLine: lines[i + 1],
    };
    const { action, consumedLines } = selectLineAction(line, ctx);
    if (action.kind === "open") {
      const opened: PdfSection = {
        name: action.name,
        rawHeading: action.rawHeading ?? line.text.trim(),
        lines: [],
      };
      // #355: retain the header row's remainder(s) as the section's first
      // content line(s) — the role/degree entry that shared an inline
      // leading-token header's row (gap 1), or the grid values carried on a
      // same-row stacked label's two rows (gap 2).
      if (action.retainLines) opened.lines.push(...action.retainLines);
      sections.push(opened);
      openedRealSection = true;
      prevLineOpenedBoundary = true;
      // Selector-level "consume next line" outcome (#355 gap 2's stacked
      // rail label spans two source lines): skip past what it consumed.
      i += consumedLines - 1;
      continue;
    }
    prevLineOpenedBoundary = false;
    if (action.marksContactEnd) seenContactInProfile = true;
    sections[sections.length - 1].lines.push(line);
  }

  return sections;
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
// rather than as another proposer in `section-router.ts` (#655):
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
 * anchor costs nothing and closes the whole class.
 *
 * The institution half is ALSO anchored to the lead now (#843 item 5), the
 * same reasoning applied to the same word order: a real education entry LEADS
 * with its degree or its school, while an employer name — "Research Engineer,
 * Stanford University (Sep 2018 - Jun 2021)", "Content Lead, Khan Academy (Jul
 * 2021 - Present)" — carries the institution AFTER the title, separated by the
 * first comma. Un-anchored, `University` / `College` / `Institute` / `School` /
 * `Academy` / `Polytechnic` matched anywhere in the head, so both examples above
 * read as degree lines and a whole headerless cluster of such roles recovered
 * ZERO of them. The anchor is the HEAD's leading segment, up to (not including)
 * the first comma — the same segment a "Title, Company, Location" line would
 * put its title in — tested with {@link INSTITUTION_HINTS} rather than
 * requiring index 0, since the hint word can sit anywhere inside a multi-word
 * institution name ("Ridgemont State University"). An institution-LED line
 * ("Ridgemont State University, B.S. Computer Science (Aug 2012 - May 2016)")
 * still rejects, because the hint now sits in its own lead segment.
 *
 * The residue this leaves: an institution name split ACROSS the first comma —
 * "Stanford, University Relations (Sep 2018 - Jun 2021)" — would recover as a
 * role, same as it did before this anchor (both halves of the trade are
 * unmeasured without a repro; #843 did not surface one, so it is stated rather
 * than guessed at). A degree list read as employment is still worse than a
 * school-employed role left where it was, so the predicate still fails CLOSED
 * on ambiguity — the anchor only narrows WHERE it looks, not which way the
 * guard resolves a tie.
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
  const leadSegment = head.split(",")[0];
  if (INSTITUTION_HINTS.test(leadSegment)) return false;
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
 *
 * Second known residue (PR #1162 review, on #843 item 5): a headerless
 * EDUCATION line written "Field, Institution (dates)" with no `DEGREE_RE`
 * abbreviation at all — e.g. "Computer Science, Stanford University (Sep
 * 2018 - Jun 2021)" — still misreads as a role header, because the
 * institution hint sits past the first comma, outside the lead segment
 * {@link looksLikeHeaderlessRoleHeader} tests. Falling back to an
 * `INSTITUTION_HINTS` test over the FULL head when the lead segment misses
 * is not a safe fix: it is the exact shape of the #843 item 5 fixture this
 * function now recovers correctly ("Research Engineer, Stanford University"
 * has the institution past the comma too), so that fallback would reject a
 * genuine institution-named EMPLOYER right back out again. No repro pins
 * this one; the ambiguity is real ("Title, Org" and "Field, Org" are the same
 * shape without a header or a degree word to arbitrate) and is left open
 * rather than guessed at with a fix that regresses the case just closed.
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

/**
 * Split `lines` into sections using the markdown emitter's heading promotions
 * as the boundary signal, rather than running `matchSectionHeader` against
 * every line. `headings` is the set of `PdfLine` objects the emitter rendered
 * as `#`/`##`/`###` (`MarkdownEmission.headings`) — the SAME objects as in
 * `lines`, so membership is tested by identity. Returns `null` when fewer than
 * two canonical sections open; the caller falls back to the regex-on-line
 * splitter.
 *
 * Why this is tighter than the regex-on-line splitter: the line splitter
 * matches *any* line whose text equals a section keyword (e.g. a line that
 * just says "Skills" in the middle of a profile paragraph would open a new
 * section). This splitter only treats a line as a header when the emitter
 * already promoted it via font-size ratio — filtering out the body-font-size
 * false positives the line splitter cannot avoid.
 *
 * Why identity and not text (#651): the emitter used to assemble its own lines
 * and this splitter reconciled the two by normalized text equality, so any
 * assembly disagreement on a heading row silently failed the match and demoted
 * the whole document to the regex path. With one assembler and one array, the
 * promotion gate is meaningful exactly because the promoted object IS the line
 * being classified. A promoted heading whose text is not a canonical section
 * name (the candidate's name, a tagline) opens nothing and falls into the
 * current section, as before.
 */
export function splitIntoSectionsWithMarkdown(
  lines: PdfLine[],
  headings: ReadonlySet<PdfLine>,
): PdfSection[] | null {
  if (headings.size === 0) return null;

  const sections: PdfSection[] = [{ name: "profile", lines: [] }];
  // Immediately-preceding line that was APPENDED to the current section (not a
  // header). Reset to null whenever a section opens, so the two-line-wrap fold
  // below only ever considers two consecutive body lines. See `matchWrappedHeader`.
  let prevAppended: PdfLine | null = null;
  for (const line of lines) {
    const section = headings.has(line) ? matchSectionHeader(line.text) : null;
    if (section) {
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
    // is in `headings` — the identity-gated branch above never fires and the
    // whole section is stranded in the profile. When this
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

  // Count only non-profile sections — promoted headings that are all
  // non-canonical (name, tagline) open nothing and still fall back.
  const canonicalCount = sections.filter((s) => s.name !== "profile").length;
  if (canonicalCount < 2) return null;

  return sections;
}
