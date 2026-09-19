// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * e2e/support/score-hero.ts — shared drop/locate helpers for the score hero,
 * factored out of `viewport.spec.ts` (#954) so `e2e/mobile/score-strip.spec.ts`
 * (#960) can drive the same widget without a second copy of the drop-and-wait
 * boilerplate or the toggle-label constants drifting between the two files.
 *
 * `SCORE_REGIMES` is the data-regime matrix #960 needs to prove the docked
 * strip's height is not a function of the score: three verdict bands
 * (`getScoreTier` in `src/lib/score/score.ts` — Strong >=80, Getting There
 * 60-79, Needs Work <60) crossed with the optional layout-penalty span
 * (`score.layout.multiplier < 1`), six fixtures total. Each fixture's
 * `overall`/`multiplier` pair is read straight off its baked corpus snapshot
 * (`tests/fixtures/pdfs/**\/*.expected.json`, written by `corpus.test.ts`),
 * which computes `computeAnonymousAtsScore` off the identical
 * `parsed`/`sections` shape `scoreParsedResume` (`src/lib/score/score-cascade.ts`)
 * feeds it at parse time — `projectScoreSections` is an identity-holder
 * projection (returns `canonical.sections` by reference), so the snapshot
 * number IS the number this app renders for that PDF, not an approximation:
 *
 *   openresume-react-pdf.pdf              81  mult 1     Strong, no penalty
 *   chromium-asymmetric-sidebar.pdf       80  mult 0.85  Strong, with penalty
 *   awesome-cv-resume.pdf                 75  mult 1     Getting There, no penalty
 *   two-column-achievements-sidebar.pdf   63  mult 0.85  Getting There, with penalty
 *   single-column-year-only-roundtrip.pdf 55  mult 1     Needs Work, no penalty
 *   deedy-resume-macfonts.pdf             45  mult 0.85  Needs Work, with penalty
 *
 * Re-run `npm run bake-fixtures` before trusting these numbers again if any of
 * the six fixtures, or the scoring formula/weights, change.
 */
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import type { Page, Locator } from "@playwright/test";
import {
  COLLAPSE_LABEL,
  EXPAND_LABEL,
} from "../../src/components/features/scoreToggleLabels.ts";

function fixturePath(relative: string): string {
  return fileURLToPath(
    new URL(`../../tests/fixtures/pdfs/${relative}`, import.meta.url),
  );
}

// Re-exported, not re-declared. `scoreToggleLabels.ts` exists because
// `AtsScoreReadout` and `CollapsedScoreBar` are separate subtrees that have to
// agree on these two names for focus restoration to work at all, and its
// docblock is explicit that "a constant private to either one only guards half
// of it" — a private copy here would put a rename a third site deep. Every e2e
// caller goes through this one hop. The `../../src` edge it adds to
// `tsconfig.e2e.json`'s program is deliberate and cheap: the module is two
// string constants with no imports of its own.
export { COLLAPSE_LABEL, EXPAND_LABEL };

/** Regression ceiling on the docked strip's height, re-derived from the one
 *  measurement that matters — what the strip is when it is CORRECT.
 *
 *  The strip has three measured states, and the old ceiling of 70 sat in the
 *  worst possible place among them:
 *
 *    26px  one line, unwrapped — every band, every width, post-fix.
 *    62px  a TWO-line wrap (26 + the 12px `gap-3` row gap + a 24px second
 *          line). Pre-#960 this is what `Getting There` did at 1024/1280/1440,
 *          and `Strong` did there too once a layout penalty widened the pill.
 *    94px  a THREE-line wrap, only at 640–767px, where the dimension group
 *          was still `sm:flex` and 585px of tracks could not share a
 *          550–678px row with the pill and the toggle.
 *
 *  70 catches the three-line case (94 > 70) and MISSES the two-line one
 *  (62 <= 70) — and the two-line case is #960's headline bug, the one the
 *  issue's screenshots show at ~995px. #954 recorded that 62px as the
 *  "docked" height, so the constant was calibrated against an already-wrapped
 *  strip, and #960's fail-before run went red only because it happened to run
 *  at a width where the wrap was the three-line kind.
 *
 *  34 is the post-fix 26px plus 8px (~31%) for cross-machine font/subpixel
 *  variance — comfortably clear of a correct strip, and 28px below even the
 *  cheapest wrap. `expectDockedStripIsOneLine` is the direct proof and fails
 *  on the two-line case specifically; this ceiling is the secondary guard
 *  against the strip simply growing without wrapping. Re-measure both (never
 *  loosen either without re-measuring) if the strip's padding or font-size
 *  changes. */
export const DOCKED_MAX_PX = 34;

export interface ScoreRegime {
  readonly name: string;
  readonly band: "Strong" | "Getting There" | "Needs Work";
  readonly penalty: boolean;
  readonly fixture: string;
}

export const SCORE_REGIMES: readonly ScoreRegime[] = [
  {
    name: "strong, no penalty",
    band: "Strong",
    penalty: false,
    fixture: fixturePath("unknown/openresume-react-pdf.pdf"),
  },
  {
    name: "strong, with penalty",
    band: "Strong",
    penalty: true,
    fixture: fixturePath("unknown/chromium-asymmetric-sidebar.pdf"),
  },
  {
    name: "getting there, no penalty",
    band: "Getting There",
    penalty: false,
    fixture: fixturePath("latex/awesome-cv-resume.pdf"),
  },
  {
    name: "getting there, with penalty",
    band: "Getting There",
    penalty: true,
    fixture: fixturePath("unknown/two-column-achievements-sidebar.pdf"),
  },
  {
    name: "needs work, no penalty",
    band: "Needs Work",
    penalty: false,
    fixture: fixturePath("unknown/single-column-year-only-roundtrip.pdf"),
  },
  {
    name: "needs work, with penalty",
    band: "Needs Work",
    penalty: true,
    fixture: fixturePath("latex/deedy-resume-macfonts.pdf"),
  },
];

/** Look a regime up by name, failing HERE when the name matches nothing —
 *  a bare `.find(...)!` would hand `undefined` to the drop helper and fail
 *  inside it, far from the renamed or dropped entry that caused it. */
export function scoreRegime(name: string): ScoreRegime {
  const regime = SCORE_REGIMES.find((r) => r.name === name);
  if (!regime) throw new Error(`no SCORE_REGIMES entry named "${name}"`);
  return regime;
}

/** Assert the fixture still renders the band its regime claims.
 *
 *  The table above is the only other record of that link, and two of the six
 *  sit within a point of the Strong threshold (81, and exactly 80). A scorer
 *  change that moves either down one point re-bakes the snapshots, keeps
 *  every other assertion green and the test title still reading `(Strong)`,
 *  and silently drops a band from the matrix — the same shape as the stale
 *  `DOCKED_MAX_PX` above. The pill's accessible name carries the band
 *  verbatim, so it is the one place to read it from. */
export async function expectRegimeBand(
  page: Page,
  regime: ScoreRegime,
): Promise<void> {
  await expect(
    page.getByRole("button", {
      name: new RegExp(`^Resume score \\d+ out of 100, ${regime.band}\\.`),
    }),
    `${regime.name}: fixture no longer renders as ${regime.band} — re-pick it or re-bake the table above`,
  ).toBeVisible();
}

/** Default fixture for specs that only need ONE parse, not the full matrix
 *  (kept identical to `viewport.spec.ts`'s pre-#960 constant so its own
 *  above-the-fold/hash-anchor assertions, unrelated to the score bug, keep
 *  measuring the same PDF). */
export const DEFAULT_FIXTURE_PDF = fixturePath("latex/awesome-cv-resume.pdf");

/** Drop a fixture PDF via the real (hidden, `sr-only`) file input and wait for
 *  the reconstructed résumé to render. `setInputFiles` doesn't require the
 *  element to be visible, only attached — `DropZone`'s input is `sr-only`,
 *  not `display:none`.
 *
 *  Scoped by `accept` rather than a bare `input[type="file"]`: `/` also
 *  renders a second, unrelated file input (JSON library-record import,
 *  `accept="application/json,.json"`), and a bare selector is a Playwright
 *  strict-mode violation with both on the page. */
export async function dropFixtureAndWaitForParse(
  page: Page,
  fixture: string = DEFAULT_FIXTURE_PDF,
): Promise<void> {
  await page.goto("/");
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .setInputFiles(fixture);
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
export function heroSection(page: Page): Locator {
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

/** Force the docked state via the same user-toggle path `useAutoCollapse`
 *  exposes, rather than waiting out the real ~4.5s countdown — a spec that
 *  raced that timer would flake. */
export async function dockScoreHero(page: Page): Promise<void> {
  await page.getByRole("button", { name: COLLAPSE_LABEL, exact: true }).click();
  await page.getByRole("button", { name: EXPAND_LABEL, exact: true }).waitFor();
}

/** The docked pill's fixed-width verdict slot. Matched on the width class
 *  itself because that IS the thing under test — a fixed-width box holding a
 *  two-word label. `forceVerdictWordFontSize` re-reads the computed style
 *  afterwards rather than trusting this selector: renaming the slot's width
 *  utility would otherwise leave the style tag matching nothing and hand us a
 *  test that passes because it tested nothing. */
const VERDICT_SLOT = 'button[aria-label^="Resume score"] [class~="sm:w-28"]';

/** Enlarge the verdict word ALONE, leaving every `rem`-derived width in the
 *  row where it was — the shape of what Chrome's minimum-font-size setting
 *  does to 11px text, which is how a real user reaches this state without any
 *  code change.
 *
 *  Asserts the override actually landed on exactly one element, so this can
 *  never degrade into a no-op that the caller then "proves" something with. */
export async function forceVerdictWordFontSize(
  page: Page,
  px: number,
): Promise<void> {
  await page.addStyleTag({
    content: `${VERDICT_SLOT} { font-size: ${px}px !important; }`,
  });
  const applied = await page
    .locator(VERDICT_SLOT)
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).fontSize));
  expect(applied, "verdict-word slot font-size override").toEqual([`${px}px`]);
}

/** Assert the verdict word's fixed-width slot did not wrap to a second line.
 *
 *  A single-line slot has `slotHeight ≈ lineHeight` (~18.7px at 14px font);
 *  wrapping to two lines jumps to `≥2 * lineHeight` (~37.3px).
 *  Comparing `slotHeight < lineHeight * 1.5` detects the cause (the label
 *  wrapped inside its fixed-width slot) directly rather than the symptom
 *  (the whole docked strip exceeding `DOCKED_MAX_PX`). */
export async function expectVerdictSlotDidNotWrap(
  page: Page,
  label?: string,
): Promise<void> {
  const { slotHeight, lineHeight } = await page
    .locator(VERDICT_SLOT)
    .evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const parsedLineHeight = parseFloat(style.lineHeight);
      const fontSize = parseFloat(style.fontSize);
      const resolvedLineHeight = Number.isFinite(parsedLineHeight)
        ? parsedLineHeight
        : fontSize * 1.2;
      return {
        slotHeight: rect.height,
        lineHeight: resolvedLineHeight,
      };
    });

  const message = label
    ? `${label}: verdict word wrapped inside its fixed-width slot`
    : "verdict word wrapped inside its fixed-width slot";

  expect(slotHeight, message).toBeLessThan(lineHeight * 1.5);
}

/** Sub-pixel slack for the height comparison below. Chromium reports the
 *  docked row and its tallest child as the same integral 26px here, so this
 *  only absorbs fractional layout on other machines — it is two orders of
 *  magnitude smaller than the ≥32px a wrapped line adds, so it cannot mask
 *  the regression the comparison exists to catch. */
const LINE_BREAK_EPSILON_PX = 1;

export interface DockedStripMetrics {
  /** The docked `<section>` — what `DOCKED_MAX_PX` ceilings. */
  readonly sectionHeight: number;
  /** `CollapsedScoreBar`'s `flex-nowrap` root, the row that must not break. */
  readonly rowHeight: number;
  /** Tallest of the row's currently-displayed children. */
  readonly tallestChildHeight: number;
  /** One entry per child group, `display:none` ones included (as 0/0). */
  readonly groups: readonly {
    readonly clientWidth: number;
    readonly scrollWidth: number;
  }[];
}

/** Read the docked strip's geometry in one round trip.
 *
 *  The row is `section > div:first-child`: `AtsScoreReadout`'s collapsed
 *  branch renders `<section>` with `CollapsedScoreBar`'s root as its only
 *  child, and `guardProps` contributes event handlers, never an extra
 *  wrapper. */
export async function measureDockedStrip(
  page: Page,
): Promise<DockedStripMetrics> {
  return await heroSection(page).evaluate((section: Element) => {
    const row = section.querySelector(":scope > div")!;
    const children = Array.from(row.children);
    const displayed = children.filter(
      (child) => getComputedStyle(child).display !== "none",
    );
    return {
      sectionHeight: section.getBoundingClientRect().height,
      rowHeight: row.getBoundingClientRect().height,
      tallestChildHeight: Math.max(
        ...displayed.map((child) => child.getBoundingClientRect().height),
      ),
      groups: children.map((child) => ({
        clientWidth: child.clientWidth,
        scrollWidth: child.scrollWidth,
      })),
    };
  });
}

/** The docked strip's two structural invariants, asserted together because
 *  neither is sufficient alone — and shared by `viewport.spec.ts` and
 *  `e2e/mobile/score-strip.spec.ts` so the assertion block exists once.
 *
 *  1. ONE LINE. Note what this does NOT use: `getClientRects().length === 1`,
 *     which #960 first shipped as "the direct proof a `flex-nowrap` row hasn't
 *     broken onto a second line". It is not proof of anything — that method
 *     returns more than one rect only for INLINE-level boxes, and both the
 *     hero `<section>` and the strip row are block-level, so the count is 1
 *     however their children lay out. It stayed 1 through a genuine two-line
 *     wrap and through the clipped state #960 shipped.
 *     A single-line flex row's height IS its tallest item's height (this row
 *     carries no padding, border or item margins); a wrapped one adds the
 *     12px `gap-3` row gap plus the whole second line. So comparing the two
 *     observes the line break directly, and it degrades gracefully — it reads
 *     the same whichever group is the one that wrapped.
 *  2. NO CLIPPED TILE. `scrollWidth <= clientWidth` per group: the dimension
 *     group is `overflow-hidden`, so an overrun is silent and renders a tile
 *     cut through its own text (`COMPLETENESS ▬▬▬ 2`) rather than failing
 *     anything. This is the assertion that keeps that group's width budget
 *     honest — see the group comment in `CollapsedScoreBar.tsx`.
 *
 *  The height ceiling rides along as a secondary guard against the strip
 *  simply getting fatter without wrapping. `label` names the regime and width
 *  under test so a failure says which cell of the matrix broke. */
export async function expectDockedStripIsOneLine(
  page: Page,
  label: string,
): Promise<void> {
  const m = await measureDockedStrip(page);

  expect(
    m.rowHeight,
    `${label}: strip row wrapped — ${m.rowHeight}px tall vs a tallest child of ${m.tallestChildHeight}px`,
  ).toBeLessThanOrEqual(m.tallestChildHeight + LINE_BREAK_EPSILON_PX);

  m.groups.forEach((group, i) => {
    expect(
      group.scrollWidth,
      `${label}: group ${i + 1} is clipped — needs ${group.scrollWidth}px, has ${group.clientWidth}px`,
    ).toBeLessThanOrEqual(group.clientWidth);
  });

  // Catches the inflation the comparison above cannot: a wrap INSIDE one of
  // the groups (the verdict word breaking its fixed-width slot, say) makes
  // that child taller, so the row still matches its tallest child and only
  // the absolute height gives it away.
  expect(
    m.sectionHeight,
    `${label}: docked strip is ${m.sectionHeight}px tall, over the ${DOCKED_MAX_PX}px ceiling — tallest group ${m.tallestChildHeight}px, so something inside the row grew or wrapped`,
  ).toBeLessThanOrEqual(DOCKED_MAX_PX);

  // Whatever else width forced out, these two must have survived: they are
  // the only route back to the full readout, and the widget docks itself
  // ~4.5s after arrival, so this is the state nearly every user is in.
  await expect(
    page.getByRole("button", { name: EXPAND_LABEL, exact: true }),
    `${label}: expand toggle`,
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "How is this scored?" }),
    `${label}: scoring explainer`,
  ).toBeVisible();
}
