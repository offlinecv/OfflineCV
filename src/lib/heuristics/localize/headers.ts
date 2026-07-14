// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * The shared markdown HEADER ORACLE — the one place `localize/skills.ts` and
 * `localize/education.ts` read `cascade.markdown` to ask:
 *
 *   > The strict section router (`matchSectionHeader`) is EXACT-match after a
 *   > trailing-punct strip. Did it REJECT a header that loosely reads as this
 *   > section (a leading decorative glyph #414, an out-of-alias wording, a
 *   > two-line wrap #374)?
 *
 * The two localizers had a ~60-line clone of this (headerCandidates →
 * missedHeaders → orphanBlock) plus a `looseXReason` that differed only in its
 * alias/anchor sets and one noun. One helper, two callers.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ `unavailable` — why the oracle can FAIL TO RUN, and why that is not      │
 * │ the same as "no header was rejected". Read before touching this.         │
 * │                                                                          │
 * │ `cascade.markdown` is `undefined` in two real, common cases              │
 * │ (`cascade.ts`): the layout probe called the PDF SCANNED (Tier 1 is        │
 * │ short-circuited entirely — there is no markdown to emit), or             │
 * │ `emitMarkdown()` returned undefined because the document was too sparse   │
 * │ for the positional emitter. In both, this oracle has NOTHING to read.     │
 * │                                                                          │
 * │ The clone this replaced coalesced that to `""` — so "the oracle could     │
 * │ not run" became indistinguishable from "the oracle ran and found no       │
 * │ rejected header". That difference is load-bearing: `skills-header-        │
 * │ unrecognized` and `skills-no-section` are BYTE-IDENTICAL in               │
 * │ `ReproArtifact` (0 skills, no routed region), and the ONLY bit that       │
 * │ separates them is `skillsHeaderCandidateRejected` — which is derived      │
 * │ EXCLUSIVELY from this oracle. Coalescing therefore silently downgraded a  │
 * │ real header-rejection on a scanned/sparse PDF to `skills-no-section`,     │
 * │ which 9 corpus fixtures "cover" — so the sweep would answer COVERED       │
 * │ ("stop, we already reproduce this") for a defect NO fixture reproduces.   │
 * │                                                                          │
 * │ So `unavailable` is reported, `derived.headerOracleUnavailable` carries   │
 * │ it, and the `*-no-section` classes REFUSE to fire while it is true. An    │
 * │ undecidable pair reports as undecided; it never guesses.                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * PURE: reads an already-parsed `CascadeResult`, never re-parses, never does I/O.
 */

import type { CascadeResult } from "../types.ts";
import { matchSectionHeader } from "../regex.ts";

/** A markdown line the emitter marked as a header (`#`/`##`/`###`). */
const MD_HEADER_RE = /^#{1,3}\s+/;

/** A section-like header the STRICT router did not map to this section, and why
 *  a strict match would have failed. Text only — the caller decides whether that
 *  text is safe to print (harness scratch: yes; PII-free `DerivedSignals`: the
 *  text never enters it, only the boolean "was one rejected"). */
export interface MissedHeader {
  text: string;
  reason: string;
}

export interface HeaderOracle {
  /**
   * TRUE when `cascade.markdown` is absent or empty — a scanned or sparse PDF.
   * The oracle could not run: `missedHeaders` is empty because there was nothing
   * to look at, NOT because nothing was rejected. Never read `missedHeaders`
   * without reading this. See the file header.
   */
  unavailable: boolean;
  /** Every markdown header, with what the strict router mapped it to (or null). */
  headerCandidates: { text: string; strict: string | null }[];
  /** Section-like headers the strict router rejected. */
  missedHeaders: MissedHeader[];
  /** The markdown block under the FIRST missed header, up to the next header —
   *  i.e. the content that dropped with it. */
  orphanBlock: string[];
}

/**
 * The loose header oracle for one section. Mirrors the strict normalizer in
 * `matchSectionHeaderDetailed` (trim + lowercase + trailing-punct strip) but
 * ALSO strips a leading run of non-letter / non-number glyphs — the exact gap
 * #414 identified. Returns the reason a strict match would have failed, or null
 * if the line doesn't read as this section at all.
 *
 * `noun` appears verbatim in the returned reason, so the two callers' messages
 * stay byte-identical to what they printed before the extraction.
 */
export function looseHeaderReason(
  raw: string,
  aliases: readonly string[],
  anchors: ReadonlySet<string>,
  noun: string,
): string | null {
  const trimmedLower = raw.trim().toLowerCase().replace(/[:·•]+$/, "").trim();
  const glyphStripped = trimmedLower.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (glyphStripped.length === 0 || glyphStripped.length > 40) return null;
  if (aliases.includes(glyphStripped)) {
    return glyphStripped === trimmedLower
      ? "alias match (would route — not a miss)"
      : `leading-glyph prefix (${JSON.stringify(trimmedLower)} → ${JSON.stringify(glyphStripped)})`;
  }
  const tokens = glyphStripped.split(/\s+/).filter(Boolean);
  if (tokens.some((t) => anchors.has(t)))
    return `contains ${noun} anchor token but wording not in aliases (${JSON.stringify(glyphStripped)})`;
  return null;
}

/**
 * Run the header oracle over `cascade.markdown` for one section.
 *
 * `section` is BOTH the strict-router section name a candidate must NOT have
 * matched, and the noun spliced into the reason string.
 */
export function findMissedHeaders(
  cascade: CascadeResult,
  aliases: readonly string[],
  anchors: ReadonlySet<string>,
  section: string,
): HeaderOracle {
  const md = cascade.markdown;
  const unavailable = !md || md.trim().length === 0;
  const mdLines = (md ?? "").split("\n");

  const candidates = mdLines
    .map((l, i) => ({
      text: l.replace(MD_HEADER_RE, "").trim(),
      i,
      isHeader: MD_HEADER_RE.test(l),
    }))
    .filter((h) => h.isHeader && h.text.length > 0);

  const missed = candidates
    .map((h) => ({
      ...h,
      strict: matchSectionHeader(h.text),
      reason: looseHeaderReason(h.text, aliases, anchors, section),
    }))
    .filter(
      (h) =>
        h.strict !== section &&
        h.reason !== null &&
        !h.reason.startsWith("alias match"),
    );

  const orphanBlock: string[] = [];
  if (missed.length > 0) {
    for (let i = missed[0].i + 1; i < mdLines.length; i++) {
      if (MD_HEADER_RE.test(mdLines[i])) break;
      if (mdLines[i].trim()) orphanBlock.push(mdLines[i].trim());
    }
  }

  return {
    unavailable,
    headerCandidates: candidates.map((h) => ({
      text: h.text,
      strict: matchSectionHeader(h.text),
    })),
    missedHeaders: missed.map((h) => ({ text: h.text, reason: h.reason! })),
    orphanBlock,
  };
}
