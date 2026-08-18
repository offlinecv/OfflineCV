// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JdMatchHeader — the shared heading of the JD-match card (#866 review).
 *
 * `KeywordMatch` and `SemanticMatch` opened with a byte-identical `<header>` +
 * title row: the `JD match` `<h2>` and the `alpha` pill. #204 created that
 * duplicate honestly — the keyword body was moved VERBATIM out of the old
 * `JdMatch.tsx` and the semantic view was written to match it — but nothing
 * held the two together afterwards, so renaming `alpha` (or retiring it, which
 * is the likeliest edit) in one file would silently leave the other behind.
 * The two views are peers rendered by the same router; a user toggling between
 * them would see the panel rename itself.
 *
 * ## What it deliberately does NOT absorb
 *
 * The `<Card>` wrapper, the arm-specific headline and disclaimer paragraphs,
 * and everything below the header stay in the views. The duplication worth
 * removing is the COPY — the strings that must not drift — not the layout: a
 * reader of `KeywordMatch` should still see its card chrome, its two-column
 * grid and its own disclaimer without following an import. So this takes the
 * arm's own header lines as `children` and adds only the title row above them,
 * which keeps each view's `<Card className="… gap-4 shadow-xs">` visible at
 * its own call site.
 *
 * Feature-area, not `@design-system`: one heading shared by two siblings in the
 * same lane is not a design-system concern, and promoting it would mint a
 * primitive with two callers and a hardcoded product string in it.
 */

import type { ReactNode } from "react";

export function JdMatchHeader({ children }: { children: ReactNode }) {
  return (
    <header className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-content-muted">
          JD match
        </h2>
        <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-4xs font-semibold uppercase tracking-wider text-content-secondary">
          alpha
        </span>
      </div>
      {children}
    </header>
  );
}
