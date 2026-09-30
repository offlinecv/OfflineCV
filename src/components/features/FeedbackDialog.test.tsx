// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * FeedbackDialog (#900) — the multi-step feedback interstitial that replaced
 * the inline `FeedbackPanel`. Covers: Step 1's sentiment routing (4-5★ →
 * positive, 1-3★ → constructive), that submitting from either step-2 body ships
 * sanitized props via `trackFeedback` and reports success via `onSubmitted`,
 * and that it lands on the focused `aria-live` confirmation rather than closing
 * — a dialog that vanishes confirms nothing to a screen reader.
 *
 * Also covers #1006: a star picked then dismissed without submitting still
 * fires `feedback_rated` (`outcome: "dismissed"`) exactly once, a submit fires
 * it as `"submitted"` alongside `feedback_submitted` sharing the same
 * `open_id`-carrying rating, no star picked at all fires nothing, and a submit
 * followed by the confirmation step's own Close never double-fires it.
 *
 * Uses raw `createRoot` (no RTL), matching `ExportDialog.test.tsx`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function mountDialog(opts: {
  trackFeedback?: (...args: unknown[]) => void;
  trackFeedbackRated?: (...args: unknown[]) => void;
  onClose?: () => void;
  onSubmitted?: () => void;
  /** #912 — a star already picked on the inline nudge. */
  initialRating?: number;
} = {}): Promise<HTMLDivElement> {
  // jsdom does not implement modal dialogs in every version, and the `Dialog`
  // primitive calls `showModal()` from an effect. Stubbed to a plain open so
  // the tests exercise the dialog's CONTENT rather than the UA's modality —
  // same stub `ExportDialog.test.tsx` uses.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
  // FeedbackPositiveStep calls useGitHubStars on mount, which fetches on a
  // cache miss and swallows failure — stubbed so this suite never touches the
  // network (same reason PageShell.test.tsx stubs fetch).
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
  vi.resetModules();
  vi.doMock("../../lib/analytics.ts", () => ({
    trackFeedback: opts.trackFeedback ?? (() => {}),
    trackFeedbackRated: opts.trackFeedbackRated ?? (() => {}),
  }));
  const { FeedbackDialog } = await import("./FeedbackDialog.tsx");

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(FeedbackDialog, {
        open: true,
        onClose: opts.onClose ?? (() => {}),
        onSubmitted: opts.onSubmitted ?? (() => {}),
        ...(opts.initialRating !== undefined
          ? { initialRating: opts.initialRating }
          : {}),
      }),
    );
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
  vi.unstubAllGlobals();
});

/** The button whose visible text is exactly `label`, or null. */
function button(el: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...el.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === label,
    ) ?? null
  );
}

function rate(el: HTMLElement, value: number): void {
  const star = el.querySelector(
    `input[type="radio"][value="${value}"]`,
  ) as HTMLInputElement;
  star.click();
}

/** Type into a controlled `<textarea>`/`<input>` the way React's own synthetic
 *  events do — setting `.value` directly does not go through React's value
 *  tracker, so the native setter has to be used before dispatching `input`. */
function type(el: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("FeedbackDialog", () => {
  it("opens on Step 1: a bare 1-5 star rating", async () => {
    const el = await mountDialog();
    expect(el.textContent).toContain("How did your resume turn out?");
    expect(el.querySelectorAll('input[type="radio"]').length).toBe(5);
    // No step-2 content yet.
    expect(el.querySelector("textarea")).toBeNull();
  });

  it("routes a 4-5★ rating to the positive step (GitHub CTA + Submit)", async () => {
    const el = await mountDialog();
    await act(async () => rate(el, 5));

    expect(el.textContent).toContain("Thank you! We're glad it helped.");
    expect(el.querySelector('a[href*="github.com"]')).not.toBeNull();
    expect(button(el, "Submit")).not.toBeNull();
    // The constructive step's category pills must not leak into this step.
    expect(button(el, "Parsing")).toBeNull();
  });

  it("routes a 1-3★ rating to the constructive step (category pills + Submit Feedback)", async () => {
    const el = await mountDialog();
    await act(async () => rate(el, 2));

    expect(el.textContent).toContain("How can we make OfflineCV better?");
    expect(button(el, "Parsing")).not.toBeNull();
    expect(button(el, "Submit Feedback")).not.toBeNull();
    // The positive step's GitHub CTA must not leak into this step.
    expect(el.querySelector('a[href*="github.com"]')).toBeNull();
  });

  it("submits sanitized props from the positive step and reports success", async () => {
    const trackFeedback = vi.fn();
    const onSubmitted = vi.fn();
    const onClose = vi.fn();
    const el = await mountDialog({
      trackFeedback,
      onSubmitted,
      onClose,
    });

    await act(async () => rate(el, 5));

    const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => type(textarea, "Loved it!"));

    // No email typed and the opt-in checkbox left unchecked — zero PII.
    await act(async () => button(el, "Submit")?.click());

    expect(trackFeedback).toHaveBeenCalledTimes(1);
    expect(trackFeedback.mock.calls[0][0]).toMatchObject({
      rating: 5,
      feedbackText: "Loved it!",
      wantsContact: false,
    });
    // `email` is only ever forwarded when the checkbox is opted in — left
    // undefined here rather than an empty string (`buildFeedbackProps`, the
    // real payload-shaping layer this mock bypasses, drops it either way).
    expect(trackFeedback.mock.calls[0][0].email).toBeUndefined();
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    // The dialog confirms in place instead of vanishing — see the next case.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("confirms the submission in place, focused, and closes only on Close", async () => {
    const onClose = vi.fn();
    const el = await mountDialog({ onClose });
    await act(async () => rate(el, 5));
    await act(async () => button(el, "Submit")?.click());

    // The form is gone and a live-announced thank-you has taken its place.
    expect(el.querySelector("textarea")).toBeNull();
    expect(el.textContent).toContain("Thanks for your feedback!");
    const live = el.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live).not.toBeNull();
    expect(live.textContent).toContain("Thanks for your feedback!");
    // Focus moved into it, so the confirmation is announced and the tab ring
    // stays inside the dialog.
    expect(document.activeElement).toBe(live);

    expect(onClose).not.toHaveBeenCalled();
    await act(async () => button(el, "Close")?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("confirms in place after a constructive submission too", async () => {
    const onClose = vi.fn();
    const el = await mountDialog({ onClose });
    await act(async () => rate(el, 2));
    await act(async () => button(el, "Submit Feedback")?.click());

    expect(el.textContent).toContain("Thanks for your feedback!");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("attaches the opted-in email from the positive step", async () => {
    const trackFeedback = vi.fn();
    const el = await mountDialog({ trackFeedback });
    await act(async () => rate(el, 4));

    const checkbox = el.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    await act(async () => checkbox.click());
    const email = el.querySelector('input[type="email"]') as HTMLInputElement;
    await act(async () => type(email, "me@example.com"));

    await act(async () => button(el, "Submit")?.click());
    expect(trackFeedback.mock.calls[0][0]).toMatchObject({
      rating: 4,
      wantsContact: true,
      email: "me@example.com",
    });
  });

  it("toggles a category pill and submits it from the constructive step", async () => {
    const trackFeedback = vi.fn();
    const onSubmitted = vi.fn();
    const el = await mountDialog({ trackFeedback, onSubmitted });
    await act(async () => rate(el, 1));

    const pill = button(el, "Parsing") as HTMLButtonElement;
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    await act(async () => pill.click());
    expect(pill.getAttribute("aria-pressed")).toBe("true");

    await act(async () => button(el, "Submit Feedback")?.click());
    expect(trackFeedback.mock.calls[0][0]).toMatchObject({
      rating: 1,
      category: "Parsing",
    });
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it("closes without submitting via Cancel / Skip on the constructive step", async () => {
    const trackFeedback = vi.fn();
    const trackFeedbackRated = vi.fn();
    const onSubmitted = vi.fn();
    const onClose = vi.fn();
    const el = await mountDialog({
      trackFeedback,
      trackFeedbackRated,
      onSubmitted,
      onClose,
    });
    await act(async () => rate(el, 2));
    await act(async () => button(el, "Cancel / Skip")?.click());

    expect(trackFeedback).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    // #1006 — a star picked then dismissed is not silently discarded.
    expect(trackFeedbackRated).toHaveBeenCalledTimes(1);
    expect(trackFeedbackRated.mock.calls[0][0]).toMatchObject({
      rating: 2,
      outcome: "dismissed",
    });
  });
});

/**
 * #1006 — a rating picked then dismissed is never recorded today; these cover
 * the fix: `feedback_rated` fires exactly once per dialog open, at the end of
 * that open, whatever it ends in.
 */
describe("FeedbackDialog — feedback_rated fires once per open (#1006)", () => {
  it("fires feedback_rated(dismissed) exactly once for a star picked then closed", async () => {
    const trackFeedback = vi.fn();
    const trackFeedbackRated = vi.fn();
    const onClose = vi.fn();
    const el = await mountDialog({ trackFeedback, trackFeedbackRated, onClose });

    await act(async () => rate(el, 2));
    await act(async () => button(el, "Cancel / Skip")?.click());

    expect(trackFeedback).not.toHaveBeenCalled();
    expect(trackFeedbackRated).toHaveBeenCalledTimes(1);
    expect(trackFeedbackRated.mock.calls[0][0]).toMatchObject({
      rating: 2,
      outcome: "dismissed",
    });
  });

  it("emits nothing when the dialog opens and closes with no star picked", async () => {
    const trackFeedback = vi.fn();
    const trackFeedbackRated = vi.fn();
    const onClose = vi.fn();
    const el = await mountDialog({ trackFeedback, trackFeedbackRated, onClose });

    await act(async () => button(el, "Close")?.click());

    expect(trackFeedback).not.toHaveBeenCalled();
    expect(trackFeedbackRated).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("emits only the final star when it is changed before the open ends", async () => {
    const trackFeedbackRated = vi.fn();
    const el = await mountDialog({ trackFeedbackRated });

    await act(async () => rate(el, 2));
    await act(async () => button(el, "Back")?.click());
    await act(async () => rate(el, 5));
    // Nothing fires per star click — only the close/submit that ends the open.
    expect(trackFeedbackRated).not.toHaveBeenCalled();

    await act(async () => button(el, "Close")?.click());
    expect(trackFeedbackRated).toHaveBeenCalledTimes(1);
    expect(trackFeedbackRated.mock.calls[0][0]).toMatchObject({
      rating: 5,
      outcome: "dismissed",
    });
  });

  it("fires feedback_rated(submitted) alongside feedback_submitted, sharing open_id, and never double-fires on the confirmation's own Close", async () => {
    const trackFeedback = vi.fn();
    const trackFeedbackRated = vi.fn();
    const el = await mountDialog({ trackFeedback, trackFeedbackRated });

    await act(async () => rate(el, 5));
    await act(async () => button(el, "Submit")?.click());

    expect(trackFeedback).toHaveBeenCalledTimes(1);
    expect(trackFeedbackRated).toHaveBeenCalledTimes(1);
    const submittedOpenId = trackFeedback.mock.calls[0][0].openId;
    expect(typeof submittedOpenId).toBe("string");
    expect(submittedOpenId.length).toBeGreaterThan(0);
    expect(trackFeedbackRated.mock.calls[0][0]).toMatchObject({
      rating: 5,
      openId: submittedOpenId,
      outcome: "submitted",
    });

    // The thanks step's own Close must not re-fire feedback_rated.
    await act(async () => button(el, "Close")?.click());
    expect(trackFeedbackRated).toHaveBeenCalledTimes(1);
  });

  it("mints a new open_id on each reopen", async () => {
    const trackFeedback = vi.fn();
    const el = await mountDialog({ trackFeedback, initialRating: 3 });
    await act(async () => button(el, "Submit Feedback")?.click());
    const firstOpenId = trackFeedback.mock.calls[0][0].openId;

    // Unmount before remounting rather than reusing this instance — this
    // suite mounts fresh per test everywhere else, and a second independent
    // open must not reuse the first open's id either way.
    await act(async () => root!.unmount());
    container?.remove();

    const el2 = await mountDialog({ trackFeedback, initialRating: 4 });
    await act(async () => button(el2, "Submit")?.click());
    const secondOpenId = trackFeedback.mock.calls[1][0].openId;

    expect(firstOpenId).not.toBe(secondOpenId);
  });

  it("mints a new open_id when the SAME instance closes and reopens without unmounting", async () => {
    // `App.tsx` never unmounts `FeedbackDialog` between opens — it toggles
    // `open` on one persistent instance, which re-runs the `[open,
    // initialRating]` effect rather than a fresh mount's initializers. The
    // unmount/remount test above cannot exercise that path.
    const trackFeedback = vi.fn();
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false;
    };
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
    vi.resetModules();
    vi.doMock("../../lib/analytics.ts", () => ({
      trackFeedback,
      trackFeedbackRated: vi.fn(),
    }));
    const { FeedbackDialog } = await import("./FeedbackDialog.tsx");

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onSubmitted = vi.fn();
    const render = (open: boolean, initialRating: number) =>
      act(async () => {
        root!.render(
          createElement(FeedbackDialog, {
            open,
            onClose: () => {},
            onSubmitted,
            initialRating,
          }),
        );
      });

    await render(true, 3);
    await act(async () => button(container!, "Submit Feedback")?.click());
    const firstOpenId = trackFeedback.mock.calls[0][0].openId;

    await render(false, 3);
    await render(true, 4);
    await act(async () => button(container!, "Submit")?.click());
    const secondOpenId = trackFeedback.mock.calls[1][0].openId;

    expect(firstOpenId).not.toBe(secondOpenId);
  });
});

/** #912: the nudge collects a star before this dialog exists, so opening on
 *  the star step would ask for it twice — and the second ask is where people
 *  drop out. */
describe("FeedbackDialog opened from the nudge (#912)", () => {
  it("opens straight onto the constructive branch for a low pre-picked star", async () => {
    const el = await mountDialog({ initialRating: 2 });
    expect(el.textContent).toContain("How can we make OfflineCV better?");
    // Not the star step: no second ask.
    expect(el.textContent).not.toContain("Tap a star to rate your experience.");
  });

  it("opens straight onto the positive branch for a high pre-picked star", async () => {
    const el = await mountDialog({ initialRating: 5 });
    expect(el.textContent).toContain("Thank you! We're glad it helped.");
    expect(el.querySelector('a[href*="github.com"]')).not.toBeNull();
  });

  it("submits the pre-picked rating, not a zero", async () => {
    // The value only ever arrived as a prop, so a shell that forgot to seed
    // its own state would still render the right step and report `rating: 0`.
    const trackFeedback = vi.fn();
    const el = await mountDialog({ initialRating: 2, trackFeedback });
    // The constructive step's own label — the positive step says "Submit".
    await act(async () => button(el, "Submit Feedback")?.click());

    expect(trackFeedback).toHaveBeenCalledTimes(1);
    expect(trackFeedback.mock.calls[0][0]).toMatchObject({ rating: 2 });
  });

  it("still opens on the star step when nothing was pre-picked", async () => {
    const el = await mountDialog({ initialRating: 0 });
    expect(el.textContent).toContain("Tap a star to rate your experience.");
  });
});
