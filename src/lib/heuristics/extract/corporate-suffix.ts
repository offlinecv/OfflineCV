// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Corporate-suffix TOKEN BASE + regex MECHANICS, shared by the four
 * legal-entity-suffix vocabularies that live in `experience-disambiguate.ts`
 * (`LEGAL_SUFFIX_RE`, `COMPANY_TAIL_TOKENS_RE`, `COMPANY_LEGAL_TAIL_RE`) and
 * `line-primitives.ts` (`LEGAL_TERMINAL_SUFFIX_RE`). Part (c) of #653 /
 * roadmap item 5(c) of #646.
 *
 * WHY THIS EXISTS. Each of those four sets hand-wrote its own alternation of
 * legal-entity tokens ("Inc", "LLC", "Ltd", "GmbH", …) plus its own answer to
 * "does a captured token get to carry a trailing period" — the #641 fix
 * ("Corp." must still match a set built for "Corp"). Because that answer was
 * baked into each regex literal by hand, #641 had to be diagnosed and applied
 * PER COPY, and it landed differently in each one (compare
 * `COMPANY_TAIL_TOKENS_RE`'s single outer `\.?` to `COMPANY_LEGAL_TAIL_RE`'s
 * per-token `Inc\.?|Ltd\.?|Corp\.?`). And because each set also spelled its
 * own token STRINGS, the same concept was already written two ways across the
 * sets (`l.l.c` beside `L.L.C`) with nothing to catch a third spelling or a
 * typo. This module owns both halves: {@link SUFFIX_TOKENS} is the vocabulary,
 * spelled once; {@link composeSuffixRegex} is the mechanics — turning a token
 * list into an alternation with the right anchors, and applying the
 * trailing-dot allowance — so the next fix of this shape is written once.
 *
 * WHAT STAYS PER-SET (do not "fix" this file to change it). MEMBERSHIP is
 * deliberate human judgement, not something this module decides: the four
 * vocabularies disagree ON PURPOSE — a token that safely narrows a
 * PROMOTION decision (`COMPANY_LEGAL_TAIL_RE`) would silently break a
 * DEFERRAL decision (`COMPANY_TAIL_TOKENS_RE`) where a false positive is
 * harmless. Each call site still names its OWN subset of the base, with its
 * own docblock explaining what it's for and why it differs from its siblings;
 * sharing the base means a set names a subset of a named vocabulary, NOT that
 * the sets converge. A token that only one set wants is still fine here — the
 * base is a vocabulary, not a mandate.
 *
 * NOT consolidated here: `COMPANY_SUFFIX_RE` in `extract/title-shape.ts`.
 * That module is an explicit import LEAF (#605 review) — its docblock
 * requires it import nothing, to keep the eager `ContactCard →
 * edit/headline → extract/shared` chain from pulling in anything heavier
 * than the two regexes it needs. Importing this composer there would trade
 * a real, deliberate architecture guard for uniformity, so `COMPANY_SUFFIX_RE`
 * stays a hand-written literal — see `corporate-suffix.test.ts` for the test
 * that still pins its membership alongside the four generated sets.
 */

/**
 * THE TOKEN BASE — every legal-entity / corporate-tail token any set below
 * draws from, spelled ONCE in its canonical form. Keys are the stable handle a
 * set selects by (dots become underscores); values are the exact bytes that
 * reach the alternation.
 *
 * The canonical spelling is Title/acronym case. `LEGAL_SUFFIX_RE` matches an
 * already-lowercased haystack and so writes its alternation lowercase — that
 * is a per-set RENDERING of the same token, expressed by
 * `selectSuffixTokens(…, { lowercase: true })`, not a second spelling of it.
 *
 * A few entries are used only by the hand-written `COMPANY_SUFFIX_RE` in
 * `title-shape.ts` (`LIMITED`, `COMPANY`, `PTY`). They live here so the
 * vocabulary is complete and that set's membership can be read against the
 * same list, even though the leaf-module contract keeps it from importing.
 */
export const SUFFIX_TOKENS = {
  // Legal-entity forms.
  INC: "Inc",
  LLC: "LLC",
  L_L_C: "L.L.C",
  LTD: "Ltd",
  LIMITED: "Limited",
  CORP: "Corp",
  CORPORATION: "Corporation",
  COMPANY: "Company",
  CO: "Co",
  GMBH: "GmbH",
  PLC: "PLC",
  LP: "LP",
  LLP: "LLP",
  PC: "PC",
  PTY: "Pty",
  S_A: "S.A",
  N_A: "N.A",
  SA: "SA",
  NA: "NA",
  // Corporate-tail nouns. Legitimate employer-name endings that are NOT legal
  // entity markers — safe in a deferral vocabulary, unsafe in a promotion one.
  BANK: "Bank",
  GROUP: "Group",
  HOLDINGS: "Holdings",
  SYSTEMS: "Systems",
  SOLUTIONS: "Solutions",
  TECHNOLOGIES: "Technologies",
  STUDIOS: "Studios",
  MEDIA: "Media",
  SOFTWARE: "Software",
  CONSULTING: "Consulting",
  PARTNERS: "Partners",
  VENTURES: "Ventures",
  INDUSTRIES: "Industries",
  FINANCIAL: "Financial",
  HEALTH: "Health",
  HEALTHCARE: "Healthcare",
  NETWORKS: "Networks",
  DIGITAL: "Digital",
  ANALYTICS: "Analytics",
  LABS: "Labs",
} as const;

/** A handle into {@link SUFFIX_TOKENS}. Selecting by key rather than by string
 *  is what makes a mis-spelled token a compile error instead of a set that
 *  silently stops matching. */
export type SuffixTokenKey = keyof typeof SUFFIX_TOKENS;

export interface SelectTokensOptions {
  /** Emit each selected token lowercased — for a set whose haystack is already
   *  lowercased and whose alternation is therefore written lowercase
   *  (`LEGAL_SUFFIX_RE`). Same token, different rendering. */
  lowercase?: boolean;
}

/**
 * Select a set's own vocabulary out of {@link SUFFIX_TOKENS}, IN THE ORDER
 * GIVEN — alternation order is part of a regex's `.source`, so the caller's
 * order is preserved verbatim rather than normalised to the base's.
 */
export function selectSuffixTokens(
  keys: readonly SuffixTokenKey[],
  options: SelectTokensOptions = {},
): string[] {
  return keys.map((key) =>
    options.lowercase ? SUFFIX_TOKENS[key].toLowerCase() : SUFFIX_TOKENS[key],
  );
}

/** Escape a literal token so it is safe inside a regex alternation. */
function escapeToken(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where the anchors sit:
 *  - "boundary" — `\b(GROUP)\b`, an unanchored substring test.
 *  - "full" — `^(GROUP)$`, a whole-string test.
 *  - "trailing" — `\b(GROUP)$`, anchored only at the end (a
 *    sentence-terminator guard, where the leading context is prose, not a
 *    bare token).
 */
export type SuffixAnchor = "boundary" | "full" | "trailing";

export interface ComposeSuffixOptions {
  anchor: SuffixAnchor;
  /** Capturing vs non-capturing group. Default: non-capturing. */
  capture?: boolean;
  /**
   * The #641 behaviour, implemented once here: tolerate a matched token
   * carrying a trailing period.
   *   - `true` appends ONE optional dot after the whole alternation — every
   *     token in `tokens` is dot-eligible. Use when a set applies the dot
   *     uniformly (`COMPANY_TAIL_TOKENS_RE`, `LEGAL_TERMINAL_SUFFIX_RE`).
   *   - An array names the SUBSET of `tokens` that gets an inline optional
   *     dot instead — only the tokens customarily written with a trailing
   *     period ("Inc.", "Corp.", "S.A.") get one; others ("LLC", "GmbH")
   *     don't. Use when a set is selective (`LEGAL_SUFFIX_RE`,
   *     `COMPANY_LEGAL_TAIL_RE`).
   *   - Omitted / `false` — no dot tolerance at all.
   *
   * ⚠️ Under `anchor: "boundary"` the two forms are NOT equivalent, and the
   * asymmetry is in the anchor, not in this option. `true` places its dot
   * AFTER the closing `\b` (`\b(?:…)\b\.?`), where it is consumed; the array
   * form places its dots INSIDE the group, where the closing `\b` — which
   * cannot hold between a "." and a space or end-of-string — forces the
   * engine to backtrack off the dot, so an inline dot is inert there. The
   * inline form's inertness is pre-existing behaviour transcribed from
   * `title-shape.ts`'s hand-written literal and is pinned by
   * `corporate-suffix.test.ts`; both are documented rather than "fixed",
   * because changing either would move a regex the goldens hold byte-exact.
   */
  allowTrailingDot?: boolean | readonly string[];
  /** Regex flags. Default `"i"` — every corporate-suffix set matches
   *  case-insensitively. Stateful flags are rejected: see
   *  {@link composeSuffixRegex}. */
  flags?: string;
}

/** `g`/`y` carry `lastIndex` between calls. Every set here is built ONCE at
 *  module scope and reused for the life of the process, so a stateful flag
 *  would make the same input match or not depending on what was tested before
 *  it — a defect with no local symptom. Rejected at construction. */
const STATEFUL_FLAGS_RE = /[gy]/;

/**
 * Build a legal-entity-suffix regex from a closed token list — normally one
 * produced by {@link selectSuffixTokens}. Pure mechanics; see the module
 * docblock for what stays a per-call decision (membership, anchor style, and
 * which tokens tolerate a trailing period).
 */
export function composeSuffixRegex(
  tokens: readonly string[],
  options: ComposeSuffixOptions,
): RegExp {
  const dotSubset = Array.isArray(options.allowTrailingDot)
    ? new Set(options.allowTrailingDot)
    : null;
  const outerDot = options.allowTrailingDot === true ? "\\.?" : "";

  const alternation = tokens
    .map((token) => {
      const escaped = escapeToken(token);
      return dotSubset?.has(token) ? `${escaped}\\.?` : escaped;
    })
    .join("|");
  const group = `(${options.capture ? "" : "?:"}${alternation})`;
  const flags = options.flags ?? "i";
  if (STATEFUL_FLAGS_RE.test(flags)) {
    throw new Error(
      `composeSuffixRegex: stateful flags are not allowed (got "${flags}") — ` +
        "these regexes are module-scope singletons and lastIndex would leak between calls",
    );
  }

  switch (options.anchor) {
    case "boundary":
      // `outerDot` sits AFTER the closing `\b`, not before it: a `\b` can never
      // hold between "." and a space/end, so a dot inside the group is always
      // backtracked away. Outside it, "Acme Inc." matches with the period
      // consumed — which is what `allowTrailingDot: true` asks for.
      return new RegExp(`\\b${group}\\b${outerDot}`, flags);
    case "full":
      return new RegExp(`^${group}${outerDot}$`, flags);
    case "trailing":
      return new RegExp(`\\b${group}${outerDot}$`, flags);
    default:
      throw new Error(`composeSuffixRegex: unreachable anchor ${String(options.anchor)}`);
  }
}
