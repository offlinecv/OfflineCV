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

  const lines = education.lines
    .filter((l) => !isBulletLine(l))
    .map((l) => l.text)
    .filter((t) => t.trim().length > 0);
  if (lines.length === 0) return { value: [], confidence: 0 };

  // Group into one chunk per qualification. A new chunk begins when the current
  // one already holds a degree and the next line introduces another degree, or
  // already holds an institution and the next line introduces another. This
  // keeps multi-degree sections from collapsing into a single entry (only the
  // first degree was ever extracted before) and works for both
  // "Degree / School / Dates" and "School / Degree / Dates" orderings.
  const chunks: string[][] = [];
  let current: string[] = [];
  let hasDegree = false;
  let hasInstitution = false;
  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = [];
    hasDegree = false;
    hasInstitution = false;
  };
  for (const text of lines) {
    const isDeg = DEGREE_RE.test(text);
    const isInst = INSTITUTION_HINTS.test(text);
    if ((isDeg && hasDegree) || (isInst && hasInstitution)) flush();
    current.push(text);
    if (isDeg) hasDegree = true;
    if (isInst) hasInstitution = true;
  }
  flush();

  const built = chunks
    .map(educationFromChunk)
    .filter((b) => b.entry.degree || b.entry.institution);
  if (built.length === 0) return { value: [], confidence: 0 };
  return {
    value: built.map((b) => b.entry),
    confidence: avgScore(built.map((b) => b.score)),
  };
}
