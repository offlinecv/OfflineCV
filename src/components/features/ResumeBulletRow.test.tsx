// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render tests for `ResumeBulletRow` (#626) — the per-bullet remove control
 * and the empty-commit-drops-the-bullet resolution — and its Fix It
 * gutter marker (#913), the in-résumé way into a bullet's Fix It step.
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
import { bulletId } from "../../lib/score/bullet-id.ts";
import { bulletAnchorId, type GuidanceItem } from "../../lib/score/guidance.ts";
import {
  bulletStepsOf,
  FixItEntryContext,
} from "../../hooks/useFixItMode.ts";

const BULLET_TEXT = "Cut p99 checkout latency by 38% via edge caching.";
const BULLET: BulletObservation = {
  text: BULLET_TEXT,
  id: bulletId(BULLET_TEXT, 0),
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

const WEAK_TEXT = "Worked on the billing service.";
const WEAK: BulletObservation = {
  text: WEAK_TEXT,
  id: bulletId(WEAK_TEXT, 1),
  index: 1,
  hasMetric: false,
  startsWithActionVerb: false,
  wellFormedLength: false,
  wordCount: 5,
};

/** The guidance item `computeScoreGuidance` would mint for `WEAK` — only the
 *  fields the marker reads matter. */
const WEAK_ITEM: GuidanceItem = {
  id: `bullet-${WEAK.id}`,
  dimension: "specificity",
  dimensions: ["specificity", "structure"],
  location: "Experience → Engineer · Acme → bullet 2",
  targetAnchor: bulletAnchorId(WEAK.id),
  targetType: "bullet",
  bulletId: WEAK.id,
  issues: [
    { dimension: "specificity", title: "Missing measurable metric", suggestion: "" },
    { dimension: "structure", title: "Weak opening verb", suggestion: "" },
  ],
  summary: "Missing measurable metric · Weak opening verb",
};

function withSteps(
  node: React.ReactNode,
  startAt: (id: string) => void,
  items: readonly GuidanceItem[] = [WEAK_ITEM],
) {
  return createElement(
    FixItEntryContext.Provider,
    { value: { bulletSteps: bulletStepsOf(items), startAt } },
    node,
  );
}

const editableRow = (bullet: BulletObservation) =>
  createElement(ResumeBulletRow, {
    bullet,
    onBulletChange: () => {},
    onRemove: () => {},
  });

const marker = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>("button[data-fixit-marker]");

describe("ResumeBulletRow — gutter marker (issue 913)", () => {
  it("hangs a warning mark in the gutter, keeps the • itself, and describes the failed checks", () => {
    const el = render(withSteps(editableRow(WEAK), () => {}));
    const btn = marker(el);
    expect(btn).not.toBeNull();
    // The bullet keeps its own muted • — the column reads like the PDF…
    const box = btn!.parentElement!;
    expect(box.firstElementChild?.textContent).toBe("•");
    expect(box.className).toContain("text-content-muted");
    // …and the flag is a separate mark hung LEFT of the column, in the token.
    // Never colour-only (WCAG 1.4.1): a passing bullet has no mark at all.
    const mark = btn!.previousElementSibling as HTMLElement;
    expect(mark.textContent).toBe("\u26A0\uFE0E");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.className).toMatch(/\babsolute\b[^"]*\bright-full\b/u);
    expect(mark.className).toContain("text-feedback-warning-text");
    // The control's description names every failed check.
    const describedBy = btn!.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy!)?.textContent;
    expect(description).toContain("Missing measurable metric");
    expect(description).toContain("Weak opening verb");
  });

  it("enters Fix It at THAT bullet's step on click, and on Enter/Space via the native button", () => {
    const startAt = vi.fn();
    const el = render(withSteps(editableRow(WEAK), startAt));
    const btn = marker(el)!;
    // A real <button>, so Enter and Space activate it with no key handler.
    expect(btn.tagName).toBe("BUTTON");
    click(btn);
    expect(startAt).toHaveBeenCalledExactlyOnceWith(WEAK_ITEM.id);
  });

  it("adds no width: the glyph box is identical flagged or not, and the mark and control are absolutely positioned", () => {
    const flagged = render(withSteps(editableRow(WEAK), () => {}));
    const flaggedBox = marker(flagged)!.parentElement!;
    const plainBox = render(withSteps(editableRow(BULLET), () => {})).querySelector(
      "li div > span",
    ) as HTMLElement;
    expect(flaggedBox.className).toBe(plainBox.className);
    expect(marker(flagged)!.className).toContain("absolute");
    expect((marker(flagged)!.previousElementSibling as HTMLElement).className).toContain(
      "absolute",
    );
  });

  it("renders a plain muted • — no control — for a bullet Fix It has no step for", () => {
    const el = render(withSteps(editableRow(BULLET), () => {}));
    expect(marker(el)).toBeNull();
    expect(el.innerHTML).not.toContain("text-feedback-warning-text");
    expect(el.querySelector("li div > span")?.textContent).toBe("•");
  });

  it("renders no marker of any kind on a READ-ONLY row, even with a step keyed to its id", () => {
    // Project / achievement / certification rows are never Fix It steps; the
    // item here is contrived to prove the row does not even look.
    const el = render(
      withSteps(createElement(ResumeBulletRow, { bullet: WEAK }), () => {}),
    );
    expect(marker(el)).toBeNull();
    expect(el.querySelector("[aria-describedby]")).toBeNull();
    expect(el.innerHTML).not.toContain("text-feedback-warning-text");
    expect(el.textContent).toContain(WEAK_TEXT);
  });

  it("shows no marker outside a Fix It provider (the authoring lane has no steps)", () => {
    const el = render(editableRow(WEAK));
    expect(marker(el)).toBeNull();
  });

  it("moves no focus on render — only the marker click enters the step", () => {
    const before = document.activeElement;
    render(withSteps(editableRow(WEAK), () => {}));
    expect(document.activeElement).toBe(before);
  });

  it("is an edit-scope whose remove control is edit chrome", () => {
    const el = render(withSteps(editableRow(WEAK), () => {}));
    expect(el.querySelector("li")!.classList.contains("edit-scope")).toBe(true);
    expect(
      el.querySelector('[aria-label="Remove bullet"]')!.classList.contains("edit-chrome"),
    ).toBe(true);
  });
});
