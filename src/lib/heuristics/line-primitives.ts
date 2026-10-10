// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Leaf-level line primitives shared by the entry-block parser and the field
 * extractors: bullet detection/stripping, date-range parsing, and the
 * closed-vocabulary bare-location predicate.
 *
 * These live in their own module to break the import cycle that arises when
 * `entry-blocks.ts` (the shared windowing primitive) and `extract-fields.ts`
 * (its caller) both need the same low-level helpers. This module depends only
 * on `regex.ts` constants, the zero-dependency `lexicon/action-verbs.ts` set,
 * and the `PdfLine` type — nothing in the heuristics layer imports back into
 * it — so it sits cleanly below both.
 */

import { startsWithActionVerb } from "../lexicon/action-verbs.ts";
import { MIDDOT } from "../resume-format/index.ts";
import { bulletCharClass, PARSER_BULLET_GLYPHS } from "./bullet-glyphs.ts";
import { composeSuffixRegex, selectSuffixTokens } from "./extract/corporate-suffix.ts";
import type { PdfLine } from "./line-model.ts";
import {
  COUNTRY_GAZETTEER,
  DATE_RANGE_RE,
  INTL_LOCATION_RE,
  MONTH,
  MONTH_YEAR_RE,
  NUMERIC_MONTH_YEAR_RE,
  OPEN_ENDED_ALT,
  PROGRAM_NOTE_RE,
  SEASON,
  STRICT_MONTH_YEAR_RE,
  US_LOCATION_RE,
  US_STATE_CODE_RE,
  YEAR_RE,
} from "./regex.ts";

/** Glyphs a template may use as a list bullet — {@link PARSER_BULLET_GLYPHS},
 *  the parser's half of the shared `bullet-glyphs.ts` vocabulary (#915). One
 *  source of truth for the line-level tests below and the item-level
 *  `isBulletGlyph` — they must agree on what counts as a bullet, or a glyph
 *  stripped from a line's text could still survive as a standalone pdfjs item. */
const BULLET_CLASS = bulletCharClass(PARSER_BULLET_GLYPHS);
const BULLET_LEAD_RE = new RegExp(`^\\s*${BULLET_CLASS}`);
const BULLET_PREFIX_RE = new RegExp(`^\\s*${BULLET_CLASS}\\s*`);
const BULLET_GLYPH_RE = new RegExp(`^${BULLET_CLASS}$`);

/** True if the line looks like a bullet point (starts with •, ‣, -, *, ◦, or is indented prose). */
export function isBulletLine(line: PdfLine): boolean {
  return BULLET_LEAD_RE.test(line.text);
}

/** Strip leading bullet glyphs + whitespace. */
export function stripBullet(text: string): string {
  return text.replace(BULLET_PREFIX_RE, "").trim();
}

/** True when a pdfjs item is *nothing but* a bullet glyph — i.e. the template
 *  drew the marker as its own text run, so the glyph is line decoration rather
 *  than content. */
export function isBulletGlyph(str: string): boolean {
  return BULLET_GLYPH_RE.test(str.trim());
}

/**
 * True when a line reads like a description sentence rather than an entry
 * header (company / title / institution). Some templates — notably the Word /
 * Office résumé templates — write the role description as a glyph-less prose
 * paragraph instead of a bulleted list, so `isBulletLine` alone can't tell the
 * description apart from the header lines around the date.
 *
 * Two signals, both required, plus a word floor:
 *   - a lowercase letter (a long ALL-CAPS company/title isn't prose), and
 *   - an INTERNAL sentence break ("…accomplishments. Where the team…") — a
 *     period between two letters, a capitalized word, then a RUNNING CLAUSE:
 *     a later lowercase-initial word in that second sentence. This is what
 *     keeps a long-but-header line like "Acme Analytics (8 employee
 *     venture-backed startup) New York, NY" out: it has commas and parentheses
 *     but no sentence period, so it stays a header (and its company is
 *     preserved). The lowercase-continuation requirement is the other half:
 *     a résumé's "Company. City, State" header delimiter ALSO looks like a
 *     "word. Capital" break, but its tail is an all-Title-Case location with
 *     no lowercase word — so it is NOT prose. Without that guard, a two-column
 *     role header like "…Northwind Technology. San Jose, California" was misread
 *     as a description, its block dropped, and the role demoted to loose bullets
 *     under a neighbor (#341).
 * The 8-word floor sits just under the scorer's 8-30-word bullet window, so a
 * paragraph the scorer would grade as a bullet is captured as body here too.
 * Glyph-less descriptions WITHOUT a sentence period (e.g. indented one-line
 * bullets) are left to the bullet/indent path, unchanged by this predicate.
 */
const PROSE_MIN_WORDS = 8;
// `word. Capital…` (a sentence break) followed, before the next period, by a
// space + lowercase letter (a real second clause). The trailing lowercase is
// what separates a running sentence from a "Company. City, State" location tail
// (all Title-Case, no lowercase word → not prose). See #341.
const SENTENCE_BREAK_RE = /[a-z]{2}\.\s+[A-Z][^.]*\s[a-z]/;
export function isProseLine(text: string): boolean {
  const trimmed = text.trim();
  if (!/[a-z]/.test(trimmed)) return false;
  if (!SENTENCE_BREAK_RE.test(trimmed)) return false;
  return trimmed.split(/\s+/).filter(Boolean).length >= PROSE_MIN_WORDS;
}

/**
 * True when a below-anchor line (the run between a date sub-line and the first
 * bullet) reads unambiguously as body prose rather than a header extension.
 *
 * Used by {@link buildEntryBlock} to PREEMPT such a line from `headerLines`
 * before `disambiguateCompanyTitle` runs (#615 review, PR #688 Thread 1). Left
 * in the header run, a line like "Founding site leader; owned charter and
 * headcount." gets absorbed into the still-empty `team` slot — turning a body
 * sentence into a team name in the exported header and violating #615 AC #3.
 * `isProseLine` above is too strict here (it needs an internal sentence break
 * AND ≥8 words); this predicate is targeted at the specific below-anchor
 * signals no legitimate header field carries.
 *
 * FOUR signals qualify — any one is sufficient, and each is strict enough
 * that no real title / company / team / location line trips it. They are
 * tested in the order listed, and the order is load-bearing only between 3
 * and 4 (see 3):
 *
 * 1. A semicolon (`;`) anywhere in the line. Titles, teams, companies and
 *    locations never use `;` as a delimiter, so its presence is a strong
 *    prose signal that costs nothing on legitimate headers.
 *
 * 2. A grade-code-led middot line — see {@link looksLikeMiddotMetadata},
 *    which owns that shape and its own narrowness argument.
 *
 * 3. An action-verb lead followed by a lowercase CONTENT word (#708) — see
 *    {@link looksLikeVerbLedScope}. This is the only signal keyed on GRAMMAR
 *    rather than punctuation, which is why #708's two shapes need it: one
 *    carries no `;`, no grade code and no terminator at all, and the other
 *    ends on a legal-entity suffix, so signal 4 actively REJECTS it. It must
 *    be tested BEFORE 4 for that second shape — 4 returns `false` on a
 *    legal-suffix ending, and a `return` cannot be reconsidered.
 *
 * 4. A sentence-terminator ending (`.!?`), EXCEPT when the terminating token
 *    is a legal-entity suffix from a closed Anglo-American list. "Google,
 *    Inc." and "Acme Corp." are legitimate company names on their own line
 *    — the {@link LEGAL_TERMINAL_SUFFIX_RE} guard keeps them out. The list
 *    is deliberately narrow: adding `AG` / `AB` / `SE` / `NV` / `AS` / `Oy`
 *    would widen the false-positive class rather than shrink it, because
 *    each is a common English word ending (`lab.`, `case.`, `was.`, `has.`).
 *    So `"Deutsche Bank AG."` on its own line trips this predicate as prose
 *    — a known limitation, accepted because the scope of {@link
 *    LEGAL_TERMINAL_SUFFIX_RE} is companies-that-round-trip-cleanly, not an
 *    exhaustive international vocab.
 *
 * Still deliberately NARROW. A middot line that does NOT lead with a grade
 * code, and a scope line that is Title-Cased throughout ("Grew ARR From $2M
 * To $8M"), match nothing here and fall through to the header path. If
 * disambiguation leaves any of their tokens unclaimed by fields, the
 * second-chance {@link recoverLeadingBodyProse} in `experience.ts` catches
 * them via token coverage; if disambiguation misroutes one (a separate defect
 * class from #615), a broader predicate would need its own repro + tests.
 *
 * 5. {@link looksLikeUnpunctuatedRunningSentence} — a sentence carrying NONE
 *    of the above tells at all (#1088). A Word / Google-Docs résumé role
 *    description is routinely a single plain-paragraph sentence with no `;`,
 *    no grade-code middot, no lexicon action-verb lead ("Worked" is
 *    deliberately excluded from {@link ACTION_VERBS} as a weak generic verb,
 *    same reasoning as #708's "Founding"), and — when the source simply omits
 *    the trailing period — no `.!?` either. Every one of signals 1-4 misses
 *    that shape, so it survived as a header candidate: entry-blocks.ts's
 *    above-anchor and next-header-start walks (which stop on this same
 *    predicate) had nothing to stop them from claiming it as the NEXT role's
 *    title, dropping the role it actually described.
 */
// `\b` at the start is load-bearing (PR #688 review B1): without it,
// `Co\.?$` matches "co." at the end of any word — "San Francisco.", "off
// Cisco.", "growth of Xerox." — and the whole sentence gets classified as
// a legal-entity name, so the preemption skips a scope line that ends on a
// common place/word suffix and the sentence lands in `team` instead of
// `description`. `.?$` anchors to line end; the alternation is
// Anglo-American legal suffixes only (adding `AG` / `AB` / `SE` / `NV` /
// `AS` / `Oy` widens the same class of false positive, so it stays out).
// Composed via `extract/corporate-suffix.ts` (#917) — see that module's
// docblock for what's mechanical (escaping, anchors, the #641 trailing-dot
// allowance) vs what's this set's own judgement (the token list below, kept
// deliberately narrow per the docblock above).
// Exported for one purpose: `extract/corporate-suffix.test.ts` pins its
// `.source` and `.flags` byte-identical to the pre-#917 literal. Only a golden
// on THIS constant catches an edit to the key list below.
export const LEGAL_TERMINAL_SUFFIX_RE = composeSuffixRegex(
  selectSuffixTokens([
    "INC", "CORP", "CORPORATION", "LTD", "LLC", "L_L_C", "GMBH", "PLC", "CO",
    "SA", "NA", "LP", "LLP", "PC",
  ]),
  { anchor: "trailing", allowTrailingDot: true },
);
export function looksLikeBelowAnchorProse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes(";")) return true;
  if (looksLikeMiddotMetadata(trimmed)) return true;
  if (looksLikeVerbLedScope(trimmed)) return true;
  if (/[.!?]$/.test(trimmed)) return !LEGAL_TERMINAL_SUFFIX_RE.test(trimmed);
  return looksLikeUnpunctuatedRunningSentence(trimmed);
}

/**
 * Signal 5 of {@link looksLikeBelowAnchorProse} (#1088): a running sentence
 * with no `;`, no grade-code middot, no lexicon verb lead, and no trailing
 * `.!?` to key on — the shape a Word/Google-Docs role description takes when
 * it is a single plain paragraph and the source simply omits the period.
 *
 * Three structural signals, all required, stand in for the punctuation/grammar
 * tells the other four signals use:
 *   - it carries NO comma — the mark of a "Company, City, ST" header or a
 *     comma-delimited tech-stack list, never a résumé sentence's own clause
 *     boundary (same CSV exemption `looksLikeVerbLedScope` and
 *     `looksLikeBodyParagraph`, entry-blocks.ts, already apply). Checked
 *     AFTER the parenthetical strip below, so a comma living only inside a
 *     parenthetical aside ("…billing (payments, inventory, invoicing)
 *     systems…") does not disqualify an otherwise-clean running sentence —
 *     the aside is not the CSV/header shape this check guards against;
 *   - it carries NO two consecutive Title-Cased words — the tell of a job
 *     title or org name ("Director of Business Development", "Doubleclick
 *     Advertising Solutions", "Data Platform Engineering Team"). A genuine
 *     sentence carries exactly one capitalized word (the sentence-initial
 *     one); anything that stays capitalized for a second word running is a
 *     header/title fragment wearing this signal's other two tells by
 *     coincidence, not a résumé sentence; and
 *   - it carries at least TWO lowercase CONTENT words
 *     ({@link isLowercaseContentWord}) — not merely lowercase-initial, since a
 *     Title-Cased org name routinely carries one lowercase connector
 *     ("Planned Parenthood of Greater Ohio", #708). Two is deliberately
 *     stricter than {@link looksLikeVerbLedScope}'s "one after the verb":
 *     that signal has a verb lead to anchor on, this one has no grammatical
 *     anchor at all, so it asks for more content evidence before preempting a
 *     header candidate.
 * All three are gated on a {@link PROSE_MIN_WORDS}-word floor — the same
 * floor {@link isProseLine} uses — so a short label (every reject case in
 * `line-primitives.below-anchor-prose.test.ts` is under 8 words) never
 * qualifies regardless of its connector words.
 *
 * A parenthesized qualifier is stripped before any count runs. A role title
 * routinely carries one ("Quality Assurance Intern (40 hours per week)",
 * "Peer Tutor (15 to 20 hours per week)" — both real ground-truth titles in
 * `google-docs-skia-proxy-role-first-experience.truth.json`): short once the
 * parenthetical is removed, but AT the 8-word floor with 2-3 lowercase
 * content words INSIDE it, which false-positived this signal before the strip
 * and dropped the second role's title outright. A genuine unbroken sentence
 * is unaffected either way — removing a parenthetical aside never turns a
 * real 13-word description into a phrase under the floor.
 *
 * A single leading Title-Cased word is not itself evidence either way — a
 * genuine sentence's own sentence-initial word looks identical — UNLESS the
 * word immediately after it is a bare gerund/participle (PR #1089 review): "X
 * serving enterprise clients…" / "Team supporting analytics…" is the shape a
 * one-line company-plus-tagline header takes, never a real sentence (a real
 * sentence needs a finite verb, not a bare "-ing" form, right after its
 * subject). Checked BEFORE the adjacency loop below so a single-word company
 * name glued to its tagline by {@link buildEntryBlock}'s wrap-fold doesn't
 * survive as "exactly one capitalized word" and get read as prose, silently
 * dropping the name.
 */
const NON_GERUND_ING_WORDS = new Set([
  "during", "spring", "string", "morning", "evening",
  "something", "anything", "everything", "nothing",
]);
function isBareGerund(word: string): boolean {
  const bare = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  return (
    LOWERCASE_WORD_RE.test(bare) &&
    bare.length > 4 &&
    bare.endsWith("ing") &&
    !NON_GERUND_ING_WORDS.has(bare)
  );
}
function looksLikeUnpunctuatedRunningSentence(text: string): boolean {
  const withoutParens = text.replace(/\([^)]*\)/g, " ");
  if (withoutParens.includes(",")) return false;
  const words = withoutParens.split(/\s+/).filter(Boolean);
  if (words.length < PROSE_MIN_WORDS) return false;
  let leadingCapRunEnd = 0;
  while (leadingCapRunEnd < words.length && /^[A-Z]/.test(words[leadingCapRunEnd])) {
    leadingCapRunEnd++;
  }
  if (
    leadingCapRunEnd === 1 &&
    leadingCapRunEnd < words.length &&
    isBareGerund(words[leadingCapRunEnd])
  ) {
    return false;
  }
  let contentWords = 0;
  for (let i = 0; i < words.length; i++) {
    if (isLowercaseContentWord(words[i])) contentWords++;
    if (i > 0 && /^[A-Z]/.test(words[i - 1]) && /^[A-Z]/.test(words[i])) {
      return false;
    }
  }
  return contentWords >= 2;
}

/**
 * True when a below-anchor line reads as a **role-scope sentence** by grammar
 * alone: it leads with an action verb AND carries a lowercase **content** word
 * after that lead — a word that is neither Title-Cased nor a closed-class
 * connector.
 *
 * This is #708's signal, and it exists because both of that issue's shapes are
 * invisible to the punctuation-keyed signals:
 *
 *   - `"Owned the build system roadmap and tooling budget"` — no `;`, no grade
 *     code, no terminator at all; and
 *   - `"Led the observability migration off Northwind Systems Inc."` — ends on
 *     a real legal-entity suffix, which {@link LEGAL_TERMINAL_SUFFIX_RE}
 *     cannot tell apart from `"Contoso, Inc."` by the terminal token alone.
 *
 * Both filled an empty `team` slot, which the exported org header line and
 * `ReconstructedRole` then render as a team name.
 *
 * The verb set is the shared {@link ACTION_VERBS} lexicon, reached through
 * {@link startsWithActionVerb} — the same question, and the same answer,
 * `looksLikeRoleHeaderTitle` already asks in `experience.ts` when it rejects a
 * title-shaped candidate that is really accomplishment prose (#662). Sharing
 * the lexicon is what keeps the two layers from drifting on what "verb-led"
 * means.
 *
 * **The lowercase-word requirement carries the precision, and dropping it
 * breaks real résumés.** Several lexicon verbs are also participial adjectives
 * that lead genuine header lines — "Managed Services Consultant", "Integrated
 * Systems Engineer", "Automated Logic Corporation", "Unified Communications
 * Lead". A verb lead ALONE preempts all four, turning a real title or company
 * into a bullet. What separates them from a sentence is that a header line is
 * Title Case throughout while a sentence needs function words ("the", "and",
 * "off") — the same Title-Case-tail reasoning {@link isProseLine} uses to keep
 * a "Company. City, State" header out of the prose class (#341).
 *
 * **A lowercase-initial word is not enough on its own, though (#708).**
 * Title-Cased org names routinely carry a lowercase CONNECTOR — "Planned
 * Parenthood of Greater Ohio", "Managed Services for Healthcare", "Integrated
 * Systems of America", "Secured Lending of the Midwest" — and every one of
 * those leads with a lexicon verb, so a bare lowercase-initial test preempts
 * the employer line out of the header run entirely: `company` comes back
 * empty, the name is emitted as a description bullet, and (because the line is
 * usually "Company, City, ST") the `location` goes with it. What a name never
 * carries is a lowercase **content** word: an ordinary noun/verb/adjective
 * like "build", "roadmap", "observability", "migration". So the test is a
 * lowercase word MINUS the closed {@link HEADER_CONNECTOR_WORDS} class, which
 * is what {@link isLowercaseContentWord} decides.
 *
 * Requiring ≥2 lowercase-initial words instead would clear the first three
 * shapes but not "Secured Lending of the Midwest" (two connectors), and it
 * would still miss any two-connector name ("Bank of the West"); requiring a
 * connector to be PRESENT is inverted — "of" is exactly what those names
 * carry. Keying on the content word is the discriminator that holds in both
 * directions.
 *
 * The check runs over the words AFTER the verb, so the verb's own casing is
 * irrelevant. A token that is not a bare lowercase word ("3", "P&L,",
 * "Northwind", "eBay") is neither evidence for nor against, so `some` simply
 * keeps looking.
 *
 * The residue is one-sided and fails CLOSED — a scope line whose only
 * lowercase words are connectors ("Led the Payments Platform for the Americas")
 * is NOT caught and falls through to the header path, exactly as it did before
 * #708. This is not a narrow, single-example gap: measured against 12
 * realistic Title-Cased scope lines, about half (6 of 12) have no lowercase
 * word other than a connector and are missed (#843 item 3) — e.g. "Owned the
 * Global Risk and Compliance Portfolio", "Managed the EMEA Sales
 * Organization", "Drove the Cloud Migration across Europe". Widening to reach
 * them would want its own repro, per this module's rule that each widening is
 * pinned by the shape that motivated it.
 */
/** Closed-class connectors that appear INSIDE genuine Title-Cased org and role
 *  names, and so carry no prose evidence. Articles, the two coordinating
 *  conjunctions, the prepositions English company names actually use, and the
 *  nobiliary/locative particles non-English ones do ("Unified Communications
 *  de Mexico", "Automated Logic van Nuys") — #843 item 1. Deliberately a
 *  REJECT list: adding a word here only makes {@link looksLikeVerbLedScope}
 *  more conservative (fewer preempts), which is the safe direction — a missed
 *  scope line lands in `team` as it did before #708, while a preempted
 *  employer line loses `company` outright. */
const HEADER_CONNECTOR_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "with",
  "at", "by", "in", "on", "from", "off", "across",
  "de", "del", "la", "van", "von", "di", "da", "du", "der", "y",
]);
/** A bare all-lowercase word — letters only, apostrophes/hyphens allowed
 *  inside. Excludes mixed-case brand tokens ("eBay", "iRobot"), which lead
 *  lowercase but are names, not prose. */
const LOWERCASE_WORD_RE = /^\p{Ll}[\p{Ll}\p{M}'’-]*$/u;
function isLowercaseContentWord(word: string): boolean {
  // Strip edge punctuation but keep digits (#843 item 2): a letters-only strip
  // ate the digit off an ordinal ("1st" → "st", "3rd" → "rd"), so "Managed 1st
  // Choice Health" read "st" as a lowercase content word and the line
  // preempted out of the header run. Keeping `\p{N}` at the edges leaves "1st"
  // / "2nd" / "3rd" failing `LOWERCASE_WORD_RE` outright (a leading digit is
  // not `\p{Ll}`), with no change to any token that was already letters-only.
  const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return LOWERCASE_WORD_RE.test(bare) && !HEADER_CONNECTOR_WORDS.has(bare);
}
function looksLikeVerbLedScope(text: string): boolean {
  if (!startsWithActionVerb(text)) return false;
  const [, ...rest] = text.trim().split(/\s+/);
  return rest.some(isLowercaseContentWord);
}

/**
 * True when a middot-separated line reads as **role-scope metadata** rather
 * than a header — specifically the shape #615 variant 3 names by example:
 * "L7 · 18 engineers, 2 TLMs reporting" and its cousins ("M4 · 22 engineers,
 * 3 squads", "L6/L7 · 30 engineers").
 *
 * A middot header is `Title · Company` / `Title · Company · Team` and the
 * disambiguator handles it. A middot-metadata line ALSO uses ` · ` as a
 * separator but leads with a **grade-code segment** (1–3 uppercase letters
 * followed by 1–2 digits, whole segment, optionally slash-joined for
 * dual-track "L6/L7" leveling), which no title / company / team / location
 * ever is. That first-segment shape is the whole discriminator here — a
 * cheap, high-precision preempt.
 *
 * Deliberately narrow, PR #688 review B3: middot lines that don't lead with
 * a grade code fall through to disambiguation as usual, so a legitimate
 * "Software Engineer · Google" header still routes correctly. Widening
 * (quantity-plus-role-noun anywhere in the line, generic "any segment that
 * looks like nothing else does") would want its own repro + tests — this
 * predicate closes the issue's named variant and stops there. Follow-ups
 * that widen it should add their own regression cases.
 *
 * Module-private, called only from {@link looksLikeBelowAnchorProse} — kept a
 * named function rather than an inlined branch so a future widening and its
 * tests key on this specific shape instead of sinking into the general
 * predicate. Export it when a second caller actually exists; exporting it
 * ahead of one is the forward-staging `fallow` flags as dead code.
 */
const MIDDOT_METADATA_GRADE_CODE_RE =
  /^[A-Z]{1,3}\d{1,2}(?:\/[A-Z]{1,3}\d{1,2})*$/;
function looksLikeMiddotMetadata(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.includes(MIDDOT)) return false;
  // Looser than the contract's `MIDDOT_SPLIT_RE` on purpose: a metadata
  // line is source text, not our own export, so it may glue the glyph to a
  // segment ("L7·18 engineers"). The membership test above is the shared byte.
  const segments = trimmed.split(/\s*·\s*/).filter((s) => s.length > 0);
  if (segments.length < 2) return false;
  return MIDDOT_METADATA_GRADE_CODE_RE.test(segments[0]);
}

/**
 * A page running-header / footer line — the candidate's own name + "Resume" /
 * "Résumé" / "CV" / "Curriculum Vitae" furniture a continuation page repeats at
 * its top or bottom (often beside a date and a page number, e.g. "June 10, 2026
 * Jane Doe Resume 2" / "Jane Doe · Résumé 1"). When an entry-style section
 * (experience, projects, education, or an achievements-family section) spans a
 * page break, that furniture line lands mid-section and would otherwise become
 * an entry header (a role's company/title) or contaminate a description blob
 * (#225, generalized #283). A genuine entry line never carries the word
 * résumé/CV, so keying on it is a safe, content-free strip. Matched
 * case-insensitively and accent-tolerantly (`Résumé`/`Resume`).
 *
 * NB: `\b` is unreliable around the accented `é` (not a `\w` char in JS regex),
 * so we anchor on the ASCII-letter side only: `(?<![A-Za-z])` … `(?![A-Za-z])`.
 * These spelled-out forms are rare inside an entry title, so a letter boundary
 * is a safe key.
 */
const PAGE_FURNITURE_RE =
  /(?<![A-Za-z])(r[ée]sum[ée]|curriculum\s+vitae)(?![A-Za-z])/i;

// The bare two-letter "CV" is far easier to hit by accident inside content — a
// parenthesised domain acronym ("Cardiovascular (CV) Fellowship"), a hyphenated
// code ("CV-204"), a journal short-name — so it strips a real entry if keyed on
// a letter boundary alone. Require it to stand alone between whitespace / line
// ends, which the running-header form ("Jane Doe · CV", "Name CV 2") satisfies
// but a punctuation-adjacent in-content "CV" does not.
const CV_FURNITURE_RE = /(?:^|\s)cv(?:$|\s)/i;

/** True when the line is page running-header/footer furniture, not content.
 *  Shared by the achievements extractor and the entry-block parser so a footer
 *  that lands mid-section on a page break is stripped on every entry path. */
export function isPageFurniture(line: PdfLine): boolean {
  return PAGE_FURNITURE_RE.test(line.text) || CV_FURNITURE_RE.test(line.text);
}

/** Multi-word US cities recognized by BOTH the whole-string `BARE_LOCATION_RE`
 *  (case-insensitive) and the embedded-fold `KNOWN_MULTIWORD_US_CITY_RE`
 *  (case-sensitive Title-case). Single source of truth so the two can't drift
 *  apart. Longest-first so "New York City" wins over "New York" in the embedded
 *  alternation (regex first-match); order is irrelevant for the `^…$`-anchored
 *  `BARE_LOCATION_RE`.
 *
 *  Silicon-Valley/Peninsula additions (#616): "Mountain View", "Palo Alto",
 *  "Menlo Park" are the multi-word tech-hub cities that show up co-located
 *  with Globex/Meta/Stanford in a `Title · Company, City · Team` middot header
 *  with NO trailing state suffix. Without the vocab entry, Pass F of
 *  `stripLocationSuffix` (bare-city tail check) failed to full-match them and
 *  the middle segment stayed whole ("Globex, Mountain View" → company). Same
 *  closed-vocab discipline as the pre-existing entries: a real company that
 *  merely contains one of these tokens ("Mountain View Software") still fails
 *  the `^…$`-anchored full-string match.
 *
 *  #634 review follow-up: "Santa Clara", "Redwood City" and "Ann Arbor" close
 *  the three headers the review reproduced as still-broken (Nvidia, Meta, Ford).
 *  They do NOT make the vocabulary complete — this list is a closed set by
 *  design, so any multi-word city outside it still folds into `company`. That
 *  narrowing is the standing limitation of the approach, not a bug to be fixed
 *  by growing the list without bound; see `experience.multiword-city.test.ts`,
 *  which pins both halves (a listed city splits; an unlisted one does not, and
 *  a company merely containing a listed city stays whole). */
export const MULTIWORD_US_CITY_ALT =
  "New York City|New York|New Orleans|San Francisco|San Diego|San Jose|San Antonio|Los Angeles|Las Vegas|Salt Lake City|Mountain View|Palo Alto|Menlo Park|Santa Clara|Redwood City|Ann Arbor";

/** Bare city/region names (no "City, ST" state tail, so `US_LOCATION_RE` misses
 *  them) that show up as a `"Title, Location"` header tail — must NOT be cleaved
 *  off as the company. Exact whole-string match keeps a real company that merely
 *  contains a city word ("New York Times", "Boston Consulting") splittable. */
export const BARE_LOCATION_RE = new RegExp(
  `^(remote|hybrid|on-?site|${MULTIWORD_US_CITY_ALT}|washington|washington d\\.?c\\.?|boston|chicago|seattle|austin|denver|portland|atlanta|dallas|houston|phoenix|miami|detroit|philadelphia|pittsburgh|minneapolis|nashville|charlotte|columbus|indianapolis|baltimore|sacramento|raleigh|london|paris|berlin|munich|tokyo|singapore|bangalore|bengaluru|mumbai|delhi|hyderabad|toronto|vancouver|sydney|melbourne|dublin|amsterdam)$`,
  "i",
);

/** Trailing field-separator glyphs left dangling once a wrapped location is
 *  unwrapped ("Acme Consulting, _Springfield, IL_," → "…Springfield, IL,") —
 *  the same trailing set `experience-disambiguate.ts`'s `stripDanglingSeparator`
 *  trims after peeling a location suffix. Exported so that caller reuses this
 *  literal instead of carrying a second copy — `experience-disambiguate.ts`
 *  already imports from this module (see {@link unwrapEmphasisLocation}), so
 *  importing the regex too doesn't add a new edge to the graph. */
export const TRAILING_SEPARATOR_RE = /[\s,–—\-|·]+$/;

/** Whole-string "City, Region, Country" — a 3-part international location cell
 *  ("Bengaluru, KA, India") that none of `US_LOCATION_RE` / `INTL_LOCATION_RE`
 *  (2-part only) cover (#1125). The region token is a SUB-NATIONAL code
 *  ("KA" for Karnataka, "ON" for Ontario) that varies per country, so — unlike
 *  `US_STATE_CODE_RE` — there is no closed vocabulary to validate it against;
 *  the trailing country group still goes through the same `COUNTRY_GAZETTEER`
 *  closed-vocabulary check every other international branch here uses, which
 *  is what keeps a coincidental three-comma phrase from full-matching:
 *  nothing reads as this shape unless its LAST segment is a real country. */
const INTL_LOCATION_3PART_RE =
  /^([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+){0,2}),\s*([A-Z]{2}),\s*([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+){0,2})$/;

/**
 * Unwrap a markdown-emphasis pair (`_..._`) that wraps a location, dropping
 * the pair and any trailing separator left dangling after its close, ONLY
 * when the wrapped interior reads as a complete location (recursively, via
 * {@link isBareLocationString}) — the same closed-vocabulary discipline every
 * location predicate in this module applies, so a literal `snake_case_name`
 * or SDK symbol elsewhere in the text is never mistaken for emphasis.
 *
 * Scans every `_..._` pair in `s`, not just the first: a header can carry an
 * unrelated emphasis run before the location one ("Senior Engineer
 * (_Contract_), Acme Consulting, _Springfield, IL_,"), and bailing on the
 * first pair's vocabulary miss would ship the real trailing location with its
 * literal underscores still attached.
 *
 * Also requires each pair to be non-intraword, CommonMark's own test for
 * whether `_..._` is emphasis at all (the character immediately outside each
 * underscore must not be a word character) — without it, an ordinary
 * snake_case token that happens to sandwich a 2-letter state code
 * ("Manager_IN_Training") reads as a wrapped "IN" and gets stripped down to
 * "ManagerINTraining". Known gap, deliberately not chased: `\w` also counts
 * `_` itself, so a doubled-underscore (bold, `__..__`) wrapper reads as
 * intraword on both sides and is left fully untouched. Narrowing the check
 * to letters/digits only trades that no-op for a worse one — the regex's
 * `[^_]+` core still can't cross the inner pair of underscores, so it would
 * unwrap only the innermost `_..._` and leave one stray literal underscore
 * on each side rather than none. Emphasis (`_..._`) is the shape #1034's
 * PDFs exercise; bold-wrapped locations haven't shown up in the corpus.
 *
 * Fixes the literal-underscore residue left by a PDF whose source was
 * exported by a Markdown renderer that printed emphasis syntax as glyphs on
 * the page instead of applying it (#1034) — that text reaches the parser as
 * ordinary characters, so neither `mdToPlainText` nor `markdown-lines.ts`'s
 * own emphasis strip (which only ever sees real markdown source) ever touches
 * it. Leaves `s` unchanged when no pair both qualifies as emphasis and reads
 * as a location.
 *
 * Shared by {@link isBareLocationString} (the whole-string case — a location
 * with nothing else on its line) and `experience-disambiguate.ts`'s
 * `stripLocationSuffix` (the suffix case — a location glued after a company),
 * so a header line and a bare location cell parse to the same clean value
 * regardless of which field the emphasis run landed in.
 *
 * Unwraps every qualifying pair it finds, not just the first: a header can
 * carry an earlier emphasis run that independently reads as a location too
 * ("Senior Engineer, _Remote_, Acme Consulting, _Springfield, IL_,") —
 * stopping at that first success would leave the real trailing location's
 * underscores in place.
 */
export function unwrapEmphasisLocation(s: string): string {
  const re = /_([^_]+)_/g;
  let result = "";
  let copiedThrough = 0;
  let unwrappedAny = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const before = m.index > 0 ? s[m.index - 1] : undefined;
    const afterIndex = m.index + m[0].length;
    const after = afterIndex < s.length ? s[afterIndex] : undefined;
    const isIntraword = (before !== undefined && /\w/.test(before)) || (after !== undefined && /\w/.test(after));
    if (isIntraword || !isBareLocationString(m[1].trim())) continue;
    result += s.slice(copiedThrough, m.index) + m[1].trim();
    copiedThrough = afterIndex;
    unwrappedAny = true;
  }
  if (!unwrappedAny) return s;
  result += s.slice(copiedThrough);
  return result.replace(TRAILING_SEPARATOR_RE, "").trim();
}

/**
 * True when `s` is ENTIRELY a bare location string — a lone US state code, a
 * bare well-known city, or a "City, ST" / "City, Country" shape that spans the
 * WHOLE string (not merely a trailing suffix). The full-length check on the
 * US/intl matches distinguishes a self-contained location ("Pomona, CA",
 * "Mountain View, CA") from a company that merely carries a trailing city
 * ("Globex, Toronto, Canada", where INTL_LOCATION_RE matches only a substring).
 *
 * Shape is NOT sufficient — the comma-tail must resolve against a REAL location
 * signal, not merely a "CapWords, CapWords" shape. `US_LOCATION_RE` /
 * `INTL_LOCATION_RE` are generic Title-Case-pair matchers (regex.ts:42/45), so
 * on their own they full-match a comma-formatted job title whose role word is
 * outside the finite `looksLikeTitle` keyword list ("Buyer, Home Goods",
 * "Merchandiser, Footwear", "Barista, Downtown Store"), silently erasing a real
 * title into `location` (the #325 step-5 rescue false-positive class). So each
 * shape branch additionally requires its tail to be in a CLOSED vocabulary — a
 * valid 2-letter USPS code (`US_STATE_CODE_RE`) or a real country
 * (`COUNTRY_GAZETTEER`) — the same closed-vocabulary discipline
 * `stripLocationSuffix` already applies. A generic Title-Case tail
 * ("Home Goods", "Footwear") is in neither set and stays a title.
 *
 * The single shared bare-location predicate in {@link disambiguateCompanyTitle}:
 * the step-3a rotate-guard (negated — a rotatable "Company, City, Country" is
 * NOT a whole-string location), the step-3b `team`→location rescue, and the
 * step-5 `title`→location rescue all route through it, so the same closed-vocab
 * discipline gates every path and no branch can reintroduce the shape-only leak.
 *
 * Lives here rather than in `experience-disambiguate.ts` (#891) because
 * `entry-blocks.ts` — which sits BELOW the extractors — needs the same
 * vocabulary to qualify a flush-right trailer before it peels one
 * (`peelFlushRightLocation`). Sharing the predicate is what keeps the two
 * layers from disagreeing about what counts as a location.
 */
export function isBareLocationString(s: string): boolean {
  return resolveBareLocationString(s) !== undefined;
}

/**
 * Like {@link isBareLocationString}, but returns the CLEANED value (emphasis
 * unwrapped, #1034) instead of a boolean, for the callers that go on to store
 * the string as the parsed `location` — `locationFromAnchorCell` and the
 * `team`/`title`→location rescues in `experience-disambiguate.ts`. Returning
 * the raw `s` on a match would ship the literal `_Springfield, IL_` glyphs the
 * unwrap exists to remove; `isBareLocationString` itself only needs the
 * boolean, so it stays a thin wrapper over this.
 */
export function resolveBareLocationString(s: string): string | undefined {
  // Unwrap a whole-string markdown-emphasis wrapper first (#1034) — a no-op
  // (returns `s` itself) whenever `s` carries no `_..._` pair, so the common
  // case pays only one extra regex test.
  const cleaned = unwrapEmphasisLocation(s);
  const usLoc = US_LOCATION_RE.exec(cleaned);
  const intlLoc = INTL_LOCATION_RE.exec(cleaned);
  const intl3 = INTL_LOCATION_3PART_RE.exec(cleaned);
  const isBare =
    US_STATE_CODE_RE.test(cleaned) ||
    BARE_LOCATION_RE.test(cleaned) ||
    (usLoc !== null && usLoc[0].length === cleaned.length && US_STATE_CODE_RE.test(usLoc[2])) ||
    (intlLoc !== null &&
      intlLoc[0].length === cleaned.length &&
      COUNTRY_GAZETTEER.has(intlLoc[2].toLowerCase())) ||
    (intl3 !== null && COUNTRY_GAZETTEER.has(intl3[3].toLowerCase()));
  return isBare ? cleaned : undefined;
}

/**
 * A US street-address line: a leading house number, then the street, then the
 * locality, then an optional ZIP. `US_LOCATION_RE` is a plain substring
 * matcher with no notion of an address around it, so run over a line like
 * this it captures the street name as part of the city ("Main Street City,
 * ST" out of "4567 Main Street City, ST 98052", #837). Detected here so the
 * locality is taken from the address's own tail rather than from wherever the
 * greedy 3-token run happens to start.
 */
const US_STREET_ADDRESS_RE = /^\s*\d+\s+\S/;

/**
 * Street-type word (or a bare unit marker `#`) that ends a street name and
 * opens the locality on an address-shaped line: "4567 Main STREET City, ST"
 * → everything after "Street" is the locality. Deliberately closed and not an
 * attempt to parse the address in full — only to find where the street ends.
 *
 * The trailing `\s*,?\s+` admits BOTH shapes an address line draws: the
 * street type running straight into the city with no punctuation ("Main
 * Street City, ST") and the city set off from the street by its own comma
 * ("123 Example Way, Springfield, IL") — the comma is optional, but at least
 * one whitespace character after it (or after the word, when there is no
 * comma) is required so the match can't land mid-word.
 *
 * "Circle", "Highway", "Parkway", "Trail", "Loop", "Square", "Crescent",
 * "Pike", "Row" and "Walk" joined the original suffix list (PR #1126 review):
 * a line ending in one of them ("4567 Main Circle City, ST 98052") used to
 * fail {@link isAddressShapedLine} outright and fall through to the unguarded
 * `US_LOCATION_RE` greedy match, reproducing #837's exact bug. Global (`g`)
 * so {@link lastStreetTypeMatchEnd} can walk every occurrence in a line, not
 * just the first — callers that only need the first match reset `lastIndex`
 * before and after their own `exec`.
 *
 * The street-type word itself is captured (group 1, undefined for the bare
 * `#` branch) so {@link lastStreetTypeMatchEnd} can tell a real suffix match
 * apart from an abbreviated "St."/"Ste." that is actually "Saint" opening a
 * place name ("St. Petersburg", "Ste. Anne") — see that function's
 * `isSaintAbbreviation` guard.
 */
const STREET_TYPE_RE =
  /(?:\b(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Suite|Apt|Circle|Cir|Highway|Hwy|Parkway|Pkwy|Trail|Loop|Square|Sq|Crescent|Pike|Row|Walk)\b\.?|#)\s*,?\s+/gi;

/**
 * True when `matchedWord` (group 1 of a `STREET_TYPE_RE` hit, ending right
 * before `tailAfterMatch`) is SHAPED like an abbreviated "St."/"Ste." that
 * could read as "Saint" rather than as the street-type word "Street"/
 * "Suite" — i.e. it is followed by a capitalized word, the shape a place
 * name takes ("St. Petersburg", "St. Louis", "Ste. Anne"). Spelled-out
 * "Street"/"Suite" is never shaped this way and is excluded by the
 * `/^ste?$/` test alone.
 *
 * Shape alone does not make it ambiguous, though — see
 * {@link lastStreetTypeMatchEnd}, the only caller, for why: a LONE "St."/
 * "Ste." match is the only closer the line has, so it must be the street
 * suffix regardless of what follows it ("4567 Main St, Springfield, IL" —
 * origin/main's own un-guarded reading, and the one a too-eager guard here
 * regressed, PR #1126 follow-up). This predicate only answers "does this
 * match look like it could be Saint"; the caller decides whether another
 * match exists to make that reading safe to act on.
 */
function isSaintAbbreviation(matchedWord: string | undefined, tailAfterMatch: string): boolean {
  return matchedWord !== undefined && /^ste?$/i.test(matchedWord) && /^[A-Z]/.test(tailAfterMatch);
}

/**
 * End index of the LAST usable `STREET_TYPE_RE` match whose START precedes
 * `text`'s first comma (or anywhere in the string, when there is none) — the
 * boundary a street name carrying two street-type words needs. A line like
 * "5 Avenue Road Toronto, ON" matches `STREET_TYPE_RE` at both "Avenue" and
 * "Road"; cutting the tail after the FIRST match glues the second onto the
 * locality ("Road Toronto, ON" instead of "Toronto, ON", PR #1126 review).
 *
 * An "St."/"Ste." match shaped like "Saint" (see {@link isSaintAbbreviation})
 * is skipped as a candidate cut point ONLY when another, unambiguous
 * street-type match exists in the line to serve as the real one — so a
 * trailing "St. Petersburg" in "4567 Main Street St. Petersburg, FL" isn't
 * mistaken for a second street-type word ahead of "Street", and a leading
 * "St. Charles" in "123 St. Charles Avenue New Orleans, LA" isn't mistaken
 * for the real street-type word when "Avenue" is (PR #1126 follow-up
 * review). But nearly every city name is capitalized, so that same shape
 * test fires on the ORDINARY "St" abbreviation too: "4567 Main St,
 * Springfield, IL" has no second match to fall back on, and skipping its
 * lone "St" unconditionally would drop `location` entirely — a working case
 * turned into a regression (PR #1126 round 2). A lone "St"/"Ste" is never
 * "Saint"; it is the only closer there is, so it must be trusted — UNLESS
 * nothing but the house number (and, optionally, a unit designator —
 * "4567 Unit 12 St. Petersburg, FL", #1173) precedes it ("100 St.
 * Petersburg, FL"): a street suffix needs a street NAME to close, and a
 * unit designator is not one, so there the lone "St." opens the city, and
 * the returned cut is the match's START, keeping "St." in the tail (PR
 * #1126 round 3; #1173).
 *
 * Filters by each match's START position rather than slicing the text before
 * matching: `STREET_TYPE_RE`'s own trailing `\s*,?\s+` consumes the comma
 * that sets a city off from its street ("Way**, **Springfield"), so handing
 * it a region truncated AT that comma strands the match with nothing to
 * close on and it fails outright — the exact regression a first attempt at
 * this fix introduced (caught by `corpus.test.ts`'s baked snapshots, not by
 * the hand-picked unit cases above, none of which happened to need a street
 * word immediately before a comma). Scanning the full string and discarding
 * only matches that START after the first comma gets the same "street words
 * don't live in the locality tail" guard {@link isAddressShapedLine} applies,
 * without truncating the text the regex itself still needs to close its own
 * match against. Returns `undefined` when no qualifying street-type word is
 * found at all.
 */
/** Nothing but a leading house number, optionally followed by a unit
 *  designator — the prefix a street-type word has when no street NAME
 *  precedes it (see {@link lastStreetTypeMatchEnd}). A unit designator
 *  ("Unit 12", "Apt 4B", "No. 12", "#12"/"# 12") is not a street name
 *  either, so it must not make the guard below think one is there
 *  ("4567 Unit 12 St. Petersburg" — #1173). Anything else before the
 *  street-type word (a real street name, "4567 Main") is left unmatched
 *  on purpose: that is the ambiguous case the guard still defers to the
 *  "trust the lone match" branch for. The word-keywords require a space
 *  before the identifier so the keyword can't glue onto a street name
 *  that merely starts with it — "Apt" is a prefix of "Aptos", and without
 *  that space "4567 Aptos" parsed as "Apt" + "os" instead of being left
 *  unmatched as the ambiguous real-street-name case above (review on
 *  #1186). The identifier itself allows a hyphen ("Unit 12-A", a unit
 *  number with a sub-unit letter) so that case isn't left unmatched too
 *  (review on #1186); "#" keeps its optional space since "#12" has no
 *  keyword to glue onto. */
const HOUSE_NUMBER_PREFIX_RE =
  /^\s*\d+[A-Za-z]?(?:\s+(?:(?:Unit|Apartment|Apt\.?|No\.)\s+|#\s*)[A-Za-z0-9-]+)?\s*$/i;

function lastStreetTypeMatchEnd(text: string): number | undefined {
  const firstComma = text.indexOf(",");
  STREET_TYPE_RE.lastIndex = 0;
  const matches: { start: number; end: number; isSaintShaped: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = STREET_TYPE_RE.exec(text)) !== null) {
    if (firstComma !== -1 && m.index > firstComma) break;
    const matchEnd = m.index + m[0].length;
    matches.push({
      start: m.index,
      end: matchEnd,
      isSaintShaped: isSaintAbbreviation(m[1], text.slice(matchEnd)),
    });
  }
  STREET_TYPE_RE.lastIndex = 0;
  if (matches.length === 1) {
    const [lone] = matches;
    // A suffix closes a street NAME, so a Saint-shaped "St."/"Ste." with only
    // the house number (plus an optional unit designator, which isn't a
    // name either, #1173) before it has no name to close: it opens the
    // place name instead ("100 St. Petersburg, FL"), and the tail starts AT it.
    if (lone.isSaintShaped && HOUSE_NUMBER_PREFIX_RE.test(text.slice(0, lone.start))) {
      return lone.start;
    }
    // Otherwise a lone match is the only closer the line has — trust it even
    // if it is "St"/"Ste"-shaped, since there is no other candidate to defer to.
    return lone.end;
  }
  let end: number | undefined;
  for (const match of matches) {
    if (!match.isSaintShaped) end = match.end;
  }
  return end;
}

/**
 * `US_STREET_ADDRESS_RE` alone matches any line that merely starts with a
 * digit — a header tagline like "15 years of experience, Austin, TX" passes
 * it despite carrying no address, and routing it into the address-only
 * branch below loses `location` entirely (`extractLocalityFromAddressLine`
 * finds no `STREET_TYPE_RE` word and returns `undefined`, with no
 * document-wide fallback to recover it, #837). Require a street-type word
 * too, so a numeric-leading non-address line falls through to the plain
 * greedy match instead of being swallowed.
 *
 * A street-type word can also occur naturally far into an unrelated sentence
 * ("5 Austin, TX natives founded Park Avenue Ventures") — `STREET_TYPE_RE`
 * found "Avenue" there with no address in sight, which swallowed `location`
 * the same way a bare `US_STREET_ADDRESS_RE` match once did. An address
 * line's street-type word always precedes the comma that opens its locality,
 * so require the match to land at or before the first comma; a street-type
 * word appearing only after it is prose, not an address.
 */
export function isAddressShapedLine(text: string): boolean {
  if (!US_STREET_ADDRESS_RE.test(text)) return false;
  STREET_TYPE_RE.lastIndex = 0;
  const streetMatch = STREET_TYPE_RE.exec(text);
  STREET_TYPE_RE.lastIndex = 0;
  if (!streetMatch) return false;
  const firstComma = text.indexOf(",");
  return firstComma === -1 || streetMatch.index <= firstComma;
}

/**
 * One or more lowercase connectives that can open an international street
 * name's tail right after its street-type word — "Pl **des** Vosges", "Pl
 * **de la** Concorde", "Rue **von der** Vogelweide". `INTL_LOCATION_RE`
 * requires a leading capital, so on a tail like "des Vosges, Paris 75004" it
 * silently skips the lowercase "des" and matches starting at "Vosges"
 * instead, mis-pairing that STREET-name fragment with the real city
 * ("Vosges, Paris" instead of "Paris", PR #1126 review). A closed vocabulary
 * of the connective words a street name actually uses — the same closed-list
 * discipline as {@link HEADER_CONNECTOR_WORDS} above — strips a RUN of one or
 * more connectives (not just one: "de la Concorde" is two, "van den Berg" is
 * two) AND the capitalized word right after them (still the street name, not
 * the locality) before the location regexes ever see the tail. A single
 * trailing connective is not enough on its own — the original one-connective
 * form left "la" unstripped ahead of "Concorde" in "de la Concorde", and the
 * leftover lowercase "la" doesn't block `INTL_LOCATION_RE` from still
 * matching "Concorde, Paris", the exact street-fragment leak this regex
 * exists to prevent. Stripping can leave no comma-paired locality shape at
 * all ("Paris 75004" alone, no state/region to pair with) — that resolves to
 * `undefined` rather than a wrong answer, the same "missing beats wrong"
 * trade {@link extractLocalityFromAddressLine} already makes.
 */
const STREET_NAME_CONNECTIVE_RE =
  /^(?:(?:de|des|du|del|la|le|les|van|von|der|den|do|da)\s+)+[A-Z][A-Za-z.\-]*\s*/;

function stripLeadingStreetConnective(tail: string): string {
  return tail.replace(STREET_NAME_CONNECTIVE_RE, "");
}

/**
 * Locality out of an address-shaped line's tail — the text after the LAST
 * street-type word (see {@link lastStreetTypeMatchEnd}) — rather than the
 * greedy `US_LOCATION_RE` match against the whole line, which would fold the
 * street name into the city. Tries the two-letter-state shape first;
 * `allowIntlFallback` additionally tries `INTL_LOCATION_RE`'s looser shape so
 * a spelled-out state ("Springfield, California") or an international
 * locality ("Bengaluru, India") in the tail still resolves —
 * `INTL_LOCATION_RE` is a strict superset of `US_LOCATION_RE`'s pattern, so
 * trying it second never overrides a correct two-letter-code match. The
 * caller gates the fallback so an address line can't resolve via
 * international shape before `extractLocation`'s plain-US pass has had a
 * chance at every line (#837 follow-up — see there). Returns `undefined` when
 * no street-type word is recognized, or the tail carries no recognizable
 * locality shape at all: a missing `location` costs a little score
 * completeness, a wrong one is printed on the user's exported résumé (#837).
 */
export function extractLocalityFromAddressLine(
  text: string,
  allowIntlFallback: boolean,
): string | undefined {
  const tailStart = lastStreetTypeMatchEnd(text);
  if (tailStart === undefined) return undefined;
  const tail = stripLeadingStreetConnective(text.slice(tailStart));
  const us = US_LOCATION_RE.exec(tail);
  if (us) return us[0];
  if (!allowIntlFallback) return undefined;
  const intl = INTL_LOCATION_RE.exec(tail);
  return intl && !/@/.test(intl[0]) ? intl[0] : undefined;
}

/** Collapse internal whitespace and trim — the canonical date-token normalizer. */
export function normalizeDate(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** True when a parsed date anchor is an unfilled Word/Office template placeholder
 *  ("Month Year", or a bare "Month"/"Year") rather than a real date. `DATE_RANGE_RE`
 *  admits these word placeholders so a template role still anchors/splits and the
 *  placeholder strips off the title — but the placeholder must NOT be recorded as a
 *  real date, or completeness would stop flagging the missing role dates. */
function isPlaceholderDate(token: string): boolean {
  return /^(?:month(?:\s+year)?|year)$/i.test(token.trim());
}

/** An end token that is ONLY an open-ended word — the test that decides
 *  `is_current`. Derived from the shared lexicon rather than spelled out, like the
 *  parser's other open-ended sites — and this is the one whose drift would not
 *  merely mis-strip text but stop a role being marked current (#931).
 *  Non-global, so `.test` is stateless across calls. */
const OPEN_ENDED_ONLY_RE = new RegExp(`^(?:${OPEN_ENDED_ALT})$`, "i");

/** Parse a date range (start/end) from a line. Tolerates M/YYYY, Mmm YYYY, YYYY,
 *  and Season YYYY[, YYYY] (branch (c) of DATE_RANGE_RE). */
export function parseDateRange(text: string): {
  start_date?: string;
  end_date?: string;
  is_current?: boolean;
} {
  // Try the paired DATE_RANGE_RE first.
  const m = DATE_RANGE_RE.exec(text);
  DATE_RANGE_RE.lastIndex = 0;
  if (m) {
    // Branch (c): Season YYYY, YYYY — m[5] is start ("Summer 2013"), m[6] is end year.
    if (m[5] !== undefined) {
      return { start_date: normalizeDate(m[5]), end_date: normalizeDate(m[6]) };
    }
    const start = normalizeDate(m[1] ?? m[3]);
    // An unfilled template range ("Month Year - ...") matched only to anchor and
    // strip the role header — it carries no real date, so report none. (A real
    // start with a placeholder end still keeps the start; see below.)
    if (isPlaceholderDate(start)) return {};
    const endRaw = m[2] ?? m[4];
    if (OPEN_ENDED_ONLY_RE.test(endRaw)) {
      return { start_date: start, is_current: true };
    }
    const end = normalizeDate(endRaw);
    return isPlaceholderDate(end)
      ? { start_date: start }
      : { start_date: start, end_date: end };
  }
  // Fall back to loose detection: the EARLIEST lone date token in the line.
  //
  // A lone (un-paired) date — a project or award dated "Jan. 2026" with no end
  // date — never matches `DATE_RANGE_RE`, which needs two anchors. It used to
  // decay here to the bare year, which had two consequences, not one: the date
  // lost its month, AND the month word survived in the entry title, because
  // `stripDateRange` only removes what a date regex matched ("tinylm | Link
  // Jan." · "2026", #380). So the month-anchored form is tried alongside the
  // bare year and the earlier of the two wins — preserving the long-standing
  // "first date token in the line" semantics for every line that has only a
  // bare year, while a `Mon. YYYY` is now captured whole. `stripDateRange`
  // removes exactly the same token, so the two stay in lockstep by
  // construction; anything else would re-leak the month into the title.
  //
  // STRICT_MONTH_YEAR_RE, not the loose MONTH_YEAR_RE: this is a date VALUE, and
  // the loose form's `[a-z]*` tail reads "Marketing 2020" as a month-year, so
  // "Head of Marketing 2020" would record start_date "Marketing 2020" and lose
  // the word from the title.
  const lone = STRICT_MONTH_YEAR_RE.exec(text);
  STRICT_MONTH_YEAR_RE.lastIndex = 0;
  const year = YEAR_RE.exec(text);
  YEAR_RE.lastIndex = 0;
  if (lone && (!year || lone.index <= year.index)) {
    return { start_date: normalizeDate(lone[0]) };
  }
  if (year) return { start_date: year[0] };
  return {};
}

/** Index of the earliest date-region token (month-year, numeric month/year, or
 *  a bare year) in `text`, or -1 if none. Marks where the right-hand date column
 *  begins so a wrapped header's left (org) and right (date) continuations fold
 *  back onto the correct side, and where {@link dateSeparator} looks for the
 *  punctuation that set the date off. The three source regexes are global; reset
 *  `lastIndex` before each scan so repeated calls are idempotent. */
export function dateRegionStart(text: string): number {
  let idx = -1;
  for (const re of [MONTH_YEAR_RE, NUMERIC_MONTH_YEAR_RE, YEAR_RE]) {
    re.lastIndex = 0;
    const m = re.exec(text);
    re.lastIndex = 0;
    if (m && (idx === -1 || m.index < idx)) idx = m.index;
  }
  return idx;
}

// Punctuation a résumé uses to set a trailing date off from the text before it.
// Two sets that have to be reasoned about TOGETHER:
//   - DATE_SEPARATOR_CHARS — what `dateSeparator` REPORTS, so a consumer (the
//     achievements header, the PDF exporter) can re-emit the source's own glyph.
//   - TRIMMED_SEPARATOR_CHARS — what `stripDateRange` REMOVES from the title
//     once the date is gone.
// A glyph the first set reports and the second leaves behind is kept TWICE —
// once on the title, once re-emitted by the consumer — and the doubling GROWS on
// every parse→export→re-parse cycle ("Tech Lead: 2020" → "Tech Lead:: 2020" →
// "Tech Lead::: 2020"). `;` and `:` were exactly that: reported, never trimmed.
// They are added to the trim here — no résumé title legitimately ends in a
// semicolon or a colon, so removing them is safe.
//
// The middot is the ONE deliberate asymmetry: it is reported (a source that
// wrote "Award · 2021" must get its middot back) but NOT trimmed, because a
// TRAILING " ·" is the org-signature marker the experience anchor-position
// tiebreak keys on (#298) and stripping it there mis-anchors the role. It does
// not double on the achievements path — `liftHeaderLabel` clears the dangling
// glyph before the title is stored — which the two-cycle round-trip test over
// every separator pins. Do not "fix" the asymmetry by adding `·` to the trim.
// `-` sits last in each class so it is a literal, never a range.
const DATE_SEPARATOR_CHARS = ",;:|·–—-";
const TRIMMED_SEPARATOR_CHARS = ",;:|–—-";
const DATE_SEPARATOR_RE = new RegExp(`([${DATE_SEPARATOR_CHARS}])\\s*$`);
const SEPARATOR_TRIM_RE = new RegExp(
  `^[\\s${TRIMMED_SEPARATOR_CHARS}]+|[\\s${TRIMMED_SEPARATOR_CHARS}]+$`,
  "g",
);

/**
 * The punctuation the source used between an entry's header text and its
 * trailing date — "Globex Engineering Excellence, 2021" → `","` — or undefined
 * when the date was set off by whitespace alone (or by nothing at all).
 *
 * `stripDateRange` deletes the date AND the separator that held it, so the
 * separator is source information that would otherwise be lost at parse. The
 * achievements header renders type/title/year as three separately editable
 * fields and therefore must re-emit SOME separator between them; without this it
 * hardcoded a middot and silently rewrote the résumé's comma (#380). Callers
 * fall back to the middot when this returns undefined — with no source
 * punctuation to honour there is nothing to preserve, and the fields still need
 * to be told apart.
 */
export function dateSeparator(text: string): string | undefined {
  const idx = dateRegionStart(text);
  if (idx <= 0) return undefined;
  const m = DATE_SEPARATOR_RE.exec(text.slice(0, idx));
  return m ? m[1] : undefined;
}

// A range whose START token is a bare SEASON ("Fall 2013 – Spring 2014",
// "Summer 2013, 2014"). Deliberately EXCLUDED from `isLoneDateRange` (see below).
const SEASON_LEAD_RE = new RegExp(String.raw`^${SEASON}\b`, "i");

/**
 * True when `text` is nothing but a month-year / year date range. The single
 * discriminator shared by two #425 flush-right-date call sites so they can never
 * drift: the section splitter's `flush()` exemption (which keeps a flush-right
 * date merged into the org line's `PdfLine` instead of splitting it off at the
 * wide same-y gap) and the ATS PDF model (which only routes a date to the
 * flush-right slot when it is one of these, keeping everything else glued into
 * the line's text). Reuses the shared `DATE_RANGE_RE` rather than a hand-rolled
 * pattern, and requires it to cover the ENTIRE trimmed run: a lone
 * `Jan 2024 – Present` / `2019 - 2021` qualifies, but a run carrying any other
 * text (a course name, a skill, an org fragment) does not — so a genuine
 * multi-column grid's trailing column still splits.
 *
 * `allowSingle: true` (#618) EXTENDS the predicate to also match a bare
 * `(19|20)\d{2}` single graduation year ("2023" — the common shape for
 * certificates, bootcamps, and non-degree programs), so an Education entry
 * with a lone year gets the same right-aligned slot a range gets. Every other
 * guard is preserved: the season-lead exclusion still applies (a bare year
 * has no season anyway), and the bare-numeric guard still holds — the
 * `^(?:19|20)\d{2}$` full-match ensures a bare `5000` (salary column) stays
 * a splittable grid column. `allowSingle` also intentionally does NOT admit
 * month-year (`May 2020`) or apostrophe-year (`'19`) alone; only bare 4-digit
 * years qualify. Used by the EXPORTER only (`experienceEntries`' `headerLineDate`
 * gate and `educationEntries`' `rightAlignEduDate`, both in
 * `ats-resume-model.ts`) — deliberately NOT applied to the parser-side
 * `columnGapCuts` in `sections.ts`, which stays range-only. Cited by symbol
 * rather than `path:line` on purpose: this docblock's own insertion shifted both
 * call sites, so the line numbers were stale in the commit that wrote them
 * (#620, #661).
 *
 * The parser side stays range-only for two reasons:
 *
 *  1. It is not needed, because `pdfjs` synthesizes a whitespace item across
 *     ANY wide intra-line gap — this is pdfjs behaviour for flush-right text in
 *     general, not a property of our own renderer. It extracts such a line as
 *     three items: the org text at the left margin, a synthesized whitespace
 *     item filling the wide gap, and the year at the right margin. Empirically
 *     that filler's width is set so the measured `x`-gap to the year is ≈ 0 pt,
 *     well under `COLUMN_GAP_THRESHOLD`, so `columnGapCuts` never computes a cut
 *     in the first place. Measured identically on our export and on the
 *     hand-drawn `drawRight` fixture, which never goes through
 *     `render-ats-pdf.ts` — so the reasoning covers third-party flush-right PDFs
 *     too, not only round-trips. Range and lone-year both re-parse cleanly.
 *
 *     This rests on a pdfjs implementation detail with no pinned contract. If an
 *     upgrade stopped emitting the filler the gap becomes ≈ 360 pt, far over
 *     `COLUMN_GAP_THRESHOLD`, and unlike the range path the lone-year path has
 *     NO `flush()` exemption to fall back on. What guards that is
 *     `render-roundtrip-education-lone-year.repro.test.ts`: it round-trips
 *     through pdfjs, so it is the test that pins this pdfjs behaviour and it
 *     fails loudly if the behaviour changes. Read it before a pdfjs bump.
 *
 *  2. It ACTIVELY breaks an external fixture. `columnGapCuts` also feeds
 *     `rowIsMultiColumn`, which drives embedded-column reorder detection —
 *     and admitting a lone year there flips a wrap-continuation row like
 *     `[Museum, 2024]` (the second physical line of a `[Company / Museum,
 *     May 2023 – / June 2024]` two-column entry) from "multi-column" to
 *     "single-column". That breaks the reorder chain and drops the whole
 *     entry, verified against
 *     `google-docs/google-docs-skia-proxy-multiline-bullets-coursework.pdf`
 *     where an Experience entry vanished from the count on the initial
 *     wider fix. So `allowSingle` stays opt-in and only the exporter opts in.
 *
 * Two shapes are deliberately NOT matched under DEFAULT mode (allowSingle=false),
 * so they stay glued rather than flush-right — both fully round-trip-safe
 * (gluing is the #430 behavior), and both narrowing the blast radius of this
 * core line-splitter change:
 *   - a bare single date/year: `DATE_RANGE_RE` needs two anchors, so a lone
 *     `2020` returns false (opt into it explicitly with `allowSingle: true`); and
 *   - a SEASON-led range (`Fall 2013 – Spring 2014`, `Summer 2013, 2014`): this
 *     exclusion is load-bearing for an EXTERNAL fixture, not our own export.
 *     `word/openresume-laverne-word-quartz.pdf` carries a flush-right honors
 *     rail — "Dean's List  … Fall 2013 – Spring 2014" / "Summer 2013, 2014" —
 *     and its committed corpus snapshot depends on those season rails staying
 *     SPLIT off the "Dean's List" label (dropping the exclusion re-parses the
 *     fixture and fails `corpus.test`, verified). Merging a season range onto its
 *     honors label mis-segments the label as a dated entry.
 *
 *     Why seasons but NOT a plain year-range honors line ("Dean's List
 *     2019 - 2021", which IS treated as a lone range and would merge): this is a
 *     deliberately NARROW, fixture-anchored carve-out, not a claim that every
 *     honors rail is excluded. Season ranges are near-exclusive to academic /
 *     honors contexts, so excluding them is low-collateral; a bare YEAR range is
 *     overwhelmingly a real employment/education date rail (the shape the
 *     exporter actually right-aligns), so excluding it too would defeat the
 *     flush-right round-trip it exists to protect. The #425 multi-row fix
 *     (`columnGapCuts` in `sections.ts`) does NOT subsume this: it stops ≥2
 *     adjacent date rails from being read as a column grid, but a single honors
 *     rail still reaches `flush()`, where merging vs. splitting is exactly what
 *     the season exclusion controls — so the carve-out is still required.
 */
export function isLoneDateRange(
  text: string,
  opts: { allowSingle?: boolean } = {},
): boolean {
  const t = text.trim();
  if (t.length === 0 || SEASON_LEAD_RE.test(t)) return false;
  // `DATE_RANGE_RE`'s bare-year anchor is `\d{4}`, so a plain numeric range that
  // is not a date ("5000 - 6000", a salary/score grid column) full-matches. Gate
  // on a real date signal: a plausible 19xx/20xx year, or any month / season /
  // slash / apostrophe / placeholder token (each of which carries a letter,
  // slash, or apostrophe). A bare non-year numeric range has none, so it stays a
  // normal splittable grid column instead of being merged as a flush-right rail.
  if (!/(?:19|20)\d{2}|[A-Za-z'/]/.test(t)) return false;
  // #618 — a bare `(19|20)\d{2}` graduation year qualifies under `allowSingle`.
  // Kept BEFORE the `DATE_RANGE_RE` match so the strict single-year shape is
  // recognised even though the range regex needs two anchors. The `^…$` full
  // match plus the numeric gate above keep the bare-numeric guard load-bearing:
  // `5000` stays out (fails the year gate) and so does `Institution 2023` (fails
  // the full-string anchor). Month-year and apostrophe-year alone stay out too
  // — only 4-digit 19xx/20xx years qualify.
  if (opts.allowSingle && /^(?:19|20)\d{2}$/.test(t)) return true;
  const m = DATE_RANGE_RE.exec(t);
  DATE_RANGE_RE.lastIndex = 0;
  return m !== null && m.index === 0 && m[0].length === t.length;
}

export function stripDateRange(text: string): string {
  // Remove the paired match and leftover year tokens.
  let cleaned = text.replace(DATE_RANGE_RE, "").trim();
  DATE_RANGE_RE.lastIndex = 0;
  cleaned = cleaned
    .replace(new RegExp(String.raw`\b(${OPEN_ENDED_ALT})\b`, "gi"), "")
    .trim();
  // Lone month-year tokens BEFORE bare years: a `Mon. YYYY` that no range
  // matched is one token, and removing its year first would strand the month in
  // the title ("… Link Jan.", #380). This is the exact token `parseDateRange`'s
  // lone-date fallback captures — the SAME strict regex, deliberately — so the
  // date the parser records and the text the title loses are the same run, and a
  // word that merely starts with a month prefix ("Marketing") is not eaten.
  cleaned = cleaned.replace(STRICT_MONTH_YEAR_RE, "").trim();
  STRICT_MONTH_YEAR_RE.lastIndex = 0;
  cleaned = cleaned.replace(YEAR_RE, "").trim();
  YEAR_RE.lastIndex = 0;
  // After year removal, bracket/paren pairs that held only the year are now
  // empty (e.g. "[2019]" → "[]", "(2019)" → "()"). Strip them.
  cleaned = cleaned.replace(/\[\s*\]|\(\s*\)/g, "").trim();
  // Trim the separator that held the date (and any leading counterpart).
  cleaned = cleaned.replace(SEPARATOR_TRIM_RE, "");
  SEPARATOR_TRIM_RE.lastIndex = 0;
  return cleaned;
}

// ── Entry-header shape (moved from entry-blocks.ts, #1106) ──────────────────
// These two predicates are pure text shape — no geometry, no segmentation — and
// the Download-PDF exporter needs `isEntryHeaderShape` to decide how a header
// renders. Housing them here, on the leaf every lane already reaches, keeps
// `ats-resume-model.ts` from importing the 1,900-line segmenter for eight lines.

/** True when the whole trimmed line is essentially JUST a date / date-range — a
 *  bare year, a month-year, or a season/graduation-qualified range — so it must
 *  not be mistaken for an entry header or an institution. Strips date tokens and
 *  connective/season/graduation words; an empty remainder means the line carried
 *  nothing but a date. Shared by education chunking, the entry-block segmenter
 *  and {@link isEntryHeaderShape}. */
export function isDateOnlyLine(text: string): boolean {
  const stripped = text
    .replace(new RegExp(String.raw`\b${MONTH}\.?`, "gi"), "")
    .replace(new RegExp(String.raw`\b${SEASON}\b`, "gi"), "")
    .replace(/\b\d{4}\b/g, "")
    .replace(/\b(?:present|current|expected|graduation|graduated|anticipated)\b/gi, "")
    .replace(/[\s,–\-—|/().:]+/g, "")
    .trim();
  return stripped.length === 0;
}

/**
 * True when `text` reads like the HEADER LEAD of a resume entry — a role title,
 * an organization, a program/certificate name, or an institution — rather than
 * description prose, a bare date line, or a sub-field note (GPA / Minor / etc.).
 *
 * This is the shared "entry-boundary shape" predicate behind the anchor-on-shape
 * fixes: education recognizes a degree-keyword-less program entry by it (#238),
 * and experience recognizes a dateless role header by it (#239). It is
 * intentionally TEXT-ONLY — it makes no use of x/y geometry — so a section with
 * no layout data (education chunking runs on flattened strings) and one with full
 * geometry (experience) can both rely on it; each caller layers its own geometry
 * guards (wrapped-tail indent, dangling-connective predecessor) on top.
 *
 * A line qualifies when ALL hold:
 *   - it carries substantive text (non-empty after trim), and
 *   - it LEADS WITH A CAPITAL OR DIGIT — a proper-noun / numbered entry lead, not
 *     a lowercase-led sentence fragment (a wrapped bullet tail), and
 *   - it does NOT read as a date-only line ({@link isDateOnlyLine}) — a bare
 *     graduation year / attendance range is the date OF an entry, not a new one, and
 *   - it does NOT read as prose ({@link isProseLine}) — a mid-thought description
 *     sentence, and
 *   - it is NOT a sub-field note ({@link PROGRAM_NOTE_RE}) — "GPA: 3.8",
 *     "Minor in Economics", "Relevant Coursework: …" are properties of the entry
 *     above, not a new entry head.
 */
export function isEntryHeaderShape(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (!/^[A-Z0-9]/.test(t)) return false;
  if (isDateOnlyLine(t)) return false;
  if (isProseLine(t)) return false;
  if (PROGRAM_NOTE_RE.test(t)) return false;
  return true;
}
