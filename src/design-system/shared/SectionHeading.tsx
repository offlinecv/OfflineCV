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
 * case in `CLAUDE.md`: exactly one shared piece per concern.
 *
 * Deliberately unstyled beyond the heading's own tokens and deliberately not
 * configurable — callers vary only in their text. A caller needing a different
 * level or weight wants a different concern, not a variant here.
 */

import type { ReactNode } from "react";

interface SectionHeadingProps {
  children: ReactNode;
}

export function SectionHeading({ children }: SectionHeadingProps) {
  return (
    <h2 className="text-sm font-semibold uppercase tracking-wider text-content-muted">
      {children}
    </h2>
  );
}
