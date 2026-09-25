// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * SectionHeading — the ONE `<h2>` that titles a section of the reconstructed
 * résumé (Summary, Education, Skills, and the Experience heading inside
 * `ReconstructedResume`).
 *
 * Extracted because it had been copied verbatim into four feature files, each
 * carrying the same six lines and the same class string. Every copy was already
 * on semantic tokens and none had local state, so the duplication bought
 * nothing — it only meant a type-scale or token change had to be made four
 * times, with a silent visual drift if one was missed. This is the Golden Rule
 * case in `CLAUDE.md`: one shared piece per concern.
 *
 * Deliberately unstyled beyond the heading's own tokens and deliberately not
 * configurable — callers vary only in their text. A caller needing a different
 * level or weight wants a different concern, not a variant here.
 *
 * The rule under it mirrors the exported PDF's (#913): `render-ats-pdf.ts`
 * draws every section heading with a margin-to-margin 0.75pt mid-grey line
 * directly beneath it (`drawRule`, `gapAfterRule`). 0.75pt is 1 CSS px, so a
 * full-width 1px bottom border in the strong border token is the same mark,
 * and the column reads like the page it previews. The header block (name,
 * headline, contact) is not a section and has no rule in either place — it
 * never renders this component.
 */

import type { ReactNode } from "react";

interface SectionHeadingProps {
  children: ReactNode;
}

export function SectionHeading({ children }: SectionHeadingProps) {
  return (
    <h2 className="border-b border-border-strong pb-1 text-sm font-semibold uppercase tracking-wider text-content-muted">
      {children}
    </h2>
  );
}
