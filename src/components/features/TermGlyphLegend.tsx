// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * TermGlyphLegend — one line naming what the chip marks mean (#597).
 *
 * `/jobs/` grew four marks on its chips over three issues — `★` for the term
 * that is actually searched (#581) and `✓ / ○ / ⚠︎` for term quality (#585) —
 * each self-evident to whoever added it and none of them explained on screen.
 * A mark nobody can read is decoration, so this states the mapping once,
 * adjacent to the chip rows.
 *
 * Its own file rather than inline in `JobQueryEditor`, which is already ~286
 * LOC against the ~200 guide: per CLAUDE.md, extend a sibling instead of
 * growing that file.
 *
 * The glyphs come from `ChipListEditor`'s own {@link QUALITY_MARK} table, not a
 * second copy — change a mark there and this legend follows. Each entry pairs
 * the glyph with words, so meaning is never carried by colour alone, and the
 * glyphs themselves are `aria-hidden`: a screen reader gets the sentence, which
 * is the part that means something.
 */

import { QUALITY_MARK } from "./ChipListEditor.tsx";
import type { TermQuality } from "../../lib/job-search/term-quality.ts";

/** Consequence only, matching `term-quality.ts`'s `REASONS` register: what the
 *  mark tells you about your results, never how the mark was decided. */
const QUALITY_MEANING: Record<TermQuality, string> = {
  strong: "sharpens your matches",
  weak: "adds little",
  noise: "narrows nothing",
};

const PRIMARY_GLYPH = "★";
const PRIMARY_MEANING = "the one that is searched";

/** Every string this component can put on screen, so the copy rule above is
 *  assertable — see `job-search-copy.test.ts`. Same purpose as
 *  `search-plan.ts`'s `SEARCH_PLAN_COPY`: a new phrase cannot quietly escape
 *  the denylist by living in a component instead of a lib module. */
export const TERM_GLYPH_LEGEND_COPY: readonly string[] = [
  PRIMARY_MEANING,
  ...Object.values(QUALITY_MEANING),
];

export function TermGlyphLegend() {
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-content-secondary">
      <span>
        <span aria-hidden="true">{PRIMARY_GLYPH} </span>
        {PRIMARY_MEANING}
      </span>
      {(Object.keys(QUALITY_MEANING) as TermQuality[]).map((quality) => (
        <span key={quality}>
          <span aria-hidden="true" className={QUALITY_MARK[quality].className}>
            {QUALITY_MARK[quality].glyph}{" "}
          </span>
          {QUALITY_MEANING[quality]}
        </span>
      ))}
    </p>
  );
}
