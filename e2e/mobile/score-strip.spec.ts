// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * e2e/mobile/score-strip.spec.ts — the mobile-375 regression proof for #960,
 * and (since #988) for the verdict word staying visible there too.
 *
 * Adding a spec under `e2e/mobile/` activates the `mobile-375` Playwright
 * project (`playwright.config.ts`), which was configured but dormant — its
 * `testMatch` only looks here, and nothing existed yet. #960 is one of the
 * two issues expected to add this file (the other is #959, Popover
 * containment, which is stacked on top and reuses this same drop/dock
 * plumbing from `e2e/support/score-hero.ts`). #988 added the
 * `expectVerdictWordVisible` assertion below rather than a third file: same
 * drop/dock plumbing, same three regimes, and the two things it checks (one
 * line, band visible) must hold together — a slot narrow enough to avoid a
 * wrap but too narrow to actually show the word would pass #960's test and
 * fail #988's, or vice versa.
 *
 * At 375px the dimension-track group (`CompactDimension` × 3) is already
 * `hidden` below `lg` (1024px), by design — below that width the row has no
 * width budget that fits a whole set of tiles, and a clipped tile is not an
 * option (see the group comment in `CollapsedScoreBar.tsx`) — so every regime
 * renders the SAME two visible groups: the score pill and the `ⓘ`/`Score
 * details ▾` toggle. That collapses the
 * six-fixture matrix `viewport.spec.ts` runs at desktop widths down to what
 * actually varies at this width: the pill's digit count — and all three
 * regimes below score two digits, so a `100` or single-digit pill is not
 * exercised here. Three regimes — one per verdict band, one of the three
 * carrying a layout penalty — are enough to prove the row never wraps at the narrowest
 * width the product supports; the full penalty × band cross is already
 * proven at desktop widths in `viewport.spec.ts`.
 */
import { test } from "@playwright/test";
import {
  dockScoreHero,
  dropFixtureAndWaitForParse,
  expectDockedStripIsOneLine,
  expectRegimeBand,
  expectVerdictWordGlyphVisible,
  expectVerdictWordVisible,
  scoreRegime,
} from "../support/score-hero.ts";

const MOBILE_REGIMES = [
  scoreRegime("strong, no penalty"),
  scoreRegime("getting there, with penalty"),
  scoreRegime("needs work, no penalty"),
];

test.describe("docked score strip is one line at 375px (#960)", () => {
  for (const regime of MOBILE_REGIMES) {
    test(`${regime.name} (${regime.band})`, async ({ page }) => {
      await dropFixtureAndWaitForParse(page, regime.fixture);
      await dockScoreHero(page);
      await expectRegimeBand(page, regime);

      // #988: at 375px the band must have a visible TEXT form, not just the
      // pill's aria-label (screen readers only) and the dot's colour (WCAG
      // 1.4.1). #965/#960 shipped this word `hidden` below `sm`; this is the
      // regression proof it stays on screen there.
      await expectVerdictWordVisible(page, regime);

      // #1060: the DOM-presence check above cannot tell "Strong" from "S…" —
      // this measures the actual painted glyphs at the 20px slot width and
      // fails only if the ellipsis ever swallows the whole word.
      await expectVerdictWordGlyphVisible(page, regime);

      // Same shared assertion the desktop widths use, rather than a second
      // copy of the block — it also checks that the toggle and the ⓘ
      // explainer survived, which at this width is the whole point: they are
      // the only route back to the expanded state, since the dimension
      // tracks are absent below `lg` regardless.
      await expectDockedStripIsOneLine(page, `${regime.name} @ 375px`);
    });
  }
});
