// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Core line/section types shared across the heuristics layer, split out of
 * `sections.ts` (#650) so a consumer that only needs the *shape* of a parsed
 * line/section — not the header-classification logic that produces one —
 * doesn't drag `sections.ts`'s ~2000-line `splitIntoSections` body into its
 * bundle graph. `cascade.ts` imports `ACCOMPLISHMENT_SECTION_NAMES` eagerly
 * (it is not behind a dynamic `import()`), so that value living in the same
 * module as `splitIntoSections` was pulling the whole god module into the
 * `/` entry chunk. Pure types + one small policy constant: no parsing logic
 * lives here, and nothing here imports `sections.ts` or `line-assembly.ts`.
 */

import type { PdfTextItem } from "./types.ts";
import type { SectionName } from "./regex.ts";

export interface PdfLine {
  page: number;
  /** Line's representative y (average of item y-centers). */
  y: number;
  /** Left-most item x on the line. */
  x: number;
  /** Items sorted left-to-right. */
  items: PdfTextItem[];
  /** Concatenated text with spaces between runs. */
  text: string;
  /** Max fontSize across items — drives name / header detection. */
  maxFontSize: number;
  /** True if every item on the line is all-caps (names + headers). */
  allCaps: boolean;
  /**
   * Vertical distance (PDF points) from the previous line's baseline on the
   * same page to this line's — i.e. the gap *above* this line. `0` for the
   * first line on each page (no line above ⇒ no gap signal). This is the
   * font-independent header cue (#216): a section header sits below a
   * paragraph break, so its gap-above runs visibly larger than the body
   * line-height even on font-flattening renderers (Google Docs/Skia,
   * WeasyPrint/Cairo) where the font-ratio signal collapses to ≈1.0–1.09.
   * Cross-page transitions reset to `0` so a page break is never read as a
   * header gap.
   */
  gapAbove: number;
}

export interface PdfSection {
  /** "profile" covers anything above the first recognized header. */
  name: SectionName | "profile";
  /** Verbatim heading text as it appeared in the source document, when this
   *  section was opened by a recognized/other header (issue #285). Absent for
   *  "profile" (content above the first header) and synthesized sections. */
  rawHeading?: string;
  lines: PdfLine[];
}

/**
 * Typed, scorer-facing view of the detected section structure (spike #127 §2.1,
 * issue #132). Promotes the `PdfSection[]` the cascade already computes into a
 * minimal contract: section name → trimmed, non-empty text lines, in document
 * order. The pure scorer reads this instead
 * of receiving a hand-serialized `skillsSectionText` slice, so the cascade is
 * the single source of truth for "which lines belong to which section" and we
 * never add a per-bug side-channel again.
 *
 * Kept dependency-light on purpose: `ReadonlyMap<name, string[]>` rather than
 * `PdfSection[]`, so `score.ts` need not import `PdfLine`/`PdfTextItem`
 * geometry types.
 */
export interface SectionedResume {
  /** Section name → trimmed, non-empty text lines, in document order.
   *  "profile" (anything above the first header) is included so contact/name
   *  consumers can share the same view. */
  readonly byName: ReadonlyMap<SectionName | "profile", readonly string[]>;
  /** Sections whose lines pool into the experience-bullet set, in canonical
   *  policy order. A convenience accessor over `byName` for the scorer; not yet
   *  consumed by the pool sourcing (that is the next issue — see #132 Notes). */
  readonly accomplishmentSections: readonly SectionName[];
  /** Section name → verbatim source heading text, when the section was opened
   *  by a recognized/other header (issue #285). Display-layer only — scoring
   *  stays keyed on canonical `SectionName`; this is purely for the UI/export
   *  to render the user's own wording instead of the hardcoded canonical word.
   *  Absent entries — and an absent map entirely, for hand-built test fixtures
   *  predating this field — fall back to the canonical word at the call site. */
  readonly sectionHeadings?: ReadonlyMap<SectionName, string>;
  /** Which splitter produced the section boundaries — provenance for
   *  confidence tuning / telemetry. */
  readonly source: "markdown" | "regex";
}

/** Canonical policy: these sections contribute experience-bullet lines. Encoded
 *  once here rather than duplicated across the authed/anonymous scorers. */
export const ACCOMPLISHMENT_SECTION_NAMES: readonly SectionName[] = [
  "experience",
  "projects",
  "achievements",
];
