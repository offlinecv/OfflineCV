// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * FeedbackNudge (#912) — the inline ask that replaced #900's automatic modal.
 *
 * The properties worth pinning are the ones that make it NOT a dialog: it
 * carries the star value it was clicked with (so the dialog it opens does not
 * ask again), it offers a real "not now", and it announces itself politely
 * rather than seizing anything. A regression here does not throw — it just
 * quietly becomes an interruption again.
 */

import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { setupDomRoot } from "./__test-utils__/dialog-dom.ts";
import { FeedbackNudge } from "./FeedbackNudge.tsx";

const dom = setupDomRoot();

function radios(): HTMLInputElement[] {
  return [...dom.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
}

function clickText(text: string) {
  const button = [...dom.container.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  return button;
}

describe("FeedbackNudge (#912)", () => {
  it("hands over the star that was picked, so the dialog need not ask twice", () => {
    const onRate = vi.fn();
    dom.render(<FeedbackNudge onRate={onRate} onDismiss={() => {}} />);

    const stars = radios();
    expect(stars.length).toBe(5);
    act(() => {
      stars[1].click();
    });

    expect(onRate).toHaveBeenCalledTimes(1);
    expect(onRate).toHaveBeenCalledWith(2);
  });

  it("offers a real 'not now' that opens nothing", () => {
    const onRate = vi.fn();
    const onDismiss = vi.fn();
    dom.render(<FeedbackNudge onRate={onRate} onDismiss={onDismiss} />);

    expect(clickText("Not now")).toBeTruthy();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onRate).not.toHaveBeenCalled();
  });

  it("announces politely and holds no rating of its own", () => {
    dom.render(<FeedbackNudge onRate={() => {}} onDismiss={() => {}} />);

    // `status`, not `alert`: an invitation waits its turn behind whatever the
    // screen reader was saying about the export the user just finished.
    expect(dom.container.querySelector('[role="status"]')).toBeTruthy();
    // No star is pre-lit — a lit star here would claim a rating was recorded
    // when nothing has been sent.
    expect(radios().some((r) => r.checked)).toBe(false);
  });

  it("is not a dialog, and so cannot trap focus", () => {
    // The whole reason this component exists. If it ever becomes a `Dialog`,
    // #912's fix has been undone.
    dom.render(<FeedbackNudge onRate={() => {}} onDismiss={() => {}} />);
    expect(dom.container.querySelector("dialog")).toBeNull();
    expect(dom.container.querySelector('[aria-modal="true"]')).toBeNull();
  });
});
