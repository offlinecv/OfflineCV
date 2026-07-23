// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * buildJobQuery — derives a job-search query from a parsed resume (#318,
 * slice 1 of the job-search epic). Pure function, no I/O.
 *
 * Titles: the DISTINCT titles across parsed experience, most-recent-first
 * (the cascade parses roles most-recent-first, mirroring the résumé's own
 * reverse-chronological order), deduped case-insensitively and capped at
 * MAX_TITLES. Someone who has held several distinct titles (common in
 * leadership — an exec whose prior roles were engineering-leadership or IC
 * titles) keeps every facet of their identity in the search rather than
 * collapsing to the single most-recent title (#539). Falls back to the
 * top-level `current_title` when there's no experience title at all; a résumé
 * with neither naturally falls back to a skills-only query (empty `titles`,
 * populated skills) — the degenerate-query UI state handles the rest.
 *
 * Seniority: derived from keywords in the résumé's titles, not from
 * `ParsedResume.seniority_level` — the issue asks for a title-keyword
 * derivation so the seniority shown always traces back to a word the user can
 * see in their own title. The PRIMARY (first / most-recent) title is checked
 * first; when it carries no seniority keyword at all, we fall back to
 * scanning the remaining titles in the same most-recent-first order and take
 * the first one that matches (#540) — this is what lets an exec whose most
 * recent line is a board seat still show "Executive" off an earlier CEO
 * title, without letting a later IC title outrank a primary title that DID
 * carry a keyword (the #539 scope boundary: a real primary match always
 * wins, no fallback scan once we have one).
 *
 * Skills: reuses the shared SKILLS canonical index (`getSkillIndex` from
 * jd-match) to canonicalize + dedupe `parsed.skills` — two raw entries that
 * alias the same canonical skill (e.g. "JS" and "Javascript") collapse into
 * one. Skills that don't match a known canonical alias pass through verbatim
 * (title-cased raw string) rather than being dropped, so an unusual but real
 * skill still surfaces.
 *
 * Ranking (#541): a résumé's skills section is typically NOT already ordered
 * by relevance — an incidental early entry (a soft skill, a one-off tool) can
 * sit ahead of an entire coherent cluster (e.g. AI/ML) simply because of
 * where it was typed. Before capping, skills are stable-sorted so entries
 * that match the shared SKILLS taxonomy (`canonicalId` is set) rank ahead of
 * ones that don't — a known, named skill is a stronger relevance signal than
 * an arbitrary string, and it's the same index the JD-match lane already
 * trusts for evidence matching. Ties keep their original résumé order
 * (`Array.prototype.sort` is stable), so within "canonical" and within
 * "unrecognized" the input order is preserved — this is deliberately simple:
 * title/seniority-aware weighting was considered (see the issue) but adds a
 * second dependency + tie-breaking policy for a v1 fix; revisit if canonical-
 * only ranking proves too coarse in practice. Capped at MAX_SKILLS after
 * ranking, so the cap drops the least-relevant tail instead of an arbitrary
 * one.
 */

import type { ParsedResume } from "../score/types.ts";
import { getSkillIndex } from "../jd-match/skills.ts";

export interface JobQuery {
  /** Distinct role titles, most-recent-first, deduped case-insensitively and
   *  capped at MAX_TITLES. Empty when none could be derived (skills-only /
   *  degenerate query). `titles[0]` is the primary (most-recent) title. */
  titles: string[];
  /** Top-ranked skills, canonicalized + deduped, capped at MAX_SKILLS. */
  skills: string[];
  /** Seniority keyword found across the résumé's titles (Executive/VP/
   *  Director/Manager/Staff/Principal/Lead/Senior/Junior/Intern) — the
   *  PRIMARY title wins when it has a keyword, otherwise the first match
   *  scanning the rest of `titles` in order (#540) — or undefined when none
   *  of them carries a recognized keyword. */
  seniority?: string;
  /** Candidate location, seeded from the parsed résumé's top-level
   *  `location` (contact address, e.g. "Austin, TX") when present (#545).
   *  Single free-text value, user-editable — unlike titles/skills this is
   *  not a list: a candidate has one search location at a time, not several
   *  to union together. Undefined when the parse has no location and the
   *  user hasn't typed one. */
  location?: string;
}

/**
 * Structural subset of `ParsedResume` this module actually reads. The live
 * caller (`ResultDetailTabs`) holds a `HeuristicParsedResume`
 * (`Partial<ParsedResume> & { skills, experience, education }` —
 * src/lib/heuristics/types.ts), which lacks `ParsedResume`'s other required
 * fields (`full_name`, `skills_explicit`, `skills_inferred`). Picking just the
 * fields we use keeps `buildJobQuery` callable with either shape without a
 * cast, while still reading naturally as "takes a parsed resume".
 */
export type ResumeQueryInput = Pick<
  ParsedResume,
  "skills" | "experience" | "current_title" | "location"
>;

/**
 * Cap on skills surfaced in the query (and rendered as removable chips in
 * `FindJobsPanel`). 5 (the original value) majority-truncated a normal ~12-
 * skill résumé section — most of a candidate's skills, sometimes a whole
 * coherent cluster, silently vanished from the query (#541). 12 covers a
 * normal-length skills section without materially truncating it, while still
 * bounding the pathological case (a résumé with 60 keyword-stuffed skills).
 * Deep-link URL length is bounded separately — see
 * `MAX_DEEP_LINK_SKILLS` in deep-links.ts, which slices this already-ranked
 * list further for the egress keyword phrase rather than sharing one cap
 * across both the in-app query and the outbound URLs.
 */
export const MAX_SKILLS = 12;

/**
 * Cap on distinct titles surfaced in the query. Bounds the deep-link keyword
 * string, the in-app query-term filter, and the audited egress phrase so a
 * résumé with a long, varied history can't balloon any of them. Four keeps the
 * common leadership case (current exec title + one or two prior IC/leadership
 * titles) intact while dropping the long tail of early-career titles.
 */
export const MAX_TITLES = 4;

// Order matters throughout this table: every row is checked top-to-bottom and
// the FIRST match wins, so a more specific keyword must sit above the more
// general one it would otherwise be swallowed by. Two ordering constraints in
// particular:
//   - "Senior Staff Engineer" must read as Staff, not Senior → the IC ladder
//     keeps its original specific-before-general order (Staff/Principal/Lead
//     before Senior).
//   - "Senior Vice President" must read as VP (specifically SVP), not
//     Executive-via-"Chief" and not the bare "Senior" IC keyword → SVP/EVP sit
//     above the generic VP row, and the whole leadership tier sits above the
//     IC tier so a compound title like "Senior Director" reads as Director,
//     not Senior (#540).
const SENIORITY_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  // Leadership/exec tier (#540) — most specific/senior first.
  { label: "Executive", pattern: /\bco-?founder\b|\bfounder\b/i },
  { label: "Executive", pattern: /\bchief\s+.+?\s+officer\b/i },
  { label: "Executive", pattern: /\bceo\b|\bcto\b|\bcfo\b|\bcoo\b|\bcio\b|\bcmo\b|\bciso\b|\bcxo\b/i },
  { label: "VP", pattern: /\bsvp\b|\bsenior\s+vice\s+president\b/i },
  { label: "VP", pattern: /\bevp\b|\bexecutive\s+vice\s+president\b/i },
  { label: "VP", pattern: /\bvp\b|\bvice\s+president\b/i },
  { label: "Director", pattern: /\bdirector\b|\bhead\s+of\b/i },
  { label: "Manager", pattern: /\bmanager\b/i },
  // "Chief of Staff" is an exec/leadership role, not the IC "Staff" rung — it
  // lacks the trailing "officer" the generic Chief row requires, so it must be
  // caught explicitly ABOVE the IC ladder or it falls through to `\bstaff\b`.
  { label: "Executive", pattern: /\bchief\s+of\s+staff\b/i },
  // IC ladder (original #539 table) — specific before general.
  { label: "Staff", pattern: /\bstaff\b/i },
  { label: "Principal", pattern: /\bprincipal\b/i },
  { label: "Lead", pattern: /\blead\b/i },
  { label: "Senior", pattern: /\bsenior\b|\bsr\.?\b/i },
  { label: "Junior", pattern: /\bjunior\b|\bjr\.?\b/i },
  { label: "Intern", pattern: /\bintern(?:ship)?\b/i },
];

function deriveTitles(parsed: ResumeQueryInput): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const exp of parsed.experience ?? []) {
    const title = exp.title?.trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue; // dedup case-insensitively, keep first-seen casing
    seen.add(key);
    out.push(title);
    if (out.length >= MAX_TITLES) break; // most-recent-first, so we keep the recent ones
  }
  if (out.length > 0) return out;
  // No experience title at all → fall back to the top-level current_title, or
  // an empty set (skills-only / degenerate query).
  const current = parsed.current_title?.trim();
  return current ? [current] : [];
}

function deriveSeniority(title: string): string | undefined {
  for (const { label, pattern } of SENIORITY_PATTERNS) {
    if (pattern.test(title)) return label;
  }
  return undefined;
}

/**
 * Scans `titles` in order (most-recent-first) and returns the label from the
 * first one that carries a seniority keyword. Called with the PRIMARY title
 * first, so a real match there always wins immediately; the scan only
 * continues into the rest of the array when the primary carries no keyword at
 * all (#540) — e.g. a most-recent title that is a board seat or a sabbatical
 * line, with a CEO/VP/etc. title earlier in the history.
 */
function deriveSeniorityAcrossTitles(titles: string[]): string | undefined {
  for (const title of titles) {
    const match = deriveSeniority(title);
    if (match) return match;
  }
  return undefined;
}

function titleCase(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

interface RankedSkill {
  label: string;
  /** true when the entry matched the shared SKILLS taxonomy — ranks first. */
  isCanonical: boolean;
  /** original résumé-order index — the stable tie-breaker within a rank. */
  index: number;
}

function deriveSkills(parsed: ResumeQueryInput): string[] {
  const index = getSkillIndex();
  const seen = new Set<string>();
  const ranked: RankedSkill[] = [];
  let order = 0;
  for (const raw of parsed.skills ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const canonicalId = index.aliasToId.get(trimmed.toLowerCase());
    const dedupeKey = canonicalId ?? trimmed.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    ranked.push({
      label: canonicalId ? (index.idToLabel.get(canonicalId) ?? trimmed) : titleCase(trimmed),
      isCanonical: Boolean(canonicalId),
      index: order++,
    });
  }
  // Canonical (taxonomy-recognized) skills rank ahead of unrecognized ones;
  // `sort` is stable, so ties keep their résumé order via the explicit
  // `index` tie-breaker (belt-and-suspenders against non-stable engines).
  ranked.sort((a, b) => {
    if (a.isCanonical !== b.isCanonical) return a.isCanonical ? -1 : 1;
    return a.index - b.index;
  });
  return ranked.slice(0, MAX_SKILLS).map((entry) => entry.label);
}

function deriveLocation(parsed: ResumeQueryInput): string | undefined {
  const location = parsed.location?.trim();
  return location || undefined;
}

export function buildJobQuery(parsed: ResumeQueryInput): JobQuery {
  const titles = deriveTitles(parsed);
  // Primary title first, then fall back across the rest of the titles (#540).
  const seniority = deriveSeniorityAcrossTitles(titles);
  const skills = deriveSkills(parsed);
  const location = deriveLocation(parsed);
  return { titles, skills, seniority, location };
}
