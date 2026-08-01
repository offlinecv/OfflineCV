// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
const BOILERPLATE_ANCHORS: readonly string[] = [
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
const NOUN_PASS_CAP = 25;

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
  // The outcomes-framing heading family. Observed leaking from a live JD as
  // the term "What Success Looks Like" — a heading over the requirements it
  // introduces, so it is exactly the #156 case, and no résumé will ever
  // "cover" it.
  "what success looks like",
  "what success means",
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
  // "… Experience" section headers (resume + JD section names, #156). Listed
  // exactly rather than via a tail word: "experience" alone would wrongly drop
  // real competency phrases ("User Experience", "Customer Experience",
  // "Developer Experience"). The first three mirror the issue's own examples.
  "work experience",
  "additional experience",
  "performance experience",
  "involvement experience",
  "professional experience",
  "relevant experience",
  "industry experience",
  "prior experience",
  "previous experience",
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

/**
 * Words that, as the FIRST word of a captured noun phrase, mark it a sentence
 * or title opener rather than a competency: articles, prepositions,
 * conjunctions and pronouns. The phrase regex requires every word to be
 * capitalized, so these only fire sentence-initially or in a title — exactly
 * where the capture is a fragment.
 *
 * Observed on a live Apple posting: *"**At Apple**, new ideas…"* and *"**As
 * Senior Software Engineering** Manager, you will…"* both became requirement
 * terms, the second truncated mid-phrase by the 4-word cap. No résumé covers
 * either, so each one is pure denominator.
 *
 * Note this is NOT the same guard as {@link ACRONYM_STOPLIST}, which contains
 * several of the same words: that set governs the all-caps ACRONYM regex only.
 * The two regexes are independent, so the stoplist did nothing for "At Apple".
 */
const LEADING_FUNCTION_WORDS = new Set<string>([
  "the",
  "an",
  "as",
  "at",
  "in",
  "on",
  "of",
  "for",
  "to",
  "by",
  "with",
  "from",
  "and",
  "or",
  "but",
  "if",
  "this",
  "these",
  "those",
  "we",
  "you",
  "your",
  "our",
  "it",
  "is",
  "are",
]);

/** True when a captured noun phrase leads with a function word — see
 *  {@link LEADING_FUNCTION_WORDS}. */
function hasLeadingFunctionWord(keyLower: string): boolean {
  const first = keyLower.slice(0, keyLower.indexOf(" "));
  return LEADING_FUNCTION_WORDS.has(first);
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
  // Degree abbreviations. "BS or MS in Computer Science" is a real requirement,
  // but the CREDENTIAL half of it carries no matchable signal — the field of
  // study does, and it is captured separately as its own phrase. Left as terms
  // they are two more entries no résumé projection will ever contain (the
  // parser stores "Bachelor of Technology", never "BS"), so they are pure
  // denominator. MBA is deliberately absent: it is a specific, matchable
  // credential rather than a generic level marker.
  "BS",
  "BA",
  "MS",
  "MA",
  "BSC",
  "MSC",
]);

export interface ExtractOptions {
  /** Override the snippet length. Default 80. */
  snippetChars?: number;
  /**
   * The posting's own title, when the caller knows it. A posting cannot be
   * evidence for itself: noun-pass phrases contained in the title are the job's
   * IDENTITY, not its requirements, so they are dropped from the term list.
   *
   * Observed on a live Apple posting titled "Senior Engineering Manager, Info
   * Apps": both `Senior Engineering Manager` and `Info Apps` (the team name)
   * entered the coverage denominator, which no résumé can ever cover — the
   * candidate is penalized for the posting having a name.
   *
   * Scoped to the NOUN pass on purpose. A title naming a real technology
   * ("Senior Rust Engineer") is caught by the skill pass, which this never
   * touches, and the noun pass already drops any hit the skill dictionary
   * knows — so a genuine title skill survives while the job-identity phrases go.
   */
  postingTitle?: string;
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
  const titleLower = (options.postingTitle ?? "").toLowerCase();

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
    // Drop the posting's own title/team words — see `ExtractOptions.postingTitle`.
    // Word-boundary anchored so "Eng" inside "Engineering" is not a title hit.
    if (titleLower && countOccurrences(titleLower, lower) > 0) return false;
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

/**
 * Longest alias length that is short enough to collide with an unrelated
 * acronym. Only `js`, `ts`, `c#` and `d3` are this short today, and only they
 * are subject to the slash-compound guard below — a longer alias ("java",
 * "rust") carries enough signal that a compound hit is almost certainly real.
 */
const SHORT_ALIAS_MAX_LEN = 2;

/** Token characters an alias can be built from — the set `escapeRegex`'d into
 *  the alias pattern, so a compound neighbour is read with the same alphabet
 *  the dictionary uses (`c++`, `.net`, `react.js`). */
const ALIAS_TOKEN_RE = /[A-Za-z0-9#+.]+/;

/**
 * Is a SHORT alias hit inside a slash compound whose other side is not itself
 * a known skill?
 *
 * `/` is a word boundary in `ALIAS_BOUNDARY_PREFIX`/`SUFFIX`, and it has to be:
 * "JS/TS" is how résumés write two real skills, and dropping slash boundaries
 * would lose it. But the same boundary makes a security clearance read as a
 * language — **"Active TS/SCI Clearance" matched the `ts` alias and reported
 * TypeScript**, observed on a live defense JD where TypeScript appears nowhere.
 * That is a false POSITIVE in the user's favour, which is worse than a miss: it
 * credits a résumé for a skill the posting never asked for.
 *
 * The discriminator is the other side of the slash. In "JS/TS" it is itself an
 * alias; in "TS/SCI" it is not. So a short alias in a compound is kept only
 * when its neighbour is also in the dictionary — which preserves every
 * legitimate compound without enumerating clearance jargon we would never
 * finish listing (TS/SCI, NOFORN, JADC2 …).
 *
 * Scope, deliberately: this covers the COMPOUND only. A bare "TS clearance"
 * still reads as TypeScript, because the only thing distinguishing it from a
 * résumé's bare "TS" is domain knowledge this module does not have. Narrowing
 * that would need either a clearance-phrase list (unbounded) or dropping the
 * two-letter aliases outright (loses real résumé hits) — neither is worth it
 * for a case the compound guard already covers in its common form.
 */
function isForeignSlashCompound(
  body: string,
  aliasStart: number,
  aliasLen: number,
  aliasToId: ReadonlyMap<string, string>,
): boolean {
  const before = body.slice(0, aliasStart);
  const after = body.slice(aliasStart + aliasLen);

  const neighbour = before.endsWith("/")
    ? ALIAS_TOKEN_RE.exec(
        before.slice(0, -1).split(/[^A-Za-z0-9#+.]/).pop() ?? "",
      )?.[0]
    : after.startsWith("/")
      ? ALIAS_TOKEN_RE.exec(after.slice(1))?.[0]
      : undefined;

  return neighbour !== undefined && !aliasToId.has(neighbour.toLowerCase());
}

/**
 * Words that can open a direct object, and so mark the word before them as a
 * transitive VERB rather than the tail of a noun phrase.
 */
const DIRECT_OBJECT_OPENERS = new Set<string>([
  "a",
  "an",
  "the",
  "some",
  "our",
  "its",
  "their",
  "his",
  "her",
  "this",
  "these",
  "those",
  "several",
  "many",
  "multiple",
]);

/**
 * Is a multi-word alias ending in a GERUND actually a verb phrase here?
 *
 * Observed: the `team-building` alias `"team building"` matched *"lead a
 * high-performing engineering **team building** some of Apple's most beloved
 * apps"* — where "team" is the tail of "engineering team" and "building" opens
 * a verb phrase. The alias straddles two constituents and reports a competency
 * the posting never asked for. Same family as the TS/SCI false positive above,
 * and judged the same way: a bogus requirement is worse than a missed one,
 * because it enters the coverage denominator no résumé can cover.
 *
 * The discriminator is what FOLLOWS. A gerund used as a verb takes a direct
 * object, which opens with a determiner or quantifier ("building **some** of
 * Apple's apps"); the competency reading does not ("team building and
 * mentorship", "strong team building skills", end of clause). So the guard
 * fires only on a directly-following determiner, which leaves every ordinary
 * usage of the alias intact.
 */
function isGerundVerbUsage(
  body: string,
  matchedAlias: string,
  aliasStart: number,
  aliasLen: number,
): boolean {
  const lastWord = matchedAlias.slice(matchedAlias.lastIndexOf(" ") + 1);
  if (lastWord === matchedAlias || !lastWord.endsWith("ing")) return false;
  const next = /^\s+([A-Za-z']+)/.exec(body.slice(aliasStart + aliasLen));
  return next !== null && DIRECT_OBJECT_OPENERS.has(next[1].toLowerCase());
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
    if (
      matchedAlias.length <= SHORT_ALIAS_MAX_LEN &&
      isForeignSlashCompound(body, aliasStart, m[1].length, index.aliasToId)
    ) {
      continue;
    }
    if (isGerundVerbUsage(body, matchedAlias, aliasStart, m[1].length)) continue;
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
    // Drop sentence/title openers ("The Summer Music Intern", "At Apple", "As
    // Senior Software Engineering") — the capitalized run after a leading
    // function word is almost always a title or sentence subject, not a skill
    // (#156). Real skill phrases don't lead with an article or preposition.
    if (hasLeadingFunctionWord(key)) continue;
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
function rankNounHits(
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
