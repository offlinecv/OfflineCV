// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * e2e/viewport.spec.ts — the harness behind #954.
 *
 * Vitest runs in jsdom, which has no layout engine, so three product claims
 * about `/` have never been regression-tested by anything: the score hero's
 * compact height (#953/#956), the editable résumé starting above the fold on
 * initial parse, and the `scroll-padding-top` sizing in `src/styles.css` that
 * is meant to keep the `#contact` / `#reconstructed-resume` hash-anchor
 * targets clear of the sticky `PageShell` header. This spec drops a synthetic
 * fixture PDF into the real drop zone in an actual Chromium layout engine and
 * asserts all three at `md`+ widths (`playwright.config.ts` runs this file at
 * both 1280x800 and 1440x900).
 *
 * Every threshold below was measured against THIS fixture on the current
 * `main` (a throwaway `chromium.launch()` script, not this file — this file
 * only has to defend the numbers, not rederive them), not inherited from an
 * older, superseded target. Re-measure before changing any of them.
 *
 * Score-hero height, post-#956: `AtsScoreReadout`'s original static ≤160px
 * target (#953) was explicitly retired once #956 shipped the widget as a
 * two-state design instead, per the "Clarification (rewrite)" comment on
 * #953. Measured today: 185.5px expanded, 62px docked, identically at both
 * 1280x800 and 1440x900. `EXPANDED_MAX_PX` and `DOCKED_MAX_PX` are regression
 * ceilings on those two numbers, NOT design targets — each margin covers
 * cross-machine rendering variance and nothing more, so what a ceiling does
 * and does not catch is stated next to the constant rather than inferred from
 * its size. #955 owns any further compression of the expanded state; if it
 * lands one, tighten `EXPANDED_MAX_PX` (never `DOCKED_MAX_PX`, a different
 * state) and re-measure the docked figure too, since #955's own notes say the
 * ring/dimension-row block — not the hero's outer padding — sets the floor.
 *
 * Above-the-fold, and what this spec does NOT defend: #955 ("...the first
 * résumé section still lands below the fold") is open, but its own table was
 * measured on `gh-953` mid-implementation, before commits that shipped in
 * #956 — re-measuring THIS fixture on `main` today puts the Summary heading
 * at 751.5px, inside the 800px raw fold with a real (if modest) margin, which
 * matches #956's own PR table ("Summary 752px ✅"), not #955's stale 810px.
 * This spec asserts that current, verified-true number. It does NOT assert
 * the harder claims #955 is still tracking: the two-column-layout fixture
 * (#956 measured that one at 834px, ❌, and #955's own AC3 leaves it an open
 * question whether that case is even in scope), or the original AC's
 * "~700px effective" fold height (751.5 already exceeds that budget). Do not
 * cite a pass here as those being fixed.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { fileURLToPath } from "node:url";

// The production strings, not private copies. `scoreToggleLabels.ts` exists
// because `AtsScoreReadout` and `CollapsedScoreBar` are separate subtrees that
// have to agree on these two names for focus restoration to work at all, and
// its docblock is explicit that "a constant private to either one only guards
// half of it". A third private copy here would put a rename three sites deep.
// The `../src` edge this adds to `tsconfig.e2e.json`'s program is deliberate
// and cheap: the module is two string constants with no imports of its own.
import {
  COLLAPSE_LABEL,
  EXPAND_LABEL,
} from "../src/components/features/scoreToggleLabels.ts";

const FIXTURE_PDF = fileURLToPath(
  new URL("../tests/fixtures/pdfs/latex/awesome-cv-resume.pdf", import.meta.url),
);

// Measured 185.5px. +14.5px (~8%) covers cross-machine font/subpixel
// variance; nowhere near the ~340px the pre-#956 static hero measured, which
// is the regression this ceiling exists to catch.
const EXPANDED_MAX_PX = 200;
// Measured 62px, both viewports. +8px (~13%) for the same rendering variance.
//
// Be clear about what this does NOT defend. 62px is ALREADY the wrapped
// two-row state: `CollapsedScoreBar` is `flex flex-wrap`, and its children
// currently land on two rows (measured child offsets 228/231 and 266, i.e.
// 26 + 12 of `gap-3` + 24 = 62). So this ceiling is calibrated ON the wrap,
// not against it, and a #960 regression that merely re-wraps the strip would
// pass here. What it catches is the strip growing past its present two rows.
// #965 moves this constant into `e2e/support/score-hero.ts` and re-derives it
// from the true one-row height (26px); tighten it there, with a fresh
// measurement, rather than guessing a smaller number here.
const DOCKED_MAX_PX = 70;

// Measured 275.5px expanded (identical at both viewports). The hero ceilings
// above bound `AtsScoreReadout`'s own <section>; this one bounds the whole
// score card that holds it — `ParsedHeader`, the two-column `ErrorState` and
// the `gap-6` + `p-5` chrome add 90px that sits OUTSIDE both hero ceilings
// while pushing the résumé down exactly the way #953/#956 care about. Without
// this assertion, `ParsedHeader` growing a row moves the résumé and leaves
// every other ceiling in this file untouched. +24.5px (~9%), same rendering
// variance as the other two.
const CARD_MAX_PX = 300;

/** Drop the fixture PDF via the real (hidden, `sr-only`) file input and wait
 *  for the reconstructed résumé to render. `setInputFiles` doesn't require
 *  the element to be visible, only attached — `DropZone`'s input is
 *  `sr-only`, not `display:none`.
 *
 *  Scoped by `accept` rather than a bare `input[type="file"]`: `/` also
 *  renders a second, unrelated file input (JSON library-record import,
 *  `accept="application/json,.json"`), and a bare selector is a Playwright
 *  strict-mode violation with both on the page. */
async function dropFixtureAndWaitForParse(page: Page): Promise<void> {
  await page.goto("/");
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .setInputFiles(FIXTURE_PDF);
  await page
    .locator("#reconstructed-resume")
    .waitFor({ state: "visible", timeout: 15_000 });
}

/** The score hero's outer `<section ref={rootRef}>`, whichever of the two
 *  states (`AtsScoreReadout`'s full reveal or `CollapsedScoreBar`'s docked
 *  strip) is currently mounted — selected via the toggle button's accessible
 *  name rather than a test id. No production component in this repo carries
 *  a `data-testid` (it's a test-file-only stub convention, see
 *  `ResultDetail.test.tsx`), and both states already expose a stable,
 *  user-facing name for their toggle.
 *
 *  `exact: true` matters: the docked strip's score pill carries a SEPARATE,
 *  longer aria-label ("Resume score 75 out of 100, Getting There. Expand
 *  score details.") that also *contains* `EXPAND_LABEL` as a substring, so a
 *  non-exact match resolves two elements and Playwright refuses to guess
 *  between them. */
function heroSection(page: Page): Locator {
  const collapseToggle = page.getByRole("button", {
    name: COLLAPSE_LABEL,
    exact: true,
  });
  const expandToggle = page.getByRole("button", {
    name: EXPAND_LABEL,
    exact: true,
  });
  return collapseToggle.or(expandToggle).locator("xpath=ancestor::section[1]");
}

/** The score `Card` wrapping the hero — `Result.tsx`'s
 *  `<Card className="flex flex-col gap-6 shadow-xs">`, which also holds
 *  `ParsedHeader` and the two-column `ErrorState`. `Card` renders a
 *  `<section>` (it keeps the landmark semantics its call sites relied on), so
 *  it is the hero section's own nearest `<section>` ancestor. This is the
 *  surface whose height is the actual above-the-fold budget; the hero is only
 *  the part of it #953/#956 compressed. */
function scoreCard(page: Page): Locator {
  return heroSection(page).locator("xpath=ancestor::section[1]");
}

test.describe("above-the-fold layout (#954)", () => {
  test("score hero is <=200px expanded and docks to <=70px", async ({ page }) => {
    await dropFixtureAndWaitForParse(page);

    // Expanded (arrival) state first, and read immediately: `useAutoCollapse`
    // only docks after a 4.5s idle countdown, and everything from the parse
    // wait above to this assertion runs in well under that, so this cannot
    // race the timer.
    const expandedBox = await heroSection(page).boundingBox();
    expect(expandedBox).not.toBeNull();
    expect(expandedBox!.height).toBeLessThanOrEqual(EXPANDED_MAX_PX);

    // …and the card that holds it, which is what actually decides how far
    // down the page the résumé starts. See `CARD_MAX_PX`.
    const cardBox = await scoreCard(page).boundingBox();
    expect(cardBox).not.toBeNull();
    expect(cardBox!.height).toBeLessThanOrEqual(CARD_MAX_PX);

    // Force the docked state via the same user-toggle path `useAutoCollapse`
    // exposes (`toggle`, which locks out the timer), rather than waiting out
    // the real countdown — a spec that raced that timer would flake.
    await page
      .getByRole("button", { name: COLLAPSE_LABEL, exact: true })
      .click();
    await page
      .getByRole("button", { name: EXPAND_LABEL, exact: true })
      .waitFor();

    const dockedBox = await heroSection(page).boundingBox();
    expect(dockedBox).not.toBeNull();
    expect(dockedBox!.height).toBeLessThanOrEqual(DOCKED_MAX_PX);
  });

  test("first résumé section (Summary) is above the fold on initial parse", async ({
    page,
  }) => {
    await dropFixtureAndWaitForParse(page);

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    // The Summary heading, not `#reconstructed-resume` (the outer container
    // that wraps ContactCard + the TargetingSection disclosure + the whole
    // document body): a container-top check passes with ~330px of margin to
    // spare and would keep passing through a large regression — see the
    // docblock above for why the Summary heading is "the first résumé
    // section" #955/#956 both measure. `SectionHeading` renders an <h2>; the
    // fixture's verbatim source heading for this section is "Summary"
    // (`SummarySection` falls back to that same string when the source PDF
    // carries no heading of its own, so this name is stable either way).
    const summaryHeading = page.getByRole("heading", {
      name: "Summary",
      exact: true,
    });

    // The lower bound is the sticky header's BOTTOM, not 0. `PageShell`'s
    // header is 135px tall (the `119 + 16 = 135px band` in `styles.css`), so a
    // heading that regressed to y = 50 would be sitting underneath it —
    // invisible — and still satisfy `y >= 0`. "Above the fold" has to mean
    // "below the header and above the fold" or it certifies nothing at the
    // top end. Measured 751.5px against a header bottom of 135, so this holds
    // with room at both viewports.
    const headerBox = await page.locator("header.sticky").boundingBox();
    expect(headerBox).not.toBeNull();

    // Expanded state — the harder case, since it's the taller of the two.
    // Read before the auto-collapse timer can dock the widget, same margin
    // as the hero-height test above.
    const summaryBox = await summaryHeading.boundingBox();
    expect(summaryBox).not.toBeNull();
    expect(summaryBox!.y).toBeGreaterThanOrEqual(
      headerBox!.y + headerBox!.height,
    );
    expect(summaryBox!.y).toBeLessThan(viewport!.height);
  });

  test("hash anchors scroll their targets clear of the sticky header", async ({
    page,
  }) => {
    await dropFixtureAndWaitForParse(page);

    // `header.sticky`, not a bare `header`: `ParsedHeader` (the "Parsed · Not
    // saved · N pages" strip) renders its own, non-sticky `<header>` inside
    // the résumé card, and only `PageShell`'s carries the `sticky` class this
    // spec is defending the clearance of.
    const header = page.locator("header.sticky");
    await header.waitFor({ state: "visible" });

    // Dock the widget FIRST, and do it through the user toggle. Every hash
    // jump below scrolls far past `useAutoCollapse`'s 40px displacement
    // threshold, so without this the widget is one lost focus away from
    // docking mid-loop: the hero would shrink ~124px, everything above the
    // target would reflow, and the clearance assertion would start failing
    // non-deterministically. Today it survives only because clicking an
    // in-hero `<a href="#...">` focuses it and the focus hold short-circuits
    // the scroll listener — a side effect this test never asked for and that
    // moving those anchors would silently remove. `toggle` LOCKS (see the
    // hook's docblock): once the user has stated a preference neither the
    // timer nor the scroll listener may overrule it, so one click here makes
    // the whole loop immune to both.
    await page
      .getByRole("button", { name: COLLAPSE_LABEL, exact: true })
      .click();
    const expandToggle = page.getByRole("button", {
      name: EXPAND_LABEL,
      exact: true,
    });
    await expandToggle.waitFor();

    for (const [href, targetId] of [
      ["#contact", "contact"],
      ["#reconstructed-resume", "reconstructed-resume"],
    ] as const) {
      // A real `<a href="#...">` click (ScoreDimensionRow / CollapsedScoreBar)
      // is a same-document hash navigation, not a full page load — the parsed
      // résumé survives it. A `page.goto("/#...")` would NOT: the parse isn't
      // persisted until the first edit (`useAutosaveResume`), so a full
      // reload here would land back on the empty drop zone.
      await page.locator(`a[href="${href}"]`).first().click();
      // Wait for the scroll position to stop moving rather than for a fixed
      // number of frames. The jump itself is instant (styles.css sets no
      // scroll-behavior, so this is not a "smooth" animation) and one frame
      // would do today, but a frame count is a guess about layout timing and
      // this is a fact about it.
      await page.waitForFunction(
        () =>
          new Promise<boolean>((resolve) => {
            const before = window.scrollY;
            requestAnimationFrame(() => resolve(window.scrollY === before));
          }),
      );
      // The lock above must still hold — if the widget ever docks mid-loop,
      // fail on that rather than on the reflow it causes three lines later.
      await expect(expandToggle).toBeVisible();

      const headerBox = await header.boundingBox();
      const targetBox = await page.locator(`#${targetId}`).boundingBox();
      expect(headerBox).not.toBeNull();
      expect(targetBox).not.toBeNull();
      // "Clear of the sticky header" = the target's top sits at or below the
      // header's bottom edge, never underneath it.
      expect(targetBox!.y).toBeGreaterThanOrEqual(
        headerBox!.y + headerBox!.height - 1,
      );
    }
  });
});
