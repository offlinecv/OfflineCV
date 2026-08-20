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
 *   - Years (1900-2099) and date ranges: `2019`, `2019-2021`
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
 *    it — except for a headcount, where a same-value digit that was ALREADY
 *    sitting unclaimed on both sides before the rewrite doesn't count.** For
 *    `form`/`range`/`year`, a claimed input atom is a drop only if its key is
 *    absent from *every* atom on the other side — claimed or not. Whether a
 *    bare integer reads as a range endpoint or a grouped figure depends on the
 *    surrounding prose (`50-100` vs `50 to 100`) or punctuation (`1,200` vs
 *    `1200`), so requiring the other side to re-produce the exact same reading
 *    would make the gate fire on numbers the user typed themselves, purely
 *    because the model re-spelled the phrasing around them; `year` has no
 *    unclaimed state to compare against in the first place (a 4-digit number
 *    in range is always a year, see `bareIntegerClaim`), so the lenient lookup
 *    is also the only one available to it. A headcount is different: its
 *    context (a management verb, a people noun) is common enough to
 *    reproduce by accident on a digit that means something else entirely —
 *    `"Managed a team of 12 engineers"` dropped down to `"Led the
 *    department"`, sitting next to an unrelated, UNCHANGED `"Completed module
 *    12"`, would score clean under a blanket `outputKeys.has`, because the
 *    coincidental `12` was already there before the rewrite touched anything.
 *    So a headcount counts as present only if the output claims it too, OR a
 *    *NEW* unclaimed occurrence of the key appears that the input didn't
 *    already carry — `outputClaimedKeys` and the unclaimed-occurrence counts
 *    below implement exactly that, and the "new" qualifier is what keeps
 *    `"Managed 5 engineers"` → `"Completed phase 5"` (the digit's ONLY
 *    occurrence, reworded away from headcount context) reading as a
 *    legitimate reword rather than a drop. Undecorated keys still share one
 *    `num:` namespace across all four bare-integer readings, because a
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
 *    claimed fact on the input side too. Every other claim kind keeps the
 *    lenient rule-1 lookup, because for those the unclaimed→claimed move is
 *    exactly the re-spelling rule 1 protects: `50 to 100` → `50-100` (unclaimed
 *    → range) and `1200` → `1,200` (unclaimed → grouped figure) are the same
 *    claim written differently. `12-person` is read as people context for the
 *    same reason — the hyphen is how English attaches the noun, not a different
 *    claim from `12 people`. The residual cost is a people phrasing our lexicon
 *    misses on the input side but recognises on the output side
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
type NumericClaim = "none" | "form" | "headcount" | "year" | "range";

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
 * What, if anything, makes this bare integer worth defending, given the words
 * around it?
 *
 * Three ways to qualify — a headcount, a year, or one endpoint of a tight
 * range. Everything else ("the 3 of us", "phase 2", "section 4") is noise: it
 * still produces an atom, so the other side can match against it, but it is
 * never itself reported as dropped or added.
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
  const before = bullet.slice(
    Math.max(0, matchStart - PEOPLE_CONTEXT_WINDOW),
    matchStart,
  );
  const after = bullet.slice(
    matchStart + digits.length,
    matchStart + digits.length + PEOPLE_CONTEXT_WINDOW,
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

  if (digits.length === 4) {
    const year = Number(digits);
    if (year >= 1900 && year <= 2099) return "year";
  }

  // A range endpoint (#778). `50-100 tickets` used to track NEITHER number:
  // both are bare integers with no people context and no year shape, so a
  // rewrite could drop the whole range and the guardrail scored it clean. The
  // two endpoints are two independent atoms rather than one `50-100` atom, so a
  // rewrite that re-spells the dash (`50–100`) or the whole range (`50 to 100`)
  // still matches — the dash is detection context, never part of the key.
  return isRangeEndpoint(match, bullet) ? "range" : "none";
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
  // that is what the warning copy quotes back. Keying on the literal spelling
  // is what made "Processed 1,200 orders" → "Processed 1200 orders" report a
  // dropped `1,200` and revert a rewrite that changed nothing but the comma.
  const value = digits.replace(/,/g, "");

  if (isDecorated(g)) {
    return {
      key: (prefix + value + suffix).toLowerCase(),
      display,
      claim: "form",
    };
  }

  // Undecorated. ONE key namespace regardless of what (if anything) qualified
  // it — a headcount `12`, a year `2019`, a range endpoint `50` and a grouped
  // `1,200` are the same value as the same digits written with no context and
  // no commas, and splitting them by namespace is what made `Managed 12 people`
  // → `Managed a 12-person team` report a dropped `12`.
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
  isPresent: (atom: ClassifiedAtom) => boolean,
): string[] {
  const reported = new Set<string>();
  const missing: string[] = [];
  for (const atom of atoms) {
    if (!isClaimed(atom)) continue;
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
    if (isClaimed(atom)) continue;
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
  // Per-key counts of UNCLAIMED occurrences on each side — the baseline of
  // "this digit shows up elsewhere for unrelated reasons" that already
  // existed before the rewrite touched anything. Only headcount needs this:
  // it is the one claim kind with a real unclaimed state on the same key
  // (`num:12` from "team of 12" vs `num:12` from "module 12" of a curriculum).
  const inputUnclaimedCounts = countUnclaimedByKey(inputAtoms);
  const outputUnclaimedCounts = countUnclaimedByKey(outputAtoms);

  // Drop: the value is gone from the output in every spelling (rule 1) —
  // except for a headcount, which counts as present only if the output
  // claims it too, OR a NEW unclaimed occurrence of the key appears that
  // wasn't already there before the rewrite (the "phase 5" masking case
  // below, which rule 1 is right to treat as a reword, not a loss). Without
  // the "new" qualifier, an unrelated digit the input ALREADY carried
  // unclaimed (e.g. "module 12" sitting next to a genuinely-dropped
  // "12 engineers") would mask the drop just by surviving unchanged — the
  // masking bug rule 1's blanket `outputKeys.has` used to have. `form`/
  // `range`/`year` keep the fully lenient lookup: those claims genuinely
  // depend on prose a rewrite is licensed to move (or, for `year`, have no
  // unclaimed state to compare against at all), so tightening them risks a
  // false revert on a legitimate reword rule 1 exists to allow.
  const dropped = missingFrom(inputAtoms, (atom) => {
    if (atom.claim !== "headcount") return outputKeys.has(atom.key);
    if (outputClaimedKeys.has(atom.key)) return true;
    return (
      (outputUnclaimedCounts.get(atom.key) ?? 0) >
      (inputUnclaimedCounts.get(atom.key) ?? 0)
    );
  });
  // Invention: the same lookup, except that a headcount the output asserts is
  // "present" only if the input asserted that value too (rule 3). `phase 5` →
  // `5 engineers` reuses the digit while making a claim the résumé never made.
  const added = missingFrom(outputAtoms, (atom) =>
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
