// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * e2e/mobile/page-overflow.spec.ts — the mobile-375 regression proof for #970.
 *
 * `document.documentElement.scrollWidth` ran 435–442px against a 375px
 * `clientWidth` on `/` with nothing open — a page that scrolls sideways on a
 * phone. #960's own investigation pinned the overflowing node to
 * `ParsedHeader`'s control row (`div.flex.items-center.gap-3`, "Feedback /
 * Save to library / Try another file"), measured across the same six
 * corpus-fixture regimes `viewport.spec.ts` uses at desktop widths
 * (`score-strip.spec.ts` itself exercises only 3 of the 6, `MOBILE_REGIMES`),
 * at 375px specifically — #960 also measured 640px up as clean
 * (`scrollWidth == clientWidth` exactly), so this spec only needs the one
 * width the bug lives at.
 *
 * Reusing `SCORE_REGIMES` rather than a new fixture list: no fixture here is
 * edited or degenerate, so the edited/save-state badges and "Reset to
 * parsed" button never actually vary across regimes — the six are reused
 * simply to avoid a second fixture table to keep in sync with
 * `score-hero.ts`'s existing one.
 */
import { test, expect } from "@playwright/test";
import { dropFixtureAndWaitForParse, SCORE_REGIMES } from "../support/score-hero.ts";

test.describe("no horizontal page scroll at 375px (#970)", () => {
  for (const regime of SCORE_REGIMES) {
    test(`${regime.name} (${regime.band})`, async ({ page }) => {
      await dropFixtureAndWaitForParse(page, regime.fixture);

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));

      expect(
        scrollWidth,
        `${regime.name}: page scrolls horizontally at 375px — scrollWidth ${scrollWidth} vs clientWidth ${clientWidth}`,
      ).toBe(clientWidth);
    });
  }
});
