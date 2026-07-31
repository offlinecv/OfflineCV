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
 * skill still surfaces. Which of them were recognized is no longer discarded:
 * it ships as `canonicalSkills`, because a title-cased free-text phrase is
 * indistinguishable from a canonical label downstream and being judged as one
 * is what made `term-quality.ts` call a real skill weak. See that field.
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
 *
 * Title noise (#579): site-lead and regional-lead titles carry a GEOGRAPHY or
 * EMPLOYER word inside the title itself ("Berlin Site Lead", "Acme Cloud
 * Lead"), and the title scorer paid that word the same weight as a real role
 * word — deciding, upstream of the star rating, which postings survived
 * `capPerCompany`. Rather than ship a gazetteer, `titleNoise` is derived from
 * the résumé's OWN experience locations and company names, which we already
 * parse. See that field's doc and `deriveTitleNoise` for the required guard
 * rail that keeps a genuine role word out of the noise set.
 */

import type { ParsedResume } from "../score/types.ts";
import { getSkillIndex } from "../jd-match/skills.ts";
import { parseSeniorityLabel } from "./seniority.ts";
export { parseSeniorityLabel };
import { ROLE_KEYWORDS, tokenizeWords } from "./role-keywords.ts";
import { normalizeSkillKey } from "./role-profiles.ts";
import { looksLikeTitle } from "../heuristics/extract/title-shape.ts";

export interface JobQuery {
  /** Distinct role titles, most-recent-first, deduped case-insensitively and
   *  capped at MAX_TITLES. Empty when none could be derived (skills-only /
   *  degenerate query). `titles[0]` is the stated target when there is one,
   *  or the primary (most-recent) title. */
  titles: string[];
  /** Top-ranked skills, canonicalized + deduped, capped at MAX_SKILLS. */
  skills: string[];
  /** Seniority keyword found across the résumé's titles (Executive/VP/
   *  Director/Manager/Staff/Principal/Lead/Senior/Junior/Intern) — the
   *  PRIMARY title (titles[0], which may be the headline) wins when it has
   *  a keyword, otherwise the first match scanning the rest of `titles` in
   *  order (#540) — or undefined when none of them carries a recognized keyword. */
  seniority?: string;
  /** Candidate location, seeded from the parsed résumé's top-level
   *  `location` (contact address, e.g. "Austin, TX") when present (#545).
   *  Single free-text value, user-editable — unlike titles/skills this is
   *  not a list: a candidate has one search location at a time, not several
   *  to union together. Undefined when the parse has no location and the
   *  user hasn't typed one. */
  location?: string;
  /** Title-only exclude terms (#563) — a posting is dropped when its TITLE
   *  (never its description) contains one of these as a case-insensitive
   *  substring. User-editable chips, same interaction as `titles`/`skills`.
   *  Optional (rather than always-present) so every pre-existing `JobQuery`
   *  literal across the lane's tests keeps compiling unchanged; every reader
   *  MUST treat `undefined` the same as `[]` — see `filterPostingsByExcludeTerms`
   *  in `role-keywords.ts`, the sole place that applies it. Not derived here:
   *  these are user-editable chips, so their seed is the CALLER's to choose —
   *  `buildJobQuery`'s caller (`FindJobsPanel`) computes it from the role-family
   *  classification (`seedExcludeTermsForFamilies` in `role-keywords.ts`) and
   *  passes the result in. (This module used to justify the seed parameter by
   *  staying free of any runtime dependency on `role-keywords.ts`; #579's
   *  `titleNoise` guard rail made that dependency necessary, so the seed pattern
   *  now stands on the "user-editable state belongs to its UI" reason alone.) */
  excludeTerms?: string[];
  /** Optional user-entered minimum ANNUAL compensation (#564) — a SOFT
   *  signal only, following the #545/#561/#562 precedent: `rank.ts` reads it
   *  for a sort-key penalty and `JobResultCard` reads it for a "below your
   *  floor" badge, but a below-floor posting is never dropped. Undefined
   *  (the default) means no floor is set, byte-identical to pre-#564
   *  behavior for every existing caller. Not derived by `buildJobQuery` —
   *  purely user input, wired from `FindJobsPanel`'s `CompFloorInput`. */
  compFloor?: number;
  /** Résumé-derived role families (#568) — seeded from
   *  `roleFilterForResume(parsed).families` (role-keywords.ts) and rendered as
   *  REMOVABLE chips by `RoleFamilyChips`; there is no free-text add, since
   *  the family vocabulary is the fixed `ROLE_FAMILIES` enum, not user text.
   *  Typed as `string[]` (elements are `RoleFamily` labels) rather than
   *  importing that type, so `JobQuery` stays a plain, structurally-typed
   *  record that any caller can build without pulling in the role taxonomy.
   *  TWO distinct states, both load-bearing: `undefined` means "not
   *  asserted" — every reader falls back to deriving the filter from the
   *  résumé (`roleFilterForResume`), byte-identical to pre-#568 behavior for
   *  every existing caller/test. `[]` means "the user removed every seeded
   *  chip" — readers resolve that to `roleFilterForFamilies([])`, the
   *  PERMISSIVE "all" filter (never-fail-closed, same floor
   *  `roleFilterForResume` already guarantees for an unclassified résumé) —
   *  never to zero results. */
  families?: string[];
  /** The subset of `skills` — verbatim, same strings — that jd-match's canonical
   *  skill index recognizes (#584 follow-up). It is the ANSWER TO ONE QUESTION a
   *  downstream classifier cannot ask for itself: *is this chip a canonical skill
   *  name, or free résumé prose?* `deriveSkills` already computes it (that is what
   *  ranks canonical entries first) and used to throw it away, emitting a
   *  title-cased raw phrase that looks exactly like a canonical label — so
   *  `term-quality.ts` judged "Team Building & Mentorship" as if it were one and
   *  called a real, on-role skill weak.
   *
   *  It travels on the query rather than being recomputed downstream because
   *  `term-quality.ts` must not gain a runtime import of jd-match (its own
   *  docblock and `role-profiles.ts`'s draw that boundary — it keeps the skill
   *  dictionary out of the `/` entry chunk). Data, not a dependency.
   *
   *  `undefined` ⇒ NOT ASSERTED, and every reader must treat that as "no basis to
   *  judge any skill", never as "none are canonical and all are therefore weak" —
   *  see `assessQueryTerms`. Emitted only when non-empty, the same optional-field
   *  contract as `titleNoise`, so a hand-built query literal keeps compiling and
   *  an existing whole-object assertion keeps passing.
   *
   *  NOT EGRESS. `providers/keywords.ts` — the sole resume-derived egress helper —
   *  reads `titles` and `skills` only; no adapter serializes the query object. */
  canonicalSkills?: string[];
  /** Lowercased tokens that appear in the résumé's own experience LOCATIONS and
   *  COMPANY names — geography/employer words that ride along inside a role
   *  title ("Berlin Site Lead", "Acme Cloud Lead") and would otherwise score as
   *  role relevance at full `TITLE_WORD_OVERLAP_WEIGHT`. Derived here, never
   *  user-facing: there is no chip for it. `undefined` ⇒ treat as `[]`, so every
   *  pre-existing `JobQuery` literal and test keeps its current behaviour — the
   *  same optional-field contract as `excludeTerms` / `families`.
   *
   *  Unlike those two, this one IS derived in this module rather than seeded by
   *  the caller: it is not user-editable state that a UI owns, it is a pure
   *  function of the parse, and an opt-in guard rail is no guard rail. That is
   *  what makes the `ROLE_KEYWORDS` import below necessary — see it for why the
   *  resulting `role-keywords.ts` ↔ this-module cycle is safe. */
  titleNoise?: string[];
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
  "skills" | "experience" | "current_title" | "location" | "headline"
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

/** Separators a headline stacks distinct roles on.
 *
 *  `·`, `•` and `|` split bare — none of them occurs inside a single role.
 *  `-` and `/` do occur inside one, so both split only when a space sits on
 *  each side, the way a person writes a genuine stack ("Product Manager /
 *  Data Analyst"). Unguarded, `/` turns "React/Node Engineer" into `React` +
 *  `Node Engineer`, and `titles[0]` is what egresses (#605 review).
 *
 *  `,` is absent from the set entirely rather than space-guarded. Nobody
 *  writes " , ", so a guarded comma would never fire — a dead branch — while
 *  a bare one splits "VP, Engineering" and "Engineer, Data Platform", which
 *  are single roles, into fragments.
 *
 *  `&` and `and` are excluded for the same reason: "Founding Member & Site
 *  Reliability Engineer" is one compound role, not two, and splitting it
 *  would mint titles nobody holds. */
const HEADLINE_SEPARATOR_RE = /[·•|]|\s[-–—/]\s/;

/**
 * The distinct role titles a headline names, in stated order — one entry for a
 * plain headline, N for a separator-stacked tagline. Empty for absent/blank,
 * and any part that reduces to nothing is dropped rather than emitted as "".
 *
 * A MANUFACTURED PART IS RE-SHAPE-GATED (#605 review). Both routes into a
 * headline shape the WHOLE string — `extractHeadline` admits a parsed one only
 * past `looksLikeTitle`, and a user-typed one is warned by
 * `headlineRoundTripWarning` — and neither says anything about a fragment this
 * split invents. `looksLikeTitle("Software Engineer · Coffee Lover")` is true;
 * `looksLikeTitle("Coffee Lover")` is not. Since `titles[0]` is the one audited
 * resume-derived egress (`providers/keywords.ts`) and every part also renders
 * as a chip in `RolesPanel`, a part that does not read as a title is dropped
 * rather than egressed and shown as a chip the user never typed.
 *
 * A single part is NOT re-gated: it is the caller's own headline unchanged, and
 * this function is not the place to overrule a headline the user typed.
 */
export function splitHeadline(headline: string | undefined): string[] {
  const whole = (headline ?? "").trim();
  if (!whole) return [];

  const parts = whole
    .split(HEADLINE_SEPARATOR_RE)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length <= 1) return parts;

  const titled = parts.filter(looksLikeTitle);
  // Every part failing means the string read as a title only in aggregate.
  // Keep it whole rather than dropping the headline outright: it is still the
  // user's stated target, and `RolesPanel` needs it among the chips to star it.
  return titled.length > 0 ? titled : [whole];
}

/**
 * The ROLE HEAD of one title — the part a job search should actually match on,
 * with a trailing scope qualifier dropped. `"Engineering Lead - Customer
 * Experience"` searches as `"Engineering Lead"`.
 *
 * WHY THIS IS NOT `splitHeadline`, AND WHY IT DOES NOT LIVE IN `deriveTitles`.
 * A scoped title is one role, not two — the qualifier names the org the role
 * sits in. So the chip, the local `matchesQuery` broadening, and the exported
 * PDF all want the string the user actually holds; only the outbound SEARCH
 * TERM wants it narrowed, because a careers box matches the qualifier as a
 * required term and finds nothing. Narrowing this in `deriveTitles` instead
 * would hit all three surfaces at once — the #605 blast radius: `titles[0]`
 * feeds the audited egress, `buildContact` prints the unsplit string into the
 * PDF, and `RolesPanel` stars a chip by `titles.indexOf(primary)`. So this is a
 * READ-SIDE narrowing applied by the egress caller, and `JobQuery.titles` is
 * left holding the user's own words.
 *
 * It reuses `HEADLINE_SEPARATOR_RE` and the `looksLikeTitle` re-gate rather
 * than inventing a second splitter, which is what keeps #605's two lessons in
 * force here:
 *
 *  - **The separator set is already the safe one.** `-` and `/` split only when
 *    spaced on both sides, so `React/Node Engineer` stays whole; `,` is absent
 *    entirely, so `VP, Engineering` stays whole. Both are single roles whose
 *    head alone (`React`, `VP`) would be a worse query than the compound.
 *  - **The head is re-gated, not assumed.** The first part is not always the
 *    role: `"Customer Experience - Engineering Lead"` inverts the order, and
 *    `looksLikeTitle` rejects the qualifier so the real role is picked instead.
 *    When NO part reads as a title the whole string is kept — the same refusal
 *    `splitHeadline` makes, for the same reason: a manufactured fragment that
 *    failed the shape gate is worse than the text the user typed.
 *
 * A title with no separator is returned unchanged, so callers can apply this
 * unconditionally.
 */
export function roleHeadForSearch(title: string): string {
  const whole = title.trim();
  const parts = whole
    .split(HEADLINE_SEPARATOR_RE)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length <= 1) return whole;
  return parts.find(looksLikeTitle) ?? whole;
}

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
export function deriveTitles(parsed: ResumeQueryInput): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  /**
   * Admits one candidate title. Trims, drops blanks, dedups case-insensitively
   * (keeping first-seen casing), and enforces `MAX_TITLES`. Returns `false` once
   * the list is full, so each source below stops at the cap without repeating
   * the check — three loops applying the same three rules inline is what pushed
   * this function over the cognitive-complexity bar.
   */
  const push = (raw: string | undefined): boolean => {
    if (out.length >= MAX_TITLES) return false;
    const title = raw?.trim();
    if (title && !seen.has(title.toLowerCase())) {
      seen.add(title.toLowerCase());
      out.push(title);
    }
    return out.length < MAX_TITLES;
  };

  // The stated target (#599) leads, because `titles[0]` is what `searchPhrase`
  // sends as the feeds' `search=` param — the one audited resume-derived egress.
  //
  // SPLIT IT FIRST. A headline is a tagline, not a title: `extractHeadline`
  // routinely lifts "DevOps Engineer · Software Architect" — two roles stacked
  // on a separator. Sent whole, that is a single-intent full-text query naming
  // two intents, which is exactly what `keywords.ts`'s own docblock says it
  // avoids ("stacking distinct titles … would over-constrain the feed"), and it
  // returns near-nothing. Splitting is preferred over gating the compound out:
  // each part IS a real title, so the first becomes a clean egress phrase and
  // the rest still widen the local `matchesQuery` broadening.
  //
  // The WHOLE headline arrives already shaped — `extractHeadline` admits a
  // parsed one only past `looksLikeTitle`, and a user-typed one is warned by
  // `headlineRoundTripWarning` in the ContactCard editor. The PARTS do not
  // inherit that: the split invents them, so `splitHeadline` re-gates them
  // itself. See its docblock.
  for (const part of splitHeadline(parsed.headline)) {
    if (!push(part)) break;
  }

  // `hasExpTitle` is set before the cap check on purpose: a résumé whose
  // experience titles were all crowded out by the headline still HAS experience
  // titles, so it must not fall through to the `current_title` fallback below.
  // Most-recent-first, so the cap keeps the recent ones.
  let hasExpTitle = false;
  for (const exp of parsed.experience ?? []) {
    if (!exp.title?.trim()) continue;
    hasExpTitle = true;
    if (!push(exp.title)) break;
  }
  if (hasExpTitle) return out;

  // No experience title at all → fall back to the top-level current_title, or
  // an empty set (skills-only / degenerate query).
  push(parsed.current_title);
  return out;
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
    const match = parseSeniorityLabel(title);
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
      // A recognized skill renders the dictionary's own `label`, a free-text one
      // is title-cased here. Those two only agree on casing because #607
      // title-cased every authored `label` in `jd-match/skills.ts` — before
      // that, recognition status leaked into casing and the card read
      // "cross-functional collaboration, Team Building & Mentorship".
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

/**
 * Every comparison key jd-match's dictionary recognizes — each alias, each
 * canonical id, and each display label, all through `normalizeSkillKey`. Built
 * once, lazily, so importing this module still costs nothing until a query is
 * actually built.
 *
 * Keyed rather than looked up through `aliasToId` directly on purpose: that map
 * is keyed on the RAW lowercased alias, so it misses a label that is not itself
 * an alias ("CI/CD" for `ci-cd`) and any separator variant ("Team-Building").
 * `normalizeSkillKey` is the same folding `term-quality.ts` compares with, so
 * "is this canonical" and "does this match what the role expects" can never
 * disagree about whether two spellings are the same skill.
 */
let canonicalSkillKeys: ReadonlySet<string> | undefined;
function getCanonicalSkillKeys(): ReadonlySet<string> {
  if (!canonicalSkillKeys) {
    const index = getSkillIndex();
    const keys = new Set<string>();
    const add = (value: string) => {
      const key = normalizeSkillKey(value);
      if (key) keys.add(key);
    };
    for (const [alias, id] of index.aliasToId) {
      add(alias);
      add(id);
    }
    for (const label of index.idToLabel.values()) add(label);
    canonicalSkillKeys = keys;
  }
  return canonicalSkillKeys;
}

/**
 * The entries of `skills` that name a canonical jd-match skill, verbatim and in
 * input order — the value of `JobQuery.canonicalSkills` (see that field for why
 * the fact travels on the query at all).
 *
 * Exported because the query is EDITABLE: a chip the user types has to be
 * annotated the same way a derived one was, or the annotation would silently
 * describe only the original parse. `JobQueryEditor` recomputes the whole list
 * through this same function on every skill add, so there is one rule, not two.
 * Pure and total — non-string entries are dropped rather than coerced.
 */
export function canonicalSkillLabels(skills: readonly string[] | undefined): string[] {
  const keys = getCanonicalSkillKeys();
  const out: string[] = [];
  for (const skill of skills ?? []) {
    if (typeof skill !== "string") continue;
    const key = normalizeSkillKey(skill);
    if (key && keys.has(key)) out.push(skill);
  }
  return out;
}

function deriveLocation(parsed: ResumeQueryInput): string | undefined {
  const location = parsed.location?.trim();
  return location || undefined;
}

/**
 * The flattened `ROLE_KEYWORDS` vocabulary as TOKENS — the guard-rail set for
 * `deriveTitleNoise`. `ROLE_KEYWORDS`' values are multi-word PHRASES ("data
 * engineer", "site reliability", "front-end"), so flattening them into single
 * tokens is a real step: a direct membership test against the phrase list would
 * never match a one-word candidate, and the guard would silently never fire.
 * Tokenized with `tokenizeWords`, the same rule the scorer uses.
 *
 * Built lazily and memoized — see the import docblock: reading `ROLE_KEYWORDS`
 * at module-evaluation time would depend on which side of the cycle loads first.
 */
let roleVocabularyTokens: ReadonlySet<string> | undefined;
function getRoleVocabularyTokens(): ReadonlySet<string> {
  if (!roleVocabularyTokens) {
    const tokens = new Set<string>();
    for (const phrases of Object.values(ROLE_KEYWORDS)) {
      for (const phrase of phrases) {
        for (const token of tokenizeWords(phrase)) tokens.add(token);
      }
    }
    roleVocabularyTokens = tokens;
  }
  return roleVocabularyTokens;
}

/**
 * The REQUIRED #579 guard rail: true when a candidate noise token is part of the
 * role vocabulary and must therefore stay a query term. A company literally
 * named after a role word ("Engineering Inc.", "Design Studio") would otherwise
 * strip `engineering` / `design` from the query entirely — a far worse failure
 * than the geography bleed being fixed, and for a leadership résumé ("VP
 * Engineering", where `vp` is below the 3-char token gate) it can strip the
 * ONLY scoring word the title has.
 *
 * Membership is EXACT. The flattened vocabulary carries both `engineer` and a
 * bare `engineering` (from "engineering manager" / "engineering lead" /
 * "engineering director" / "engineering leadership"), plus bare `design`, so an
 * equality test already covers both worked examples — "Engineering Inc." keeps
 * `engineering` and drops `inc.`; "Design Studio" keeps `design` and drops
 * `studio`. A PREFIX test would additionally protect every employer/place token
 * that merely STARTS with a vocabulary token — `datadog`/`databricks` (`data`),
 * `salesforce` (`sales`), `webflow` (`web`), `mobileye` (`mobile`), `seoul`
 * (`seo`) — leaving exactly the geography/employer bleed #579 exists to fix
 * unsuppressed. Exact membership protects the role words and nothing else.
 */
function isRoleVocabularyToken(token: string): boolean {
  return getRoleVocabularyTokens().has(token);
}

/**
 * Derive `JobQuery.titleNoise` (#579) — the union of the tokens in every
 * `experience[].location` and `experience[].company`, minus anything the role
 * vocabulary protects. `ResumeQueryInput` already `Pick`s `experience`, which
 * carries both fields, so no signature widening is needed.
 *
 * Returns `undefined` (not `[]`) when nothing survives — experience with neither
 * a location nor a company, or a résumé with no experience at all — so the field
 * is simply ABSENT on a query built from such a parse, which is what keeps the
 * whole-object assertions in this module's tests passing unchanged.
 */
function extractUnseenTokens(field: string, seen: Set<string>): string[] {
  const tokens: string[] = [];
  for (const token of tokenizeWords(field)) {
    if (seen.has(token)) continue;
    seen.add(token); // protected tokens are recorded too — tested once, not per row
    if (!isRoleVocabularyToken(token)) {
      tokens.push(token);
    }
  }
  return tokens;
}

function deriveTitleNoise(parsed: ResumeQueryInput): string[] | undefined {
  const noise: string[] = [];
  const seen = new Set<string>();
  for (const exp of parsed.experience ?? []) {
    if (exp.location) noise.push(...extractUnseenTokens(exp.location, seen));
    if (exp.company) noise.push(...extractUnseenTokens(exp.company, seen));
  }
  return noise.length > 0 ? noise : undefined;
}

/**
 * @param excludeTermSeeds Pre-computed exclude-term chips to seed the query
 *   with (#563) — pass `seedExcludeTermsForFamilies(roleFilterForResume(parsed).families)`
 *   from the call site (`FindJobsPanel`). Defaults to `[]` (byte-identical to
 *   pre-#563 behavior) so every other/test caller is unaffected. Kept as a
 *   plain parameter rather than computed in here — see the `excludeTerms`
 *   doc on `JobQuery` for why this module doesn't import `role-keywords.ts`.
 * @param familySeeds The résumé-derived role families (#568) — pass
 *   `roleFilterForResume(parsed).families` from the call site. Defaults to
 *   `undefined` (via the empty-array-becomes-undefined normalization below)
 *   so every other/test caller keeps the pre-#568 "families not asserted"
 *   behavior on `JobQuery` — see that field's doc for the `undefined` vs `[]`
 *   distinction.
 */
export function buildJobQuery(
  parsed: ResumeQueryInput,
  excludeTermSeeds: readonly string[] = [],
  familySeeds?: readonly string[],
): JobQuery {
  const titles = deriveTitles(parsed);
  // Primary title first, then fall back across the rest of the titles (#540).
  const seniority = deriveSeniorityAcrossTitles(titles);
  const skills = deriveSkills(parsed);
  // Annotated from the EMITTED labels, not from `deriveSkills`' internal flag:
  // that flag reads `aliasToId` on the raw résumé string, while every downstream
  // comparison is against the label this function actually ships. Annotating the
  // shipped value is what makes the two agree by construction.
  const canonical = canonicalSkillLabels(skills);
  const location = deriveLocation(parsed);
  const excludeTerms = [...excludeTermSeeds];
  const families = familySeeds === undefined ? undefined : [...familySeeds];
  const titleNoise = deriveTitleNoise(parsed);
  return {
    titles,
    skills,
    canonicalSkills: canonical.length > 0 ? canonical : undefined,
    seniority,
    location,
    excludeTerms,
    families,
    titleNoise,
  };
}
