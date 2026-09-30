// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * bullet-glyphs — the one shared vocabulary of glyphs a résumé template (or
 * an LLM's own markdown output) draws as a list bullet. A LEAF module: it
 * imports nothing, and nothing may be added here that does — same discipline
 * as `extract/title-shape.ts`, and for the same reason. `line-primitives.ts`
 * (the parser's existing home for bullet detection) imports `regex.ts`, so
 * deriving the vocabulary there instead would drag `regex.ts` — and its
 * module-eval `Intl` gazetteer — onto any consumer that only wants to know
 * what a bullet glyph is, including the scorer and the edit layer, which sit
 * outside `heuristics/` entirely (the #605 failure class).
 *
 * This module exists because the glyph vocabulary used to be five hand-typed
 * character classes that were supposed to agree and quietly didn't (#915,
 * part (a) of #653): the parser treated `⁃` (U+2043, "hyphen bullet") and `—`
 * (em dash) as bullets while the scorer's `BULLET_MARKER_RE` did not, so a
 * résumé using either glyph had its Experience bullets segmented correctly by
 * the parser and then silently dropped from the Specificity/Structure pool.
 *
 * ── Per-glyph adjudication (2026-09-29 decision on #915) ──────────────────
 *
 * {@link DOT_BULLET_GLYPHS} (`•‣▪●◦`) plus {@link ASTERISK_BULLET} (`*`) were
 * already bullets on both sides and stay that way.
 *
 * {@link AMBIGUOUS_DASH_BULLETS} (`-` and `–`, en dash) are the one pair this
 * module does NOT unify by fiat. A leading `-`/`–` is genuinely ambiguous —
 * it can open a bullet, but it can equally be a date-range fragment
 * ("2020 - 2021" wrapped mid-line) or a negated number (see #821). Maintainer
 * intent for #915 is that these two stay governed by whichever side already
 * handles them, unchanged: the parser keeps treating them as bullets where it
 * already did, and the scorer keeps its own existing `-`/`–` handling too
 * (dropping them from the scorer would deflate Specificity on every
 * hyphen-bulleted résumé, for no reason connected to this issue). Naming them
 * here, once, is what stops a future edit from "helpfully" merging this pair
 * the way {@link HYPHEN_AND_EMDASH_BULLETS} below was merged.
 *
 * {@link HYPHEN_AND_EMDASH_BULLETS} (`⁃` U+2043 and `—` em dash) are the
 * glyphs #915 actually moves: parser bullets the scorer lacked. The scorer
 * adopts them here; nothing that already worked stops working, because
 * neither glyph collides with the date-range/negated-number ambiguity that
 * keeps {@link AMBIGUOUS_DASH_BULLETS} split.
 *
 * {@link SCORER_ONLY_POINTER_GLYPHS}, {@link MIDDOT_BULLET} and
 * {@link UNDECODED_BULLET_GLYPHS} are glyphs the scorer already recognised
 * that the parser does not. Per the decision, the scorer KEEPS these —
 * dropping them would move scores the other way for no reason. (`▶`/`►`
 * triangle bullets; `·` U+00B7; `�` the replacement char pdfjs emits for
 * an undecodable ToUnicode map; `` the Symbol-font PUA codepoint Word
 * uses for its default bullet.) The parser has never needed them because it
 * reads the PDF's own drawn glyph runs, which don't hit the font-substitution
 * failure modes that produce `�`/`` in the first place.
 *
 * {@link MARKDOWN_ONLY_DOT_GLYPHS} (`∙` bullet operator, `⬤` large black
 * circle, `▸` small right triangle) are extra dot-family glyphs
 * `markdown-emit.ts` alone has recognised since before this issue, for its
 * own reason (rendering an already-assembled `PdfLine[]` as markdown, a wider
 * net than either the parser's line-shape checks or the scorer's bullet
 * pool). #915 does not touch that membership — see {@link
 * MARKDOWN_BULLET_GLYPHS} — it only stops the class from being a hand-typed
 * literal.
 *
 * Three near-copies elsewhere are deliberately left as their own hand-typed
 * literals rather than derived from here — each is its own narrower
 * predicate with its own reasoning already written down, and folding it into
 * this vocabulary would risk changing what it matches: `extract/summary.ts`
 * `SUMMARY_BULLET_RE` (excludes em dash on purpose — summary prose uses em
 * dashes as punctuation, not bullets), `heuristics/localize/achievements.ts`
 * `BULLET_LINE_RE` (a body-vs-header check, not a scoring path), and
 * `extract/skills.ts` `SKILL_SPLIT_RE` (a delimiter, not a bullet — it
 * deliberately EXCLUDES the dash glyphs and `*` that this vocabulary
 * includes, because those occur inside real skill tokens like `CI-CD`).
 */

/** The round/square "dot" bullet family every template that isn't using a
 *  dash or asterisk draws its bullets with. */
const DOT_BULLET_GLYPHS = ["•", "‣", "▪", "●", "◦"] as const;

/** Markdown-style asterisk bullet (`* item`). */
const ASTERISK_BULLET = "*";

/** Plain hyphen — the ambiguous half of {@link AMBIGUOUS_DASH_BULLETS}. */
const HYPHEN_BULLET = "-";
/** En dash — the other ambiguous half. */
const EN_DASH_BULLET = "–";
/** The ambiguous dash pair (#821): a leading hyphen or en dash can open a
 *  bullet, or it can be a date-range fragment / negated number. Governed by
 *  each side's own existing rules, not merged here — see the module docblock. */
export const AMBIGUOUS_DASH_BULLETS = [HYPHEN_BULLET, EN_DASH_BULLET] as const;

/** Hyphen bullet (U+2043) — visually a small dash, semantically unambiguous
 *  (unlike {@link HYPHEN_BULLET}, it never collides with a date-range read). */
export const HYPHEN_BULLET_GLYPH = "⁃";
/** Em dash used as a bullet marker. */
export const EM_DASH_BULLET = "—";
/** Parser bullets the scorer lacked before #915; adopted by the scorer here. */
const HYPHEN_AND_EMDASH_BULLETS = [HYPHEN_BULLET_GLYPH, EM_DASH_BULLET] as const;

/** Triangle-pointer bullets the scorer recognises that the parser does not. */
const RIGHT_POINTER_BULLET = "▶";
const RIGHT_POINTER_BULLET_ALT = "►";
const SCORER_ONLY_POINTER_GLYPHS = [RIGHT_POINTER_BULLET, RIGHT_POINTER_BULLET_ALT] as const;

/** Mid-dot bullet (U+00B7) — scorer-only. */
const MIDDOT_BULLET = "·";

/** Font-substitution artifacts pdfjs/Word can emit in place of a real bullet
 *  glyph — see the module docblock. Scorer-only. */
const REPLACEMENT_CHAR_BULLET = "�";
const PRIVATE_USE_SYMBOL_BULLET = "";
const UNDECODED_BULLET_GLYPHS = [REPLACEMENT_CHAR_BULLET, PRIVATE_USE_SYMBOL_BULLET] as const;

/** Extra dot-family glyphs only `markdown-emit.ts` has ever recognised. */
const BULLET_OPERATOR_GLYPH = "∙";
const LARGE_CIRCLE_GLYPH = "⬤";
const SMALL_RIGHT_TRIANGLE_GLYPH = "▸";
const MARKDOWN_ONLY_DOT_GLYPHS = [
  BULLET_OPERATOR_GLYPH,
  LARGE_CIRCLE_GLYPH,
  SMALL_RIGHT_TRIANGLE_GLYPH,
] as const;

// ── Composed, per-consumer glyph sets ───────────────────────────────────────

/** `line-primitives.ts` / `sections.ts` / `regex.ts` — the parser's bullet
 *  class. Unchanged by #915: it already treated every glyph here as a bullet. */
export const PARSER_BULLET_GLYPHS = [
  ...DOT_BULLET_GLYPHS,
  ASTERISK_BULLET,
  ...AMBIGUOUS_DASH_BULLETS,
  ...HYPHEN_AND_EMDASH_BULLETS,
] as const;

/** `score.ts` `BULLET_MARKER_RE` / `group-bullets.ts` / `apply-overrides.ts`
 *  `LEADING_MARKER_RE` — the scorer's bullet-marker class. #915 adds
 *  {@link HYPHEN_AND_EMDASH_BULLETS} (the parser/scorer union); every glyph
 *  the scorer already recognised is kept. */
export const SCORER_BULLET_GLYPHS = [
  ...PARSER_BULLET_GLYPHS,
  ...SCORER_ONLY_POINTER_GLYPHS,
  MIDDOT_BULLET,
  ...UNDECODED_BULLET_GLYPHS,
] as const;

/** `score.ts` `LONE_BULLET_RE` — a glyph alone on its own line, glued to the
 *  next line's text (#30). Deliberately excludes every dash-shaped glyph
 *  (`-`, `–`, `⁃`, `—`) — a lone dash line reads far more often as a divider
 *  than as a bullet whose text wandered onto the next line — and the asterisk
 *  (`*`), whose lone-line reading is a footnote mark, not a bullet.
 *  Unchanged by #915 — this predicate was never part of the parser/scorer
 *  divergence the issue moves. */
export const LONE_LINE_BULLET_GLYPHS = [
  ...DOT_BULLET_GLYPHS,
  ...SCORER_ONLY_POINTER_GLYPHS,
  MIDDOT_BULLET,
  ...UNDECODED_BULLET_GLYPHS,
] as const;

/** `markdown-emit.ts` `LEADING_BULLET_RE` — rendering an assembled
 *  `PdfLine[]` as markdown. Its own, wider glyph set (see
 *  {@link MARKDOWN_ONLY_DOT_GLYPHS}); unchanged by #915. */
export const MARKDOWN_BULLET_GLYPHS = [
  ...DOT_BULLET_GLYPHS,
  MIDDOT_BULLET,
  HYPHEN_BULLET_GLYPH,
  PRIVATE_USE_SYMBOL_BULLET,
  ...MARKDOWN_ONLY_DOT_GLYPHS,
  RIGHT_POINTER_BULLET,
  ASTERISK_BULLET,
  HYPHEN_BULLET,
] as const;

/** Escape one glyph for safe placement inside a `[...]` regex character
 *  class: backslash, `]` and `^` always need it, and `-` needs it everywhere
 *  a class can place it (first/last-position rules are easy to get wrong when
 *  the set is composed from constants rather than typed by hand). */
function escapeGlyphForCharClass(glyph: string): string {
  return glyph.replace(/[\\\]^-]/g, "\\$&");
}

/** Build a `[...]` character-class source string from a glyph set. The single
 *  place every consumer above turns its named set into the regex fragment it
 *  interpolates — so "derive the class" and "escape it correctly" can never
 *  drift apart per call site. */
export function bulletCharClass(glyphs: readonly string[]): string {
  return `[${glyphs.map(escapeGlyphForCharClass).join("")}]`;
}
