// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * term-quality.ts — judges every term of a `JobQuery` (#584): which of the
 * user's own titles and skills carry weight, and which high-value terms for
 * their role the résumé never uses.
 *
 * WHY THIS MODULE EXISTS. Three separate surfaces ask the same three questions
 * — *which of my titles is a good search term*, *which of my skills are pulling
 * weight*, *what am I missing* — so the judgement lives in one pure module and
 * the surfaces render it. The copy in `reason` is part of that: it is written
 * here, once, and shown verbatim, so `/jobs/` and `/` cannot describe the same
 * chip differently.
 *
 * THE CONSTRAINT THIS GUARDS: **never tell a user a real term is worthless.**
 * A false "noise" or "weak" verdict is not a cosmetic miss — it invites someone
 * to delete a term that was working. Three rules follow from that and are the
 * reason the code is shaped the way it is:
 *
 *  1. NOTHING IS JUDGED WITHOUT A BASIS. When no role profile resolves, this
 *     returns NO verdict at all for terms whose quality depends on the role —
 *     not a defaulted "weak". Only the role-independent noise verdicts survive,
 *     because those are true regardless of who the candidate is. `missing` is
 *     `[]` for the same reason: inventing "you're missing X" for a role we could
 *     not identify is worse than saying nothing. A surface renders an
 *     unjudged term as a plain chip; absence of a verdict is the honest state
 *     and consumers MUST treat it that way rather than substituting a default.
 *  2. THE EXPECTED SET IS THE UNION OF EVERY RESOLVED PROFILE, from BOTH
 *     resolvers. A résumé is usually more than one facet — an EM who was an ML
 *     engineer has both, and judging their PyTorch against the manager profile
 *     alone would call a sharp, narrowing term "weak". Resolving by skills too
 *     costs nothing in false-strongs, because `resolveProfilesBySkills` needs
 *     two hits before it reports anything: a lone off-role tool still reads as
 *     weak, while a coherent off-role cluster reads as the real second facet it
 *     is. This does NOT preempt the title/skill coherence check — that compares
 *     the two resolvers' answers independently, which is exactly why
 *     `role-profiles.ts` keeps them separate.
 *  3. `missing` COMES FROM ONE PROFILE, not the union. Profiles are per-rung, so
 *     unioning would hand a manager a director's titles — advice that reads as
 *     "apply one level up" when we meant "here is what your role is called".
 *
 * DERIVED, NOT INVENTED. Every input is an asset that already ships. "Noise" is
 * whatever `search.ts` already refuses to admit postings on, read through the
 * shared rules in `query-terms.ts`; "strong"/"weak"/"missing" come from
 * `role-profiles.ts` and its own matching predicates. This module adds no fourth
 * vocabulary and no second copy of either rule — if it did, the explanation
 * would drift from the behaviour it claims to explain.
 *
 * NOISE OUTRANKS STRONG, deliberately. `Go` is a canonical backend skill AND a
 * bare two-char token the admission filter drops, so it is reported as noise:
 * admission happens upstream of relevance, and a term that admits nothing
 * narrows nothing no matter how apt it is. The copy is scoped to that
 * consequence ("can't narrow your results") and never says the skill does not
 * belong on the résumé — because it does, it still renders as a chip, and it
 * still reaches the deep links.
 *
 * STRONG NEEDS EVIDENCE; WEAK NEEDS STANDING. The two skill verdicts are NOT
 * two halves of one boolean, and treating them as one is what let this module
 * violate its own constraint. "Strong" is a positive claim — this term is one
 * the role expects — and any term that demonstrably matches an expected skill
 * earns it. "Weak" is the destructive claim — *this term is not what your role
 * is hired on* — and it may only be said about a term we are entitled to judge:
 * a CANONICAL skill name, one the shared dictionary knows. A free-text résumé
 * phrase ("Team Building & Mentorship") is not a canonical name, so a failure to
 * match it proves nothing about the term and everything about our vocabulary; it
 * gets NO verdict, exactly like rule 1's unresolved role. Before this asymmetry
 * existed, nine of eleven skills on a leadership résumé whose role resolved
 * confidently were marked weak — including "Engineering Leadership" and "Hiring
 * & Talent Acquisition".
 *
 * WHICH SKILLS ARE CANONICAL ARRIVES AS DATA, on `JobQuery.canonicalSkills`,
 * because this module must not gain a runtime import of jd-match (see the
 * boundary note below). `undefined` there means NOT ASSERTED — a hand-built or
 * storage-restored query — and is read as "no standing to call anything weak",
 * never as "nothing is canonical, so everything is weak". That is the only
 * reading of absent data that cannot resurrect the false-weak bug; the cost is
 * silence on a query nobody annotated, which is the honest state.
 *
 * MATCHING IS WORD-WISE, NOT KEY-EQUAL (`skillCovers`). A canonical id is one
 * concept; a résumé phrase is often several ("Team Building & Mentorship"), and
 * comparing whole normalized keys makes the two never equal. The same predicate
 * answers both questions that need it — *is this chip strong* and *does the
 * query already carry this expected skill* — so a term can never be suggested
 * and marked at odds with itself. It is deliberately word-level, never
 * substring: "javascript" is one word and so never covers "java".
 *
 * CLASSIFIES ONLY. Nothing here mutates a query or removes a term. Removal is a
 * user action on a surface, always.
 *
 * THE COHERENCE CHECK (#587) IS A FOURTH JUDGEMENT, and the strictest one. It
 * compares the two resolvers' answers — what the person calls themselves vs what
 * their evidence describes — and reports a leadership/IC axis disagreement. It
 * deliberately does NOT read the union rule 2 builds: the union exists to stop a
 * genuine second facet reading as weak, and folding it in here would erase the
 * very disagreement this looks for. Its false-positive cost is higher than any
 * verdict's — "your résumé does not match your titles" is a claim about the
 * document, not about one chip — so it clears four gates, not one; see
 * `assessCoherence`.
 *
 * NO jd-match RUNTIME IMPORT, the same boundary `role-profiles.ts` draws. Two
 * consequences for callers: `query.skills` are expected to be the canonical
 * labels `buildJobQuery` already produces (a raw alias like "k8s" is nobody's
 * canonical id and would read as unexpected), and `MissingTerm.term` for a skill
 * is a canonical jd-match id (`ci-cd`), not a display label — a surface wanting
 * "CI/CD" maps it through jd-match's `getSkillIndex().idToLabel`.
 */

import type { JobQuery } from "./query-builder.ts";
import type { RoleFamily } from "./role-keywords.ts";
import {
  isAdmittingTitleTerm,
  isSignificantSkillTerm,
  titleNoiseTokens,
  titleTokens,
} from "./query-terms.ts";
import {
  normalizeSkillKey,
  profileTitleMatches,
  resolveProfilesBySkills,
  resolveProfilesByTitles,
  type RoleProfile,
} from "./role-profiles.ts";

/**
 * Version of THIS MODULE'S classification rules + the copy they emit. Bump when
 * a change here can move what `assessQueryTerms` returns for the same query — a
 * rule change, a cap change, or a `reason` rewrite (the strings are
 * user-visible).
 *
 * DELIBERATELY NOT A VERSION OF THE ANSWER. The output is also a function of the
 * upstream data this module reads — chiefly `ROLE_PROFILES`, whose `titles` /
 * `skills` ORDER decides which terms survive `MAX_MISSING_TITLES` /
 * `MAX_MISSING_SKILLS`, and which since #588 is prevalence-ranked from a
 * regenerable snapshot. Folding that into this number would mean bumping it on
 * every mining run with no rule changed, which makes it useless as a marker of
 * "the rules moved". That data carries its own versions and this one does not
 * shadow them: reproduce an answer from the pair `TERM_QUALITY_VERSION` +
 * `ROLE_PROFILES_VERSION`, plus `PREVALENCE_SNAPSHOT.generatedAt` for the exact
 * ordering. #588 accordingly bumped `ROLE_PROFILES_VERSION` (1.0 → 1.1) and left
 * this at 1.2.
 *
 * Changelog:
 * - 1.0 (2026-07-25): initial classifier (#584).
 * - 1.1 (2026-07-25): title/skill coherence finding (#587) — an added optional
 *   `coherence` field; no existing field changed shape or value.
 * - 1.2 (2026-07-25): a skill verdict now needs standing before it can read
 *   "weak" (`query.canonicalSkills`), skill matching is word-wise rather than
 *   key-equal, and a `missing` entry is suppressed when the query already
 *   covers it. Moves verdicts (weak → none, none → strong) and drops
 *   suggestions for the same query; no field changed shape.
 */
export const TERM_QUALITY_VERSION = "1.2";

export type TermQuality =
  /** Canonical for the resolved role — a market term that narrows well. */
  | "strong"
  /** Recognized but weak: too generic, or peripheral to the resolved role. */
  | "weak"
  /** Not a role signal at all — geography, employer, or a token below the
   *  significance gate that contributes nothing to admission. */
  | "noise";

export interface TermVerdict {
  /** The term verbatim as it appears in the query (and as the chip renders). */
  readonly term: string;
  readonly kind: "title" | "skill";
  readonly quality: TermQuality;
  /** One short user-facing consequence — never the mechanism. Rendered as-is;
   *  no issue numbers, no "tokenizer", no "admission filter". */
  readonly reason: string;
}

export interface MissingTerm {
  /** A high-value term for the resolved role that the résumé does not use.
   *  For `kind: "skill"` this is a canonical jd-match id, not a display label
   *  (module docblock). */
  readonly term: string;
  readonly kind: "title" | "skill";
}

/** Which way round a coherence disagreement runs. */
export type CoherenceDirection =
  /** Leadership titles, exclusively individual-contributor skills. */
  | "leadership-titles-ic-skills"
  /** Individual-contributor titles, exclusively people-leadership skills. */
  | "ic-titles-leadership-skills";

/**
 * A CONFIDENT title/skill disagreement (#587). Present only when every gate in
 * {@link assessCoherence} cleared; its absence is the overwhelmingly common —
 * and correct — case, and means nothing about the résumé.
 */
export interface CoherenceFinding {
  readonly direction: CoherenceDirection;
  /** The query's own titles that resolved the title side, verbatim, capped at
   *  {@link MAX_NAMED_TITLES}. Never empty. */
  readonly titles: readonly string[];
  /** The query's own skills that back the OTHER side of the axis, verbatim.
   *  Length is the evidence the threshold is measured in. */
  readonly offAxisSkills: readonly string[];
  /** Canonical jd-match ids the titles' own role expects and the query lacks —
   *  the competencies that would close the gap. Ids, not labels (module
   *  docblock); a surface wanting "People Management" maps them through
   *  jd-match's `getSkillIndex().idToLabel`. */
  readonly missingSkills: readonly string[];
  /** The one user-facing sentence, written here so `/jobs/` and `/` cannot
   *  describe the same finding differently. Consequence only, no mechanism. */
  readonly note: string;
}

export interface QueryTermAssessment {
  /** One verdict per judgeable term, query order, titles before skills. A term
   *  with NO verdict was not judgeable — see rule 1 in the module docblock. */
  readonly verdicts: readonly TermVerdict[];
  /** High-value terms for the resolved role that the query lacks. Always `[]`
   *  when no role resolved. */
  readonly missing: readonly MissingTerm[];
  /** A confident title/skill mismatch, or `undefined` — which is the normal
   *  state and must render as nothing at all, never as an "all clear". */
  readonly coherence?: CoherenceFinding;
}

// ── Copy ────────────────────────────────────────────────────────────────────
// Consequence only. These strings ship to the user unchanged on two surfaces,
// so they carry no mechanism vocabulary and no internal noun — a reader must
// never need to know what a token, a gate or a profile is. `term-quality.test.ts`
// asserts the absence of that vocabulary; keep new entries inside the same rule.

const REASONS = {
  /** The title's every word is a place or a former employer. */
  titleNoisePlace: "Names a place or an employer, so it won't find roles.",
  /** The title has no word long enough to search on at all. */
  titleNoiseEmpty: "Has no words a job search can look for.",
  titleStrong: "A title employers post, so it narrows your results.",
  titleWeak: "Not a common posting title for this role, so it finds fewer jobs.",
  skillNoise: "Too common as a search term to narrow your results.",
  skillStrong: "Expected for this role, so it sharpens your matches.",
  skillWeak: "Not what this role is usually hired on, so it adds little.",
} as const;

/**
 * The coherence sentence, per direction (#587). Takes the query's own titles so
 * the claim is anchored to words the user can see on screen rather than to an
 * abstraction. Same rule as `REASONS`: consequence only — what the postings
 * behind these titles ask for — never how the finding was reached.
 */
const COHERENCE_NOTES: Readonly<Record<CoherenceDirection, (titles: string) => string>> = {
  "leadership-titles-ic-skills": (titles) =>
    `You're searching with leadership titles (${titles}), but every skill you list is a hands-on technical one. Postings for these titles usually ask for people management, hiring, and roadmap ownership.`,
  "ic-titles-leadership-skills": (titles) =>
    `You're searching with individual-contributor titles (${titles}), but every skill you list is a people-leadership one. Postings for these titles usually ask for hands-on depth in specific languages and tools.`,
};

// ── Caps ────────────────────────────────────────────────────────────────────
// Small on purpose: `missing` is advice, and a list of fifteen things a résumé
// "should" say is not advice. Both lists are already most-expected-first in
// `ROLE_PROFILES`, so the cap keeps the head and drops the tail.
//
// That "already most-expected-first" is where these caps meet #588: for the
// profiles whose evidence cleared the prevalence gates the head is measured, and
// for the rest it is the curator's ordering. Either way the caps read POSITION,
// so a change to `ROLE_PROFILES`' ordering changes which terms ship as advice
// without changing a single rule in this module.
//
// `MAX_MISSING_SKILLS` is exported for the tests only: a test that needs a
// profile short enough that nothing falls out of the head has to be able to
// assert that precondition rather than assume it, or a sixth curated skill
// voids it silently.

const MAX_MISSING_TITLES = 3;
export const MAX_MISSING_SKILLS = 5;

/** How many of the query's own titles the coherence sentence names before it
 *  stops listing — a sentence quoting six titles is not readable. */
const MAX_NAMED_TITLES = 3;

// ── The coherence threshold (#587) ──────────────────────────────────────────

/**
 * THE THRESHOLD. How many of the query's OWN SKILLS must sit on the wrong side
 * of the leadership/IC axis before the disagreement is reported at all.
 *
 * Unit: distinct skills in `query.skills` (deduped by `normalizeSkillKey`) that
 * a role on the *skill-resolved* side is normally described with. Countable by
 * hand from the chips on screen — that is the point of choosing skills as the
 * unit rather than an opaque score.
 *
 * Why 4. `resolveProfilesBySkills` already refuses to name a role on fewer than
 * two shared skills, because one is a coincidence. Four is double that floor:
 * one cluster is a role, two clusters' worth is a *shape*, and only a shape
 * justifies telling someone their document disagrees with itself. Concretely,
 * it is what separates an engineer who lists "Coaching" and "Team Building"
 * beside nothing else (2 — silent) from one whose entire skills row is people
 * management (5+ — reported).
 *
 * Raising it makes this quieter and never wronger; lowering it below the
 * resolver's own floor of 2 would let a single coincidental pair speak.
 */
const MIN_OFF_AXIS_SKILLS = 4;

/**
 * The one `RoleFamily` that means *running* an engineering organisation rather
 * than building inside one. This is READ from the shipped taxonomy, not a second
 * hand-maintained list of which roles are "leadership": every leadership rung in
 * `ROLE_PROFILES` already declares this family and no IC profile does, so the
 * axis cannot drift from the table. Typed as `RoleFamily` on purpose — renaming
 * the family in `role-keywords.ts` breaks the build here instead of silently
 * turning this check off.
 *
 * `pm` is deliberately NOT here. A product or program manager leads work, not an
 * engineering org, and their expected skills overlap both sides; counting them as
 * leadership would fire on every PM résumé that lists SQL.
 */
const LEADERSHIP_FAMILY: RoleFamily = "eng-leadership";

/**
 * Trimmed, non-blank, case-insensitively deduped terms in input order. Runtime
 * non-strings are dropped rather than coerced: `assessQueryTerms` is total on
 * any `JobQuery` shape, including one built by hand or restored from storage,
 * and a stray `null` chip should vanish rather than become the verdict `"null"`.
 */
function cleanTerms(raw: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw ?? []) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

// ── Skill matching (word-wise) ──────────────────────────────────────────────

/**
 * Words that carry no skill signal, dropped so "Coaching and Mentorship" and
 * "Coaching & Mentorship" are the same phrase. Same shape and reasoning as
 * `role-profiles.ts`'s title stop words, and kept just as short: every word
 * removed is a word the subset rules below can no longer tell two skills apart
 * with.
 */
const SKILL_STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "at", "for", "in", "of", "on", "or", "the", "to", "with",
]);

/**
 * The separators a résumé uses to cram several concepts into one skill entry.
 * Splitting on them is what lets "Team Building & Mentorship" be read as the two
 * skills it names rather than one skill nobody has.
 *
 * `+` is deliberately NOT one: it would tear "C++" into a bare "c", and it buys
 * nothing — clause 2 already reads `react` out of an unsplit "React + Redux",
 * since an expected skill only has to be contained in the concept.
 */
const SKILL_CONCEPT_SEPARATORS = /\s*(?:&|\/|,|\band\b)\s*/i;

/** One skill concept: its canonical key, its words in order, and their set. */
interface SkillPhrase {
  readonly key: string;
  readonly words: readonly string[];
  readonly set: ReadonlySet<string>;
}

function skillPhrase(raw: string): SkillPhrase {
  const words = String(raw)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !SKILL_STOP_WORDS.has(word));
  return { key: normalizeSkillKey(raw), words, set: new Set(words) };
}

/** The concepts one query skill names — one for an ordinary skill, several for
 *  a multi-concept résumé phrase. Empty concepts (a trailing "&") are dropped. */
function skillConcepts(raw: string): SkillPhrase[] {
  return String(raw)
    .split(SKILL_CONCEPT_SEPARATORS)
    .map(skillPhrase)
    .filter((phrase) => phrase.words.length > 0);
}

/** True when every member of `needle` is in `haystack`. Empty needle ⇒ false —
 *  an empty set is a subset of everything, which here would match everything. */
function isSubsetOf(needle: ReadonlySet<string>, haystack: ReadonlySet<string>): boolean {
  if (needle.size === 0 || needle.size > haystack.size) return false;
  for (const word of needle) {
    if (!haystack.has(word)) return false;
  }
  return true;
}

/**
 * THE SKILL-MATCHING RULE: does the query skill `skill` carry the expected
 * canonical skill `expected`? Two consumers read it — a chip matching something
 * expected is "strong", and an expected term the query already carries is not
 * "missing" — so a term can never be suggested and marked at odds with itself.
 *
 * Three ways to match, narrowest first. Each is a separate claim, and each was
 * chosen against a specific wrong answer:
 *
 *  1. SAME KEY. `normalizeSkillKey` equality — "CI/CD" is `ci-cd`. This is the
 *     pre-existing rule and must stay FIRST: concept splitting would otherwise
 *     tear "CI/CD" into `ci` and `cd` and lose the match it already had.
 *  2. SPELLED OUT INSIDE A CONCEPT (`expected ⊆ concept`). "Team Building &
 *     Mentorship" carries `team-building`; "AWS Lambda" carries `aws`. The
 *     concept may say MORE than the expected skill; it may not say less.
 *  3. THE SAME THING, LESS QUALIFIED (`concept ⊆ expected`, sharing the HEAD) —
 *     `allowLessQualified` only. "Mentorship" is what `coaching-mentorship` is
 *     about, so a résumé listing it is not missing that skill. The head word (the
 *     last — the noun a phrase is ABOUT) must be the shared one, which is what
 *     keeps "Performance Optimization" from covering `performance-management`:
 *     they share "performance", a qualifier, and disagree on the head. Without
 *     that guard any incidental shared word would suppress a real gap.
 *
 * WHY CLAUSE 3 IS OPT-IN, AND OFF FOR VERDICTS. It is a weaker claim than the
 * other two: the query term is a bare head noun, so it names the general activity
 * without the qualifier that makes the expected skill what it is ("Strategy" is
 * not "technical strategy"). That is enough to stop us telling someone to add
 * what they arguably already said — a suppressed suggestion costs nothing, the
 * cap back-fills — but not enough to tell them the term is "expected for this
 * role, so it sharpens your matches", which would be a false strong. The two
 * verdicts have different error costs, so they get different thresholds; the
 * shared clauses stay shared.
 *
 * Word-level throughout, never substring: "javascript" is one word, so it never
 * covers "java", and "mysql" never covers "sql". Total; never throws.
 */
function skillCovers(
  expected: SkillPhrase,
  skill: string,
  allowLessQualified: boolean,
): boolean {
  if (expected.key.length > 0 && expected.key === normalizeSkillKey(skill)) return true;
  if (expected.words.length === 0) return false;
  const head = expected.words[expected.words.length - 1];
  for (const concept of skillConcepts(skill)) {
    if (isSubsetOf(expected.set, concept.set)) return true;
    if (
      allowLessQualified &&
      expected.words.length > 1 &&
      concept.set.has(head) &&
      isSubsetOf(concept.set, expected.set)
    ) {
      return true;
    }
  }
  return false;
}

/** Clauses 1–2: strong enough to base a VERDICT on. */
function skillIsExpected(expected: SkillPhrase, skill: string): boolean {
  return skillCovers(expected, skill, false);
}

/** The expected canonical ids as phrases, deduped by key — the union of every
 *  resolved profile's skills, ready to match query chips against. */
function dedupePhrases(ids: readonly string[]): SkillPhrase[] {
  const seen = new Set<string>();
  const out: SkillPhrase[] = [];
  for (const id of ids) {
    const phrase = skillPhrase(id);
    if (phrase.key.length === 0 || seen.has(phrase.key)) continue;
    seen.add(phrase.key);
    out.push(phrase);
  }
  return out;
}

/** All three clauses, across the whole query: is this expected skill already
 *  said, in whatever words? The SUPPRESSION side of the rule. */
function anySkillCovers(expected: SkillPhrase, skills: readonly string[]): boolean {
  return skills.some((skill) => skillCovers(expected, skill, true));
}

/**
 * Whether a query title already covers an expected one, in EITHER direction —
 * the narrow near-identity relation, not a general similarity.
 *
 * Forward (`expected ⊆ résumé title`) is the pre-existing rule: "Senior
 * Engineering Manager, Payments" already says "engineering manager". Reverse
 * (`résumé title ⊆ expected`) is the fix: a résumé saying "Engineering Lead" was
 * being told to add "engineering team lead", a strictly wordier spelling of what
 * it already says. The reverse direction is safe precisely because the résumé
 * side must be a token SUBSET — the résumé already says a shorter version of the
 * same phrase, not merely a related one. "Sr. Engineering Manager" is NOT a
 * subset of "software engineering manager" (senior ≠ software), so that genuinely
 * different market phrasing still gets suggested, which is the point of the
 * advice.
 */
function titleCovers(expected: string, title: string): boolean {
  return profileTitleMatches(expected, title) || profileTitleMatches(title, expected);
}

/** Profiles from both resolvers, title answers first, deduped by id. */
function unionProfiles(
  byTitles: readonly RoleProfile[],
  bySkills: readonly RoleProfile[],
): RoleProfile[] {
  const seen = new Set<string>();
  const out: RoleProfile[] = [];
  for (const profile of [...byTitles, ...bySkills]) {
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    out.push(profile);
  }
  return out;
}

/**
 * The high-value terms `primary` expects that the query does not already carry.
 * "Already carry" is `titleCovers` / `skillCovers`, not string equality — see
 * those two and the note below. `undefined` primary ⇒ `[]` — the unresolved-role
 * contract.
 *
 * A suggestion also has to survive the SAME admission rules the verdicts apply.
 * `ROLE_PROFILES` legitimately carries canonical terms that narrow nothing —
 * `go` is a real backend skill and a token the search cannot filter on — and
 * telling someone to add a term we would immediately mark noise is advice that
 * does nothing. Whatever is suppressed here, the cap simply back-fills from the
 * next-most-expected entry, so suppression costs the advice nothing.
 *
 * "ALREADY CARRIES IT" IS NOT KEY EQUALITY, on either kind. Offering someone
 * "+ team building" while "Team Building & Mentorship" sits as a chip on the same
 * screen, or "+ engineering team lead" to someone titled "Engineering Lead",
 * reads as a broken product — and it was the same root cause both times: a
 * whole-string comparison cannot see a phrase that already says the thing.
 * `skillCovers` and `titleCovers` are the two relations, and both are shared with
 * the verdict pass rather than re-derived here.
 */
function missingTerms(
  primary: RoleProfile | undefined,
  titles: readonly string[],
  skills: readonly string[],
  noise: ReadonlySet<string>,
): MissingTerm[] {
  if (!primary) return [];
  const missing: MissingTerm[] = [];

  let titleCount = 0;
  for (const expected of primary.titles) {
    if (titleCount >= MAX_MISSING_TITLES) break;
    if (!titleTokens(expected).some((token) => isAdmittingTitleTerm(token, noise))) continue;
    if (titles.some((title) => titleCovers(expected, title))) continue;
    missing.push({ term: expected, kind: "title" });
    titleCount += 1;
  }

  let skillCount = 0;
  for (const expected of primary.skills) {
    if (skillCount >= MAX_MISSING_SKILLS) break;
    if (!isSignificantSkillTerm(expected.toLowerCase())) continue;
    if (anySkillCovers(skillPhrase(expected), skills)) continue;
    missing.push({ term: expected, kind: "skill" });
    skillCount += 1;
  }

  return missing;
}

/**
 * Which side of the leadership/IC axis a whole resolved side sits on, or
 * `undefined` when it sits on BOTH.
 *
 * "Both" is not a weak answer, it is a disqualifying one: a résumé that resolves
 * an engineering-manager AND a backend-engineer genuinely describes both, and the
 * mixed case covers the two shapes we most need to never accuse — the promoted
 * IC whose titles span the ladder, and the manager who kept their engineering
 * skills (rule 2's EM-who-was-an-ML-engineer). Reading only the top profile of
 * each side would report both of them.
 */
function sharedAxis(profiles: readonly RoleProfile[]): "leadership" | "ic" | undefined {
  if (profiles.length === 0) return undefined;
  const leadership = profiles.filter((profile) => profile.family === LEADERSHIP_FAMILY).length;
  if (leadership === profiles.length) return "leadership";
  if (leadership === 0) return "ic";
  return undefined;
}

/** Distinct canonical keys of `terms` that appear in `expected`. */
function overlap(terms: readonly string[], expected: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const key = normalizeSkillKey(term);
    if (seen.has(key) || !expected.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/**
 * The title/skill coherence check (#587): does what this person calls themselves
 * disagree with what their evidence describes?
 *
 * FOUR GATES, every one of which must clear. Each exists to kill a specific
 * false positive, because the cost of a wrong finding here is telling someone
 * their résumé is broken when it isn't:
 *
 *  1. BOTH SIDES RESOLVED. An unresolved side is ignorance, not evidence. A
 *     résumé whose titles we cannot place says nothing about its skills.
 *  2. NEITHER SIDE IS MIXED (`sharedAxis`). A person who is genuinely both is
 *     coherent — see that function.
 *  3. THE SIDES DISAGREE on the axis. Same axis ⇒ nothing to say, whatever the
 *     family: a frontend engineer whose skills read fullstack is not mismatched,
 *     and firing on that alone would make this a noise generator. Family-only
 *     disagreement is deliberately NOT reported (see the issue's "family or the
 *     leadership/IC axis" — we take the confident intersection).
 *  4. THE CLAIM IS LITERALLY TRUE AND NOT MARGINAL. "every skill you list is X"
 *     is only said when the query carries ZERO skills the titles' own role
 *     expects — one managerial skill on an engineer's résumé is enough to keep
 *     us quiet, and it lands in the gap gate 2 cannot see because the resolver
 *     needs two hits to name a role. And the other side must be backed by at
 *     least {@link MIN_OFF_AXIS_SKILLS} skills.
 *
 * A skill counts as evidence even when it is too generic to filter on ("go"):
 * this describes the SHAPE of the document, which is true regardless of what the
 * search can narrow with.
 *
 * Total and deterministic; returns `undefined` far more often than not, which is
 * the designed outcome.
 */
function assessCoherence(
  byTitles: readonly RoleProfile[],
  bySkills: readonly RoleProfile[],
  titles: readonly string[],
  skills: readonly string[],
): CoherenceFinding | undefined {
  const titleAxis = sharedAxis(byTitles); // gates 1 and 2
  const skillAxis = sharedAxis(bySkills);
  if (!titleAxis || !skillAxis || titleAxis === skillAxis) return undefined; // gate 3

  const expectedByTitleSide = new Set(
    byTitles.flatMap((profile) => profile.skills.map(normalizeSkillKey)),
  );
  if (overlap(skills, expectedByTitleSide).length > 0) return undefined; // gate 4, "every"

  const expectedBySkillSide = new Set(
    bySkills.flatMap((profile) => profile.skills.map(normalizeSkillKey)),
  );
  const offAxisSkills = overlap(skills, expectedBySkillSide);
  if (offAxisSkills.length < MIN_OFF_AXIS_SKILLS) return undefined; // gate 4, threshold

  // The user's own words for the finding to name. Non-empty whenever `byTitles`
  // is, since a profile only resolves off a matching title; guarded anyway so
  // the copy can never quote an empty list.
  const namedTitles = titles
    .filter((title) =>
      byTitles.some((profile) =>
        profile.titles.some((expected) => profileTitleMatches(expected, title)),
      ),
    )
    .slice(0, MAX_NAMED_TITLES);
  if (namedTitles.length === 0) return undefined;

  // What would close the gap: the titles' own role's expected skills, minus what
  // the query already has (nothing, by gate 4) and minus anything the search
  // could not use anyway — the same suppression `missingTerms` applies.
  const missingSkills = byTitles[0].skills
    .filter((skill) => isSignificantSkillTerm(skill.toLowerCase()))
    .slice(0, MAX_MISSING_SKILLS);

  const direction: CoherenceDirection =
    titleAxis === "leadership" ? "leadership-titles-ic-skills" : "ic-titles-leadership-skills";

  return {
    direction,
    titles: namedTitles,
    offAxisSkills,
    missingSkills,
    note: COHERENCE_NOTES[direction](namedTitles.map((title) => `"${title}"`).join(", ")),
  };
}

/**
 * Verdicts for the title half of a query.
 *
 * Split out of {@link assessQueryTerms} so each verdict rule reads on its own:
 * the two halves share no state, and the asymmetry between them — a title is
 * judged as soon as a role resolves, a skill additionally needs standing — is
 * the module's central claim, easiest to check when neither loop is nested
 * inside the wiring that calls it.
 */
function titleVerdicts(
  titles: readonly string[],
  resolved: readonly RoleProfile[],
  noise: ReadonlySet<string>,
): TermVerdict[] {
  const verdicts: TermVerdict[] = [];
  for (const term of titles) {
    const tokens = titleTokens(term);
    if (!tokens.some((token) => isAdmittingTitleTerm(token, noise))) {
      // Two ways to admit nothing, and they are different news for the user:
      // every word was their own city/employer, or there was no real word at all.
      verdicts.push({
        term,
        kind: "title",
        quality: "noise",
        reason: tokens.some((token) => noise.has(token))
          ? REASONS.titleNoisePlace
          : REASONS.titleNoiseEmpty,
      });
      continue;
    }
    if (resolved.length === 0) continue; // no basis — say nothing (rule 1)
    const strong = resolved.some((profile) =>
      profile.titles.some((expected) => profileTitleMatches(expected, term)),
    );
    verdicts.push({
      term,
      kind: "title",
      quality: strong ? "strong" : "weak",
      reason: strong ? REASONS.titleStrong : REASONS.titleWeak,
    });
  }
  return verdicts;
}

/**
 * Verdicts for the skill half of a query — the half with the extra gate.
 *
 * "Strong" is earned by evidence (an expected skill covers the term).
 * "Weak" additionally requires STANDING: the term must be a canonical skill
 * name, per `canonicalSkills`. A free-text phrase that matches nothing tells us
 * about our vocabulary, not about the term, so it leaves with no verdict at all.
 * See the module docblock — this is the rule the first draft got wrong.
 */
function skillVerdicts(
  skills: readonly string[],
  resolved: readonly RoleProfile[],
  expectedSkills: readonly SkillPhrase[],
  canonicalSkills: ReadonlySet<string>,
): TermVerdict[] {
  const verdicts: TermVerdict[] = [];
  for (const term of skills) {
    if (!isSignificantSkillTerm(term.toLowerCase())) {
      verdicts.push({ term, kind: "skill", quality: "noise", reason: REASONS.skillNoise });
      continue;
    }
    if (resolved.length === 0) continue; // no basis — say nothing (rule 1)
    if (expectedSkills.some((expected) => skillIsExpected(expected, term))) {
      verdicts.push({ term, kind: "skill", quality: "strong", reason: REASONS.skillStrong });
      continue;
    }
    // Nothing expected matched. Whether that is news about the TERM or only
    // about our vocabulary depends on standing — see the module docblock.
    if (!canonicalSkills.has(normalizeSkillKey(term))) continue;
    verdicts.push({ term, kind: "skill", quality: "weak", reason: REASONS.skillWeak });
  }
  return verdicts;
}

/**
 * Classify every term of `query` and name what the résumé is missing.
 *
 * Total and deterministic: no I/O, no clock, no randomness, and no throw on any
 * `JobQuery` shape — empty titles, empty skills, absent optional fields, or a
 * bare `{}`. Two contracts consumers depend on, both tested:
 *
 *  - a term absent from `verdicts` was NOT judgeable; render it unmarked. That
 *    now includes a free-text skill on a query with no `canonicalSkills`
 *    annotation — silence, never a defaulted "weak".
 *  - `missing` is `[]` whenever no role resolved, and never names something the
 *    query already covers in different words.
 *  - `coherence` is `undefined` unless a mismatch cleared every gate; that
 *    absence is the normal state and renders as nothing, not as an "all clear".
 */
export function assessQueryTerms(query: JobQuery): QueryTermAssessment {
  const titles = cleanTerms(query.titles);
  const skills = cleanTerms(query.skills);
  const noise = titleNoiseTokens(query.titleNoise);

  const byTitles = resolveProfilesByTitles(titles);
  const bySkills = resolveProfilesBySkills(skills);
  const resolved = unionProfiles(byTitles, bySkills);
  // Most-confident answer to "who is this" — the title answer when there is
  // one, since a title is what a person IS and a skill only implies it.
  const primary = byTitles[0] ?? bySkills[0];
  const expectedSkills = dedupePhrases(resolved.flatMap((profile) => profile.skills));
  // Standing to say "weak", per the module docblock. `undefined` and "annotated,
  // none canonical" collapse to the same empty set on purpose: both mean no skill
  // here is one we may call worthless.
  const canonicalSkills = new Set(cleanTerms(query.canonicalSkills).map(normalizeSkillKey));

  return {
    // Titles first, then skills — `verdicts` order is the render order on the
    // chip rows, and the two loops are independent.
    verdicts: [
      ...titleVerdicts(titles, resolved, noise),
      ...skillVerdicts(skills, resolved, expectedSkills, canonicalSkills),
    ],
    missing: missingTerms(primary, titles, skills, noise),
    // The two resolvers' answers compared INDEPENDENTLY, never through
    // `resolved` — see the module docblock and `assessCoherence`'s gates.
    coherence: assessCoherence(byTitles, bySkills, titles, skills),
  };
}
