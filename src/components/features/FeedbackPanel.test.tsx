// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Render tests for the inline FeedbackPanel (#51). The pure payload-shaping
 * layer (`buildFeedbackProps`, incl. the PII opt-in rule) is covered in
 * `src/lib/analytics.test.ts`; this file covers the React surface — the
 * branches the fallow CRAP gate flagged at 0% coverage:
 *
 *   - analytics disabled (`VITE_POSTHOG_KEY` unset) → panel renders nothing
 *   - enabled → form renders; Submit gated on a rating
 *   - selecting a star enables Submit; submitting fires `trackFeedback` and
 *     collapses to the inline thank-you
 *   - submitting without a rating (reachable via Enter even with Submit
 *     disabled) shows the inline error and fires nothing
 *
 * `ANALYTICS_ENABLED` is a build-time-derived const, so each case re-mocks
 * `../../lib/analytics.ts` and re-imports the component via `vi.doMock` +
 * `vi.resetModules`. Uses raw `createRoot` (no RTL), matching
 * `useModelSelection.integration.test.tsx`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function mountPanel(opts: {
  enabled: boolean;
  trackFeedback?: (...args: unknown[]) => void;
}): Promise<HTMLDivElement> {
  vi.resetModules();
  vi.doMock("../../lib/analytics.ts", () => ({
    ANALYTICS_ENABLED: opts.enabled,
    trackFeedback: opts.trackFeedback ?? (() => {}),
  }));
  const { FeedbackPanel } = await import("./FeedbackPanel.tsx");

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(FeedbackPanel));
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.resetModules();
  vi.clearAllMocks();
});

describe("FeedbackPanel", () => {
  it("renders nothing when analytics are disabled", async () => {
    const el = await mountPanel({ enabled: false });
    expect(el.querySelector("form")).toBeNull();
    expect(el.textContent).toBe("");
  });

  it("renders the form with Submit disabled until a rating is chosen", async () => {
    const el = await mountPanel({ enabled: true });
    expect(el.querySelector("form")).not.toBeNull();
    const submit = el.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // Five star radios in the rating group.
    expect(el.querySelectorAll('input[type="radio"]').length).toBe(5);
  });

  it("enables Submit after a rating, fires trackFeedback, and shows the thank-you", async () => {
    const trackFeedback = vi.fn();
    const el = await mountPanel({ enabled: true, trackFeedback });

    const fourth = el.querySelector(
      'input[type="radio"][value="4"]',
    ) as HTMLInputElement;
    await act(async () => {
      fourth.click();
    });

    const submit = el.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    await act(async () => {
      submit.click();
    });

    expect(trackFeedback).toHaveBeenCalledTimes(1);
    expect(trackFeedback.mock.calls[0][0]).toMatchObject({ rating: 4 });
    // Form collapses to the inline thank-you.
    expect(el.querySelector("form")).toBeNull();
    expect(el.textContent).toContain("Thanks for your feedback!");
  });

  it("shows the inline error and fires nothing when submitted without a rating", async () => {
    const trackFeedback = vi.fn();
    const el = await mountPanel({ enabled: true, trackFeedback });

    // Submit is reachable via Enter even while disabled — dispatch directly.
    const form = el.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect(trackFeedback).not.toHaveBeenCalled();
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      "Please select a rating before submitting.",
    );
    // Still on the form, not the thank-you.
    expect(el.querySelector("form")).not.toBeNull();
  });

  it("toggles a category pill on and off", async () => {
    const el = await mountPanel({ enabled: true });
    const pill = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Parsing",
    ) as HTMLButtonElement;
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    await act(async () => pill.click());
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    await act(async () => pill.click());
    expect(pill.getAttribute("aria-pressed")).toBe("false");
  });
});
