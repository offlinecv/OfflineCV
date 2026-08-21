// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Education GRADE + HONORS recognition (#883) — the one predicate that decides
 * whether a run of text on an education line is a grade note (`GPA: 3.72/4.00`,
 * `CGPA 8.4/10`, `First Class`, `2:1`) or a Latin-honors note (`cum laude`,
 * `with distinction`).
 *
 * It exists as its own leaf module because THREE call sites in
 * `extract/education.ts` need the same answer and must never drift: the
 * collector that lifts `gpa` / `honors` onto the entry (`parseEducationGrade`),
 * `cleanField`'s cut that keeps the same text out of the degree's subject field
 * (`isEducationNoteSegment`), and the chunker's entry-boundary guard that keeps
 * an annotation line from leading a new entry (`isGradeAnnotationLine`). A
 * fourth consumer lives in `pdf/ats-resume-model.ts`: `formatGradeNote` renders
 * the value back into a line this module re-reads, which is what makes the
 * export round-trip.
 *
 * Recognition happens at two SCOPES, and which scope a caller is entitled to is
 * the module's central distinction:
 *
 *   - **Whole LINE** — {@link parseEducationGrade} asks "does this line carry a
 *     grade anywhere?", so its labelled search is unanchored. That is safe there
 *     because the collector only lifts a value onto a field of its own; it never
 *     decides that text is *disposable*. It is also necessary: real résumés bury
 *     the keyword behind a column gap, a tab run, or a middot
 *     (`Aug. 2021 - May. 2025 · Columbus, Ohio · GPA: 3.7 / 4.0`), and a
 *     dash-separated `GPA - 3.5` straddles a segment boundary.
 *   - **Whole SEGMENT** — {@link classifyGradeSegment} asks "is this segment
 *     NOTHING BUT a grade note?", and its callers delete on a yes: the field cut
 *     in `extract/education.ts` drops the segment, and for a lead segment the
 *     whole subject field with it. Every branch is therefore anchored `^…$`,
 *     the labelled one included — an unanchored labelled branch read
 *     `B.S. in Computer Science GPA 3.8` as a pure grade note and silently
 *     dropped `Computer Science` from the parse, the export, and JD matching.
 *
 * The unlabelled branches are anchored for a second, independent reason:
 * `cum laude` and `First Class` are ordinary English that appears inside prose,
 * and the education section routinely pools such prose from a mis-routed
 * compound header — `Achievements: Graduated B.E. with Distinction; mentored 3
 * interns` (the `compound-certifications-activities-tail` fixture) must NOT
 * yield honors. A substring search there would fire on it.
 *
 * The value is stored VERBATIM — `3.72/4.00`, `3.7 / 4.0`, `8.4/10`,
 * `First Class`, `2:1` all survive as written. Normalising to a float would
 * throw away the scale and invent precision the résumé never carried, so the
 * model field is a string and nothing here parses a number.
 */

/** A grade NUMBER: 1–3 integer digits, an optional decimal tail, and no further
 *  digit after it. The `(?!\d)` is load-bearing — without it a 4-digit YEAR
 *  ("Best GPA 2020") would match its first three digits and surface "202" as a
 *  grade. With it, every split of a 4-digit run fails and the year is rejected. */
const GRADE_NUMBER_SRC = String.raw`\d{1,3}(?:\.\d+)?(?!\d)`;
/** A grade VALUE: a number, an optional `/N` scale, an optional percent sign.
 *  Whitespace inside the scale is preserved by the capture, so "3.7 / 4.0"
 *  round-trips as written rather than being re-spaced. */
const GRADE_VALUE_SRC =
  GRADE_NUMBER_SRC + String.raw`(?:\s*\/\s*${GRADE_NUMBER_SRC})?(?:\s*%)?`;
/** The grade-keyword vocabulary: GPA, and the cumulative / semester variants
 *  Indian and other non-US résumés use. */
const GRADE_LABEL_SRC = String.raw`[cs]?gpa`;

/** The qualifier words that may sit in front of the grade keyword and still
 *  leave the run a PURE grade note — `Cumulative GPA: 3.93/4.0`,
 *  `Cum. GPA: 3.83 / 4.0`, `Major GPA: 3.9 / 4.0`. Deliberately an enumeration
 *  rather than a permissive `\w+`: arbitrary leading words are precisely what a
 *  SUBJECT looks like ("Computer Science GPA 3.8"), so a wildcard here would
 *  hand back the substring search the anchored forms below exist to replace. */
const GRADE_QUALIFIER_SRC = String.raw`(?:(?:cumulative|cum\.?|overall|major|final|current)\s*)?`;

/** `GPA: 3.8` / `CGPA 8.7/10` / `Cum. GPA: 3.83 / 4.0` — label then value. */
const GRADE_LABEL_FIRST_SRC = String.raw`${GRADE_QUALIFIER_SRC}\b${GRADE_LABEL_SRC}\b\s*[:\-–—]?\s*(${GRADE_VALUE_SRC})`;
/** `3.8 GPA` — value then label, the shape openresume's template emits. */
const GRADE_LABEL_LAST_SRC = String.raw`(${GRADE_VALUE_SRC})\s*\b${GRADE_LABEL_SRC}\b`;

/** The two shapes searched ANYWHERE in a line, for {@link parseEducationGrade}
 *  alone — see the module docblock for why no other caller may have these. */
const GRADE_LABEL_FIRST_RE = new RegExp(GRADE_LABEL_FIRST_SRC, "i");
const GRADE_LABEL_LAST_RE = new RegExp(GRADE_LABEL_LAST_SRC, "i");

/** The same two shapes anchored to a WHOLE segment, for
 *  {@link classifyGradeSegment}'s "is this segment nothing but a grade?"
 *  question — the one its callers delete on. */
const GRADE_LABEL_FIRST_SEGMENT_RE = new RegExp(
  String.raw`^${GRADE_LABEL_FIRST_SRC}$`,
  "i",
);
const GRADE_LABEL_LAST_SEGMENT_RE = new RegExp(
  String.raw`^${GRADE_LABEL_LAST_SRC}$`,
  "i",
);

/** The same two shapes anchored to the END of a longer run, with at least one
 *  space in front — a grade that rode onto a subject with no punctuation to
 *  divide them ("Computer Science GPA 3.8", "Computer Science 3.8 GPA"), which
 *  the segment split therefore cannot separate. The leading `\s+` is what keeps
 *  {@link cutTrailingGradeNote} from emptying a field that is nothing BUT a
 *  grade; deciding that case is {@link classifyGradeSegment}'s job. */
const TRAILING_GRADE_NOTE_RE = new RegExp(
  String.raw`\s+(?:${GRADE_LABEL_FIRST_SRC}|${GRADE_LABEL_LAST_SRC})$`,
  "i",
);

/** A degree CLASSIFICATION written as a whole segment, with no grade keyword to
 *  anchor it — the UK/Commonwealth and Indian conventions. Whole-segment only
 *  (see the module docblock): `class` and `division` are common words. */
const GRADE_CLASSIFICATION_RE =
  /^(?:(?:first|second|third)[\s-]class(?:\s+(?:honou?rs|with\s+(?:distinction|merit)|upper\s+division|lower\s+division))?|(?:first|second|third)\s+division|2:[12])$/i;

/** An optional `Honors:` / `Honours —` label in front of the honors phrase, so
 *  a labelled line reduces to the same anchored phrase a bare one does. Only
 *  honors-specific labels: `Achievements:` and `Awards:` introduce award LISTS,
 *  and stripping those would hand prose to the anchored test below. */
const HONORS_LABEL_RE = /^(?:latin\s+)?honou?rs?\s*[:\-–—]\s*/i;
/** The honors vocabulary, matched against a WHOLE segment: the Latin set plus
 *  the English "with <honors|distinction>" forms and their intensifiers. */
const HONORS_RE =
  /^(?:(?:summa|magna)\s+)?cum\s+laude$|^(?:graduated\s+)?with\s+(?:high(?:est)?\s+)?(?:honou?rs|distinction)$/i;

/** A bare graduation YEAR trailing a punctuation-delimited segment, with
 *  whatever whitespace separates it — for {@link annotationSegments} only. A
 *  composed export line (#883) can glue the year onto an unlabelled honors
 *  phrase with nothing but a single space ("cum laude 2023"), too narrow a
 *  gap to trip the tab/2-space cell split below, so the year has to be peeled
 *  off before the whole-segment test or it never reduces to bare "cum laude".
 *  A labelled GPA note is unaffected — {@link labelledGrade} searches the raw
 *  line separately and never sees this stripped copy. */
const TRAILING_BARE_YEAR_RE = /\s*\b(?:19|20)\d{2}\b\s*$/;

/** Where one run of text on an education line ends and the next begins: a
 *  comma/semicolon, a middot/bullet, a pipe, or a SPACED dash. The dash must be
 *  spaced on both sides — an unspaced hyphen belongs inside a hyphenated word
 *  ("Pre-Med"), where a spaced one divides two runs. Exported as a SOURCE string
 *  so `extract/education.ts`'s field cut segments a degree line exactly the way
 *  this module's recogniser does; two hand-kept copies would let the collector
 *  and the cut disagree about where a note starts. */
export const EDUCATION_SEGMENT_SPLIT_SRC = String.raw`\s*[,;·•|]\s*|\s+[-–—]\s+`;

/** The punctuation-delimited runs of `line`, whitespace collapsed, empties
 *  dropped. The coarse granularity — {@link annotationSegments} adds the column
 *  cells within each run. */
function coarseSegments(line: string): string[] {
  return line
    .split(new RegExp(EDUCATION_SEGMENT_SPLIT_SRC))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** GPA / honors lifted off an education entry's lines. Either may be absent; a
 *  value is the résumé's own text, never a normalised number. */
export interface EducationGrade {
  gpa?: string;
  honors?: string;
}

/**
 * The segments of one line that an UNLABELLED classification / honors phrase may
 * occupy on its own. Split on punctuation separators and spaced dashes, and —
 * because a two-column grid puts the honors in a right-hand rail — additionally
 * on tab runs and column gaps WITHIN each punctuation segment. Both granularities
 * are returned rather than the finer one alone: a Word template that tabs BETWEEN
 * every word ("Magna\t  Cum\t  Laude") would shred the phrase at the finer
 * granularity, while the coarse segment keeps it whole once its internal
 * whitespace is collapsed.
 */
function annotationSegments(line: string): string[] {
  const out: string[] = [];
  for (const rawPart of line.split(new RegExp(EDUCATION_SEGMENT_SPLIT_SRC))) {
    const part = rawPart.replace(TRAILING_BARE_YEAR_RE, "");
    const whole = part.replace(/\s+/g, " ").trim();
    if (whole) out.push(whole);
    for (const cell of part.split(/\t+|\s{2,}/)) {
      const seg = cell.replace(/\s+/g, " ").trim();
      if (seg && seg !== whole) out.push(seg);
    }
  }
  return out;
}

/** The labelled grade value carried anywhere in `line`, or undefined. Label-first
 *  is tried before label-last so "GPA: 3.8" is never read backwards. Unanchored
 *  — for {@link parseEducationGrade}'s whole-line pass only. */
function labelledGrade(line: string): string | undefined {
  const m = GRADE_LABEL_FIRST_RE.exec(line) ?? GRADE_LABEL_LAST_RE.exec(line);
  return m?.[1]?.trim();
}

/** The labelled grade value when it is the ENTIRE segment, or undefined — the
 *  anchored twin of {@link labelledGrade}, same label-first precedence. */
function labelledGradeSegment(segment: string): string | undefined {
  const m =
    GRADE_LABEL_FIRST_SEGMENT_RE.exec(segment) ??
    GRADE_LABEL_LAST_SEGMENT_RE.exec(segment);
  return m?.[1]?.trim();
}

/**
 * Classify ONE segment as a grade, an honors phrase, or neither — a WHOLE-segment
 * predicate in every branch, because callers delete on a yes (module docblock).
 * Grade wins over honors when both could match — "First Class with Distinction"
 * is one classification, not a classification plus separate honors, and
 * splitting it would store half the résumé's phrase in each field.
 */
export function classifyGradeSegment(
  segment: string,
): { kind: "gpa" | "honors"; value: string } | undefined {
  const seg = segment.replace(/\s+/g, " ").trim();
  if (!seg) return undefined;
  const labelled = labelledGradeSegment(seg);
  if (labelled) return { kind: "gpa", value: labelled };
  if (GRADE_CLASSIFICATION_RE.test(seg)) return { kind: "gpa", value: seg };
  const honors = seg.replace(HONORS_LABEL_RE, "").trim();
  if (HONORS_RE.test(honors)) return { kind: "honors", value: honors };
  return undefined;
}

/**
 * Drop a labelled grade note that rode onto the END of `field` with no
 * punctuation in front of it, keeping the subject ahead of it — "Computer
 * Science GPA 3.8" → "Computer Science".
 *
 * The segment-wise field cut cannot reach this one: there is no separator, so
 * the subject and the note are the SAME segment, and the whole-segment
 * predicates correctly decline to call that segment a note. Only the grade
 * KEYWORD tells the two apart, which is why this cut is labelled-only — an
 * unlabelled classification with no separator ("Economics First Class") is left
 * alone rather than guessed at, since "First Class" is also ordinary English a
 * subject could end in.
 */
export function cutTrailingGradeNote(field: string): string {
  return field.replace(TRAILING_GRADE_NOTE_RE, "").trim();
}

/** The minor/major/GPA/concentration prefixes `isEducationNoteSegment` cuts on
 *  sight, built from `GRADE_LABEL_SRC` rather than a hand-duplicated `c?gpa` so
 *  it recognizes `sgpa` the same way the labelled-grade regexes above do — a
 *  hand-copy previously drifted and missed it. */
const NOTE_PREFIX_RE = new RegExp(
  String.raw`^(?:minor|major|${GRADE_LABEL_SRC}|concentration)\b`,
  "i",
);

/**
 * Whether `segment` is a sub-field NOTE that rode along on a degree line rather
 * than part of the subject — a grade, an honors phrase, or the minor/major/
 * concentration labels `cleanField` has always cut. The single predicate behind
 * both the field cut and the collector, so the two can never disagree about
 * what counts as an annotation.
 */
export function isEducationNoteSegment(segment: string): boolean {
  const seg = segment.trim();
  if (!seg) return false;
  if (NOTE_PREFIX_RE.test(seg)) return true;
  return classifyGradeSegment(seg) !== undefined;
}

/**
 * Whether a whole LINE is nothing but a grade / honors annotation — "Magna Cum
 * Laude", "GPA: 3.9 · First Class". Every segment must be one, so a line that
 * also carries real entry text is not claimed.
 *
 * Used as an entry-BOUNDARY guard: such a line is a property of the entry above
 * it and must never be read as the lead of a new one. It complements
 * `PROGRAM_NOTE_RE`, which recognises the same idea by prefix (`GPA:`, `Minor`,
 * `Coursework`) and so cannot see an unlabelled honors phrase.
 */
export function isGradeAnnotationLine(line: string): boolean {
  const segments = coarseSegments(line);
  return (
    segments.length > 0 &&
    segments.every((s) => classifyGradeSegment(s) !== undefined)
  );
}

/**
 * Render a stored `gpa` value back into a line the parser reads as that same
 * value — the export's half of the round-trip (#883). A classification is
 * emitted BARE, because "GPA: First Class" is not how anyone writes it and the
 * unlabelled recogniser already reads it back; everything else takes the `GPA: `
 * label, which is what makes a numeric value recognisable at all.
 *
 * The equality check is the contract, not decoration: the bare branch is taken
 * only when re-reading the bare string yields the identical value, so a value
 * the recogniser would re-read DIFFERENTLY can never take it. A hand-typed value
 * outside the recogniser's vocabulary ("Top 5%") still renders correctly in the
 * PDF and is simply not recovered by a re-parse — display is not lost, only the
 * structured field is.
 */
export function formatGradeNote(value: string): string {
  const bare = classifyGradeSegment(value);
  if (bare?.kind === "gpa" && bare.value === value) return value;
  return `GPA: ${value}`;
}

/**
 * Collect the entry's GPA and honors from its lines, in document order — the
 * first of each kind wins. Order matters on a résumé that lists several grades
 * ("Cum. GPA: 3.83 / 4.0" above "Major GPA: 3.9 / 4.0"): the cumulative one is
 * written first and is the one a reader means by "the GPA".
 *
 * Each line is read at BOTH scopes, and the two are not redundant. The
 * unanchored whole-line pass is the only one that can reach a labelled grade
 * buried in a longer line — behind a column gap, a tab run, a middot, or a
 * dash-separated "GPA - 3.5" whose label and value straddle a segment boundary.
 * The per-segment pass is the only one that can reach an UNLABELLED
 * classification or honors phrase, which has no keyword to find it by and is
 * therefore recognised only as a whole segment. Being the sole caller entitled
 * to the unanchored search is what keeps that search out of the field cut, where
 * it would delete a real subject.
 */
export function parseEducationGrade(
  lines: readonly string[],
): EducationGrade {
  const out: EducationGrade = {};
  for (const line of lines) {
    if (!out.gpa) {
      const labelled = labelledGrade(line);
      if (labelled) out.gpa = labelled;
    }
    for (const segment of annotationSegments(line)) {
      const hit = classifyGradeSegment(segment);
      if (!hit) continue;
      if (hit.kind === "gpa") out.gpa ??= hit.value;
      else out.honors ??= hit.value;
    }
    if (out.gpa && out.honors) break;
  }
  return out;
}
