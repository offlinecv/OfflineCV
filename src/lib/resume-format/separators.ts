// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * resume-format/separators — the byte-level glue the Download-PDF exporter draws
 * and the re-parser reads back (#649).
 *
 * Every constant here was previously spelled as a bare literal at BOTH ends of
 * the round trip — once in `lib/pdf` (the compose site) and once in
 * `lib/heuristics` (the split site) — coupled only by a prose note pointing at
 * the other module. That is the failure mode this module removes: a separator
 * changed on one side and not the other does not fail to compile, it silently
 * re-routes a field on re-parse (the #466 empty-company corruption is exactly
 * that bug, found only by a round-trip fixture).
 *
 * The constraint this module guards: **one definition per separator, imported
 * by both ends.** It is deliberately zero-dep and imports from neither
 * `lib/pdf` nor `lib/heuristics` — it is the contract BETWEEN them, so a
 * dependency either way would be a cycle and would also hand one side ownership
 * of a shared decision.
 *
 * Values are pinned byte-for-byte by `separators.test.ts`; the full table of
 * which join uses which separator (and why each is load-bearing rather than
 * cosmetic) is `docs/canonical-resume-model.md` §10.
 *
 * OUT OF SCOPE, on purpose: the date-range dialects (`" – "` spaced en dash for
 * experience/education, `"–"` unspaced for projects). Unifying those changes
 * rendered bytes and needs its own reviewed snapshot sweep — issue #649 step 3.
 * They stay in `lib/score/entry-dates.ts` until then.
 */

/** The bare middot glyph (U+00B7 MIDDLE DOT). Split sites match THIS rather
 *  than {@link MIDDOT_JOIN} when they must survive spacing collapse on
 *  re-extraction — a PDF text extractor may hand back a NBSP or a thin space
 *  where the renderer drew U+0020. */
export const MIDDOT = "·";

/** The spaced middot the exporter joins multi-value runs with: role headers
 *  (`Title · Company, Location · Team`), `Institution · Location`, the skills
 *  list, `Type · Title` credential headers, and the compact certifications
 *  line. Spaces are ASCII U+0020 on both sides. */
export const MIDDOT_JOIN = ` ${MIDDOT} `;

/** The boundary {@link MIDDOT_JOIN} draws, as the re-parser sees it. Whitespace
 *  is REQUIRED on both sides, so a middot glued inside a token is not a
 *  boundary, and `\s` (which covers the NBSP / thin spaces a PDF extractor
 *  emits, not just U+0020) absorbs whatever spacing the extraction hands back.
 *  Non-global → stateless `.test` / `.split`. */
export const MIDDOT_SPLIT_RE = /\s+·\s+/;

/** The comma that sets a subordinate org field off from the field it qualifies
 *  on one composed line: `Company, Location`, and the #466 empty-company
 *  `Title, Team`. Load-bearing in both directions — the comma is what marks the
 *  location boundary for the re-parser, and emitting a middot there instead
 *  re-parses the team as the company (#466). */
export const ORG_COMMA = ", ";

/** The gap between an entry header and a trailing date that is GLUED onto the
 *  same line rather than drawn flush-right. Two spaces, not one: the wide
 *  same-`y` gap is what `columnGapCuts` / `flush()` in `sections.ts` read as a
 *  flush-right date rail (#425). The parser side reads this geometrically (a
 *  measured x-gap), not as a literal, so there is no split-site spelling to
 *  unify — the constant exists so the one compose site is named, not silent. */
export const HEADER_DATE_GAP = "  ";

/** Hanging indent (pt) for a wrapped experience-header tail (#436). Matches the
 *  renderer's bullet text indent so the tail sits just PAST the bullet-marker
 *  margin — the threshold `isWrappedContinuation` (`entry-blocks.ts`) uses to
 *  fold a marker-less continuation back into the line it wraps from. Any value
 *  clear of that margin works; 12 pt keeps the indented tail visually aligned
 *  with the bullets. Like {@link HEADER_DATE_GAP} the split side is geometric,
 *  but unlike it the coupling is a NUMBER the parser compares against, so the
 *  two ends genuinely share one value. */
export const HEADER_WRAP_INDENT = 12;
