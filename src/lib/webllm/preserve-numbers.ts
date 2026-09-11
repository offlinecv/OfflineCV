// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Number-preservation guardrail.
 *
 * Section rewrite lets the model drop, merge, and reorder bullets — useful,
 * but also a license to silently lose, swap, or invent concrete facts. This
 * is the deterministic, model-free check: extract every numeric token from
 * the input bullets, extract the same set from the rewritten bullets, and
 * report any token that disappeared or appeared from nowhere.
 *
 * Since #778 this is a hard block, not a trust signal: `applyNumberPreservation`
 * in `post-process.ts` reads the result and, on any drop or invention, throws
 * the rewrite away and hands the user their original bullets back. The diff
 * lists below are what the revert notice quotes ("kept your original — the
 * rewrite would have removed $4.2M"); they are not an accept/reject choice
 * offered to the user. A false positive here therefore costs a whole section's
 * rewrite, which is what drives the rules under "Comparison semantics".
 *
 * Tokens covered (per issue #63 decision #3, extended by #778):
 *   - Money with $, €, £, or ¥: `$5`, `€500K`, `£1.2M`, `¥1,000`
 *   - Percent: `40%`, `12.5%`, `-15%`
 *   - Magnitude: `5K`, `10M`, `1.2B`, `10MB`, `2GB`
 *   - Multipliers: `10x`, `3.5x`  (#778)
 *   - Approximations: `~50`, `~$4.2M`, `≈30%`  (#778)
 *   - At-least markers: `10+`, `500+`, `$1M+`  (#778)
 *   - Plain numbers with commas/decimals: `1,200`, `3.14`
 *   - Years (1900-2099) in temporal context and date ranges: `2019`, `2019-2021`
 *   - Both endpoints of a numeric range: `50-100`, `10–15%`  (#778)
 *   - Headcounts in people-management context: `led 5`, `managed 8`,
 *     `team of 12`, `5 engineers`
 *
 * Each numeric position in a bullet is classified exactly once via a single
 * ATOM regex pass, which is what prevents the date-range/year and the
 * verb-prefix/noun-suffix overlaps from emitting two tokens for one digit.
 *
 * ## Comparison semantics
 *
 * Every atom carries a `claim` — why it is a fact worth defending, or `"none"`.
 * A number decorated by its own written shape (`$4.2M`, `40%`, `10x`, `1,200`)
 * always claims; a BARE integer claims only when its context supplies one — a
 * headcount, a year, or a range endpoint. `phase 2` and `1 of 5 applicants`
 * stay unclaimed, because defending them would reject a legitimate rewording
 * rather than catch a lost figure.
 *
 * Three rules follow from that. The first two exist to stop a false revert;
 * the third is what keeps the invention half of the gate from being defeated
 * by them:
 *
 * 1. **The claim decides what we look FOR; presence decides whether we found
 *    it — except for a headcount or year (#876), where a same-value digit that
 *    was ALREADY sitting unclaimed on both sides before the rewrite doesn't
 *    count.** For `form`/`range`, a claimed input atom is a drop only if its
 *    key is absent from *every* atom on the other side — claimed or not. Whether
 *    a bare integer reads as a range endpoint or a grouped figure depends on the
 *    surrounding prose (`50-100` vs `50 to 100`) or punctuation (`1,200` vs
 *    `1200`), so requiring the other side to re-produce the exact same reading
 *    would make the gate fire on numbers the user typed themselves, purely
 *    because the model re-spelled the phrasing around them. Headcount and year
 *    are different: their context (a management verb / people noun, or a
 *    temporal preposition / date range) is common enough to coincide with a
 *    digit that means something else entirely — `"Managed a team of 12
 *    engineers"` dropped down to `"Led the department"`, sitting next to an
 *    unrelated, UNCHANGED `"Completed module 12"`, or `"Founded the program in
 *    1900"` dropped next to `"Operated out of suite 1900"`, would score clean
 *    under a blanket `outputKeys.has`, because the coincidental digit was
 *    already there before the rewrite touched anything. So a headcount or year
 *    counts as present only if the output claims it too, OR a *NEW* unclaimed
 *    occurrence of the key appears that the input didn't already carry —
 *    `outputClaimedKeys` and the unclaimed-occurrence counts below implement
 *    exactly that, and the "new" qualifier is what keeps `"Managed 5
 *    engineers"` → `"Completed phase 5"` or `"Founded in 1900"` → `"Project
 *    1900"` (the digit's ONLY occurrence, reworded away from temporal context)
 *    reading as a legitimate reword rather than a drop. Undecorated keys still
 *    share one `num:` namespace across all four bare-integer readings, because a
 *    headcount, a year, a range endpoint and a comma-grouped figure holding
 *    the same digits are the same value; the presence rule is what differs
 *    per claim kind, not the key they share.
 * 2. **Set semantics, not multiset.** A number is dropped only when it is gone
 *    entirely, never when its count fell. `MERGE_AND_PRUNE_RULE` licenses the
 *    model to fold two bullets into one, and `["Cut 5% cost", "Cut 5% churn"] →
 *    ["Cut 5% cost and churn"]` is exactly that licence being used well. Counting
 *    occurrences reads the dedup as a drop and discards the whole section. The
 *    cost is a genuine "5% in Q1 and another 5% in Q2" collapse scoring clean;
 *    that trade is deliberate, because the gate reverts silently and the merge
 *    case is the one the prompt actively asks for.
 * 3. **The two directions are asymmetric, because they ask different
 *    questions.** Rule 1's lenient half (`form`/`range`) is right for a DROP —
 *    a figure the user typed is only lost if its value is gone from the
 *    output in every spelling. That same leniency is wrong for an INVENTION:
 *    that a digit happens to appear somewhere in the input is
 *    not evidence that a claim the output newly asserts was ever made. `phase 5`
 *    → `5 engineers` reuses the digit and invents the headcount, and under a
 *    plain rule-1 lookup it scored clean. So an output atom the surrounding
 *    prose reads as a HEADCOUNT counts as present only when the same value is a
 *    claimed fact on the input side too. `year` takes the strict count-parity
 *    rule on the DROP side (rule 1) to prevent an unrelated digit from masking
 *    a dropped year, but stays lenient on the ADD side because a year migrates
 *    into temporal context during a rewrite far more often than a headcount does
 *    (`"2019 Excellence Award"` → `"Award in 2019"`). Every other claim kind
 *    keeps the lenient rule-1 lookup, because for those the unclaimed→claimed
 *    move is exactly the re-spelling rule 1 protects: `50 to 100` → `50-100`
 *    (unclaimed → range) and `1200` → `1,200` (unclaimed → grouped figure) are
 *    the same claim written differently. `12-person` is read as people context
 *    for the same reason — the hyphen is how English attaches the noun, not a
 *    different claim from `12 people`. The residual cost is a people phrasing
 *    our lexicon misses on the input side but recognises on the output side
 *    (`a team comprising 5` → `5 engineers`) reverting as an invention; that is
 *    the deliberate trade for catching a headcount the model made up.
 *
 * Sign sensitivity: a leading `-` (between a word boundary and the digit) is
 * captured into the token. This is what catches "Reduced costs 15%" being
 * rewritten as "Reduced costs -15%" — same magnitude, inverted meaning. The
 * approximation marker (`~`) and the at-least marker (`+`) are captured on the
 * same reasoning: `~50` and `50` are different claims, as are `10+` and `10`.
 *
 * ## What this deliberately does NOT do
 *
 * **No cross-form value normalisation.** A DECORATED token is matched as
 * written, so `120K` does not match `120,000` and `$4.2M` does not match
 * `$4.2 million`. Those are value-equivalence features, not extraction gaps.
 * What IS normalised is surface formatting that leaves the digits themselves
 * alone: the prose around a bare integer — the part that decides tracking, per
 * rule 1 above — and the grouping commas inside the digit run, so `1,200` and
 * `1200` share a key. Both are the same claim with the phrasing moved, and
 * `120K` vs `120,000` is not.
 *
 * **No ordinals** (`1st`, `3rd`). They are the one common numeric idiom with a
 * fluent word form — a model rewriting `3rd` as `third` is a legitimate
 * rewrite, so tracking them would buy false rejects rather than caught drops.
 *
 * **No spaced ranges** (`50 - 100`). Only a tight `50-100` is read as a range;
 * a spaced hyphen is ambiguous with negation (`50 -100`) and with prose dashes.
 */

/**
 * Atom regex: one numeric occurrence with all its optional decorations.
 *   1. optional approximation marker (`~`, `∼`, `≈`)
 *   2. optional leading `-` (preceded by start, whitespace, or punctuation —
 *      not by another digit, which would make it a date-range hyphen)
 *   3. optional currency symbol ($, €, £, ¥)
 *   4. digit body (comma-grouped, decimal, or bare integer)
 *   5. optional magnitude suffix (k/m/b/g/t with optional b/B for data
 *      sizes like MB / GB) OR an `x` multiplier — alternatives, never both
 *   6. optional trailing `%`
 *   7. optional trailing `+` ("at least this much")
 *
 * The `(?<!\w)` / `(?!\w)` boundaries keep us from matching digits embedded
 * in identifiers (`abc123`) or stranded suffixes (`5KBingo`). They are also
 * what keeps `1920x1080` and `2x2` from matching at all: the multiplier
 * branch needs a non-word character after the `x`, and the bare-digit branch
 * needs one after the digits, so neither side of a dimension pair qualifies.
 *
 * Named groups, not positional: seven optional decorations read as noise
 * positionally, and the group order is not the order they are assembled in.
 */
const ATOM =
  /(?<!\w)(?<approx>[~\u223C\u2248])?(?<sign>-)?(?<currency>[$€£¥])?(?<digits>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+)(?:(?<magnitude>[kKmMbBgGtT][bB]?)|(?<multiplier>[xX]))?(?<percent>%)?(?<plus>\+)?(?!\w)/g;

/**
 * Dash characters that can join the two endpoints of a numeric range:
 * ASCII hyphen-minus, the U+2010–U+2015 dash block (hyphen, non-breaking
 * hyphen, figure dash, en dash, em dash, horizontal bar) and U+2212 MINUS
 * SIGN. A PDF extractor emits any of these where the author typed one dash,
 * so recognising only `-` would make range detection depend on the font.
 */
const RANGE_DASH = /[\u002D\u2010-\u2015\u2212]/;

/**
 * Verbs/phrasing that signal a bare integer is a headcount when they appear
 * just before the digit. Anchored to `\s*$` so it only matches when the verb
 * is the last token of the prefix slice. `team of`, `group of`, etc. cover
 * the "team of 5" patterns explicitly; bare `of` is NOT in the alternation
 * because it over-triggers ("1 of 5 candidates", "out of 10").
 */
const PEOPLE_VERB_PREFIX =
  /\b(?:led|manage[ds]?|managing|supervis(?:ed|ing)?|mentor(?:ed|ing)?|coach(?:ed|ing)?|direct(?:ed|ing)?|head(?:ed|ing)?|ran|running|team\s+of|group\s+of|squad\s+of|crew\s+of|headcount\s+of)\s*$/i;

/**
 * Nouns that signal a bare integer is a headcount when they appear just
 * after the digit. Anchored to the start of the suffix slice, so the noun has
 * to be its first token — separated by whitespace OR by one of `RANGE_DASH`'s
 * dashes, because `12-person team` is the same claim as `12 people`, only
 * attributively attached. Reading the hyphenated form as no claim at all is
 * what made the legitimate reverse rewording (`a 12-person team` →
 * `12 people`) look like an invented headcount under rule 3.
 */
const PEOPLE_NOUN_FOLLOW = new RegExp(
  `^(?:\\s|${RANGE_DASH.source})*(?:engineers?|developers?|designers?|analysts?|interns?|reports?|people|persons?|members?|employees?|contractors?|consultants?|staff|hires?|recruits?)\\b`,
  "i",
);

/**
 * What a `PEOPLE_VERB_PREFIX` match is allowed to run into when there is no
 * people noun to confirm it: end-of-string, punctuation, or a closed list of
 * prepositions/conjunctions. Anchored to the start of the suffix slice, same
 * as `PEOPLE_NOUN_FOLLOW`.
 *
 * This is what stops the verb alone from claiming a headcount when a
 * NON-people noun follows it — `Managed 5 projects` — where the verb is
 * pointing at that noun, not at a headcount. `Managed 8 across the data
 * platform` (noun elided) still qualifies, because `across` is in the list.
 */
const FUNCTION_WORD_FOLLOWS = new RegExp(
  "^(?:\\s*$|\\s*[.,;:!?)]|\\s+(?:across|in|on|at|for|to|from|over|within|during|and|with|through|by|per)\\b)",
  "i",
);

/** How many characters of context to inspect on each side of a bare integer. */
const PEOPLE_CONTEXT_WINDOW = 30;

/**
 * WHY an atom is a numeric fact the guardrail defends — `"none"` when it is
 * just a digit that happened to be in the text (`phase 2`, `1 of 5
 * applicants`).
 *
 * The reason, not only the boolean, is load-bearing on the add side (rule 3):
 * a value the OUTPUT reads as a headcount while the INPUT read it as nothing
 * is a claim the model minted, whereas the same value merely re-grouped
 * (`"form"`: `1200` → `1,200`) or re-spelled as a range (`"range"`: `50 to 100`
 * → `50-100`) is the claim the user already made. `"form"` is the number's own
 * written shape ($, %, x, ~, +, a magnitude suffix, grouping commas, a decimal
 * point); the other three are the prose around a bare integer.
 */
type NumericClaim = "none" | "form" | "headcount" | "year" | "year_verb" | "range";

interface ClassifiedAtom {
  /** Match key used for set equality (lowercased so `$5K` ≡ `$5k`). */
  key: string;
  /** Human-readable form used in the UI warning (preserves original case). */
  display: string;
  /**
   * Why this counts as a fact worth defending, or `"none"`. Unclaimed atoms are
   * never reported as dropped or added, but they still count as PRESENT for the
   * other side's lookup — see rules 1 and 3 in the module docblock.
   */
  claim: NumericClaim;
}

function isClaimed(atom: ClassifiedAtom): boolean {
  return atom.claim !== "none";
}

/**
 * Is this match one endpoint of a tight numeric range (`50-100`)?
 *
 * Both directions have to be checked, because a range contributes two separate
 * atoms and each has to be recognised from its own position: the left endpoint
 * is followed by `dash digit`, the right endpoint is preceded by `digit dash`.
 *
 * "Tight" is load-bearing — `digit dash digit` with no whitespace. It is what
 * separates a range from the two things that look like one:
 *   - `6-month window` / `day-7 retention` — the dash is followed by a letter
 *     that is not a people noun, so neither is a range and both bare integers
 *     stay unclaimed, as before.
 *   - `50 -100` — the ATOM already reads `-100` as a signed number, and it
 *     never reaches this check because a sign claims the atom verbatim.
 */
function isRangeEndpoint(match: RegExpExecArray, bullet: string): boolean {
  const start = match.index;
  const end = start + match[0].length;
  const leftEndpoint =
    RANGE_DASH.test(bullet[end] ?? "") && /\d/.test(bullet[end + 1] ?? "");
  const rightEndpoint =
    RANGE_DASH.test(bullet[start - 1] ?? "") &&
    /\d/.test(bullet[start - 2] ?? "");
  return leftEndpoint || rightEndpoint;
}

/**
 * Does this atom carry a decoration that makes it a numeric fact on its own?
 * Approximation, sign, currency, magnitude, multiplier, `%` and `+` all change
 * what the number claims, so any of them is enough — no context needed.
 */
function isDecorated(groups: Record<string, string | undefined>): boolean {
  return (
    groups.approx !== undefined ||
    groups.sign !== undefined ||
    groups.currency !== undefined ||
    groups.magnitude !== undefined ||
    groups.multiplier !== undefined ||
    groups.percent !== undefined ||
    groups.plus !== undefined
  );
}

/**
 * Month names and standard abbreviations (with optional abbreviation period)
 * used across year prefix and follow cues (#876).
 */
const MONTH_NAME =
  /(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?/i;

/**
 * Punctuation/dash characters that separate a bullet-initial date anchor from
 * the following bullet text (#876). Requires date-range dash to be followed by
 * a year (1900-2099), ongoing marker, or non-numeric prose text so numeric
 * ranges like `2000 - 3000 units` do not match.
 */
const LEADING_DATE_ANCHOR_SEPARATOR = new RegExp(
  `^\\s*(?:[:.)]` +
    `|(?:${RANGE_DASH.source}\\s*(?:(?:19\\d\\d|20\\d\\d)|present|current|now|ongoing)\\b)` +
    `|(?:${RANGE_DASH.source}(?!\\s*\\d)))\\s*`,
  "i",
);

/**
 * Context window (in characters) scanned before and after a 4-digit number
 * when checking for year context cues (#876). Raised to 64 to hold full
 * multi-word credential titles (e.g. "Google Cloud Certified Professional Cloud Architect").
 */
const YEAR_CONTEXT_WINDOW = 64;

/**
 * Case-SENSITIVE: CamelCase conference/product names (#876). Kept out of
 * YEAR_PREFIX_CUE because that regex is /i, which makes [A-Z] match a-z.
 */
const YEAR_PREFIX_CUE_CAMEL =
  /\b[A-Z][A-Za-z0-9]*(?:Con|Conf|Summit|Meetup|Expo|Fest|Symposium|Workshop|Awards?)\s*$/;

/**
 * Case-SENSITIVE: Capitalized venue/company names following "at" (#876). Kept
 * out of YEAR_PREFIX_CUE because that regex is /i, which makes [A-Z] match a-z.
 */
const YEAR_PREFIX_CUE_VENUE =
  /\bat\s+(?:[A-Z][A-Za-z0-9&.'-]*\s+)+$/;

/**
 * Temporal prepositions, verbs, credential/award phrases, month names,
 * seasons, quarters, parentheses/commas, and range connectors that signal a
 * 4-digit number (1900–2099) is being used as a year when appearing immediately
 * before the digit (#876).
 */
const YEAR_PREFIX_CUE = new RegExp(
  "(?:\\b(?:" +
    "in|since|during|until|through|between|before|after|around|circa|c\\.|" +
    "as\\s+of|class\\s+of|cohort\\s+of|batch\\s+of|" +
    "winner,?\\s*|won,?\\s*|recipient\\s+of(?:\\s+the)?|speaker\\s+at|talk\\s+at|presented\\s+at|worked\\s+at|" +
    "(?:awarded|certified|earned|completed|launched|published|promoted|shipped|graduated|founded|established|joined|built|deployed|released|delivered|led)\\s+(?:the|a|an|our|this)\\s+[A-Za-z0-9&.'-]+\\s+|" +
    "(?:employee|person|engineer|team|member|volunteer)\\s+of\\s+the\\s+year\\s+|" +
    "(?:awards?|prizes?|medals?|fellowships?|scholarships?|honou?rs?|certifications?|certificates?)\\s+|" +
    "(?:certified\\s+(?!(?:the|a|an|our|this)\\b)(?:[A-Za-z0-9&.'-]+\\s+){1,4})|" +
    `${MONTH_NAME.source}|` +
    "spring|summer|fall|autumn|winter|" +
    "q[1-4]|h[1-2]|fy" +
    ")\\s*|" +
    `[(,]\\s*|` +
    `(?:\\b(?:19\\d\\d|20\\d\\d)\\s*(?:${RANGE_DASH.source}|/|to|and)\\s*)|` +
    `(?:\\b\\d{1,2}\\s*[/.]\\s*))$`,
  "i",
);

/**
 * Weak prepositions, qualifiers, determiners, or temporal adverbs that signal
 * a 4-digit number is a year when preceding the digit (#876).
 *
 * Mapped to the lenient "verb" / `year_verb` tier so legitimate bullet merges
 * on quantities (e.g. "Reduced by 2000 hours" + "Tracked 2000 bugs") do not
 * false-revert on count parity, while dropping the year completely is caught.
 */
const YEAR_PREFIX_WEAK_CUE = new RegExp(
  "\\b(?:from|by|for|of|over|the|our|this|early|mid|late)[\\s-]*$",
  "i",
);

/**
 * Bare past-tense action verbs that signal a year when immediately preceding
 * the digit AND followed by a function word or punctuation (#876).
 */
const YEAR_PREFIX_VERB_CUE = new RegExp(
  "\\b(?:awarded|certified|earned|completed|launched|published|promoted|shipped|graduated|founded|established|joined)\\s*$",
  "i",
);

/**
 * Award and prize titles following a leading 4-digit year (#876).
 */
const YEAR_FOLLOW_AWARD_CUE =
  /^(?:\s+[A-Za-z][A-Za-z0-9&.'-]*)*\s+(?:award|prize|medal|fellowship|scholarship|honou?r)s?\b/i;

/**
 * Connectives, qualifiers, range markers, or month/season names that signal
 * a 4-digit number is a year when appearing immediately after the digit (#876).
 */
const YEAR_FOLLOW_CUE = new RegExp(
  "^(?:\\s*(?:" +
    "onwards?|present|current|now|ongoing|" +
    "to\\s+(?:(?:19\\d\\d|20\\d\\d)|present|current|now|ongoing)|" +
    "until\\s+(?:(?:19\\d\\d|20\\d\\d)|present|current|now|ongoing)|" +
    "through\\s+(?:(?:19\\d\\d|20\\d\\d)|present|current|now|ongoing)|" +
    "and\\s+(?:19\\d\\d|20\\d\\d)|" +
    `${MONTH_NAME.source}` +
    ")\\b|" +
    `\\s*(?:${RANGE_DASH.source}|/)\\s*(?:(?:19\\d\\d|20\\d\\d)|present|current|now|ongoing)\\b)`,
  "i",
);

/**
 * Slice preceding context without fabricating artificial word boundaries (\b)
 * when the fixed character window cuts mid-word (#876).
 */
function contextSliceBefore(
  bullet: string,
  matchStart: number,
  windowSize: number,
): string {
  const rawStart = Math.max(0, matchStart - windowSize);
  return rawStart > 0 && /\w/.test(bullet[rawStart - 1] ?? "")
    ? bullet.slice(rawStart, matchStart).replace(/^\S*/, "")
    : bullet.slice(rawStart, matchStart);
}

/**
 * Slice following context without fabricating artificial word boundaries (\b)
 * when the fixed character window cuts mid-word (#876).
 */
function contextSliceAfter(
  bullet: string,
  matchEnd: number,
  windowSize: number,
): string {
  const rawEnd = matchEnd + windowSize;
  if (rawEnd < bullet.length && /\w/.test(bullet[rawEnd] ?? "")) {
    const stripped = bullet.slice(matchEnd, rawEnd).replace(/\S*$/, "");
    return stripped.trim().length === 0 ? " …" : stripped;
  }
  return bullet.slice(matchEnd, rawEnd);
}

/**
 * Does this 4-digit bare integer sit in temporal/year context? (#876)
 *
 * Distinguishes high-confidence explicit temporal cues ("strict" parity) from
 * bare past-tense verb cues or weak prepositions ("verb" — lenient on drop side
 * to prevent false reverts on plain quantities like "Shipped 2000 to partners").
 */
function isYearContext(
  match: RegExpExecArray,
  bullet: string,
  digits: string,
): "strict" | "verb" | "none" {
  if (digits.length !== 4) return "none";
  const year = Number(digits);
  if (year < 1900 || year > 2099) return "none";

  const matchStart = match.index;
  const before = contextSliceBefore(bullet, matchStart, YEAR_CONTEXT_WINDOW);
  const after = contextSliceAfter(
    bullet,
    matchStart + digits.length,
    YEAR_CONTEXT_WINDOW,
  );

  // 1. Explicit temporal prefix cue (e.g. "in 1900", "since 2019", "Jan 2021", "2019 - 2021", "KubeCon 2022", "at Acme 2020")
  if (
    YEAR_PREFIX_CUE.test(before) ||
    YEAR_PREFIX_CUE_CAMEL.test(before) ||
    YEAR_PREFIX_CUE_VENUE.test(before)
  ) {
    return "strict";
  }

  // 2. Explicit temporal follow cue (e.g. "2019 onwards", "2019 - Present", "2019 to 2021", "2019 Excellence Award")
  if (YEAR_FOLLOW_CUE.test(after) || YEAR_FOLLOW_AWARD_CUE.test(after)) {
    return "strict";
  }

  // 3. Leading date anchor at the start of a bullet (e.g. "2019: Founded company", "• 2019 - Started role")
  const leadingText = bullet
    .slice(0, matchStart)
    .trim()
    .replace(/^[-*•⁃–—\s]+/, "");
  if (leadingText.length === 0 && LEADING_DATE_ANCHOR_SEPARATOR.test(after)) {
    return "strict";
  }

  // 1b. Bare past-tense verb followed by a function word, punctuation, or end of bullet (#876)
  if (YEAR_PREFIX_VERB_CUE.test(before) && FUNCTION_WORD_FOLLOWS.test(after)) {
    return "verb";
  }

  // 1c. Weak prepositions, qualifiers, or bullet-initial attributive years (#876)
  if (YEAR_PREFIX_WEAK_CUE.test(before) || leadingText.length === 0) {
    return "verb";
  }

  return "none";
}

/**
 * What, if anything, makes this bare integer worth defending, given the words
 * around it?
 *
 * Three ways to qualify — a headcount, a year, or one endpoint of a tight
 * range. Everything else ("the 3 of us", "phase 2", "section 4", "suite 1900")
 * is noise: on the drop side, it is not required to be preserved unless matched
 * on the other side. On the add side, hallucinated numbers are guarded by
 * checking whether newly introduced values existed in the input.
 *
 * The match index IS the digit index on this branch: every prefix decoration
 * (approximation, sign, currency) implies `isDecorated`, so a caller that
 * reaches here has nothing between `match.index` and the first digit.
 *
 * Years are checked before ranges, which is what keeps `2019-2021` scoring as a
 * pair of years rather than a range — the two classifications now share the
 * `num:` key namespace, but a 4-digit year qualifies without needing a dash, so
 * `2019` in "between 2019 and 2021" stays claimed.
 */
function bareIntegerClaim(
  match: RegExpExecArray,
  bullet: string,
  digits: string,
): NumericClaim {
  const matchStart = match.index;
  const before = contextSliceBefore(bullet, matchStart, PEOPLE_CONTEXT_WINDOW);
  const after = contextSliceAfter(
    bullet,
    matchStart + digits.length,
    PEOPLE_CONTEXT_WINDOW,
  );

  // A people noun after the digit is decisive on its own.
  if (PEOPLE_NOUN_FOLLOW.test(after)) {
    return "headcount";
  }
  // The verb alone qualifies only when NO noun follows — the digit runs into
  // a preposition, punctuation, or the end of the bullet. A non-people noun
  // right after the digit (`Managed 5 projects`) means the verb is modifying
  // that noun, not asserting a headcount.
  if (PEOPLE_VERB_PREFIX.test(before) && FUNCTION_WORD_FOLLOWS.test(after)) {
    return "headcount";
  }

  const yearKind = isYearContext(match, bullet, digits);
  if (yearKind === "strict") {
    return "year";
  }
  if (yearKind === "verb") {
    return "year_verb";
  }

  // A range endpoint (#778). `50-100 tickets` used to track NEITHER number:
  // both are bare integers with no people context and no year shape, so a
  // rewrite could drop the whole range and the guardrail scored it clean. The
  // two endpoints are two independent atoms rather than one `50-100` atom, so a
  // rewrite that re-spells the dash (`50–100`) or the whole range (`50 to 100`)
  // still matches — the dash is detection context, never part of the key.
  if (isRangeEndpoint(match, bullet)) {
    return "range";
  }

  // Never demote below main: a 4-digit integer in 1900-2099 that no cue
  // recognised stays CLAIMED, but leniently. A cue MISS then costs nothing
  // relative to main; only a strict-tier cue HIT can change the answer (#876 redesign).
  const n = Number(digits);
  if (digits.length === 4 && n >= 1900 && n <= 2099) {
    return "year_verb";
  }

  return "none";
}

function classifyAtom(match: RegExpExecArray, bullet: string): ClassifiedAtom {
  const g = match.groups!;
  const digits = g.digits!;

  const prefix = (g.approx ?? "") + (g.sign ?? "") + (g.currency ?? "");
  const suffix =
    (g.magnitude ?? g.multiplier ?? "") + (g.percent ?? "") + (g.plus ?? "");
  const display = prefix + digits + suffix;

  // Grouping commas are presentation, not value: `1,200` and `1200` are the
  // same figure spelled two ways. The KEY drops them so the two spellings
  // match; `display` keeps whichever the author (or the model) wrote, because
  // that is what the warning copy quotes back.
  const value = digits.replace(/,/g, "");

  if (isDecorated(g)) {
    return {
      key: (prefix + value + suffix).toLowerCase(),
      display,
      claim: "form",
    };
  }

  // Undecorated (bare integer, grouped integer `1,200`, or decimal `3.14`).
  // ONE key namespace (`num:1200`) regardless of grouping.
  return {
    key: `num:${value}`,
    display,
    // Grouping and a decimal point are the figure's own written shape, so they
    // claim it without needing context: `1,200` and `3.14` were written as
    // figures on purpose.
    claim:
      digits.includes(",") || digits.includes(".")
        ? "form"
        : bareIntegerClaim(match, bullet, digits),
  };
}

function extractNumbers(bullets: readonly string[]): ClassifiedAtom[] {
  const tokens: ClassifiedAtom[] = [];
  for (const bullet of bullets) {
    ATOM.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ATOM.exec(bullet)) !== null) {
      tokens.push(classifyAtom(match, bullet));
    }
  }
  return tokens;
}

export interface PreservationResult {
  ok: boolean;
  /** Tokens present in input that did not survive into the output. */
  dropped: string[];
  /** Tokens present in output that did not appear in the input. */
  added: string[];
}

function is4DigitYearValue(atom: ClassifiedAtom): boolean {
  if (!atom.key.startsWith("num:")) return false;
  const digits = atom.key.slice(4);
  if (digits.length !== 4) return false;
  const n = Number(digits);
  return n >= 1900 && n <= 2099;
}

/**
 * Every claimed atom in `atoms` that `isPresent` cannot find on the other side,
 * reported by its display form in first-encounter order, at most once per key.
 *
 * The presence test is a parameter rather than a set lookup because the two
 * directions ask different questions of the other side (rule 3): a drop asks
 * only whether the value survived anywhere, an invention asks whether the claim
 * was there to begin with. Membership is set-shaped, not counted (rule 2).
 */
function missingFrom(
  atoms: readonly ClassifiedAtom[],
  isCandidate: (atom: ClassifiedAtom) => boolean,
  isPresent: (atom: ClassifiedAtom) => boolean,
): string[] {
  const reported = new Set<string>();
  const missing: string[] = [];
  for (const atom of atoms) {
    if (!isCandidate(atom)) continue;
    if (reported.has(atom.key) || isPresent(atom)) continue;
    reported.add(atom.key);
    missing.push(atom.display);
  }
  return missing;
}

/** How many UNCLAIMED atoms share each key — the drop side's masking guard. */
function countUnclaimedByKey(
  atoms: readonly ClassifiedAtom[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const atom of atoms) {
    if (isClaimed(atom) && atom.claim !== "year_verb") continue;
    counts.set(atom.key, (counts.get(atom.key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Check that every numeric fact from the input bullets survives into the
 * rewritten bullets, and that no new numeric fact was invented.
 *
 * Set semantics: a number counts as preserved while it appears at all, so a
 * licensed merge that de-duplicates a repeated metric is not a drop. Diff lists
 * preserve the order tokens were encountered, so the UI can quote them back to
 * the user without sorting noise. Tokens are returned in their original casing
 * (`$5K`, not `$5k`).
 */
export function checkNumbersPreserved(
  input: readonly string[],
  output: readonly string[],
): PreservationResult {
  const inputAtoms = extractNumbers(input);
  const outputAtoms = extractNumbers(output);

  const inputKeys = new Set(inputAtoms.map((a) => a.key));
  const outputKeys = new Set(outputAtoms.map((a) => a.key));
  // Only the values the INPUT itself asserted as facts. A headcount the output
  // asserts has to land in here, not merely in `inputKeys` — see rule 3.
  const inputClaimedKeys = new Set(
    inputAtoms.filter(isClaimed).map((a) => a.key),
  );
  const outputClaimedKeys = new Set(
    outputAtoms.filter(isClaimed).map((a) => a.key),
  );
  const outputStrictYearKeys = new Set(
    outputAtoms.filter((a) => a.claim === "year").map((a) => a.key),
  );
  // Per-key counts of UNCLAIMED occurrences on each side — the baseline of
  // "this digit shows up elsewhere for unrelated reasons" that already
  // existed before the rewrite touched anything. Headcount and year (#876) need
  // this: they are the two claim kinds with a real unclaimed state on the same key
  // (`num:12` from "team of 12" vs `num:12` from "module 12", or `num:1900` from
  // "in 1900" vs `num:1900` from "suite 1900").
  const inputUnclaimedCounts = countUnclaimedByKey(inputAtoms);
  const outputUnclaimedCounts = countUnclaimedByKey(outputAtoms);

  // Drop: the value is gone from the output in every spelling (rule 1) —
  // except for a headcount and strict year (#876), which count as present only if the
  // output claims it too, OR a NEW unclaimed occurrence of the key appears that
  // wasn't already there before the rewrite (the "phase 5" masking case
  // below, which rule 1 is right to treat as a reword, not a loss). Without
  // the "new" qualifier, an unrelated digit the input ALREADY carried
  // unclaimed (e.g. "module 12" sitting next to a genuinely-dropped
  // "12 engineers", or "suite 1900" sitting next to "in 1900") would mask the
  // drop just by surviving unchanged — the masking bug rule 1's blanket
  // `outputKeys.has` used to have. `form`/`range` keep the fully lenient
  // lookup: those claims genuinely depend on prose a rewrite is licensed to
  // move, so tightening them risks a false revert on a legitimate reword rule 1
  // exists to allow.
  const dropped = missingFrom(
    inputAtoms,
    isClaimed,
    (atom) => {
      if (atom.claim !== "headcount" && atom.claim !== "year") {
        return outputKeys.has(atom.key);
      }
      const claimedOnOtherSide =
        atom.claim === "year"
          ? outputStrictYearKeys.has(atom.key)
          : outputClaimedKeys.has(atom.key);
      if (claimedOnOtherSide) return true;
      return (
        (outputUnclaimedCounts.get(atom.key) ?? 0) >
        (inputUnclaimedCounts.get(atom.key) ?? 0)
      );
    },
  );
  // Invention: the same lookup, except that a headcount the output asserts is
  // "present" only if the input asserted that value too (rule 3). `phase 5` →
  // `5 engineers` reuses the digit while making a claim the résumé never made.
  // `year` / 4-digit years (1900–2099) defend against invented values while
  // remaining lenient on additions (#876): an output year only needs its numeric
  // value present in the input in any form (e.g. "2019 Excellence Award" -> "Award in 2019"),
  // preventing legitimate temporal rewording from being flagged as an invented year.
  const added = missingFrom(
    outputAtoms,
    (atom) => isClaimed(atom) || is4DigitYearValue(atom),
    (atom) =>
      atom.claim === "headcount"
        ? inputClaimedKeys.has(atom.key)
        : inputKeys.has(atom.key),
  );

  return {
    ok: dropped.length === 0 && added.length === 0,
    dropped,
    added,
  };
}
