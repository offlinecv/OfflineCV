// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * empty-result.ts — the from-scratch résumé factory (#313).
 *
 * `buildBlankResult()` seeds a `CascadeResult` with no parsed content and NO
 * triggers, so it renders through `ReconstructedResume` as a normal, fully
 * editable resume rather than tripping any of the parser-audit degenerate
 * branches (`fonts_unmappable` in `Result`, the scanned-abandon path).
 * Mirrors the empty branch of `buildScannedResult` (cascade.ts) but is
 * AUTHORED, not parsed — hence `suggestedEscalation: "none"` and `tiers: []`.
 *
 * `tiers: []` doubles as a structural signal elsewhere in the app (see
 * `useDownloadPdf.ts`'s download-source tagging) that a result was authored
 * from scratch rather than produced by any parse path — every real cascade
 * path (PDF or DOCX) always pushes at least `"t0_layout"` / `"t1_openresume"`
 * onto `tiers`.
 */

import { emptyParsed } from "./cascade.ts";
import { ACCOMPLISHMENT_SECTION_NAMES } from "./sections.ts";
import { toCanonicalResume } from "./canonical.ts";
import type { CascadeResult } from "./types.ts";

export function buildBlankResult(): CascadeResult {
  return {
    // Canonical model with no parsed content: empty field core, empty section
    // view (same inert shape the scanned-abandon path uses, #132), no
    // confidence.
    canonical: toCanonicalResume(
      emptyParsed(),
      {
        byName: new Map(),
        accomplishmentSections: ACCOMPLISHMENT_SECTION_NAMES,
        source: "regex",
      },
      {},
    ),
    confidence: 0,
    triggers: [],
    // Authored, not parsed — nothing to escalate.
    suggestedEscalation: "none",
    tiers: [],
    rawText: "",
    linkAnnotations: [],
    diagnostics: {
      rawCharCount: 0,
      extractedCharCount: 0,
      pages: 1,
      elapsedMs: 0,
    },
    timings: { t0_layout_ms: 0, t1_openresume_ms: 0 },
  };
}
