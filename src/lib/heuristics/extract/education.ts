// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { ResumeEducation } from "../../score/types.ts";
import type { PdfSection } from "../sections.ts";
import {
  DEGREE_RE,
  INSTITUTION_HINTS,
  MONTH_YEAR_RE,
  NUMERIC_MONTH_YEAR_RE,
} from "../regex.ts";
import {
  isBulletLine,
  parseDateRange,
  normalizeDate,
  stripBullet,
} from "../line-primitives.ts";
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

/** A line that is essentially just a date / date-range (a bare year or
 *  month-year), so it must not be mistaken for the institution inside an
 *  education chunk. */
function isDateOnlyLine(text: string): boolean {
  const stripped = text
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?/gi, "")
    .replace(/\b\d{4}\b/g, "")
    .replace(/\b(?:present|current|expected|graduation|graduated|anticipated)\b/gi, "")
    .replace(/[\s,–\-—|/().:]+/g, "")
    .trim();
  return stripped.length === 0;
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
  if (!/\b(19|20)\d{2}\b/.test(t)) return false;
  // A graduation-date line ("Grad. May 2011 | Kolkata, India", "Expected
  // Graduation: 2026", "Class of 2025") is the DATE of an existing school, not a
  // new program — it leads with a graduation/date-context word. Reject so a
  // school's own grad-date line never splits off as a phantom entry.
  if (/^(grad(?:\.|uat\w*)?|expected|anticipated|class of|completed)\b/i.test(t))
    return false;
  // An honors / awards / activity annotation that happens to carry a year
  // ("Dean's List 2021", "Honors Thesis: … (2024)", "Teaching Assistant for …
  // (2022 - 2023)", "Study Abroad, Florence 2021") is a sub-field of the current
  // school, NOT a new program — it must not split off a phantom degree-less
  // entry (#219). These read as annotations, not program names, so an exact
  // keyword denylist is safe: a real second program ("MIT Applied Data Science
  // (2023)", "Google Data Analytics Certificate 2022") carries none of them.
  if (
    /\b(dean'?s? list|awards?|honou?rs?|thesis|teaching assistant|research assistant|study abroad|coursework|scholarships?|fellowships?|cum laude)\b/i.test(
      t,
    )
  )
    return false;
  // Drop a trailing "| City, Region" location segment before measuring the
  // program remainder — a date+location line ("… 2011 | Kolkata, India") must
  // not pass on the strength of its city words.
  const noLocation = t.replace(/[|,]\s*[A-Z][A-Za-z.\-]+(?:\s*,\s*[A-Za-z.\-]+)*$/, "");
  // Strip years and date connective words (seasons / months / range words); a
  // real program name leaves substantive text, a bare date line leaves nothing.
  const remainder = noLocation
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(
      /\b(?:spring|summer|fall|autumn|winter|present|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/gi,
      "",
    )
    .replace(/[\s,–\-—|/().:]+/g, "")
    .trim();
  return remainder.length >= 3;
}

/** Map one education chunk (the degree + institution + date lines of a single
 *  qualification) to a `ResumeEducation` and its confidence. */
function educationFromChunk(chunk: string[]): {
  entry: ResumeEducation;
  score: number;
} {
  const joined = chunk.join(" | ");
  const degreeMatch = DEGREE_RE.exec(joined);
  const degree = degreeMatch ? degreeMatch[0].trim() : "";

  // Institution: an explicit institution-hint line first; else the first line
  // that is neither the degree-bearing line nor a bare date — this recovers
  // acronym schools ("MIT", "UC Berkeley") that carry no "University"/"College"
  // word; else strip the degree off its own line (degree + school on one line).
  let institution = "";
  const instLine = chunk.find((l) => INSTITUTION_HINTS.test(l));
  if (instLine) {
    institution = instLine.trim();
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

  // Shared date primitive (via the education wrapper) so a range like
  // "Sep 2024 - July 2025" keeps both halves and a lone graduation date lands in
  // `end_date` (#97).
  const dates = parseEducationDates(joined);
  const hasDate = !!(dates.start_date || dates.end_date);

  let score = 0;
  if (institution) score += 0.3;
  if (degree) score += 0.4;
  if (hasDate) score += 0.3;

  return {
    entry: { institution, degree, ...educationDateFields(dates) },
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
    if (!isBulletLine(ls[i])) continue;
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
    if (/^[A-Z0-9]/.test(item)) {
      coursework.push({ text: item, idx: i });
      for (const k of span) consumed.add(k);
    }
    i = j - 1;
  }

  // Keep the source-line `idx` on each entry line so a built chunk's start
  // position is known — that anchor is what coursework is attributed against.
  const lines = ls
    .map((l, idx) => ({ text: l.text, bullet: isBulletLine(l), idx }))
    .filter((l) => !l.bullet && !consumed.has(l.idx) && l.text.trim().length > 0)
    .map((l) => ({ text: l.text, idx: l.idx }));
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
  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = [];
    hasDegree = false;
    hasInstitution = false;
  };
  for (let li = 0; li < lines.length; li++) {
    const text = lines[li].text;
    const isDeg = DEGREE_RE.test(text);
    const isInst = INSTITUTION_HINTS.test(text);
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
      ((next !== undefined && DEGREE_RE.test(next)) ||
        // …or the boundary line is itself a hint-less, degree-less PROGRAM NAME
        // carrying its own graduation year inline ("MIT Applied Data Science
        // (2023)", #219). The inline year is what the old code would bleed onto
        // the preceding school; splitting here keeps it with its own program.
        // Requires a Title-case program lead (not a `GPA:`/`Minor` note, not a
        // bare "Fall 2013 – Spring 2014" date range — which `isDateOnlyLine`
        // already excluded above) so an honors/awards line never splits.
        isInlineDatedProgram(text));
    if ((isDeg && hasDegree) || (isInst && hasInstitution) || startsHintlessEntry)
      flush();
    current.push(lines[li]);
    if (isDeg) hasDegree = true;
    if (isInst) hasInstitution = true;
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

  return {
    value,
    confidence: avgScore(built.map((b) => b.score)),
  };
}
