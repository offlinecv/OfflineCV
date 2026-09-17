// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * playwright.config.ts — real-browser viewport harness (#954).
 *
 * Vitest runs in jsdom, which has no layout engine: `getBoundingClientRect()`,
 * `offsetHeight` and `clientHeight` all evaluate to 0 there. Several product
 * claims about `/` — the score hero's compact height (#953/#956), the résumé
 * starting above the fold, the `scroll-padding-top` sizing in `src/styles.css`
 * — were therefore defended only by hand measurement in a real browser. This
 * config is the harness that can assert them instead.
 *
 * Chromium only, by maintainer decision on #954: one deterministic rendering
 * engine is enough to defend a CSS/layout invariant, and firefox/webkit would
 * only double the download + run cost for the same assertions.
 *
 * Served from a production `vite preview` of `dist/`, not the dev server:
 * the two ship identical CSS, and `vite preview` is the exact bundle a real
 * deploy serves — what a pixel assertion should be measured against, rather
 * than dev's on-the-fly transforms. The build that produces `dist/` runs in
 * the `test:e2e` npm script, NOT in `webServer.command` below — see the
 * comment on `webServer` for why that distinction is load-bearing rather
 * than cosmetic.
 *
 * Both `vite dev` AND `vite preview` pick up `basicSsl()` from the shared
 * plugin list in `vite.config.ts` (it isn't a dev-only plugin), so preview
 * serves HTTPS with the same self-signed cert `npm run dev` does unless
 * `OFFLINECV_DEV_HTTP=1` is set — confirmed by running `npm run preview`
 * with and without it. That flag is the one this config uses: it drops
 * TLS in favour of plain http, which is the right trade here because the
 * cost is losing WebGPU (irrelevant to layout assertions — see the README's
 * "On-device AI (WebGPU) in dev" section for the tradeoff this flag makes
 * everywhere else it's used), and the benefit is no `ignoreHTTPSErrors`
 * noise on every run.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

// Playwright matches a regex `testMatch`/`testIgnore` against the ABSOLUTE
// file path, not a path relative to `testDir` — an anchored `/^mobile\//`
// matches nothing and fails open (the desktop projects would quietly pick up
// every mobile spec). Match the directory segment instead, and accept either
// separator so the config behaves the same on Windows.
const MOBILE_DIR = /[\\/]mobile[\\/]/;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  // A committed `test.only` silently reduces the whole suite to one test while
  // the job still reports green — the same "a green check that certifies
  // nothing" failure this harness exists to prevent. Fail the CI run instead.
  forbidOnly: !!process.env.CI,
  // No retries, deliberately. Every assertion here is geometric (a rect, a
  // height, a containment), so a second attempt cannot legitimately disagree
  // with the first: a retry would only ever paper over a real flake — and the
  // margins here are thin. The thinnest in ABSOLUTE terms is the docked
  // ceiling (62 -> 70, 8px); the thinnest RELATIVE to what it measures is the
  // Summary-above-the-fold assertion at 1280x800 (48.5px of an 800px fold,
  // ~6%). Either is exactly the kind of signal that must surface rather than
  // be re-rolled.
  retries: 0,
  // Capped on CI, where the runner is smaller than a dev box and layout work
  // is measured: oversubscribed workers contend and skew the numbers the
  // assertions read.
  workers: process.env.CI ? 2 : undefined,
  use: {
    baseURL: BASE_URL,
    // `retain-on-failure`, not `on-first-retry` — with `retries: 0` there is
    // no retry to attach a trace to, and a CI-only failure with no artifact is
    // undebuggable from the log alone.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // One project per viewport under test. Only 1280x800 and 1440x900 have
  // specs today (#954's own acceptance criteria); 375x812 is configured now,
  // ahead of need, because #959/#960 (stacked on top of this issue) both add
  // a mobile spec and the maintainer asked that this harness not need a
  // rewrite to grow one.
  //
  // The split is by DIRECTORY, and the default is "runs everywhere": the two
  // desktop projects take everything in `e2e/` except `e2e/mobile/`, so a new
  // `e2e/export.spec.ts` is executed the moment it is added. The alternative
  // — pinning each project to a named spec file — silently drops any new file
  // on the floor while still reporting green, which is the same "a green
  // check certifies nothing" failure this harness exists to prevent.
  //
  // Mobile is the one explicit opt-out, and it is a product fact rather than
  // a convenience: the score-hero/above-the-fold assertions are `md`+-scoped
  // by the design itself (`AtsScoreReadout`'s `md:flex-row`), not just by the
  // numbers in this file, so running them at 375 would assert a claim the app
  // never made. A mobile spec therefore states its own claims, under
  // `e2e/mobile/`, and nothing else runs there.
  projects: [
    {
      name: "desktop-1280",
      testIgnore: MOBILE_DIR,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "desktop-1440",
      testIgnore: MOBILE_DIR,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-375",
      testMatch: MOBILE_DIR,
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } },
    },
  ],
  // Preview only — the `dist/` build lives in the `test:e2e` script instead.
  // `reuseExistingServer` skips this command outright whenever anything is
  // already answering on the port (a leftover preview from a killed run, a
  // second terminal), so a build placed HERE is the one step that gets
  // skipped exactly when it matters: the suite then measures a stale `dist/`
  // and reports green, locally only, on the machine you are iterating on.
  // Building in the npm script keeps the build unconditional and makes a
  // build failure surface as a build failure, rather than as an opaque
  // `Process from config.webServer was not able to start. Exit code: 2` with
  // the tsc output swallowed.
  webServer: {
    command: `OFFLINECV_DEV_HTTP=1 npm run preview -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
