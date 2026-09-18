// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * DocumentBody — the scroll target the triage row's bullet jump link lands on
 * (#958). Split out of ReconstructedResume.tsx, which is named in CLAUDE.md as
 * known debt and must not grow, and so that a unit test can render the target
 * side: ReconstructedResume is too heavy to render in a test, so without this
 * sibling nothing proves `#${SECTION_IDS.documentBody}` actually paints, and a
 * deleted or misspelled wrapper would leave "Review bullets ↓" jumping nowhere.
 *
 * One id wrapping every résumé section below the targeting row, rather than a
 * specific section id, because the flagged-bullet pool the link summarizes is
 * not experience-only (see `SECTION_IDS.documentBody`'s docblock in
 * `anchors.ts`). The div exists ONLY to carry that id — it repeats the parent
 * `<section>`'s `flex flex-col gap-6` so sibling spacing is unchanged, and its
 * `scroll-mt-6` matches ContactCard's.
 */

import type { ReactNode } from "react";
import { SECTION_IDS } from "../../lib/anchors.ts";

export function DocumentBody({ children }: { children: ReactNode }) {
  return (
    <div id={SECTION_IDS.documentBody} className="scroll-mt-6 flex flex-col gap-6">
      {children}
    </div>
  );
}
