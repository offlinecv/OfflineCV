// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render + apply test for the whole-résumé `ProposedPanel` (#211 apply on the
 * whole-résumé path). Verifies the gap this closes: the panel now mounts a
 * per-bullet review per experience section (Accept/Reject rows + section
 * Accept-all), and one global Apply writes every accepted decision back through
 * the per-section handlers — mapping each pair's section-relative index to the
 * real BulletObservation index — then dismisses.
 *
 * jsdom via the pragma, raw `createRoot`, matching `RewriteReviewList.test.tsx`.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ProposedPanel, type ResumeRewriteApply } from "./ResumeRewriteProposed.tsx";
import type { ResumeRewriteResult } from "../../lib/webllm/rewrite-resume.ts";
import type { SectionRewriteApply } from "./SectionRewrite.tsx";

// One experience section: bullet 0 reworded (matched), bullet 1 dropped
// (removed), one fresh bullet (added). "a team of 5" overlap keeps 0↔0 matched;
// the unrelated pair falls to remove + add.
const RESULT: ResumeRewriteResult = {
  allNumbersPreserved: true,
  sections: [
    {
      kind: "experience",
      input: {
        kind: "experience",
        id: "experience:0",
        label: "Senior Engineer — Acme",
        bullets: ["Managed a team of 5", "Filler bullet to drop"],
      },
      data: {
        bullets: ["Led a team of 5 engineers", "Mentored two interns"],
        numbersPreserved: true,
        droppedNumbers: [],
        addedNumbers: [],
      },
    },
  ],
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

function click(btn: HTMLButtonElement | undefined) {
  act(() => {
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("ProposedPanel — whole-résumé per-bullet review + apply", () => {
  function makeApply(): {
    map: ResumeRewriteApply;
    handlers: SectionRewriteApply;
  } {
    const handlers: SectionRewriteApply = {
      // section bullet 0 → observation 10, bullet 1 → observation 11.
      obsIndices: [10, 11],
      onReplace: vi.fn(),
      onRemove: vi.fn(),
      onAdd: vi.fn(),
    };
    return { map: new Map([["experience:0", handlers]]), handlers };
  }

  it("renders accept/reject rows under the section header", () => {
    const { map } = makeApply();
    const el = render(
      createElement(ProposedPanel, {
        result: RESULT,
        onDismiss: vi.fn(),
        applyBySection: map,
      }),
    );

    expect(el.textContent).toContain("Senior Engineer — Acme");
    // One Accept control per pair (matched + removed + added = 3).
    const acceptButtons = [...el.querySelectorAll("button")].filter((b) =>
      b.getAttribute("aria-label")?.startsWith("Accept this"),
    );
    expect(acceptButtons.length).toBe(3);
    // The global Apply starts disabled (nothing accepted yet).
    const apply = el.querySelector(
      'button[aria-label="Apply accepted changes to the resume"]',
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
  });

  it("Accept all + global Apply writes back through mapped obsIndices, then dismisses", () => {
    const { map, handlers } = makeApply();
    const onDismiss = vi.fn();
    const el = render(
      createElement(ProposedPanel, {
        result: RESULT,
        onDismiss,
        applyBySection: map,
      }),
    );

    const acceptAll = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Accept all",
    ) as HTMLButtonElement;
    click(acceptAll);

    const apply = el.querySelector(
      'button[aria-label="Apply accepted changes to the resume"]',
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    expect(apply.textContent).toContain("Apply 3 changes");
    click(apply);

    // matched bullet 0 (obs 10) replaced; removed bullet 1 (obs 11) removed;
    // the new bullet added — section-relative index joined to obsIndices.
    expect(handlers.onReplace).toHaveBeenCalledWith(10, "Led a team of 5 engineers");
    expect(handlers.onRemove).toHaveBeenCalledWith(11);
    expect(handlers.onAdd).toHaveBeenCalledWith("Mentored two interns");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("falls back to read-only (no review controls) when no apply wiring is given", () => {
    const el = render(
      createElement(ProposedPanel, { result: RESULT, onDismiss: vi.fn() }),
    );
    // No per-bullet Accept controls without an apply map; the diff still renders.
    const acceptButtons = [...el.querySelectorAll("button")].filter((b) =>
      b.getAttribute("aria-label")?.startsWith("Accept this"),
    );
    expect(acceptButtons.length).toBe(0);
    expect(el.textContent).toContain("Senior Engineer — Acme");
  });
});
