// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * buildJobQuery — derives a job-search query from a parsed resume (#318,
 * slice 1 of the job-search epic). Pure function, no I/O.
 *
 * Title: prefers the most recent experience entry's title (experience[0] —
 * the cascade parses roles most-recent-first, mirroring the résumé's own
 * reverse-chronological order); falls back to the top-level `current_title`
 * when there's no experience at all. A résumé with no experience and no
 * current title naturally falls back to a skills-only query (empty title,
 * populated skills) — the degenerate-query UI state handles the rest.
 *
 * Seniority: derived from keywords in the title itself (senior/staff/lead/
 * principal/junior/intern), not from `ParsedResume.seniority_level` — the
 * issue asks for a title-keyword derivation so the seniority shown always
 * traces back to a word the user can see in their own title.
 *
 * Skills: reuses the shared SKILLS canonical index (`getSkillIndex` from
 * jd-match) to canonicalize + dedupe `parsed.skills` — two raw entries that
 * alias the same canonical skill (e.g. "JS" and "Javascript") collapse into
 * one. Skills that don't match a known canonical alias pass through verbatim
 * (title-cased raw string) rather than being dropped, so an unusual but real
 * skill still surfaces. Capped at MAX_SKILLS for URL-length sanity.
 */

import type { ParsedResume } from "../score/types.ts";
import { getSkillIndex } from "../jd-match/skills.ts";

export interface JobQuery {
  /** Most recent role title, or "" when none could be derived. */
  title: string;
  /** Top-ranked skills, canonicalized + deduped, capped at MAX_SKILLS. */
  skills: string[];
  /** Seniority keyword found in the title (Staff/Principal/Lead/Senior/
   *  Junior/Intern), or undefined when the title carries no such keyword. */
  seniority?: string;
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
  "skills" | "experience" | "current_title"
>;

/** Cap on skills surfaced in the query — keeps deep-link URLs a sane length. */
export const MAX_SKILLS = 5;

const SENIORITY_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  // Order matters: check the more specific/senior keywords before "senior"
  // itself so "Senior Staff Engineer" reads as Staff, not Senior.
  { label: "Staff", pattern: /\bstaff\b/i },
  { label: "Principal", pattern: /\bprincipal\b/i },
  { label: "Lead", pattern: /\blead\b/i },
  { label: "Senior", pattern: /\bsenior\b|\bsr\.?\b/i },
  { label: "Junior", pattern: /\bjunior\b|\bjr\.?\b/i },
  { label: "Intern", pattern: /\bintern(?:ship)?\b/i },
];

function deriveTitle(parsed: ResumeQueryInput): string {
  const mostRecent = parsed.experience?.[0]?.title?.trim();
  if (mostRecent) return mostRecent;
  return parsed.current_title?.trim() ?? "";
}

function deriveSeniority(title: string): string | undefined {
  for (const { label, pattern } of SENIORITY_PATTERNS) {
    if (pattern.test(title)) return label;
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

function deriveSkills(parsed: ResumeQueryInput): string[] {
  const index = getSkillIndex();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parsed.skills ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const canonicalId = index.aliasToId.get(trimmed.toLowerCase());
    const dedupeKey = canonicalId ?? trimmed.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(
      canonicalId ? (index.idToLabel.get(canonicalId) ?? trimmed) : titleCase(trimmed),
    );
    if (out.length >= MAX_SKILLS) break;
  }
  return out;
}

export function buildJobQuery(parsed: ResumeQueryInput): JobQuery {
  const title = deriveTitle(parsed);
  const seniority = title ? deriveSeniority(title) : undefined;
  const skills = deriveSkills(parsed);
  return { title, skills, seniority };
}
