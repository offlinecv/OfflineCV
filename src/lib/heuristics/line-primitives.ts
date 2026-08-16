// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Leaf-level line primitives shared by the entry-block parser and the field
 * extractors: bullet detection/stripping and date-range parsing.
 *
 * These live in their own module to break the import cycle that arises when
 * `entry-blocks.ts` (the shared windowing primitive) and `extract-fields.ts`
 * (its caller) both need the same low-level helpers. This module depends only
 * on `regex.ts` constants, the zero-dependency `lexicon/action-verbs.ts` set,
 * and the `PdfLine` type — nothing in the heuristics layer imports back into
 * it — so it sits cleanly below both.
 */

import { startsWithActionVerb } from "../lexicon/action-verbs.ts";
import type { PdfLine } from "./line-model.ts";
import {
  DATE_RANGE_RE,
  MONTH_YEAR_RE,
  NUMERIC_MONTH_YEAR_RE,
  STRICT_MONTH_YEAR_RE,
  YEAR_RE,
} from "./regex.ts";

/** Glyphs a template may use as a list bullet. One source of truth for the
 *  line-level tests below and the item-level `isBulletGlyph` — they must agree
 *  on what counts as a bullet, or a glyph stripped from a line's text could
 *  still survive as a standalone pdfjs item. */
const BULLET_CLASS = "[•‣▪●◦⁃*\\-–—]";
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
 */
// `\b` at the start is load-bearing (PR #688 review B1): without it,
// `Co\.?$` matches "co." at the end of any word — "San Francisco.", "off
// Cisco.", "growth of Xerox." — and the whole sentence gets classified as
// a legal-entity name, so the preemption skips a scope line that ends on a
// common place/word suffix and the sentence lands in `team` instead of
// `description`. `.?$` anchors to line end; the alternation is
// Anglo-American legal suffixes only (adding `AG` / `AB` / `SE` / `NV` /
// `AS` / `Oy` widens the same class of false positive, so it stays out).
const LEGAL_TERMINAL_SUFFIX_RE =
  /\b(?:Inc|Corp|Corporation|Ltd|LLC|L\.L\.C|GmbH|PLC|Co|SA|NA|LP|LLP|PC)\.?$/i;
export function looksLikeBelowAnchorProse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes(";")) return true;
  if (looksLikeMiddotMetadata(trimmed)) return true;
  if (looksLikeVerbLedScope(trimmed)) return true;
  if (!/[.!?]$/.test(trimmed)) return false;
  return !LEGAL_TERMINAL_SUFFIX_RE.test(trimmed);
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
 * #708. Widening to reach it would want its own repro, per this module's rule
 * that each widening is pinned by the shape that motivated it.
 */
/** Closed-class connectors that appear INSIDE genuine Title-Cased org and role
 *  names, and so carry no prose evidence. Articles, the two coordinating
 *  conjunctions, and the prepositions English company names actually use.
 *  Deliberately a REJECT list: adding a word here only makes
 *  {@link looksLikeVerbLedScope} more conservative (fewer preempts), which is
 *  the safe direction — a missed scope line lands in `team` as it did before
 *  #708, while a preempted employer line loses `company` outright. */
const HEADER_CONNECTOR_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "with",
  "at", "by", "in", "on", "from", "off", "across",
]);
/** A bare all-lowercase word — letters only, apostrophes/hyphens allowed
 *  inside. Excludes mixed-case brand tokens ("eBay", "iRobot"), which lead
 *  lowercase but are names, not prose. */
const LOWERCASE_WORD_RE = /^\p{Ll}[\p{Ll}\p{M}'’-]*$/u;
function isLowercaseContentWord(word: string): boolean {
  const bare = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
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
  if (!trimmed.includes("·")) return false;
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
    if (/^(present|current|now|ongoing)$/i.test(endRaw)) {
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
const SEASON_LEAD_RE = /^(?:Spring|Summer|Fall|Autumn|Winter)\b/i;

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
  cleaned = cleaned.replace(/\b(Present|Current|Now|Ongoing)\b/gi, "").trim();
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
