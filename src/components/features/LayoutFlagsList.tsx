// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * LayoutFlagsList — renders the layout-trigger warning list.
 * Extracted from Result.tsx (issue #83). Pure display; no state.
 */

import type { LayoutTrigger } from "../../lib/heuristics/types.ts";

const LAYOUT_TRIGGER_BLURBS: Record<LayoutTrigger, string> = {
  two_column:
    "Two-column layout — some text extractors read across columns and scramble the order.",
  scanned:
    "Image-only PDF — no selectable text, so a plain-text extractor returns nothing.",
  fonts_unmappable:
    "Text is present in the source but uses custom font encodings that don't decode to characters. Common with Framer, Affinity, and some InDesign exports.",
};

interface LayoutFlagsListProps {
  triggers: readonly LayoutTrigger[];
}

export function LayoutFlagsList({ triggers }: LayoutFlagsListProps) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
        Layout flags
      </h2>
      {triggers.length === 0 ? (
        <p className="text-sm text-content-tertiary">
          No layout flags — standard single-column, text-selectable PDF.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {triggers.map((t) => (
            <li key={t} className="text-sm">
              <span className="font-mono text-xs text-content-secondary">
                {t}
              </span>{" "}
              <span className="text-content-tertiary">
                — {LAYOUT_TRIGGER_BLURBS[t]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
