// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import type { ResumeEducation } from "../../score/types.ts";
import type { PdfSection } from "../sections.ts";
import {
  DEGREE_RE,
  INSTITUTION_HINTS,
  MONTH_YEAR_RE,
  NUMERIC_MONTH_YEAR_RE,
  US_STATE_CODE_RE,
  COUNTRY_GAZETTEER,
} from "../regex.ts";
import {
  isBulletLine,
  parseDateRange,
  normalizeDate,
  stripBullet,
} from "../line-primitives.ts";
import { isDateOnlyLine, isEntryHeaderShape } from "../entry-blocks.ts";
import { avgScore } from "./shared.ts";

// ── Education ───────────────────────────────────────────────────────────────

/** Infer the precision a date string carries from its shape. A month name or a
 *  numeric month (`MM/YYYY`, `MM-YYYY`) → "month"; a bare 4-digit year → "year".
 *  Used to fill the `*_precision` companions honestly from what the text shows.
 *  Non-global regexes (no shared `lastIndex` state) so the helper is reentrant. */
function inferDatePrecision(date: string): "month" | "year" {
  const monthName =
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b/i;
  if (monthName.test(date)) return "month";
  if (/\b(0?[1-9]|1[0-2])[\/\-]\d{4}\b/.test(date)) return "month";
  return "year";
}

/**
 * Education-specific date parsing on top of the shared `parseDateRange`.
 *
 * Education entries differ from experience in two ways:
 *   - A real range ("Sep 2024 - July 2025") must keep BOTH halves — the old
 *     `YEAR_RE.exec(joined)[0]` took only the first year and dropped the end.
 *   - A lone date is a GRADUATION date ("Expected Graduation: May 2027", or a
 *     bare "2019"), so it belongs in `end_date`, not `start_date` — emitting a
 *     spurious `start_date` would imply an attendance range that isn't stated.
 *
 * `parseDateRange` returns `{ start_date }` only for both a true range's start
 * AND the lone-date fallback, so we disambiguate on the presence of an end /
 * is_current: an end means it was a range; otherwise the single date is the
 * graduation date and is moved to `end_date`. `year` is kept for back-compat
 * (graduation year preferred).
 */
function parseEducationDates(text: string): {
  start_date?: string;
  start_date_precision?: "month" | "year";
  end_date?: string;
  end_date_precision?: "month" | "year";
  year?: string;
} {
  const { start_date, end_date, is_current } = parseDateRange(text);

  // Open-ended range ("Sep 2021 - Present"): keep the start, mark graduation
  // open. Rare for education but handled for parity with experience.
  if (is_current && start_date) {
    return {
      start_date,
      start_date_precision: inferDatePrecision(start_date),
      year: yearOf(start_date),
    };
  }

  // True range: both halves present.
  if (start_date && end_date) {
    return {
      start_date,
      start_date_precision: inferDatePrecision(start_date),
      end_date,
      end_date_precision: inferDatePrecision(end_date),
      year: yearOf(end_date) ?? yearOf(start_date),
    };
  }

  // Lone date (graduation / bare year): land it in end_date, no spurious start.
  // `parseDateRange`'s single-date fallback is year-only, so re-scan the text
  // for the richest single date ("May 2027" beats "2027") before falling back.
  const lone = richestSingleDate(text) ?? end_date ?? start_date;
  if (lone) {
    return {
      end_date: lone,
      end_date_precision: inferDatePrecision(lone),
      year: yearOf(lone),
    };
  }

  return {};
}

/** Richest single date in `text`: a month-year ("May 2027" / "05/2027") if
 *  present, else the first bare year. Used for the single-graduation-date case
 *  where the month would otherwise be lost. Resets each global regex's
 *  `lastIndex` so repeated calls are deterministic. */
function richestSingleDate(text: string): string | undefined {
  const my = MONTH_YEAR_RE.exec(text);
  MONTH_YEAR_RE.lastIndex = 0;
  if (my) return normalizeDate(my[0].replace(/\./g, ""));
  const nmy = NUMERIC_MONTH_YEAR_RE.exec(text);
  NUMERIC_MONTH_YEAR_RE.lastIndex = 0;
  if (nmy) return nmy[0];
  return yearOf(text);
}

/** First 4-digit year inside a date string, or undefined. */
function yearOf(date: string): string | undefined {
  const m = /\b(19|20)\d{2}\b/.exec(date);
  return m ? m[0] : undefined;
}

/** Build the conditional `ResumeEducation` date spread from a parsed result,
 *  omitting any absent field so the entry never carries `undefined` keys. */
function educationDateFields(
  dates: ReturnType<typeof parseEducationDates>,
): Partial<ResumeEducation> {
  return {
    ...(dates.start_date ? { start_date: dates.start_date } : {}),
    ...(dates.start_date_precision
      ? { start_date_precision: dates.start_date_precision }
      : {}),
    ...(dates.end_date ? { end_date: dates.end_date } : {}),
    ...(dates.end_date_precision
      ? { end_date_precision: dates.end_date_precision }
      : {}),
    ...(dates.year ? { year: dates.year } : {}),
  };
}

/** Honors / awards / activity keyword denylist for entry-level annotation lines
 *  ("Dean's List 2015–2017", "Cum Laude", "Study Abroad, Florence 2021"). Used
 *  by both {@link isInlineDatedProgram} — to reject an annotation-lead as a
 *  phantom second entry — and by {@link filterAnnotationLinesForDates} — to
 *  keep an annotation's dates from being picked up as attendance dates on the
 *  parent entry (#371). Shared so the two consumers can never drift on which
 *  phrases count as annotations. */
const EDUCATION_ANNOTATION_RE =
  /\b(dean'?s? list|awards?|honou?rs?|thesis|teaching assistant|research assistant|study abroad|coursework|scholarships?|fellowships?|cum laude|capstone|(?:senior|final|independent|group|team)\s+project)\b/i;

/** Strip lines that read as honors / awards / activity annotations from a
 *  chunk before {@link parseEducationDates} runs on the joined text (#371).
 *  Without this, a line like "GPA: 3.7 · Dean's List 2015–2017" contributes
 *  its range to the entry and `parseDateRange`'s range-first preference makes
 *  the annotation range (2015–2017) win over the real graduation year (2017)
 *  on a sibling line. Line-level filter — an annotation phrase inline with a
 *  real date on the SAME line is rare in practice; keeping the whole line
 *  when it doesn't lead with an annotation is safer than mid-line surgery.
 *
 *  DEGREE-carve-out: a line that ALSO matches {@link DEGREE_RE} carries the
 *  real attendance / graduation date and stays regardless of which annotation
 *  keywords it contains. Commonwealth shapes like "Honours Bachelor of Science,
 *  2015 - 2019" or "Thesis-based M.Sc. Data Science, 2018 - 2020" mention
 *  `honours` / `thesis` on the SAME line as the degree + real dates; filtering
 *  the whole line would drop both. */
function filterAnnotationLinesForDates(lines: readonly string[]): string[] {
  return lines.filter((l) => DEGREE_RE.test(l) || !EDUCATION_ANNOTATION_RE.test(l));
}

/** Source-side coursework label to peel off the bullet residue before the
 *  comma-split (#367). Covers the common LaTeX/résumé conventions:
 *  `Coursework:`, `Relevant Coursework:`, `Incoming Courses:`,
 *  `Selected Courses:`, `Courses:`. Case-insensitive, anchored to the line
 *  start so a course NAME that happens to contain "Courses" mid-string
 *  ("Advanced Courses in AI") is not accidentally stripped. */
const COURSEWORK_LABEL_RE =
  /^(?:relevant\s+coursework|incoming\s+courses?|selected\s+courses?|coursework|courses?)\s*:\s*/i;

/**
 * Whether a DEGREE_RE / INSTITUTION_HINTS hit on `line` reads as a body-prose
 * match rather than a genuine EDUCATION ENTRY HEADER — the guard that stops
 * the education chunker from anchoring a phantom entry on a sentence like
 * `Graduated B.E. with Distinction` pooled from a mis-routed compound-header
 * block (#462), or on a sub-labelled prose line that happens to contain a
 * substring hit like `inter-college hackathons` (which matches
 * `INSTITUTION_HINTS`'s `\bcollege\b`).
 *
 * Rejects (returns `false` — "not a real education entry header") when the
 * line either:
 *   1. begins with a sub-label prefix (`Achievements:`, `Certifications:`,
 *      `Leadership:`, `Awards:`, `Activities:`, `Projects:`) — the substring
 *      hit downstream of the colon is body content of that annotation, or
 *   2. begins with a body-prose past-tense verb (`Graduated`, `Received`,
 *      `Earned`, `Awarded`, `Completed`, `Achieved`) with an optional
 *      intervening word before the credential — the hit is describing an
 *      event, not opening a new entry.
 *
 * Otherwise returns `true`: a genuine header like `B.E. in Computer Science —
 * <College>` or `Bachelor of Music, Music Composition` (both begin with the
 * credential itself, not a prose lead) is admitted unchanged. Closed-vocabulary
 * + prefix-only, so no real entry header is rejected. Shared by BOTH the
 * `isDeg` and `isInst` chunker gates so a sub-labelled line whose body carries
 * an incidental degree token AND an incidental institution word — e.g.
 * `Leadership: Led CSR initiatives at inter-college hackathons` — anchors
 * nothing.
 */
function isRealEntryHeader(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // Sub-label prefix — the content past the colon is an annotation body.
  if (
    /^(?:Achievements?|Certifications?|Awards?|Honou?rs?|Leadership|Activities|Projects?|Involvement|Coursework|Relevant\s+Coursework)\s*:/i.test(
      t,
    )
  )
    return false;
  // Past-tense event-narration prefix — a "…Graduated B.E. with Distinction"
  // sentence. Allow up to one intervening word ("Graduated with B.E.") before
  // the credential.
  if (
    /^(?:Graduated|Received|Earned|Awarded|Completed|Achieved|Attained|Obtained)\b(?:\s+\w+)?\s+/i.test(
      t,
    )
  )
    return false;
  return true;
}

/** Whether `line` reads as a *wrapped continuation* of the preceding coursework
 *  bullet (e.g. the `Business` half of `● Global Dimensions of` + `Business`)
 *  rather than a standalone field that merely follows the bullet. The recovery
 *  loop is opt-in on this guard so it never swallows the next entry's school or
 *  a trailing prose note into the prior course (#184). Rejects:
 *   - degree / institution-hint / date-only lines (already field-bearing),
 *   - `GPA: …` / `Minor …` / `Major …` prose labels,
 *   - acronym schools — any all-caps token of 2+ chars (`MIT`, `UC Berkeley`).
 *  A single Title-case word like `Business` carries no such token and passes,
 *  so genuine multi-column wraps still merge. */
function isCourseworkContinuation(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (DEGREE_RE.test(t) || INSTITUTION_HINTS.test(t) || isDateOnlyLine(t))
    return false;
  if (/^(GPA[:\s]|Minor\b|Major\b)/i.test(t)) return false;
  if (/\b[A-Z]{2,}\b/.test(t)) return false;
  return true;
}

/** Redacted-year stub core ("20XX"/"19XX") Word/Office templates ship in place
 *  of a real 4-digit year. Shared so `isInlineDatedProgram`'s year-presence gate
 *  and `stripInstitutionDate`'s trailing-date strip admit the SAME form — one
 *  source, no drifting second copy (#297). */
const REDACTED_YEAR = String.raw`(?:19|20)XX`;
/** A year token that may be real OR redacted — "2024" or "20XX" — as ONE regex
 *  source fragment. `(?:19|20)(?:\d{2}|XX)` distributes to `(?:19|20)\d{2}` |
 *  `(?:19|20)XX`, so every site that admits "either a real year or the redacted
 *  stub" reuses this single source instead of hand-rolling a drifting copy
 *  (#297): the year-presence gate below, `isInlineDatedProgram`'s date-lead
 *  reject ({@link DATE_LEAD_RE}), and `cleanField`'s trailing-date strip
 *  ({@link CLEAN_FIELD_DATE_RE}). */
const YEAR_OR_REDACTED_SRC = String.raw`(?:19|20)(?:\d{2}|XX)`;
/** Year-presence test that accepts either a real 4-digit year OR the redacted
 *  `20XX` stub. */
const YEAR_OR_REDACTED_RE = new RegExp(
  String.raw`\b` + YEAR_OR_REDACTED_SRC + String.raw`\b`,
  "i",
);
/** Date-LEAD reject for {@link isInlineDatedProgram}: a line beginning with a
 *  bare (real or redacted) year, a "Month YYYY" / "Month 20XX", or a numeric
 *  "MM/YYYY" is the attendance/graduation DATE of the entry above, not a program
 *  name. Reuses {@link YEAR_OR_REDACTED_SRC} in both year slots so a redacted
 *  lead ("20XX …", "Sep 20XX – May 20XX") is rejected on the same footing as a
 *  real-year lead. */
const DATE_LEAD_RE = new RegExp(
  String.raw`^(?:` +
    YEAR_OR_REDACTED_SRC +
    String.raw`|(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+` +
    YEAR_OR_REDACTED_SRC +
    String.raw`|\d{1,2}\/\d{4})`,
  "i",
);
/** Trailing graduation/attendance date strip for {@link cleanField}: an optional
 *  separator + optional grad-context words + optional month + a (real or
 *  redacted) year and everything after. Reuses {@link YEAR_OR_REDACTED_SRC} so
 *  the redacted `20XX` stub ("Sep 20XX – May 20XX") strips like a real year. */
const CLEAN_FIELD_DATE_RE = new RegExp(
  String.raw`\s*[-–—,;]?\s*(?:(?:expected|anticipated|graduat\w*|class of|present|current)\b\s*)*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s*)?\(?` +
    YEAR_OR_REDACTED_SRC +
    String.raw`\b.*$`,
  "i",
);

/** Whether `line` is a hint-less, degree-less PROGRAM NAME that carries its own
 *  graduation year inline — the second-school shape from #219, e.g.
 *  "MIT Applied Data Science (2023)" or "Google Data Analytics Certificate 2022".
 *  Used to split a NEW education entry off a chunk that already holds a full
 *  degree + institution, when the program carries no `DEGREE_RE`/`INSTITUTION_HINTS`
 *  token and so the keyword-based flush can't see the boundary. The inline year
 *  is exactly what the old whole-chunk date scan would bleed onto the preceding
 *  school; splitting here keeps it with its own program. Requires ALL of:
 *   - a Title-case / digit lead (a program label, not lowercase prose), and
 *   - NOT a `GPA:` / `Minor` / `Major` note, and
 *   - a 4-digit year token present, and
 *   - real program TEXT besides the date — once the year(s) and connective date
 *     words are stripped, a non-trivial remainder must survive. This rejects a
 *     bare date range on its own line ("Fall 2013 – Spring 2014", an honors-block
 *     date) while keeping "MIT Applied Data Science (2023)" (the "MIT Applied
 *     Data Science" remainder survives). `isDateOnlyLine` at the call site is the
 *     first such guard; this is the stricter companion that also rejects a
 *     season-qualified range whose only words ARE date words. */
function isInlineDatedProgram(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^(GPA[:\s]|Minor\b|Major\b)/i.test(t)) return false;
  if (!/^[A-Z0-9]/.test(t)) return false;
  if (!YEAR_OR_REDACTED_RE.test(t)) return false;
  // A graduation-date line ("Grad. May 2011 | Kolkata, India", "Expected
  // Graduation: 2026", "Class of 2025") is the DATE of an existing school, not a
  // new program — it leads with a graduation/date-context word. Reject so a
  // school's own grad-date line never splits off as a phantom entry.
  if (/^(grad(?:\.|uat\w*)?|expected|anticipated|class of|completed)\b/i.test(t))
    return false;
  // A line that LEADS with a date — a bare year, a "2001 - 2005" range, or a
  // "May 2011" month-year — is the attendance/graduation DATE of the entry above
  // it, not a program name. A genuine inline-dated program leads with its program
  // text and carries the year inline/trailing ("MIT Applied Data Science (2023)").
  // The trailing-location strip below only peels a ",/| City, Region" tail, so it
  // can't rescue a "2001 - 2005  City, Country" attendance line — worse when a
  // stray location glyph glues the city to the date ("2001 - 2005 eSpringfield,
  // Freedonia"), where the surviving city token would pass the remainder test and
  // split off a phantom degree-less entry. Guard on the date-lead shape directly.
  // Redacted year slots (via {@link DATE_LEAD_RE}) so a redacted-date lead
  // ("20XX …", "Sep 20XX – May 20XX") is rejected on the same footing as a
  // real-year lead.
  if (DATE_LEAD_RE.test(t)) return false;
  // An honors / awards / activity annotation that happens to carry a year
  // ("Dean's List 2021", "Honors Thesis: … (2024)", "Teaching Assistant for …
  // (2022 - 2023)", "Study Abroad, Florence 2021", "Capstone Project: Sentiment
  // Analysis (2023)") is a sub-field of the current school, NOT a new program —
  // it must not split off a phantom degree-less entry (#219, #251). These read as
  // annotations, not program names, so an exact keyword denylist is safe: a real
  // second program ("MIT Applied Data Science (2023)", "Google Data Analytics
  // Certificate 2022") carries none of them. NOTE: "project" is denied only in its
  // annotation shape — a qualifier-led "Senior/Final/… Project" or a "Project: …"
  // sub-line — NOT bare anywhere, so a genuine credential title that merely contains
  // the word ("Project Management Certificate 2022", PMP) still splits into its own
  // program entry (#251 adversarial review).
  if (EDUCATION_ANNOTATION_RE.test(t) || /\bproject\s*:/i.test(t))
    return false;
  // Drop a trailing "| City, Region" location segment before measuring the
  // program remainder — a date+location line ("… 2011 | Kolkata, India") must
  // not pass on the strength of its city words.
  const noLocation = t.replace(/[|,]\s*[A-Z][A-Za-z.\-]+(?:\s*,\s*[A-Za-z.\-]+)*$/, "");
  // Strip years and date connective words (seasons / months / range words); a
  // real program name leaves substantive text, a bare date line leaves nothing.
  const remainder = noLocation
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(new RegExp(String.raw`\b` + REDACTED_YEAR + String.raw`\b`, "gi"), "")
    .replace(
      /\b(?:spring|summer|fall|autumn|winter|present|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/gi,
      "",
    )
    .replace(/[\s,–\-—|/().:]+/g, "")
    .trim();
  return remainder.length >= 3;
}

/** Whether `text` reads as an INSTITUTION line for a degree-less program entry —
 *  an explicit institution-hint line ("MIT Sloan School of Management") OR a
 *  hint-less proper-noun line that is the school's own name ("MIT Professional
 *  Education"). It must be entry-header-shaped (proper-noun lead, not prose, not a
 *  bare date, not a GPA/Minor note) and must NOT itself be a degree line — a
 *  following degree opens a NEW entry, it is not the program's institution. Used
 *  only to confirm a program-title lead is followed by its own school, so the
 *  pair forms one entry that splits cleanly off the next (#238). */
function isInstitutionLine(text: string): boolean {
  if (DEGREE_RE.test(text)) return false;
  if (INSTITUTION_HINTS.test(text)) return true;
  return isEntryHeaderShape(text);
}

/** Whether the lines at [`i`, `i+1`] form a DEGREE-LESS PROGRAM ENTRY — a
 *  program/certificate title carrying its own inline graduation year
 *  ("Applied Data Science Program: … 2023"), immediately followed by its own
 *  institution line ("MIT Professional Education"). This is the #238 shape: an
 *  education entry recognized by entry-boundary SHAPE (a header-like program line
 *  + an institution line) rather than a degree keyword. The lead reuses the
 *  well-tested {@link isInlineDatedProgram} (a real program name with an inline
 *  year, not an honors/GPA/grad-date annotation); the partner reuses
 *  {@link isInstitutionLine}. Recognizing this pair lets the chunker bind the
 *  program's year to the program's own entry and stops it bleeding onto a
 *  neighbouring degree that has no date of its own (C2). */
function isProgramLeadAt(
  lines: { text: string }[],
  i: number,
): boolean {
  const lead = lines[i]?.text;
  const partner = lines[i + 1]?.text;
  if (lead === undefined || partner === undefined) return false;
  if (DEGREE_RE.test(lead) || INSTITUTION_HINTS.test(lead)) return false;
  if (!isInlineDatedProgram(lead)) return false;
  return isInstitutionLine(partner);
}

/** Trim a parsed field string down to the subject, cutting any trailing date,
 *  column break, pipe, or GPA/Minor/Major note that rode along on the degree
 *  line ("Computer Science   Sep. 2024 - Jun. 2027" → "Computer Science").
 *  Returns undefined when nothing substantive survives. */
function cleanField(raw: string): string | undefined {
  let f = raw
    // A column break (2+ spaces from the PDF grid) or an explicit pipe ends the
    // field — the date / location column starts after it.
    .split(/\s{2,}|\s*\|\s*/)[0]
    .trim();
  // Cut a trailing graduation / attendance date ("— May 2027", ", 2022 - 2024",
  // "Expected 2026", "Class of 2025") — the date belongs to the entry, not the
  // field. Also cut the redacted-year stub ("Sep 20XX – May 20XX") Word/Office
  // templates ship, so a reconstructed institution sub-line that carries it
  // (#297) normalizes to the same field as its degree header.
  f = f.replace(CLEAN_FIELD_DATE_RE, "");
  // Cut a trailing "… , Minor in Economics" / "… , GPA: 3.8" note — a sub-field,
  // not part of the subject.
  f = f.replace(/[,;]\s*(?:minor|major|gpa|concentration)\b.*$/i, "");
  // Strip leftover edge punctuation.
  f = f.replace(/^[\s,;:–\-—]+|[\s,;:–\-—]+$/g, "").trim();
  return f.length > 0 ? f : undefined;
}

/** Parse a degree-bearing line into a bare credential + its subject field.
 *
 * `DEGREE_RE` either matches just the credential ("B.S.") or — via its optional
 * `of <subject>` branch — greedily swallows an "… in <field>" tail
 * ("Bachelor of Science in Biology"). Either way the field is recovered from the
 * ORIGINAL line (not the truncated match) so an ampersand/comma in the subject
 * ("Computer Science & Engineering") is never lost. The credential is split off
 * at the " in " connective when the match swallowed it; otherwise the field is
 * whatever text follows the credential, with dates/notes stripped by
 * `cleanField`. Connective-less shapes ("M.S. Computer Science", "B.S. Business
 * Administration — May 2027") are handled too: the field is the post-credential
 * remainder. */
function parseDegreeAndField(line: string): {
  degree: string;
  field?: string;
} {
  const dm = DEGREE_RE.exec(line);
  if (!dm) return { degree: "" };
  const matched = dm[0];
  // If the `of`-branch swallowed an " in <field>", the credential ends at that
  // " in " — split it there and let the field be read from the original line so
  // characters DEGREE_RE can't match (e.g. "&") aren't truncated.
  const inIdx = matched.search(/\s+in\s+/i);
  let degree: string;
  let fieldStart: number;
  if (inIdx >= 0) {
    degree = matched.slice(0, inIdx).trim();
    fieldStart = dm.index + inIdx;
  } else {
    degree = matched.trim();
    fieldStart = dm.index + matched.length;
  }
  const fieldRaw = line
    .slice(fieldStart)
    // Drop a leading "in "/"of " connective or a "-"/"—"/":"/"," separator.
    .replace(/^\s*(?:in|of)\s+/i, "")
    .replace(/^\s*[-–—,:]\s*/, "")
    .replace(/^\s*(?:in|of)\s+/i, "");
  return { degree, field: cleanField(fieldRaw) };
}

/** Normalized degree+field key for a degree-bearing line — used to detect when a
 *  reconstructed entry's INSTITUTION sub-line is a near-duplicate of its own
 *  degree header rather than a genuine second degree (#297). The Download-PDF
 *  emitter places the parsed institution string on the sub-line; when that string
 *  itself carries the degree text (a parse-1 pollution these fixtures exhibit),
 *  the sub-line matches `DEGREE_RE`, so the segmenter's "second degree ⇒ new
 *  entry" rule would promote it to a phantom entry. Two lines that parse to the
 *  SAME degree and field are one entry's header + institution sub-line, not two
 *  degrees — so the sub-line stays attached. Returns null for a non-degree line.
 *  `cleanField` drops any trailing (incl. redacted `20XX`) date so the header and
 *  its date-bearing sub-line normalize to the same field. */
function degreeFieldKey(line: string): string | null {
  if (!DEGREE_RE.test(line)) return null;
  const { degree, field } = parseDegreeAndField(line);
  return `${degree} ${field ?? ""}`.toLowerCase();
}

/** Peel a trailing "City, ST" (US) or "City, Country" (international) location
 *  off an institution string, returning the cleaned institution and the
 *  location. Mirrors experience's `stripLocationSuffix` (same closed-vocabulary
 *  guards: `US_STATE_CODE_RE` for US, `COUNTRY_GAZETTEER` for intl), specialized
 *  for the institution line where the city is usually separated by a column gap
 *  ("… Engineering   Seattle, WA") rather than a comma. Stripping must leave a
 *  non-empty institution, so the whole string is never consumed. */
/** Collapse a city phrase that surfaces the same place name twice back-to-back
 *  ("Berkeley Berkeley"). This happens when a bare location line is assembled
 *  onto an institution that already ends in that place — "University of
 *  California, Berkeley" + "Berkeley, CA" glue into one line, and the greedy
 *  multi-word city capture grabs "Berkeley Berkeley" (#297). The first copy is
 *  the institution's own campus/place and is pushed back onto `before`; the
 *  second is the location's city. A non-doubled city ("San Francisco") is
 *  returned unchanged. */
export function splitDoubledCity(
  before: string,
  city: string,
): { institution: string; city: string } {
  const m = /^(\S+(?:\s+\S+)*?)\s+\1$/i.exec(city.trim());
  if (m) {
    const single = m[1];
    // Only collapse when the doubling is the concatenation artifact this was
    // written for: `before` (the institution) already ENDS in this exact place
    // phrase, so the first copy is the institution's own campus/place and the
    // second is the location's city ("University of California, Berkeley" +
    // "Berkeley, CA"; "University of California, Los Angeles" + "Los Angeles Los
    // Angeles"; SUNY campuses; etc.). The repeated `single` group may be
    // MULTI-WORD ("Los Angeles"), so compare `before`'s trailing N-word suffix
    // (N = the phrase's word count) against it — not just its last token, which
    // would see only "Angeles" and miss the artifact. When `before` does NOT end
    // in the phrase the repetition is a genuine doubled place-name city
    // ("Whitman College" + "Walla Walla, WA"), which must stay intact —
    // collapsing it would corrupt the city to "Walla".
    const norm = (s: string) => s.toLowerCase().replace(/[.,]+/g, "");
    const singleWords = single.trim().split(/\s+/);
    const beforeTail = before
      .trim()
      .split(/\s+/)
      .slice(-singleWords.length)
      .join(" ");
    if (norm(beforeTail) === norm(single)) {
      return { institution: before, city: single };
    }
  }
  return { institution: before, city };
}

function stripInstitutionLocation(s: string): {
  institution: string;
  location?: string;
} {
  // US "…, City, ST" (comma boundary → multi-word city) or "… City, ST"
  // (column-gap/space boundary → single-token city).
  const COMMA_US_RE =
    /,\s*([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+)*),\s*([A-Z]{2})$/;
  // Require a 2+ space column gap (not a single word-space) so a normal space
  // inside the institution name isn't read as a city boundary — otherwise
  // "Stanford University, CA" (state-only, no city) wrongly yields
  // institution "Stanford" + location "University, CA".
  const SPACE_US_RE = /\s{2,}([A-Z][A-Za-z.\-]+),\s*([A-Z]{2})$/;
  // " · City, ST" middot boundary — the shape the reconstructed education
  // sub-line emits ("Institution · City, ST", #291/#294). `stripInstitutionDate`
  // has already peeled any trailing dates by the time this runs.
  const MIDDOT_US_RE =
    /\s*·\s*([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+)*),\s*([A-Z]{2})$/;
  // #366 — 1-space fallback for LaTeX two-column line assembly, which joins
  // institution and city with only ONE space ("Lakeside Institute of Technology
  // Seattle, WA"). Fires only when the surviving institution prefix has ≥2
  // tokens AND its last token is not a preposition/article — a `\s+of\s+City,
  // ST` construction ("University of Miami, FL", "University of Michigan, MI")
  // is a state-suffixed institution NAME, not an institution + city + state,
  // so a prefix ending in `of`/`the`/… is the tell that the split misfired.
  // Single-word remainders ("Cornell Ithaca, NY", "MIT Cambridge, MA") are
  // ambiguous with a state-suffixed institution and stay glued too. Tried
  // AFTER the 2+ space primary so "… University  City, ST" still matches the
  // strict shape.
  const SPACE1_US_RE = /\s([A-Z][A-Za-z.\-]+),\s*([A-Z]{2})$/;
  // Lowercase words that must not sit at the tail of an institution prefix.
  // Case-insensitive because a title-cased "Of"/"The" is the same tell.
  const INST_PREFIX_STOP_TAIL = /^(?:of|the|a|an|and|for|in|on|at|to)$/i;
  let mUS =
    s.match(COMMA_US_RE) ?? s.match(SPACE_US_RE) ?? s.match(MIDDOT_US_RE);
  if (!mUS) {
    const m1 = s.match(SPACE1_US_RE);
    if (m1) {
      const beforeTokens = s
        .slice(0, m1.index)
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0);
      const lastToken = beforeTokens[beforeTokens.length - 1] ?? "";
      const guarded =
        beforeTokens.length >= 2 && !INST_PREFIX_STOP_TAIL.test(lastToken);
      if (guarded) mUS = m1;
    }
  }
  if (mUS && US_STATE_CODE_RE.test(mUS[2])) {
    const before = s
      .slice(0, mUS.index)
      .replace(/,\s*$/, "")
      .trim();
    if (before) {
      const dd = splitDoubledCity(before, mUS[1]);
      return { institution: dd.institution, location: `${dd.city}, ${mUS[2]}` };
    }
  }

  // International "…, City, Country" — country validated against the gazetteer.
  if (COUNTRY_GAZETTEER.size > 0) {
    const INTL_RE =
      /,\s*([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+)*),\s*([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+)*)$/;
    // " · City, Country" middot boundary — the international counterpart of the
    // reconstructed education sub-line (#294).
    const MIDDOT_INTL_RE =
      /\s*·\s*([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+)*),\s*([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+)*)$/;
    const mIntl = s.match(INTL_RE) ?? s.match(MIDDOT_INTL_RE);
    if (mIntl && COUNTRY_GAZETTEER.has(mIntl[2].toLowerCase())) {
      const before = s
        .slice(0, mIntl.index)
        .replace(/,\s*$/, "")
        .trim();
      if (before) {
        const dd = splitDoubledCity(before, mIntl[1]);
        return {
          institution: dd.institution,
          location: `${dd.city}, ${mIntl[2]}`,
        };
      }
    }
  }

  return { institution: s };
}

/** Peel a trailing date range / single date off an institution string. When the
 *  institution and its dates land on ONE line — as the Download-PDF reconstructed
 *  résumé emits them ("… University, S.Korea  Mar. 2010 – Aug. 2017") — the date
 *  is still captured separately via `parseEducationDates(joined)`, but without
 *  this strip it stayed glued onto `institution` and even blocked the trailing
 *  location strip (#291). Matches a month-year or bare year, optionally as a
 *  range (or "… – Present"); requires leading whitespace and never consumes the
 *  whole string. */
function stripInstitutionDate(s: string): string {
  // A single date token: a month-year ("Mar. 2010"), a numeric "MM/YYYY", or a
  // bare year optionally season-qualified ("Fall 2013"). The season prefix and
  // the numeric form matter: without them a `$`-anchored strip lands on only the
  // trailing YEAR of a "Fall 2013 – Spring 2014" range and leaves a corrupted
  // "… Fall 2013 – Spring" glued onto the institution (#294 review) — worse than
  // leaving the whole range intact.
  const SEASON = `(?:spring|summer|fall|autumn|winter)`;
  // Redacted-year stub ("Sep 20XX", "Fall 20XX", bare "20XX") Word/Office
  // templates ship — `MONTH_YEAR_RE` requires a real 4-digit year, so without
  // this a reconstructed "Institution  Sep 20XX – May 20XX" sub-line keeps the
  // date glued to the institution and never round-trips (#297).
  const REDACTED = `(?:(?:${SEASON}|(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?)\\s+)?${REDACTED_YEAR}`;
  const DATE = `(?:${MONTH_YEAR_RE.source}|${NUMERIC_MONTH_YEAR_RE.source}|${REDACTED}|(?:${SEASON}\\s+)?\\b\\d{4}\\b)`;
  // Open-ended range tail: "Present"/"Current"/"Ongoing"/"Now" as well as a
  // second date — so "… 2015 – Current" peels whole, not nothing.
  const OPEN = `(?:present|current|ongoing|now)`;
  const SEP = `\\s*[–—-]\\s*`;
  // Optional column separator immediately before the trailing date, so a
  // one-line "Institution | 2018 – 2022" (#375) peels cleanly instead of
  // leaving a bare " |" glued to the institution. The separator must be
  // followed by whitespace, so a natural comma inside the institution name
  // ("University of Washington, Seattle 2010 – 2015") that already has no
  // preceding whitespace still cannot match this optional group.
  const COL_SEP = `(?:[|·,]\\s+)?`;
  const TRAILING_DATE_RE = new RegExp(
    `\\s+${COL_SEP}${DATE}(?:${SEP}(?:${DATE}|${OPEN}))?\\s*$`,
    "i",
  );
  const stripped = s.replace(TRAILING_DATE_RE, "").trim();
  return stripped || s;
}

/** Map one education chunk (the degree + institution + date lines of a single
 *  qualification) to a `ResumeEducation` and its confidence. */
function educationFromChunk(chunk: string[]): {
  entry: ResumeEducation;
  score: number;
} {
  const joined = chunk.join(" | ");
  // Parse degree + field off the specific degree-bearing line (cleaner than the
  // joined chunk, whose " | " separators would confuse the field tail).
  // #462/#467 — apply the same `isRealEntryHeader` guard that gates chunking:
  // a chunk that happens to contain a sub-labelled body-prose line ("Achievements:
  // Graduated B.E. with Distinction") pooled from a mis-routed compound header
  // must NOT let that line's incidental DEGREE_RE/INSTITUTION_HINTS substring
  // become the entry's degree or institution field.
  const degreeLine = chunk.find(
    (l) => DEGREE_RE.test(l) && isRealEntryHeader(l),
  );
  const degreeMatch = DEGREE_RE.exec(joined);
  let { degree, field } = degreeLine
    ? parseDegreeAndField(degreeLine)
    : { degree: "", field: undefined as string | undefined };

  // Degree-less PROGRAM ENTRY (#238): a program/certificate title carrying its
  // own inline year, followed by its institution line — recognized by SHAPE, not
  // a degree keyword. The program title is the subject (`field`); the institution
  // is the following line; there is no credential, so `degree` stays empty. Done
  // before the generic institution scan so the program title is NOT mistaken for
  // the institution (the first non-degree, non-date line). Scoped to a chunk with
  // no degree line so a normal degree entry is untouched.
  let institution = "";
  if (!degreeLine && chunk.length >= 2 && isProgramLeadAt(
    chunk.map((text) => ({ text })),
    0,
  )) {
    field = cleanField(chunk[0]) ?? field;
    institution = chunk[1].trim();
  } else {
    // Institution: an explicit institution-hint line first; else the first line
    // that is neither the degree-bearing line nor a bare date — this recovers
    // acronym schools ("MIT", "UC Berkeley") that carry no "University"/"College"
    // word; else strip the degree off its own line (degree + school on one line).
    // Prefer a hint line that is NOT the degree header: when the reconstructed
    // header carries the degree AND an institution hint (parse-1 pollution,
    // #297), the true institution is on the following sub-line — read it from
    // there, not the degree header. Falls back to the header's own hint for a
    // single-line "Degree, University" entry.
    const instLine =
      chunk.find(
        (l) =>
          INSTITUTION_HINTS.test(l) &&
          l !== degreeLine &&
          isRealEntryHeader(l),
      ) ??
      chunk.find(
        (l) => INSTITUTION_HINTS.test(l) && isRealEntryHeader(l),
      );
    if (instLine) {
      // #364 — when the ONLY institution-hint match is the same one-line
      // "Degree — Institution" as the degree line, the raw line used to be
      // stored verbatim ("B.S. in Computer Science — State University") AND
      // parseDegreeAndField swallowed the institution into `field` ("Computer
      // Science — State University"), producing a doubled render in the
      // reconstructed view. Split at the em/en-dash separator so the trailing
      // half is the institution and re-parse degree/field off the head.
      if (instLine === degreeLine && degreeMatch) {
        // Peel any trailing date range off the one-line entry FIRST, so an
        // en/em-dash INSIDE the date range ("… University Aug 2021 – May 2025",
        // #506) is never mistaken for the degree↔institution separator. Without
        // this the split below cut the entry on the date's en-dash, burying the
        // credential in `institution` and re-parsing degree/field from the bare
        // end-date ("May 2025") — degree came back empty. `stripInstitutionDate`
        // runs again downstream (line ~768); it is idempotent.
        const instNoDate = stripInstitutionDate(instLine);
        // En/em-dash only — a spaced ASCII `-` commonly separates degree from
        // field ("B.S. - Computer Science, Stanford University"), not
        // institution from the rest, so splitting on it here would strand the
        // field on the wrong side of the boundary.
        const parts = instNoDate.split(/\s+[–—]\s+/);
        if (parts.length >= 2) {
          // Pick the part carrying an institution hint ("University", "College",
          // …) as the institution. If none carries a hint, fall back to the
          // last part (the #364 primary shape "Degree in Field — Institution"
          // where the hint might be missing on an acronym school). Re-parse
          // degree/field from the remaining parts joined back with em-dash.
          const hintIdx = parts.findIndex((p) => INSTITUTION_HINTS.test(p));
          const instIdx = hintIdx >= 0 ? hintIdx : parts.length - 1;
          institution = parts[instIdx].trim();
          const head = parts.filter((_, i) => i !== instIdx).join(" — ");
          ({ degree, field } = parseDegreeAndField(head));
        } else {
          // No em/en-dash separator. Try a COMMA separator
          // "<Degree Field>, <Institution>" (#506) — the shape "M.S. Data
          // Science, Example State University". Split on commas and take the run
          // from the FIRST hint-bearing part onward as the institution, so a
          // comma INSIDE the institution name ("University of California,
          // Berkeley") is preserved, re-parsing degree/field off the head.
          // Gated on a hint part existing AT INDEX ≥ 1, so there is a non-empty
          // "<Degree Field>" head before it to re-parse. `cHintIdx === 0` means
          // the line LEADS with the institution ("State University Boston, MA",
          // no degree prefix) — there is nothing to split off, so it falls to the
          // raw-line fallback unchanged rather than nuke degree/field to empty.
          // An acronym-school single-line entry ("B.S. Computer Science, MIT")
          // carries no hint and likewise falls through untouched.
          const commaParts = instNoDate.split(/\s*,\s*/);
          const cHintIdx = commaParts.findIndex((p) => INSTITUTION_HINTS.test(p));
          if (cHintIdx >= 1) {
            institution = commaParts.slice(cHintIdx).join(", ").trim();
            const head = commaParts.slice(0, cHintIdx).join(", ");
            ({ degree, field } = parseDegreeAndField(head));
          } else {
            // Keep the (date-stripped) raw line as the institution (behavior
            // preserved from before #364; the strip-then-maybe-mangle path only
            // pays off when the split cleanly isolates the institution).
            institution = instNoDate.trim();
          }
        }
      } else {
        institution = instLine.trim();
      }
    } else {
      const cand = chunk.find((l) => !DEGREE_RE.test(l) && !isDateOnlyLine(l));
      if (cand) {
        institution = cand.trim();
      } else if (degreeMatch) {
        institution = joined
          .replace(degreeMatch[0], "")
          .replace(/\s*\|\s*/g, " ")
          .replace(/[,|]+$/, "")
          .trim();
      }
    }
  }

  // Peel a trailing date range off the institution first (a one-line
  // "Institution  Dates" shape, e.g. the reconstructed-résumé emitter, #291),
  // otherwise the date blocks the $-anchored location strip below.
  institution = stripInstitutionDate(institution);

  // Peel a trailing "City, ST" / "City, Country" off the institution so it isn't
  // glued on ("University of Example, …   Seattle, WA" → institution without the
  // location, location surfaced separately).
  const { institution: instClean, location } =
    stripInstitutionLocation(institution);
  institution = instClean;

  // Strip a trailing run of pipe-delimited date / empty segments glued onto the
  // institution by a one-line "Institution (…) | <dates> |" header — the dates
  // are parsed into their own fields below, so a "| 2019-2021" or bare "|" tail
  // is residue, not part of the school name. Each group is a `|` followed by an
  // OPTIONAL year-range, so a genuine "| City" tail (a location, owned by
  // `stripInstitutionLocation`) does NOT match and is left intact. A real
  // institution never ends in a bare separator, so the final dangling-separator
  // trim only ever removes the artifact.
  institution = institution
    .replace(
      /(\s*\|\s*(?:(?:19|20)\d{2}(?:\s*[-–—]\s*(?:(?:19|20)\d{2}|present))?)?)+\s*$/i,
      "",
    )
    .replace(/[\s|,·–—-]+$/, "")
    .trim();

  // Shared date primitive (via the education wrapper) so a range like
  // "Sep 2024 - July 2025" keeps both halves and a lone graduation date lands in
  // `end_date` (#97). Filter honors/awards annotation lines first (#371) so a
  // range on a "Dean's List 2015–2017" sub-line does not steal the primary date
  // slot from the real graduation year on a sibling line.
  const datesInput = filterAnnotationLinesForDates(chunk).join(" | ");
  const dates = parseEducationDates(datesInput);
  const hasDate = !!(dates.start_date || dates.end_date);

  let score = 0;
  if (institution) score += 0.3;
  if (degree) score += 0.4;
  if (hasDate) score += 0.3;

  return {
    entry: {
      institution,
      degree,
      ...(field ? { field } : {}),
      ...(location ? { location } : {}),
      ...educationDateFields(dates),
    },
    score: Math.min(score, 1),
  };
}

export function extractEducation(
  education: PdfSection | undefined,
): { value: ResumeEducation[]; confidence: number } {
  if (!education || education.lines.length === 0)
    return { value: [], confidence: 0 };

  // Bullet lines inside an education section are relevant-coursework items
  // (a "Relevant Coursework" block, #164) — not degree/institution lines, so
  // they were dropped before. Recover them as coursework and attribute each to
  // the entry it sits under by line position (#190); a section with one entry
  // reduces to the original "attach to the primary entry" behavior.
  //
  // Two wrinkles from real grids (the de-interleaved 3-column reproducer):
  //   - A cell can wrap: "● Global Dimensions of" + a following non-bullet
  //     "Business" line. The continuation is joined back into the item and
  //     excluded from entry detection (`consumed`) so it is not mistaken for
  //     an institution.
  //   - A degree sub-note ("-including courses taught in Japanese") is also a
  //     bullet but reads as lowercase prose, not a course title. The Title-case
  //     guard drops it; course titles lead uppercase.
  // Each recovered course keeps the source-line `idx` so it can be attributed
  // to the nearest preceding degree below.
  const ls = education.lines;
  const coursework: { text: string; idx: number }[] = [];
  const consumed = new Set<number>();
  for (let i = 0; i < ls.length; i++) {
    // Coursework is usually a bullet list, but some résumés write it as a plain
    // (glyph-less) label line — "Coursework: Databases, Machine Learning" (#506).
    // Admit such a line too, or it never reaches the label-strip + comma-split
    // below and is silently dropped. `stripBullet` is a no-op on a glyph-less
    // line, so the bullet path is unaffected.
    if (!isBulletLine(ls[i]) && !COURSEWORK_LABEL_RE.test(ls[i].text)) continue;
    let item = stripBullet(ls[i].text);
    const span = [i];
    let j = i + 1;
    // Absorb at most ONE wrapped continuation line, and only when it actually
    // reads as a continuation (#184). A wrapped grid cell almost never spills
    // past one line; the single-line cap plus the opt-in `isCourseworkContinuation`
    // guard stop the loop from swallowing an acronym school or trailing prose
    // (`GPA: 3.8`) from the next entry into the prior course.
    if (
      j < ls.length &&
      !isBulletLine(ls[j]) &&
      isCourseworkContinuation(ls[j].text)
    ) {
      item += ` ${ls[j].text.trim()}`;
      span.push(j);
      j++;
    }
    item = item.trim();
    // Peel a leading source-side label ("Coursework:", "Relevant Coursework:",
    // "Incoming Courses:", "Selected Courses:", "Courses:") so the residue is
    // the course list itself and the reconstructed résumé doesn't render a
    // redundant "Coursework: Relevant Coursework: …" double-label (#367).
    item = item.replace(COURSEWORK_LABEL_RE, "").trim();
    // Split a comma-separated course list into individual entries so each
    // course is addressable in the reconstructed view (#367). A single-course
    // bullet with no comma remains one entry. The Title-case guard runs on
    // the FIRST item only (matching pre-split whole-bullet semantics): a
    // lowercase prose bullet ("- including courses taught in Japanese") is
    // dropped as before, but a mid-list lowercase course
    // ("Coursework: Data Structures, algorithms, Operating Systems") is kept
    // alongside its Title-case siblings rather than silently dropped.
    const items = item.includes(",")
      ? item.split(/\s*,\s*/).filter((t) => t.length > 0)
      : [item];
    if (items.length > 0 && /^[A-Z0-9]/.test(items[0])) {
      for (const c of items) coursework.push({ text: c, idx: i });
      for (const k of span) consumed.add(k);
    }
    i = j - 1;
  }

  // Keep the source-line `idx` on each entry line so a built chunk's start
  // position is known — that anchor is what coursework is attributed against.
  const rawEntryLines = ls
    .map((l, idx) => ({ text: l.text, bullet: isBulletLine(l), idx }))
    .filter((l) => !l.bullet && !consumed.has(l.idx) && l.text.trim().length > 0)
    .map((l) => ({ text: l.text, idx: l.idx }));
  // Re-join a degree subject that wrapped across two visual lines. A degree line
  // ending in a dangling connective ("… Computer Science &", "… Electrical and")
  // continues on the next line — PDFs wrap a long field this way. Merge the single
  // following continuation back so the field is not truncated at the wrap point
  // and the orphan tail ("Engineering") is not mistaken for an institution. Only a
  // degree line with a dangling connective absorbs, and only a continuation that is
  // not itself a new entry lead (degree / institution-hint / bare date).
  const lines: { text: string; idx: number }[] = [];
  for (let i = 0; i < rawEntryLines.length; i++) {
    const cur = rawEntryLines[i];
    const next = rawEntryLines[i + 1];
    if (
      next &&
      DEGREE_RE.test(cur.text) &&
      /(?:&|\band)\s*$/i.test(cur.text.trim()) &&
      !DEGREE_RE.test(next.text) &&
      !INSTITUTION_HINTS.test(next.text) &&
      !isDateOnlyLine(next.text)
    ) {
      lines.push({ text: `${cur.text.trim()} ${next.text.trim()}`, idx: cur.idx });
      i++; // continuation consumed
    } else {
      lines.push(cur);
    }
  }
  if (lines.length === 0) return { value: [], confidence: 0 };

  // Group into one chunk per qualification. A new chunk begins when the current
  // one already holds a degree and the next line introduces another degree, or
  // already holds an institution and the next line introduces another. This
  // keeps multi-degree sections from collapsing into a single entry (only the
  // first degree was ever extracted before) and works for both
  // "Degree / School / Dates" and "School / Degree / Dates" orderings.
  const chunks: { text: string; idx: number }[][] = [];
  let current: { text: string; idx: number }[] = [];
  let hasDegree = false;
  let hasInstitution = false;
  // True once the current chunk holds a complete DEGREE-LESS PROGRAM ENTRY
  // (a program-title lead + its institution line, #238). It becomes the
  // boundary signal a degree-keyword-less entry otherwise lacks: a following
  // degree / institution-hint / new program-lead then opens a fresh chunk,
  // instead of merging in and dragging the program's inline year onto the next
  // (dateless) school. Set only AFTER the program's own institution line is
  // consumed (`programLeadInstIdx`), so that institution line is not itself
  // mistaken for the start of a new entry.
  let hasProgramLead = false;
  let programLeadInstIdx = -1;
  // Normalized degree+field key of the current chunk's degree header (and the
  // line index it sits at), so a degree line IMMEDIATELY following it that is
  // really this entry's INSTITUTION sub-line (same degree+field, #297) is kept
  // attached instead of splitting off as a phantom entry. Adjacency is required:
  // a same-degree second entry (two "B.S., Computer Science" from different
  // schools) has its own institution line BETWEEN the two degree headers, so it
  // is not adjacent and still splits correctly.
  let currentDegreeKey: string | null = null;
  let degreeHeaderLi = -1;
  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = [];
    hasDegree = false;
    hasInstitution = false;
    hasProgramLead = false;
    programLeadInstIdx = -1;
    currentDegreeKey = null;
    degreeHeaderLi = -1;
  };
  for (let li = 0; li < lines.length; li++) {
    const text = lines[li].text;
    // #462/#467 — a DEGREE_RE or INSTITUTION_HINTS hit on a sub-labelled line
    // ("Achievements: Graduated B.E. with Distinction"), an event-narration
    // sentence ("Graduated B.E. …"), or a body sentence that contains an
    // incidental institution-word substring (e.g. `\bcollege\b` inside
    // "inter-college hackathons") is body prose that bled in from a mis-routed
    // compound header ("CERTIFICATIONS & ACTIVITIES") or an unrouted qualified
    // header ("RELEVANT COURSEWORK"), not a new education entry. Gate BOTH
    // isDeg and isInst on `isRealEntryHeader` so such lines never open a
    // phantom entry — the raw DEGREE_RE hit still shows up in
    // `startsHintlessEntry`'s next-line lookahead below (which uses raw
    // DEGREE_RE.test), so genuine follow-on degrees are unaffected.
    const isDeg = DEGREE_RE.test(text) && isRealEntryHeader(text);
    const isInst =
      INSTITUTION_HINTS.test(text) && isRealEntryHeader(text);
    const isProgramLead = isProgramLeadAt(lines, li);
    // A bare line (no degree/institution-hint, not a date) that arrives once the
    // current chunk already holds BOTH a degree and an institution, AND is
    // immediately followed by a degree, begins a new entry whose school is
    // acronym-only / hint-less (`MIT`, `UC Berkeley`) — School / Degree ordering
    // where the hint-based flush below can't see the boundary (#184). The
    // next-line-is-a-degree lookahead distinguishes a real new school from a
    // trailing prose note (`GPA: 3.8`, `Minor in Economics`), which carries no
    // following degree and so must stay inside the current entry.
    const next = lines[li + 1]?.text;
    const startsHintlessEntry =
      !isDeg &&
      !isInst &&
      hasDegree &&
      hasInstitution &&
      !isDateOnlyLine(text) &&
      // Same `isRealEntryHeader` gate as `isDeg` above (#462/#467): a phantom
      // DEGREE_RE hit on a body-prose "Graduated B.E. with Distinction" sentence
      // must not persuade the chunker that this hint-less line leads a new
      // acronym-school entry.
      ((next !== undefined && DEGREE_RE.test(next) && isRealEntryHeader(next)) ||
        // …or the boundary line is itself a hint-less, degree-less PROGRAM NAME
        // carrying its own graduation year inline ("MIT Applied Data Science
        // (2023)", #219). The inline year is what the old code would bleed onto
        // the preceding school; splitting here keeps it with its own program.
        // Requires a Title-case program lead (not a `GPA:`/`Minor` note, not a
        // bare "Fall 2013 – Spring 2014" date range — which `isDateOnlyLine`
        // already excluded above) so an honors/awards line never splits.
        isInlineDatedProgram(text));
    // Once the current chunk is a complete degree-less program entry (#238), a
    // new entry lead — a degree, an institution-hint, or another program lead —
    // closes it. The program's own institution line (`programLeadInstIdx`) is
    // excluded because `hasProgramLead` is not yet set when it arrives.
    const startsAfterProgramLead =
      hasProgramLead && (isDeg || isInst || isProgramLead);
    // A degree line that parses to the SAME degree+field as the current chunk's
    // header is that entry's own institution SUB-LINE (the reconstructed
    // "Institution" line polluted with the degree text, #297) — not a second
    // degree. Keep it attached: suppress BOTH the degree-repeat and the
    // institution-repeat flush this line would otherwise trigger.
    const isDupDegreeSubLine =
      isDeg &&
      hasDegree &&
      currentDegreeKey !== null &&
      li === degreeHeaderLi + 1 &&
      degreeFieldKey(text) === currentDegreeKey;
    if (
      !isDupDegreeSubLine &&
      ((isDeg && hasDegree) ||
        (isInst && hasInstitution) ||
        startsHintlessEntry ||
        startsAfterProgramLead)
    )
      flush();
    current.push(lines[li]);
    if (isDeg) hasDegree = true;
    if (isDeg && currentDegreeKey === null) {
      currentDegreeKey = degreeFieldKey(text);
      degreeHeaderLi = li;
    }
    if (isInst) hasInstitution = true;
    // A program lead claims the NEXT line as its institution; mark the chunk a
    // complete program entry only once that institution line has been consumed.
    if (isProgramLead) programLeadInstIdx = li + 1;
    if (li === programLeadInstIdx) hasProgramLead = true;
  }
  flush();

  // Carry each entry's start line index (its anchor) past the build/filter so
  // coursework can be attributed to it by position.
  const built = chunks
    .map((chunk) => ({
      ...educationFromChunk(chunk.map((c) => c.text)),
      startIdx: chunk[0].idx,
    }))
    .filter((b) => b.entry.degree || b.entry.institution);
  if (built.length === 0) return { value: [], confidence: 0 };

  const value = built.map((b) => b.entry);
  // Attribute each coursework item to the nearest *preceding* entry by line
  // position (#190): a course listed under the Master's stays with the Master's,
  // one under the Bachelor's with the Bachelor's. A block that appears before
  // any degree (or a single-entry section) falls to the first entry — the
  // original #164 behavior. `built` is in document order, so its `startIdx`
  // values are monotonic and the scan can stop at the first entry past `idx`.
  for (const course of coursework) {
    let target = 0;
    for (let e = 0; e < built.length; e++) {
      if (built[e].startIdx <= course.idx) target = e;
      else break;
    }
    (value[target].coursework ??= []).push(course.text);
  }

  // Deduplicate coursework on each entry (#223). When a standalone "Relevant
  // Coursework" section is an education alias, `findSection` merges its lines
  // into the education section, so bullets that appear both inline under the
  // degree AND in the standalone section are collected twice. Dedupe by exact
  // text, preserving first-occurrence order.
  for (const entry of value) {
    if (entry.coursework && entry.coursework.length > 1) {
      entry.coursework = [...new Set(entry.coursework)];
    }
  }

  return {
    value,
    confidence: avgScore(built.map((b) => b.score)),
  };
}
