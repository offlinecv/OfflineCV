// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render tests for `ResumeBulletRow` (#626) — the per-bullet remove control
 * and the empty-commit-drops-the-bullet resolution.
 *
 * Runs in jsdom with raw `createRoot`, matching `RewriteReviewList.test.tsx`
 * (the sibling rewrite-review surface).
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ResumeBulletRow } from "./ResumeBulletRow.tsx";
import type { BulletObservation } from "../../lib/score/score.ts";

const BULLET: BulletObservation = {
  text: "Cut p99 checkout latency by 38% via edge caching.",
  index: 0,
  hasMetric: true,
  startsWithActionVerb: true,
  wellFormedLength: true,
  wordCount: 9,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Set a textarea's value through the native setter (per house convention —
 *  a direct `el.value = x` bypasses React's value tracker and the ensuing
 *  `dispatchEvent("input")` fires no `onChange`, so the test would pass for
 *  the wrong reason). */
function setTextareaValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ResumeBulletRow — remove control (issue 626)", () => {
  it("renders no remove control when onRemove is absent (read-only / not wired)", () => {
    const el = render(
      createElement(ResumeBulletRow, { bullet: BULLET }),
    );
    expect(el.querySelector('[aria-label="Remove bullet"]')).toBeNull();
  });

  it("clicking Remove bullet calls onRemove, not onBulletChange", () => {
    const onBulletChange = vi.fn();
    const onRemove = vi.fn();
    const el = render(
      createElement(ResumeBulletRow, {
        bullet: BULLET,
        onBulletChange,
        onRemove,
      }),
    );
    const btn = el.querySelector(
      '[aria-label="Remove bullet"]',
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    click(btn);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onBulletChange).not.toHaveBeenCalled();
  });

  it("committing a non-empty edit calls onBulletChange, not onRemove", () => {
    const onBulletChange = vi.fn();
    const onRemove = vi.fn();
    const el = render(
      createElement(ResumeBulletRow, {
        bullet: BULLET,
        onBulletChange,
        onRemove,
      }),
    );
    // Enter edit mode via the click-to-edit affordance (the bullet text).
    click(el.querySelector('[role="button"]') as HTMLElement);
    const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
    setTextareaValue(textarea, "Led a 40% reduction in build times.");
    click(
      el.querySelector('[aria-label="Save Bullet text"]') as HTMLElement,
    );
    expect(onBulletChange).toHaveBeenCalledWith(
      "Led a 40% reduction in build times.",
    );
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("committing an EMPTY edit calls onRemove instead of onBulletChange(\"\") — no ghost row — issue 626", () => {
    const onBulletChange = vi.fn();
    const onRemove = vi.fn();
    const el = render(
      createElement(ResumeBulletRow, {
        bullet: BULLET,
        onBulletChange,
        onRemove,
      }),
    );
    click(el.querySelector('[role="button"]') as HTMLElement);
    const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
    setTextareaValue(textarea, "   ");
    click(
      el.querySelector('[aria-label="Save Bullet text"]') as HTMLElement,
    );
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onBulletChange).not.toHaveBeenCalled();
  });

  it("falls back to onBulletChange(\"\") on an empty commit when onRemove is absent (pre-issue-626 behaviour, for an unwired caller)", () => {
    const onBulletChange = vi.fn();
    const el = render(
      createElement(ResumeBulletRow, { bullet: BULLET, onBulletChange }),
    );
    click(el.querySelector('[role="button"]') as HTMLElement);
    const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
    setTextareaValue(textarea, "");
    click(
      el.querySelector('[aria-label="Save Bullet text"]') as HTMLElement,
    );
    expect(onBulletChange).toHaveBeenCalledWith("");
  });
});
