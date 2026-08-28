// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
 * The separator that joins several credentials onto ONE compact certifications
 * line (#899). It is deliberately the same `" · "` every other multi-value line
 * in the reconstructed PDF uses (the skills list, `Company · Location`), and the
 * exporter imports THIS constant rather than spelling it a second time —
 * `ats-resume-model.ts` builds `AtsSection.compactLine` with it and the renderer
 * wraps that line on it ATOMICALLY (`MIDDOT_SEGMENT_SEP`, `wrapSegmentsToLines`).
 *
 * Atomic wrapping is what makes the compact line round-trip at all: the wrap
 * point can only fall BETWEEN credentials, so every extracted `PdfLine` of the
 * block starts at a credential boundary and {@link parseFlatAwardList} can split
 * each line back into whole credentials without any flow-joining. The
 * parse → export → re-parse hop over `google-docs-skia-proxy-certifications.pdf`
 * (`corpus-roundtrip.test.ts`) is what pins the two ends to the same glyph.
 */
export const CREDENTIAL_LIST_SEPARATOR = " · ";

/**
 * The boundary {@link CREDENTIAL_LIST_SEPARATOR} draws, as the re-parser sees
 * it. Whitespace is REQUIRED on both sides, so a middot glued inside a token is
 * not a boundary, and `\s` (which covers the NBSP / thin spaces a PDF extractor
 * emits, not just U+0020) absorbs whatever spacing the extraction hands back.
 */
export const CREDENTIAL_SPLIT_RE = /\s+·\s+/;

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
  options?: {
    /**
     * Whether to run {@link splitAchievementType} on each entry's header
     * (#899). Certifications are name-led credential titles, not "Type ·
     * label" award headers — splitting one lops off a leading segment into a
     * nonsensical `type` ("AWS · Certified Solutions Architect" → type
     * "AWS"). Set `false` from the certifications call site
     * (`openresume.ts`) so `type` always stays `undefined` and the full
     * credential title is preserved in `title`. Defaults to `true`, so every
     * achievements call site is byte-identical.
     */
    splitType?: boolean;
    /**
     * Whether a flat-list line carrying {@link CREDENTIAL_LIST_SEPARATOR} is
     * split back into one entry per credential (#899) — the inverse of the
     * compact certifications line the PDF exporter draws. Set `true` from the
     * certifications call site only: an ACHIEVEMENT header uses the very same
     * middot as a display joiner ("Patent · Foo", "keyword · statement · year",
     * #307/#456), so splitting one there would shred a single award into
     * fragments. Defaults to `false`, so every achievements call site is
     * byte-identical. See {@link parseFlatAwardList} for what the flag actually
     * switches.
     */
    splitCompactList?: boolean;
  },
): { value: HeuristicAchievement[]; confidence: number } {
  if (!achievements || achievements.lines.length === 0) {
    return { value: [], confidence: 0 };
  }
  const splitType = options?.splitType ?? true;
  const splitCompactList = options?.splitCompactList ?? false;

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
    : parseFlatAwardList(lines, splitCompactList);

  // Drop any date-only / title-less block (#145) before scoring.
  return finalizeEntries(
    blocks.map((block) => achievementFromBlock(block, splitType)),
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
 *
 * `splitCompact` (#899, certifications only) adds the inverse of the exporter's
 * compact credential line: when ANY line in the section carries
 * {@link CREDENTIAL_LIST_SEPARATOR}, the section is DELIMITER-STRUCTURED and
 * every line is split on that separator into one block per credential
 * ({@link appendCredentialLine}), except where a stretch of it reads as a single
 * dated credential row instead ({@link isDatedCredentialRow}). Two consequences
 * follow from that reading and are deliberate:
 *
 *   - **Line-wrap folding is switched off for the whole section.** The exporter
 *     wraps the compact line atomically, so each extracted line begins at a
 *     credential boundary and a "wrapped tail" cannot exist; leaving the fold on
 *     would instead swallow a lowercase-led credential ("iOS …") into the line
 *     above. Applying it section-wide rather than line-by-line is what covers
 *     the wrapped tail that happens to hold a single credential and therefore
 *     carries no separator of its own. It also means a genuinely wrapped tail on
 *     a separator-less line inside a delimited section does NOT fold — the two
 *     readings of a lowercase-led line are indistinguishable and this one is the
 *     load-bearing half, since the fold would lose a credential outright. That
 *     tradeoff is CHOSEN here, not inherited: the test that pins it
 *     ("opens an entry for a lowercase-led credential on a wrapped tail line")
 *     was written alongside this flag, so a future change is free to revisit the
 *     choice — it is a decision to argue with, not a prior contract.
 *   - **A date-only fragment re-joins the credential before it.** A source that
 *     wrote "CKA · 2021" means the middot as its YEAR separator, not as a list
 *     boundary, and that shape must keep parsing exactly as it did before this
 *     flag existed — so the fragment is re-joined verbatim instead of splitting
 *     the credential from its date.
 *   - **The dated-row reading is judged per RUN, not per line.** A two-column
 *     certifications block reaches line assembly as one `PdfLine` holding
 *     several "Credential · Issuer · Year" triples, and a whole-line reading
 *     refuses to collapse ANY of them the moment a second one supplies an
 *     earlier date — handing every trailing year back to the issuer beside it.
 *     {@link dateTerminatedRuns} cuts the line at its dates so each triple is
 *     judged on its own.
 *
 * With no separator anywhere in the section — a single certification, or one
 * per line — nothing splits and this is the original function, unchanged.
 */
function parseFlatAwardList(
  lines: PdfLine[],
  splitCompact: boolean,
): EntryBlock[] {
  const texts = lines.map((l) => l.text.trim());
  const delimited =
    splitCompact && texts.some((t) => CREDENTIAL_SPLIT_RE.test(t));
  const blocks: EntryBlock[] = [];
  for (const text of texts) {
    if (!delimited) {
      appendAward(blocks, text);
      continue;
    }
    const segments = text
      .split(CREDENTIAL_SPLIT_RE)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    appendCredentialLine(blocks, segments);
  }
  return blocks;
}

/**
 * AP-style two-digit year ("'19"). No date regex in the pipeline recognises one
 * without a month in front of it — `YEAR_RE` wants four digits and
 * `STRICT_MONTH_YEAR_RE` wants the month — so `stripDateRange` leaves it whole
 * and the date-only test below has to name it explicitly. Two forms because the
 * two questions differ: whether a segment IS one, and whether a segment CARRIES
 * one somewhere inside it.
 */
const LONE_APOSTROPHE_YEAR_RE = /^'\d{2}$/;
const APOSTROPHE_YEAR_RE = /'\d{2}\b/;

/**
 * True when a `" · "` segment reduces to nothing but a date — the shape that
 * means the source used the middot as its YEAR separator rather than as a list
 * boundary.
 *
 * The discriminator is `stripDateRange` emptying the segment, NOT
 * `isLoneDateRange`: that predicate deliberately admits only bare 4-digit years
 * under `allowSingle` (see its docblock), so "May 2021" and "'19" fell through
 * it, opened their own empty-titled block and were dropped by `finalizeEntries`
 * — the credential lost its date outright on an ordinary source shape. Asking
 * "does anything survive the date strip" is the same question the entry-block
 * parser already asks of a header, and it admits every date form the pipeline
 * can parse rather than a hand-picked subset. It does not over-catch a real
 * credential or issuer name: `stripDateRange` only deletes what a date regex
 * matched, so "CKA" and "Amazon Web Services" come back unchanged.
 */
function isDateOnlySegment(segment: string): boolean {
  return (
    stripDateRange(segment) === "" || LONE_APOSTROPHE_YEAR_RE.test(segment)
  );
}

/** True when a segment carries a date anywhere inside it ("CKA (2021)"), as
 *  opposed to BEING one. Reads the same strict regexes the title/date split
 *  downstream uses, so a false month ("Marketing") is not a date here either. */
function carriesDate(segment: string): boolean {
  return (
    parseDateRange(segment).start_date !== undefined ||
    APOSTROPHE_YEAR_RE.test(segment)
  );
}

/**
 * Cut a delimited line's segments into DATE-TERMINATED RUNS: each date-only
 * segment ({@link isDateOnlySegment}) closes the run it sits at the end of, and
 * whatever trails the last one is an unterminated final run.
 *
 * The run, not the line, is the unit {@link isDatedCredentialRow} judges (#899).
 * A line holding one "Credential · Issuer · Year" triple and a line holding two
 * of them are the same shape repeated, and a two-column certifications block
 * that line assembly joined into one `PdfLine` produces exactly the second —
 * but a whole-line reading sees the FIRST triple's year as "an earlier segment
 * carries a date", refuses the collapse for the whole line, and hands every
 * trailing year back to the issuer beside it. That is the very fabrication the
 * collapse exists to stop, reintroduced by the line's length.
 *
 * Runs of zero non-date segments are kept rather than dropped: a leading date
 * fragment ("2021 · CKA") closes one, and {@link appendCredentialLine} still has
 * to hold that date for the credential it dates.
 */
function dateTerminatedRuns(segments: string[]): string[][] {
  const runs: string[][] = [];
  let run: string[] = [];
  for (const segment of segments) {
    run.push(segment);
    if (isDateOnlySegment(segment)) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * True when one date-terminated run is ONE credential whose middots are
 * internal — the everyday "Credential · Issuer · Year" row — rather than a list
 * of credentials. Three conditions, all needed (#899):
 *
 *   - the run has THREE or more segments, i.e. two or more credential-shaped
 *     segments before its date. At two ("CKA · 2021") the trailing date is
 *     re-joined to the one credential before it, which is the same entry either
 *     way, so there is nothing for this to decide;
 *   - the LAST segment is nothing but a date — an unterminated run has no date
 *     to bind wrongly in the first place; and
 *   - no EARLIER segment carries a date of its own.
 *
 * Without the third condition a genuine list whose credentials each carry their
 * own year INSIDE the run ("AWS Certified Cloud Practitioner (2025) · CKA ·
 * 2021") would collapse into a single entry and lose every credential but the
 * first. With it, the only shape that collapses is a run carrying exactly one
 * date, at its end — which our own exporter never emits, since
 * `compactCredentialHeader` parenthesises every year precisely so it cannot be
 * read as a boundary.
 *
 * Collapsing is what stops the trailing year from binding to the ISSUER segment
 * and inventing a dated certification the résumé never claimed ("Amazon Web
 * Services, 2024"). The cost is that the entry's title then contains a `" · "`
 * of its own, so a SECOND export hop re-splits it under the same
 * issuer-middot tradeoff `achievements.test.ts` pins for the two-segment shape.
 * Fabricating a credential on the first parse is the worse of the two.
 */
function isDatedCredentialRow(run: string[]): boolean {
  if (run.length < 3) return false;
  if (!isDateOnlySegment(run[run.length - 1]!)) return false;
  return !run.slice(0, -1).some(carriesDate);
}

/** Add one line of a NON-delimited flat award list: a continuation folds into
 *  the block above, anything else opens its own. */
function appendAward(blocks: EntryBlock[], text: string): void {
  const prev = blocks[blocks.length - 1];
  if (prev && isAwardContinuation(text)) {
    prev.headerLines[0] = `${prev.headerLines[0]} ${text}`.trim();
    return;
  }
  blocks.push({ headerLines: [text], dates: {}, bulletCount: 0 });
}

/**
 * Add one delimited line as blocks, one date-terminated run at a time (#899).
 *
 * A run that reads as a dated credential row ({@link isDatedCredentialRow})
 * becomes ONE block carrying the run verbatim; every other run falls through to
 * {@link appendCredentialSegments}, which opens a block per credential. Judging
 * run by run is what lets a line holding several "Credential · Issuer · Year"
 * triples collapse each of them — see {@link dateTerminatedRuns}.
 *
 * `leadingDate` is threaded ACROSS the runs of the line because the shape it
 * serves straddles them: "2021 · CKA" is a bare-date run followed by a
 * credential run, and the date has to survive the boundary to reach the
 * credential it dates. A collapsed run clears it instead — that run already
 * carries its own trailing year, so a held date has no credential left to
 * belong to on this line, and binding it to a LATER one would invent exactly
 * the dated credential the collapse exists to prevent.
 */
function appendCredentialLine(blocks: EntryBlock[], segments: string[]): void {
  let leadingDate: string | undefined;
  for (const run of dateTerminatedRuns(segments)) {
    if (isDatedCredentialRow(run)) {
      blocks.push({
        headerLines: [run.join(CREDENTIAL_LIST_SEPARATOR)],
        dates: {},
        bulletCount: 0,
      });
      leadingDate = undefined;
      continue;
    }
    leadingDate = appendCredentialSegments(blocks, run, leadingDate);
  }
}

/**
 * Add one run's worth of `" · "`-delimited segments as one block per credential
 * (#899). Returns the date still held for a credential that has not arrived yet,
 * which {@link appendCredentialLine} carries into the next run.
 *
 * A segment that is nothing but a date ({@link isDateOnlySegment}) is a
 * credential's YEAR, not a credential, so it is re-joined with the separator it
 * was split on — leaving `achievementFromBlock` the same single string (and
 * therefore the same `year` / `year_separator`) it would have read off an
 * unsplit line. Which credential it dates depends on where it sits:
 *
 *   - after one ("CKA · 2021 · …") it re-joins the block above it;
 *   - BEFORE any ("2021 · CKA · …", a source that dates its credentials on the
 *     left) it is held and appended to the credential that follows. Dropping it
 *     for want of a previous block — what the first cut did — lost the year, and
 *     appending rather than prepending is what keeps the date TRAILING, the only
 *     position `stripDateRange` + `liftHeaderLabel` can peel back off a title
 *     without stranding the separator in front of it.
 *
 * A held date is only ever displaced by a LATER one when the section opens on
 * two bare dates in a row ("2024 · 2025 · CKA") — there is no block to re-join
 * to and no credential yet to date, and the two cannot both be the credential's
 * year. Keeping the FIRST is arbitrary in exactly the way keeping the last is,
 * so neither is defensible; the held date is flushed into a block of its own
 * instead, which is title-less and therefore dropped by `finalizeEntries` (#145)
 * exactly as an undated stray date always has been.
 */
function appendCredentialSegments(
  blocks: EntryBlock[],
  segments: string[],
  held: string | undefined,
): string | undefined {
  let leadingDate = held;
  for (const segment of segments) {
    if (isDateOnlySegment(segment)) {
      if (leadingDate !== undefined) {
        blocks.push({ headerLines: [leadingDate], dates: {}, bulletCount: 0 });
        leadingDate = undefined;
      }
      const prev = blocks[blocks.length - 1];
      if (prev) {
        prev.headerLines[0] =
          `${prev.headerLines[0]}${CREDENTIAL_LIST_SEPARATOR}${segment}`;
      } else {
        leadingDate = segment;
      }
      continue;
    }
    const header = leadingDate
      ? `${segment}${CREDENTIAL_LIST_SEPARATOR}${leadingDate}`
      : segment;
    leadingDate = undefined;
    blocks.push({ headerLines: [header], dates: {}, bulletCount: 0 });
  }
  return leadingDate;
}

/** Map one entry block to a `HeuristicAchievement` and its confidence score.
 *  Extracted from `extractAchievements` to keep each function below the
 *  complexity threshold; mirrors `projectFromBlock`. `splitType` is threaded
 *  straight from `extractAchievements`'s option (#899) — see its docblock. */
function achievementFromBlock(
  block: EntryBlock,
  splitType: boolean,
): {
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
  // re-splitting a composed string (which is not a round-trip). Certifications
  // opt out (#899, `splitType`): a credential title is never "Type · label"
  // shaped, so `type` stays undefined and the full title survives untouched.
  const split = splitType ? splitAchievementType(label) : null;
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
