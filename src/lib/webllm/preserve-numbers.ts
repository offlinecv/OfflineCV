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
 * Trust signal, not a hard block. The UI surfaces the diff inline so the
 * user can decide whether the rewrite is still acceptable.
 *
 * Tokens covered (per issue #63 decision #3):
 *   - Money with $, €, £, or ¥: `$5`, `€500K`, `£1.2M`, `¥1,000`
 *   - Percent: `40%`, `12.5%`, `-15%`
 *   - Magnitude: `5K`, `10M`, `1.2B`, `10MB`, `2GB`
 *   - Plain numbers with commas/decimals: `1,200`, `3.14`
 *   - Years (1900-2099) and date ranges: `2019`, `2019-2021`
 *   - Headcounts in people-management context: `led 5`, `managed 8`,
 *     `team of 12`, `5 engineers`
 *
 * Each numeric position in a bullet is classified exactly once via a single
 * ATOM regex pass, which is what prevents the date-range/year and the
 * verb-prefix/noun-suffix overlaps from emitting two tokens for one digit.
 *
 * Sign sensitivity: a leading `-` (between a word boundary and the digit) is
 * captured into the token. This is what catches "Reduced costs 15%" being
 * rewritten as "Reduced costs -15%" — same magnitude, inverted meaning.
 */

/**
 * Atom regex: one numeric occurrence with all its optional decorations.
 *   1. optional leading `-` (preceded by start, whitespace, or punctuation —
 *      not by another digit, which would make it a date-range hyphen)
 *   2. optional currency symbol ($, €, £, ¥)
 *   3. digit body (comma-grouped, decimal, or bare integer)
 *   4. optional magnitude suffix (k/m/b/g/t with optional b/B for data
 *      sizes like MB / GB)
 *   5. optional trailing `%`
 *
 * The `(?<!\w)` / `(?!\w)` boundaries keep us from matching digits embedded
 * in identifiers (`abc123`) or stranded suffixes (`5KBingo`).
 */
const ATOM =
  /(?<!\w)(-)?([$€£¥])?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+)([kKmMbBgGtT][bB]?)?(%)?(?!\w)/g;

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
 * after the digit. Anchored to `^\s*` so the noun has to be the first token
 * of the suffix slice.
 */
const PEOPLE_NOUN_FOLLOW =
  /^\s*(?:engineers?|developers?|designers?|analysts?|interns?|reports?|people|persons?|members?|employees?|contractors?|consultants?|staff|hires?|recruits?)\b/i;

/** How many characters of context to inspect on each side of a bare integer. */
const PEOPLE_CONTEXT_WINDOW = 30;

interface ClassifiedAtom {
  /** Match key used for set equality (lowercased so `$5K` ≡ `$5k`). */
  key: string;
  /** Human-readable form used in the UI warning (preserves original case). */
  display: string;
}

function classifyAtom(
  match: RegExpExecArray,
  bullet: string,
): ClassifiedAtom | null {
  const [, sign, currency, digits, magnitude, percent] = match;
  const hasSign = Boolean(sign);
  const hasCurrency = Boolean(currency);
  const hasMagnitude = Boolean(magnitude);
  const hasPercent = Boolean(percent);

  const display =
    (hasSign ? "-" : "") +
    (hasCurrency ? currency! : "") +
    digits +
    (hasMagnitude ? magnitude! : "") +
    (hasPercent ? "%" : "");
  const key = display.toLowerCase();

  // Decorated tokens (currency / magnitude / % / comma groups / decimals
  // / explicit sign) are always tracked verbatim — they are unambiguously
  // meaningful numeric facts.
  if (
    hasCurrency ||
    hasMagnitude ||
    hasPercent ||
    hasSign ||
    digits.includes(",") ||
    digits.includes(".")
  ) {
    return { key, display };
  }

  // Bare integer. Inspect surrounding context to decide whether it's a
  // headcount, a year, or noise we should ignore.
  const matchStart = match.index;
  const before = bullet.slice(
    Math.max(0, matchStart - PEOPLE_CONTEXT_WINDOW),
    matchStart,
  );
  const after = bullet.slice(
    matchStart + digits.length,
    matchStart + digits.length + PEOPLE_CONTEXT_WINDOW,
  );

  if (PEOPLE_VERB_PREFIX.test(before) || PEOPLE_NOUN_FOLLOW.test(after)) {
    return { key: `headcount:${digits}`, display: digits };
  }

  if (digits.length === 4) {
    const year = Number(digits);
    if (year >= 1900 && year <= 2099) {
      return { key: `year:${digits}`, display: digits };
    }
  }

  // Plain integer without people context or a year shape — too noisy to
  // track. Examples: "the 3 of us", "phase 2", "section 4".
  return null;
}

function extractNumbers(bullets: readonly string[]): ClassifiedAtom[] {
  const tokens: ClassifiedAtom[] = [];
  for (const bullet of bullets) {
    ATOM.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ATOM.exec(bullet)) !== null) {
      const token = classifyAtom(match, bullet);
      if (token !== null) tokens.push(token);
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
 * Check that every numeric fact from the input bullets survives into the
 * rewritten bullets, and that no new numeric fact was invented.
 *
 * Multiset semantics: two `5%`s in the input must both appear in the output.
 * Diff lists preserve the order tokens were encountered, so the UI can quote
 * them back to the user without sorting noise. Tokens are returned in their
 * original casing (`$5K`, not `$5k`).
 */
export function checkNumbersPreserved(
  input: readonly string[],
  output: readonly string[],
): PreservationResult {
  const inputTokens = extractNumbers(input);
  const outputTokens = extractNumbers(output);

  const outputCounts = new Map<string, number>();
  for (const t of outputTokens) {
    outputCounts.set(t.key, (outputCounts.get(t.key) ?? 0) + 1);
  }
  const dropped: string[] = [];
  for (const t of inputTokens) {
    const remaining = outputCounts.get(t.key) ?? 0;
    if (remaining === 0) {
      dropped.push(t.display);
    } else {
      outputCounts.set(t.key, remaining - 1);
    }
  }

  const inputCounts = new Map<string, number>();
  for (const t of inputTokens) {
    inputCounts.set(t.key, (inputCounts.get(t.key) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const t of outputTokens) {
    const remaining = inputCounts.get(t.key) ?? 0;
    if (remaining === 0) {
      added.push(t.display);
    } else {
      inputCounts.set(t.key, remaining - 1);
    }
  }

  return {
    ok: dropped.length === 0 && added.length === 0,
    dropped,
    added,
  };
}
