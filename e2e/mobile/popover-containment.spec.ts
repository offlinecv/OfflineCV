// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * e2e/mobile/popover-containment.spec.ts — real-browser containment proof
 * for #959.
 *
 * jsdom has no layout engine (`getBoundingClientRect()` is always zero
 * there), so `Popover.test.tsx` can only pin the CLASS CONTRACT — that the
 * panel carries the below-`sm` viewport-pinning override. Whether that
 * override actually keeps the panel on screen is a real-browser question,
 * and a subtle one: a `fixed` element's `top: 100%` resolves against the
 * VIEWPORT's height, not the trigger's, so naively overriding only
 * horizontal placement (as #959's own suggested direction did) renders the
 * panel a full viewport-height below the trigger — off-screen at the
 * BOTTOM rather than the LEFT/RIGHT overflow this issue reports. That
 * failure mode is invisible to a `left >= 0 && right <= clientWidth`
 * assertion alone, so this spec also asserts vertical containment.
 *
 * Three `Popover` call sites, both widget states of the score hero, plus
 * the `AchievementTypePicker` consumer named explicitly in #959's
 * acceptance criteria:
 *   - docked score strip's explainer (`align="end"`)
 *   - expanded readout header's explainer (`align="start"`, the default)
 *   - the achievement-type menu inside the reconstructed résumé
 *
 * `awesome-cv-resume.pdf` is reused from `SCORE_REGIMES` ("getting there,
 * no penalty") rather than a new fixture — its baked corpus snapshot
 * carries 15 achievements, so its first achievement row's type picker is
 * guaranteed to render without hunting for one.
 *
 * The last describe block (#971) proves the below-`sm` scrim this file's
 * own viewport (375px) is the one real-browser oracle for: whether it is
 * actually present and covers the viewport, and whether tapping it closes
 * the panel — `Popover.test.tsx` can only pin the class/dismiss contract in
 * jsdom, which has no layout engine to confirm the scrim is visible at all.
 */
import { test, expect } from "@playwright/test";
import {
  dockScoreHero,
  dropFixtureAndWaitForParse,
  scoreRegime,
} from "../support/score-hero.ts";

const FIXTURE = scoreRegime("getting there, no penalty").fixture;

async function viewport(page: import("@playwright/test").Page) {
  return page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }));
}

function assertContained(
  box: { x: number; y: number; width: number; height: number },
  vp: { width: number; height: number },
) {
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
}

test.describe("Popover panel stays on screen at 375px (#959)", () => {
  test("docked score strip explainer (align=end)", async ({ page }) => {
    await dropFixtureAndWaitForParse(page, FIXTURE);
    await dockScoreHero(page);

    await page.getByRole("button", { name: "How is this scored?" }).click();
    const panel = page.getByRole("dialog", { name: "How is this scored?" });
    await expect(panel).toBeVisible();

    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    assertContained(box!, await viewport(page));
  });

  test("expanded readout header explainer (align=start, default)", async ({
    page,
  }) => {
    await dropFixtureAndWaitForParse(page, FIXTURE);
    // The hero starts expanded and only docks itself after ~4.5s
    // (`useAutoCollapse`) — waiting on the toggle rather than racing that
    // timer is what keeps this deterministic.
    await page
      .getByRole("button", { name: "Collapse score details", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "How is this scored?" }).click();
    const panel = page.getByRole("dialog", { name: "How is this scored?" });
    await expect(panel).toBeVisible();

    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    assertContained(box!, await viewport(page));
  });

  test("AchievementTypePicker menu (align=start, default)", async ({ page }) => {
    await dropFixtureAndWaitForParse(page, FIXTURE);

    const achievementTrigger = page
      .locator('button[aria-haspopup="menu"]')
      .first();
    await achievementTrigger.scrollIntoViewIfNeeded();
    await achievementTrigger.click();
    const panel = page.getByRole("menu", { name: "Achievement type" });
    await expect(panel).toBeVisible();

    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    assertContained(box!, await viewport(page));
  });
});

test.describe("Popover scrim at 375px (#971)", () => {
  test("open panel is accompanied by a scrim that covers the viewport", async ({
    page,
  }) => {
    await dropFixtureAndWaitForParse(page, FIXTURE);
    await dockScoreHero(page);

    await page.getByRole("button", { name: "How is this scored?" }).click();
    const panel = page.getByRole("dialog", { name: "How is this scored?" });
    await expect(panel).toBeVisible();

    // The scrim carries no role/name, so it is located structurally: the
    // panel's immediate preceding sibling, which is where `Popover.tsx`
    // renders it (same root `<div>`, scrim before panel).
    const scrim = panel.locator("xpath=preceding-sibling::*[1]");
    await expect(scrim).toBeVisible();
    await expect(scrim).toHaveAttribute("aria-hidden", "true");

    const box = await scrim.boundingBox();
    expect(box).not.toBeNull();
    const vp = await viewport(page);
    expect(box).toMatchObject({ x: 0, y: 0, width: vp.width, height: vp.height });
  });

  test("tapping the scrim closes the popover and returns focus to the trigger", async ({
    page,
  }) => {
    await dropFixtureAndWaitForParse(page, FIXTURE);
    await dockScoreHero(page);

    const trigger = page.getByRole("button", { name: "How is this scored?" });
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "How is this scored?" });
    await expect(panel).toBeVisible();

    const scrim = panel.locator("xpath=preceding-sibling::*[1]");
    // Not a corner: `PageShell`'s own header is `sticky` at `z-20`, strictly
    // above the scrim's `z-10`, so it paints OVER the scrim for the whole
    // top of the viewport regardless of the panel's position — a point near
    // a corner (e.g. (2, 2)) resolves to the header, not the scrim, and
    // Playwright's actionability check times out waiting for an occluded
    // element. Measured directly (`document.elementFromPoint`): the header
    // is the hit at (2, 2), not the scrim, confirming this is the header
    // sitting on top, not the bottom-anchored panel. The midpoint between
    // the header's bottom edge and the panel's top edge is clear of both by
    // construction, so this stays correct if either one's height changes.
    const headerBox = await page.locator("header").first().boundingBox();
    const panelBox = await panel.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    const clearY = Math.round(
      (headerBox!.y + headerBox!.height + panelBox!.y) / 2,
    );

    await scrim.click({ position: { x: 10, y: clearY } });

    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});
