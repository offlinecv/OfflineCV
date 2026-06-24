// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { ResumeExperience } from "../../score/types.ts";
import type { PdfSection } from "../sections.ts";
import { parseEntryBlocks } from "../entry-blocks.ts";
import type { EntryBlock } from "../entry-blocks.ts";
import { US_LOCATION_RE, INTL_LOCATION_RE } from "../regex.ts";
import { looksLikeTitle, looksLikeCompany, finalizeEntries } from "./shared.ts";

// ── Experience ──────────────────────────────────────────────────────────────

/**
 * Split the experience section into entry blocks and extract a
 * `ResumeExperience` row per block. The grouping heuristic:
 *
 *   - A line containing a date range anchors an entry header.
 *   - Non-bullet lines in the 0..2 lines ABOVE the anchor = company / title.
 *   - Bullet lines after the anchor, until the next anchor or section end,
 *     = the description.
 *
 * Confidence is per-entry, then averaged: we report the average of the
 * per-entry confidence as the section-level `experience` confidence.
 */
export function extractExperience(
  experience: PdfSection | undefined,
): { value: ResumeExperience[]; confidence: number } {
  // Split the section into dated entry blocks using the shared primitive, then
  // map each block's header lines into title/company/team and score it. The
  // windowing, date parsing, and bullet-body collection live in
  // `parseEntryBlocks`; this function owns only the experience-specific field
  // mapping (`disambiguateCompanyTitle`) and scoring.
  const blocks = parseEntryBlocks(experience, {
    anchor: "date_range",
    collectBody: true,
    headerLookback: 2,
  });
  // Drop a date-only phantom — a block with neither title nor company (#145).
  // Experience has no single title axis, so we keep a role that has either.
  return finalizeEntries(
    blocks.map(experienceFromBlock),
    (e) => e.title !== "" || e.company !== "",
  );
}

/** Map one dated entry block to a `ResumeExperience` and its confidence score.
 *  Extracted from `extractExperience` to keep each function below the
 *  complexity threshold; mirrors `projectFromBlock` / `achievementFromBlock`. */
function experienceFromBlock(block: EntryBlock): {
  entry: ResumeExperience;
  score: number;
} {
  const { dates } = block;
  const { title, company, team } = disambiguateCompanyTitle(block.headerLines);
  const description = block.body;

  // Score the entry.
  let score = 0;
  if (dates.start_date) score += 0.25;
  if (dates.end_date || dates.is_current) score += 0.15;
  if (company) score += 0.25;
  if (title) score += 0.2;
  if (block.bulletCount >= 1) score += 0.15;

  return {
    entry: {
      title: title ?? "",
      company: company ?? "",
      ...(team ? { team } : {}),
      ...(dates.start_date ? { start_date: dates.start_date } : {}),
      ...(dates.end_date ? { end_date: dates.end_date } : {}),
      ...(dates.is_current ? { is_current: true } : {}),
      description: description || undefined,
    },
    score: Math.min(score, 1),
  };
}

/** Legal-entity suffix that must NOT be cleaved off as a separate field by the
 *  comma split — "Acme, Inc" is one employer, not "Acme" + a role "Inc". */
const LEGAL_SUFFIX_RE =
  /^(inc\.?|llc|l\.l\.c\.?|ltd\.?|corp\.?|co\.?|gmbh|plc|lp|llp|pc|s\.a\.?|n\.a\.?|sa)$/i;

/** Bare city/region names (no "City, ST" state tail, so `US_LOCATION_RE` misses
 *  them) that show up as a `"Title, Location"` header tail — must NOT be cleaved
 *  off as the company. Exact whole-string match keeps a real company that merely
 *  contains a city word ("New York Times", "Boston Consulting") splittable. */
const BARE_LOCATION_RE =
  /^(remote|hybrid|on-?site|san francisco|san diego|san jose|san antonio|los angeles|las vegas|new york|new york city|new orleans|salt lake city|washington|washington d\.?c\.?|boston|chicago|seattle|austin|denver|portland|atlanta|dallas|houston|phoenix|miami|detroit|philadelphia|pittsburgh|minneapolis|nashville|charlotte|columbus|indianapolis|baltimore|sacramento|raleigh|london|paris|berlin|munich|tokyo|singapore|bangalore|bengaluru|mumbai|delhi|hyderabad|toronto|vancouver|sydney|melbourne|dublin|amsterdam)$/i;

/** True when the comma tail reads like a location rather than an employer —
 *  either a "City, ST"/"City, Country" shape or a bare well-known city. Used to
 *  veto the `"Title, Location"` split so a city is never recorded as company. */
function looksLikeLocationTail(after: string): boolean {
  return (
    BARE_LOCATION_RE.test(after) ||
    US_LOCATION_RE.test(after) ||
    INTL_LOCATION_RE.test(after)
  );
}

/**
 * Split a single "Role, Company" header line into [title, company]. Guarded so
 * it only fires when the part before the comma reads like a job title
 * (`looksLikeTitle`), the part after is not a bare legal suffix, and the part
 * after does not read like a location — so "Office manager, The Phone Company"
 * splits, but "Acme, Inc", "Acme Analytics (…) New York, NY" (no title keyword
 * before the comma), and "Marketing Manager, San Francisco" (location tail) do
 * not. Returns null when no guarded split applies.
 */
function splitRoleComma(h: string): [string, string] | null {
  const comma = h.indexOf(",");
  if (comma <= 0) return null;
  const before = h.slice(0, comma).trim();
  const after = h.slice(comma + 1).trim();
  if (!before || !after) return null;
  if (!looksLikeTitle(before)) return null;
  if (LEGAL_SUFFIX_RE.test(after)) return null;
  if (looksLikeLocationTail(after)) return null;
  return [before, after];
}

/**
 * Given 1..3 header lines, decide which is the company and which is the title.
 * Heuristics (in priority order):
 *   - If one looks like a company/institution (legal suffix OR "University",
 *     "College", … — see `looksLikeCompany`) and is not itself a title, that's
 *     the company; the rest is the title. This fires on the common stacked
 *     "Designation / University / Dates" student-resume shape, which the old
 *     suffix-only check missed (it has no "Inc"/"LLC").
 *   - Else if one looks like a title (role/level keyword) and the other
 *     doesn't, the title-keyword one is the title.
 *   - Otherwise the first line (top of the entry) is the company.
 *   - Team is an optional third piece, often separated by "—", ",", or "|".
 */
function disambiguateCompanyTitle(headers: string[]): {
  company?: string;
  title?: string;
  team?: string;
} {
  const filtered = headers.filter((h) => h.length > 0);
  if (filtered.length === 0) return {};

  // Split any header that has an obvious "Title @ Company", "Title — Company",
  // "Title | Company", or guarded "Title, Company" pattern.
  const splits: Array<{ text: string; source: number }> = [];
  filtered.forEach((h, idx) => {
    const atSplit = h.split(/\s+@\s+|\s+—\s+|\s+\|\s+/);
    if (atSplit.length > 1) {
      atSplit.forEach((s) => splits.push({ text: s.trim(), source: idx }));
      return;
    }
    const roleComma = splitRoleComma(h);
    if (roleComma) {
      roleComma.forEach((s) => splits.push({ text: s, source: idx }));
      return;
    }
    splits.push({ text: h, source: idx });
  });

  const companyIdx = splits.findIndex((s) => looksLikeCompany(s.text));
  let company: string | undefined;
  let title: string | undefined;
  let team: string | undefined;

  if (companyIdx !== -1) {
    company = splits[companyIdx].text;
    const others = splits.filter((_, i) => i !== companyIdx);
    title = others[0]?.text;
    team = others[1]?.text;
  } else {
    // No company suffix — tiebreak on title keywords. If only one of the
    // first two splits looks title-shaped, assign accordingly.
    const firstLooksTitle = splits[0] ? looksLikeTitle(splits[0].text) : false;
    const secondLooksTitle = splits[1] ? looksLikeTitle(splits[1].text) : false;
    if (firstLooksTitle && !secondLooksTitle) {
      title = splits[0]?.text;
      company = splits[1]?.text;
      team = splits[2]?.text;
    } else if (!firstLooksTitle && secondLooksTitle) {
      // Older convention ("Company / Title"): leave as default.
      company = splits[0]?.text;
      title = splits[1]?.text;
      team = splits[2]?.text;
    } else {
      // No title-keyword signal either way — assume top line is company.
      company = splits[0]?.text;
      title = splits[1]?.text;
      team = splits[2]?.text;
    }
  }

  return { company, title, team };
}
