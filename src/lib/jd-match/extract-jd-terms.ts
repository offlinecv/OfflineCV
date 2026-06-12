// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Deterministic JD term extraction.
 *
 * Two passes:
 *   1. Skill-phrase pass — phrase-match every alias in the curated dictionary
 *      against the JD body, dedupe to canonical IDs.
 *   2. Noun-phrase pass — heuristic regex over the remaining text to pick up
 *      capitalized multi-word phrases and ≥2-letter acronyms not in the
 *      dictionary. Weighted lower at the coverage step.
 *
 * Both passes ignore boilerplate sections (EEO, benefits, legal disclaimers).
 * The anchor list below is the full set of phrases we use to detect those
 * sections — match an anchor anywhere on a line and we skip that line plus
 * everything up to a blank line or another anchor.
 *
 * For each extracted term we record a short snippet (~80 chars) showing
 * where in the JD it surfaced. The UI hovers that snippet so a user can
 * see *why* a term was extracted.
 */

import { getSkillIndex } from "./skills.ts";

/**
 * Anchor phrases (lowercased, normalized whitespace) that mark the start of
 * boilerplate JD sections we want to exclude from term extraction.
 *
 * Sources for the list:
 *   - EEO / OFCCP "equal opportunity" disclaimers shipped in nearly every
 *     US tech JD.
 *   - Benefits / perks blocks ("we offer", "what we offer", "perks").
 *   - Visa / sponsorship / pay-range legalese.
 *   - "About us" boilerplate is intentionally NOT excluded — it often
 *     contains domain skills ("we're a Rust-first infra company") that v1
 *     should pick up.
 *
 * If you add an anchor, lowercase it and keep it phrase-shaped — we match
 * with `.includes()` after whitespace normalization, not regex.
 */
export const BOILERPLATE_ANCHORS: readonly string[] = [
  "equal opportunity employer",
  "equal employment opportunity",
  "without regard to race",
  "regardless of race",
  "we celebrate diversity",
  "we are an equal",
  "eeo statement",
  "eeo policy",
  "affirmative action",
  "reasonable accommodation",
  "ofccp",
  "pay transparency",
  "salary range",
  "compensation range",
  "base salary range",
  "expected base salary",
  "benefits we offer",
  "what we offer",
  "perks and benefits",
  "401(k)",
  "health insurance",
  "dental insurance",
  "vision insurance",
  "paid time off",
  "parental leave",
  "visa sponsorship",
  "sponsorship is not",
  "unable to sponsor",
  "must be authorized to work",
  "e-verify",
];

export interface ExtractedTerm {
  /** Stable identifier — canonical skill ID for the skill pass; the lowercased
   *  noun phrase for the noun pass. UI uses this as a React key. */
  id: string;
  /** What to render in the UI. Canonical form of the skill, or the original
   *  phrase as it appeared in the JD (preserving its capitalization). */
  display: string;
  /** Which pass surfaced the term. Coverage weights skill > noun. */
  source: "skill" | "noun";
  /** A short JD-anchored snippet (~80 chars) — used in the hover tooltip. */
  snippet: string;
}

export interface ExtractJdTermsResult {
  /** Skill-pass hits (canonical IDs). */
  skills: ExtractedTerm[];
  /** Noun-pass hits. Filtered to exclude anything that also matched a skill.
   *  Capped at `NOUN_PASS_CAP` — see `nounsDropped` for the silenced overflow. */
  nouns: ExtractedTerm[];
  /** Concatenation of `skills` then `nouns` — convenience for the coverage step. */
  all: ExtractedTerm[];
  /** How many noun-pass hits the cap silenced. UI surfaces this as a
   *  "+N more not shown" footnote so the user knows the panel isn't
   *  exhaustive when the JD is unusually noisy. */
  nounsDropped: number;
  /** JD text after boilerplate exclusion and whitespace normalization.
   *  Exposed so coverage / UI can pull snippets from the same view we matched. */
  body: string;
}

/**
 * Cap on noun-pass hits surfaced per JD. The caller applies this as a
 * first-N-in-document-order slice (`allNouns.slice(0, NOUN_PASS_CAP)`) —
 * there's no ranking step in v1; we keep what the regex finds first and
 * record the rest as `nounsDropped`. A capitalization-heavy paragraph can
 * produce 50+ noisy noun phrases; surfacing them all would drown the
 * Missing column. Empirically, typical tech JDs land at <10 noun-phrase
 * hits after the skill-overlap filter, so a 25-cap leaves comfortable
 * headroom while protecting the UI from outliers.
 */
export const NOUN_PASS_CAP = 25;

/**
 * Lines that the noun-phrase regex would otherwise pick up but that almost
 * never carry a real skill. Lowercased; we compare case-insensitively.
 */
const NOUN_STOP_PHRASES = new Set<string>([
  "the company",
  "our team",
  "our company",
  "our customers",
  "our customer",
  "our users",
  "our product",
  "our products",
  "our mission",
  "our values",
  "our vision",
  "the role",
  "the team",
  "the position",
  "the candidate",
  "the ideal candidate",
  "this role",
  "this position",
  "we",
  "us",
  "you",
  "your",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

/** Single-token acronyms we never want as a noun-pass term. Matches things
 *  the regex would otherwise sweep up from JD copy. */
const ACRONYM_STOPLIST = new Set<string>([
  "AND",
  "OR",
  "THE",
  "FOR",
  "WITH",
  "FROM",
  "INTO",
  "ON",
  "IN",
  "AS",
  "AT",
  "BY",
  "TO",
  "OF",
  "WE",
  "US",
  "YOU",
  "YOUR",
]);

export interface ExtractOptions {
  /** Override the snippet length. Default 80. */
  snippetChars?: number;
}

/**
 * Run both passes on the JD text. Returns the deduped, snippet-anchored
 * term lists.
 *
 * The body normalization is intentionally light: we strip boilerplate
 * sections, collapse runs of whitespace to single spaces, and otherwise
 * leave casing and punctuation intact. The skill regex is case-insensitive;
 * the noun-phrase regex needs the original capitalization to fire.
 */
export function extractJdTerms(
  rawJd: string,
  options: ExtractOptions = {},
): ExtractJdTermsResult {
  const snippetChars = options.snippetChars ?? 80;
  const body = stripBoilerplate(rawJd);

  const skills = extractSkillPass(body, snippetChars);
  const skilledAliases = new Set(skills.map((t) => t.id));
  const allNouns = extractNounPass(body, snippetChars).filter((n) => {
    // Drop noun hits whose lowercased form is already a skill alias —
    // those are weaker evidence for the same canonical ID.
    const lower = n.display.toLowerCase();
    if (skilledAliases.has(lower)) return false;
    // Drop noun hits that the skill pass already saw under a different alias.
    const index = getSkillIndex();
    if (index.aliasToId.has(lower)) return false;
    return true;
  });

  const nouns = allNouns.slice(0, NOUN_PASS_CAP);
  const nounsDropped = Math.max(0, allNouns.length - NOUN_PASS_CAP);

  return {
    skills,
    nouns,
    all: [...skills, ...nouns],
    nounsDropped,
    body,
  };
}

/**
 * Walk the JD line by line. A line that contains a boilerplate anchor is
 * dropped, along with the run of non-blank lines that follow (we treat a
 * blank line as the end of a boilerplate block). This is intentionally
 * conservative: it'd rather under-strip than swallow real skill copy.
 */
export function stripBoilerplate(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const lower = line.toLowerCase().replace(/\s+/g, " ");
    const hitsAnchor = BOILERPLATE_ANCHORS.some((a) => lower.includes(a));
    if (hitsAnchor) {
      skipping = true;
      continue;
    }
    if (line === "") {
      if (skipping) {
        skipping = false;
        kept.push("");
      } else {
        kept.push("");
      }
      continue;
    }
    if (skipping) continue;
    kept.push(rawLine);
  }
  // Collapse 3+ blank lines down to one to keep snippets tidy.
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractSkillPass(body: string, snippetChars: number): ExtractedTerm[] {
  const index = getSkillIndex();
  const pattern = new RegExp(index.pattern.source, index.pattern.flags);
  const seen = new Map<string, ExtractedTerm>();
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    const matchedAlias = m[1].toLowerCase();
    const id = index.aliasToId.get(matchedAlias);
    if (!id) continue;
    if (seen.has(id)) continue;
    const aliasStart = m.index + (m[0].length - m[1].length);
    seen.set(id, {
      id,
      display: id,
      source: "skill",
      snippet: snippetAround(body, aliasStart, m[1].length, snippetChars),
    });
  }
  return Array.from(seen.values());
}

/**
 * Heuristic noun-phrase pass.
 *
 * Two regexes:
 *   - Capitalized multi-word phrases of 2–4 words (e.g. "Distributed Systems",
 *     "Apache Kafka"). Each word starts with an uppercase letter and contains
 *     only letters and an optional `.`, `&`, or `-`.
 *   - Standalone all-caps acronyms of 2–6 letters/digits (e.g. "ETL", "SOC2",
 *     "ATS"). Lowercased acronyms are NOT eligible — too noisy.
 *
 * Each hit is filtered against `NOUN_STOP_PHRASES` and `ACRONYM_STOPLIST`
 * and deduped case-insensitively. The caller caps the surfaced count to
 * `NOUN_PASS_CAP` and records the dropped overflow on `nounsDropped`.
 */
function extractNounPass(body: string, snippetChars: number): ExtractedTerm[] {
  // Word-char class excludes `.` so "Kubernetes." captures "Kubernetes" only.
  // Inter-word separator is `[ \t]+` so a phrase can't span a sentence/line break.
  const phraseRe =
    /\b([A-Z][A-Za-z][A-Za-z&-]*(?:[ \t]+[A-Z][A-Za-z][A-Za-z&-]*){1,3})\b/g;
  const acronymRe = /\b([A-Z][A-Z0-9]{1,5})\b/g;
  const seen = new Map<string, ExtractedTerm>();

  let m: RegExpExecArray | null;
  while ((m = phraseRe.exec(body)) !== null) {
    const phrase = m[1].trim();
    const key = phrase.toLowerCase();
    if (NOUN_STOP_PHRASES.has(key)) continue;
    if (seen.has(key)) continue;
    seen.set(key, {
      id: key,
      display: phrase,
      source: "noun",
      snippet: snippetAround(body, m.index, phrase.length, snippetChars),
    });
  }
  while ((m = acronymRe.exec(body)) !== null) {
    const acronym = m[1];
    if (ACRONYM_STOPLIST.has(acronym)) continue;
    const key = acronym.toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, {
      id: key,
      display: acronym,
      source: "noun",
      snippet: snippetAround(body, m.index, acronym.length, snippetChars),
    });
  }
  return Array.from(seen.values());
}

function snippetAround(
  text: string,
  start: number,
  length: number,
  windowChars: number,
): string {
  const half = Math.floor(windowChars / 2);
  const from = Math.max(0, start - half);
  const to = Math.min(text.length, start + length + half);
  const prefix = from > 0 ? "…" : "";
  const suffix = to < text.length ? "…" : "";
  return (
    prefix + text.slice(from, to).replace(/\s+/g, " ").trim() + suffix
  );
}
