// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * trigger-copy — the single source of the plain-language layout-trigger
 * explanations.
 *
 * These blurbs used to live inline in `LayoutFlagsList.tsx`; they were hoisted
 * to `src/lib/` (#343) so lib-layer consumers — the shareable audit-report
 * exporter (`render-audit-report.ts`) — can render the same copy WITHOUT a lib→
 * component import (which would invert the dependency direction the codebase
 * keeps: components import from lib, never the reverse). `LayoutFlagsList` now
 * imports from here too, so the on-screen list and the exported report stay in
 * lockstep.
 */

import type { LayoutTrigger } from "./types.ts";

/** Plain-language explanation for each layout trigger the parser can fire. */
export const LAYOUT_TRIGGER_BLURBS: Record<LayoutTrigger, string> = {
  two_column:
    "Two-column layout — some text extractors read across columns and scramble the order.",
  scanned:
    "Image-only PDF — no selectable text, so a plain-text extractor returns nothing.",
  fonts_unmappable:
    "Text is present in the source but uses custom font encodings that don't decode to characters. Common with Framer, Affinity, and some InDesign exports.",
};
