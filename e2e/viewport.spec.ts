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
 * #953. Measured: 185.5px expanded and 26px docked, identically at both
 * 1280x800 and 1440x900 and in all six `SCORE_REGIMES`. (The 62px #954
 * recorded as "docked" was a strip already wrapped to two lines — that
 * commit's own comment on `DOCKED_MAX_PX` said so and pointed here for the
 * re-derivation; this is it.) `EXPANDED_MAX_PX` (here) and `DOCKED_MAX_PX`
 * (`e2e/support/score-hero.ts`, shared with the #960 mobile spec) are
 * regression ceilings on those two numbers, NOT design targets — each margin
 * covers cross-machine rendering variance and nothing more, so what a ceiling
 * does and does not catch is stated next to the constant rather than inferred
 * from its size. #955 owns any further compression of the expanded state; if
 * it lands one, tighten `EXPANDED_MAX_PX` (never `DOCKED_MAX_PX`, a different
 * state) and re-measure the docked figure too, since #955's own notes say the
 * ring/dimension-row block — not the hero's outer padding — sets the floor.
 *
 * The docked strip's ONE-LINE regression matrix (#960 — six fixtures
 * spanning the three verdict bands crossed with the layout-penalty span)
 * lives in its own describe block below, sharing `e2e/support/score-hero.ts`
 * with `e2e/mobile/score-strip.spec.ts` rather than duplicating the
 * drop/dock/locate helpers a second time.
 *
 * The last describe block (#959) proves the `Popover` primitive's `align`
 * still anchors the panel to a trigger edge at THIS file's `md`+ widths,
 * after #959 added a `max-sm:*` override that pins the panel to the viewport
 * instead, below `sm` — `e2e/mobile/popover-containment.spec.ts` is the
 * below-`sm` half of that same proof.
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
import { test, expect } from "@playwright/test";
import type { Page, Locator } from "@playwright/test";
import {
  COLLAPSE_LABEL,
  DOCKED_MAX_PX,
  EXPAND_LABEL,
  SCORE_REGIMES,
  dockScoreHero,
  dropFixtureAndWaitForParse,
  expectDockedStripIsOneLine,
  expectRegimeBand,
  expectVerdictSlotDidNotWrap,
  forceVerdictWordFontSize,
  heroSection,
} from "./support/score-hero.ts";

// Re-measured, not inherited: 185.5px, identically in all six `SCORE_REGIMES`
// at both 1280x800 and 1440x900 — so unlike `DOCKED_MAX_PX` (which #960 found
// had been calibrated against an already-wrapped strip), this figure and its
// ceiling were sound as written. +14.5px (~8%) covers cross-machine
// font/subpixel variance; nowhere near the ~340px the pre-#956 static hero
// measured, which is the regression this ceiling exists to catch.
const EXPANDED_MAX_PX = 200;

// Measured 415.5px expanded (identical at both viewports). The hero ceilings
// above and in `score-hero.ts` bound `AtsScoreReadout`'s own <section>; this
// one bounds the whole score card that holds it — `ParsedHeader`, the
// two-column `ErrorState`, the collapsed targeting and local-AI feedback
// disclosures and the `gap-6` + `p-5` chrome add 230px (415.5 − 185.5) that
// sits OUTSIDE both hero ceilings while pushing the résumé down exactly the
// way #953/#956 care about. Without this assertion, `ParsedHeader` growing a
// row moves the résumé and leaves every other ceiling in this file untouched.
//
// RAISED from 300 by #955, which is the one change allowed to move it, and
// the raise is only honest alongside what it bought. #955 moved three surfaces
// INTO this card — `TargetingSection`, the recovery offer and the local-AI
// feedback disclosure — so that `Score details` means what its toggle label
// says. That is why ARRIVAL grew, 275.5 -> 415.5.
//
// **This ceiling bounds the arrival state only, and arrival is no longer the
// state the page settles into.** All three of those surfaces dock away with
// the readout, so the steady state after `useAutoCollapse`'s countdown is
// `ParsedHeader` + the one-line pill: 116px on this fixture, 226px on the
// two-column one. Measured Summary tops tell the same story from the other
// side — 751.5 (pre-#955) -> 779.5 arriving -> 480 docked here, and 833.5 ->
// 861.5 -> 562 on the two-column fixture. So the arrival number regressed
// against #953's fold promise while the steady state improved by ~270px, and
// only the second of those is what a reader actually sits in front of.
//
// Keep BOTH facts in view when this constant next moves. A raise paired with a
// docked state that did not improve is the regression this assertion exists to
// catch; a raise like this one is a deliberate trade. Re-measure, never nudge.
// +34.5px (~8.3%), same rendering variance as the other two.
const CARD_MAX_PX = 450;

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
  test("score hero is <=200px expanded and docks to <=34px", async ({ page }) => {
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
    await dockScoreHero(page);

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

test.describe("docked score strip stays one line regardless of the score (#960)", () => {
  // Six fixtures × 4 widths. The bands cover the regression #960 found — the
  // strip wrapped for a `Getting There`/`Needs Work` score at a width it held
  // one line for `Strong`, because the old layout let the verdict word's and
  // the layout-penalty span's rendered width decide the wrap. The widths
  // cover the one #960's own fix then introduced: 1440 and 1280 are where the
  // page container is at its 934px cap, 1024 is where it first reaches it
  // (the tightest width at which the dimension tiles render at all), and 768
  // is the widest width at which they must be absent rather than clipped.
  //
  // `expectDockedStripIsOneLine` carries both assertions and says why each
  // one is shaped the way it is — in particular why the `getClientRects()`
  // count this block used to assert proved nothing.
  //
  // Every test here sets its own widths (or, for the verdict-word test,
  // measured its numbers at 1280), so the `desktop-1440` project would only
  // re-run the identical block. Run it once.
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-1280",
      "viewport-independent block; runs under desktop-1280 only",
    );
  });

  for (const regime of SCORE_REGIMES) {
    test(`${regime.name} (${regime.band}) — one line at 1440 / 1280 / 1024 / 768px`, async ({
      page,
    }) => {
      await dropFixtureAndWaitForParse(page, regime.fixture);
      await dockScoreHero(page);
      await expectRegimeBand(page, regime);

      for (const width of [1440, 1280, 1024, 768]) {
        await page.setViewportSize({ width, height: 900 });
        await expectDockedStripIsOneLine(page, `${regime.name} @ ${width}px`);
      }
    });
  }

  test("verdict word cannot wrap its fixed-width slot and re-inflate the pill", async ({
    page,
  }) => {
    // The `sm:w-28` slot is what makes group 1's width independent of the
    // band — but a fixed-width box holding a TWO-word label ("Getting There",
    // "Needs Work") is a wrap waiting to happen one level further down, and
    // the span shipped with the default `white-space: normal`.
    //
    // 14px is not an arbitrary bump. "Getting There" is the widest label at
    // 89.3px natural, so it needs 89.3 x 14/11 = 113.7px — the first whole
    // pixel size that overruns the 112px slot. Measured at 1280 with only
    // this span's font-size varied and `truncate` removed from it, the
    // docked section went 26px (11px) -> 27.3px (13px) -> 47.3px (14px):
    // the jump IS the wrap. `DEFAULT_FIXTURE_PDF` scores `Getting There`,
    // so it renders exactly that label.
    //
    // Reachable without a code change: Chrome's minimum-font-size setting
    // raises 11px text while the `rem`-based slot width stays at 112px.
    //
    // 14px is the smallest size that reproduced the unfixed wrap (47.3px
    // docked section; slot height jumps from 18.7px to 37.3px). #974 asserts
    // `slotHeight < lineHeight * 1.5` directly on the slot FIRST, so a wrap
    // fails with a message naming the wrap rather than a generic height
    // overrun — and then still checks the strip's overall ceiling
    // (`DOCKED_MAX_PX`) at the forced size, since the slot check alone would
    // miss anything else the larger text pushes onto a second line.
    await dropFixtureAndWaitForParse(page);
    await dockScoreHero(page);
    await forceVerdictWordFontSize(page, 14);
    await expectVerdictSlotDidNotWrap(page, "verdict word forced to 14px");
    await expectDockedStripIsOneLine(page, "verdict word forced to 14px");
  });
});

// #959 pinned the score explainer's panel to the VIEWPORT below `sm`
// (`max-sm:*` on `Popover`'s `PANEL_BASE`), because at 375px `align` alone
// left it off-screen in both alignments. That override is media-gated —
// `e2e/mobile/popover-containment.spec.ts` proves the below-`sm` behaviour;
// this proves the fix left `align`'s own trigger-edge anchoring untouched at
// this file's `md`+ widths (1280/1440), where #956 originally added `align`
// specifically to fix.
test.describe("Popover panel stays trigger-aligned above sm (#959)", () => {
  test("docked strip explainer anchors to the trigger's right edge (align=end)", async ({
    page,
  }) => {
    await dropFixtureAndWaitForParse(page);
    await dockScoreHero(page);

    const trigger = page.getByRole("button", { name: "How is this scored?" });
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "How is this scored?" });
    await expect(panel).toBeVisible();

    const triggerBox = (await trigger.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    const viewport = page.viewportSize()!;

    expect(
      Math.abs(panelBox.x + panelBox.width - (triggerBox.x + triggerBox.width)),
    ).toBeLessThan(1);
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width);
  });

  test("expanded header explainer anchors to the trigger's left edge (align=start, default)", async ({
    page,
  }) => {
    await dropFixtureAndWaitForParse(page);

    const trigger = page.getByRole("button", { name: "How is this scored?" });
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "How is this scored?" });
    await expect(panel).toBeVisible();

    const triggerBox = (await trigger.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    const viewport = page.viewportSize()!;

    expect(Math.abs(panelBox.x - triggerBox.x)).toBeLessThan(1);
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width);
  });
});
