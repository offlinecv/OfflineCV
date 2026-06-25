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
 * Cap on noun-pass hits surfaced per JD. Before the cap is applied the caller
 * ranks the hits by a cheap deterministic informativeness score
 * (`rankNounHits`) and keeps the top `NOUN_PASS_CAP` — not the first-N in
 * document order. Ranking is needed because a JD that opens with a marketing
 * paragraph buries the informative phrases below 25 capitalized company-fluff
 * phrases; a document-order slice would drop the signal and keep the noise.
 * The overflow past the cap is recorded as `nounsDropped`. A
 * capitalization-heavy paragraph can produce 50+ noisy noun phrases; surfacing
 * them all would drown the Missing column. Empirically, typical tech JDs land
 * at <10 noun-phrase hits after the skill-overlap filter, so a 25-cap leaves
 * comfortable headroom while protecting the UI from outliers.
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
  // Marketing / company-fluff phrases that capitalized openers love but that
  // carry no skill signal. Filtered out in `extractNounPass`, so they never
  // reach the ranker — kept here (not a parallel list) per the noun-pass
  // stoplist convention. Extend with more weak-filler phrases as JDs surface
  // them rather than starting a second list.
  "our customers",
  "our clients",
  "our partners",
  "our employees",
  "our offices",
  "our headquarters",
  "the world",
  "the future",
  "the industry",
  "the market",
  "the best",
  "join us",
  "learn more",
  "apply now",
  "our story",
  "about us",
]);

/**
 * JD *structural* section headings the noun-phrase regex would otherwise
 * surface as "keywords" — e.g. "Minimum Qualifications", "Physical Demands",
 * "Essential Functions" (#156). These describe the JD's own document
 * structure, not a competency, so listing them as "missing from your resume"
 * is noise — nobody writes "Physical Demands" on a resume. They are filtered
 * out of the noun pass entirely (before ranking, so they can't even win a
 * requirements-section bonus).
 *
 * This only touches the noun pass: a phrase that is a real dictionary skill
 * comes through the skill pass and is never subject to this list, so we can be
 * aggressive here without dropping genuine competencies.
 *
 * Two layers:
 *   - `SECTION_HEADING_STOP_PHRASES` — exact lowercased headings whose tail
 *     word is ambiguous (e.g. "Essential Functions": "functions" alone would
 *     also drop the "Cloud Functions" / "Lambda Functions" skills, so the
 *     heading is listed in full instead).
 *   - `SECTION_HEADING_TAIL_WORDS` — structural nouns that, as the LAST word of
 *     a captured phrase, mark it a heading regardless of the leading adjective
 *     ("Minimum/Preferred/Basic/Required … Qualifications"; "Key/Primary/Core …
 *     Responsibilities"). No real skill phrase ends in one of these, so the
 *     tail guard catches the open-ended adjective families without enumeration.
 */
const SECTION_HEADING_STOP_PHRASES = new Set<string>([
  // Summary / overview / description / title headers
  "job summary",
  "job description",
  "job overview",
  "job details",
  "job title",
  "job type",
  "job location",
  "job posting",
  "job function",
  "job functions",
  "position summary",
  "position overview",
  "position description",
  "position details",
  "role overview",
  "role summary",
  "role description",
  "company overview",
  "company description",
  "company background",
  "team overview",
  // "Essential functions" family — tail "functions" is deliberately NOT a
  // tail-word (protects the Cloud/Lambda Functions skills), so list it in full.
  "essential functions",
  "essential job functions",
  // Process / apply headers
  "how to apply",
  "to apply",
  "application process",
  "application instructions",
  "application deadline",
  "hiring process",
  "interview process",
  "selection process",
  // Framing headers ("about us" / "what we offer" handled by NOUN_STOP_PHRASES
  // and BOILERPLATE_ANCHORS respectively)
  "what you",
  "who you are",
  "who we are",
  "what we do",
  "what to expect",
  "why join us",
  "why work here",
  "about the role",
  "about the team",
  "about the company",
  "about the position",
  "about the job",
  "about you",
  "about the opportunity",
  // Logistics headers
  "reports to",
  "direct reports",
  "employment type",
  "work schedule",
  "work location",
  "start date",
  "compensation package",
  "benefits package",
  "working conditions",
  "work environment",
  "working environment",
]);

/**
 * Structural nouns that mark a captured phrase as a JD section heading when
 * they are its LAST word — see `SECTION_HEADING_STOP_PHRASES`. "functions" is
 * intentionally excluded (would swallow "Cloud Functions" / "Lambda
 * Functions"); those headings are listed in full above instead.
 */
const SECTION_HEADING_TAIL_WORDS = new Set<string>([
  "qualifications",
  "responsibilities",
  "requirements",
  "demands",
  "duties",
]);

/** True when a captured noun phrase is a JD structural heading (#156) rather
 *  than a competency — by exact match or by its structural tail word. */
function isSectionHeading(keyLower: string): boolean {
  if (SECTION_HEADING_STOP_PHRASES.has(keyLower)) return true;
  const lastWord = keyLower.slice(keyLower.lastIndexOf(" ") + 1);
  return SECTION_HEADING_TAIL_WORDS.has(lastWord);
}

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

  const ranked = rankNounHits(allNouns, body);
  const nouns = ranked.slice(0, NOUN_PASS_CAP);
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
 * blank line as the end of a boilerplate block).
 *
 * Tradeoff: matching is line-granular, so a line that mixes an anchor
 * with real skill copy (e.g. "Salary range: $100k. We use Rust and Go.")
 * is over-stripped — the real skills are lost with the boilerplate. Rare
 * in practice (anchors usually live on their own line or start a block),
 * and worth the simplicity for v1. A sentence-granular pass would fix
 * this if it shows up in real JDs.
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
      // A blank line ends any active boilerplate block, and is itself kept
      // so paragraph boundaries survive into the matched body.
      if (skipping) skipping = false;
      kept.push("");
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
      display: index.idToLabel.get(id) ?? id,
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
    // Drop JD structural section headings ("Minimum Qualifications",
    // "Physical Demands", …) — document structure, not a competency (#156).
    if (isSectionHeading(key)) continue;
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

/**
 * Headings that mark the start of a requirements / qualifications block. A
 * noun phrase that recurs inside one of these blocks is stronger evidence of a
 * real requirement than the same phrase in a marketing opener, so the ranker
 * weights requirements-portion hits extra.
 */
const REQUIREMENTS_HEADING_RE =
  /\b(requirements?|qualifications?|you'?ll have|what you bring|what we'?re looking for|must have|nice to have)\b/i;

/**
 * Carve out the "requirements / qualifications" portion of the body, if any.
 * Heuristic: from the first line whose text matches `REQUIREMENTS_HEADING_RE`
 * to the end of the body. Cheap and deterministic — we don't try to find the
 * block's end, since over-including only dilutes the bonus slightly. Returns
 * the lowercased portion (or "" when no such heading exists) for substring
 * counting.
 */
function requirementsPortion(body: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => REQUIREMENTS_HEADING_RE.test(line));
  if (start === -1) return "";
  return lines.slice(start).join("\n").toLowerCase();
}

/**
 * Count case-insensitive, whole-phrase occurrences of `phrase` in `haystack`
 * (already lowercased). Word-boundary anchored so "Go" doesn't match "Google".
 */
function countOccurrences(haystackLower: string, phraseLower: string): number {
  if (!phraseLower) return 0;
  const escaped = phraseLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "g");
  const matches = haystackLower.match(re);
  return matches ? matches.length : 0;
}

/**
 * Rank noun-pass hits by a cheap deterministic informativeness score so the
 * cap surfaces the most central phrases instead of the first-N in document
 * order. Signals:
 *   - body frequency: more occurrences across the JD → more central.
 *   - requirements-portion frequency: occurrences inside a
 *     requirements/qualifications block count extra (weight 2), since that's
 *     where real must-haves live rather than marketing copy.
 * Weak-filler phrases are already removed by `NOUN_STOP_PHRASES` upstream, so
 * they never reach the ranker — no double-filter here.
 *
 * The sort is stable: ties keep the input's document order, so a JD with no
 * repetition degrades gracefully to the prior first-N behavior.
 */
export function rankNounHits(
  hits: readonly ExtractedTerm[],
  body: string,
): ExtractedTerm[] {
  const bodyLower = body.toLowerCase();
  const reqLower = requirementsPortion(body);
  const scored = hits.map((hit, index) => {
    const key = hit.display.toLowerCase();
    const bodyHits = countOccurrences(bodyLower, key);
    const reqHits = reqLower ? countOccurrences(reqLower, key) : 0;
    const score = bodyHits + 2 * reqHits;
    return { hit, index, score };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.hit);
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
