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
      // section bullet 0 → observation "0|a", bullet 1 → "0|b".
      obsIds: ["0|a", "0|b"],
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
        onApplied: vi.fn(),
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

  it("Accept all + global Apply writes back through mapped obsIds, then reports what was applied", () => {
    const { map, handlers } = makeApply();
    const onApplied = vi.fn();
    const el = render(
      createElement(ProposedPanel, {
        result: RESULT,
        onDismiss: vi.fn(),
        onApplied,
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

    // matched bullet 0 (obs "0|a") replaced; removed bullet 1 (obs "0|b")
    // removed; the new bullet added — section-relative index joined to obsIds.
    expect(handlers.onReplace).toHaveBeenCalledWith(
      "0|a",
      "Led a team of 5 engineers",
    );
    expect(handlers.onRemove).toHaveBeenCalledWith("0|b");
    expect(handlers.onAdd).toHaveBeenCalledWith("Mentored two interns");
    // Apply no longer dismisses synchronously — it reports the count and the
    // touched section labels so the caller can confirm in place (#508).
    // Third arg is the batch undo (issue 510) — undefined here because these
    // handlers carry no `captureUndo`, so no Undo is offered.
    expect(onApplied).toHaveBeenCalledWith(
      3,
      ["Senior Engineer — Acme"],
      undefined,
    );
  });

  it("hands back one undo thunk that reverses the whole batch (issue 510)", () => {
    const { handlers } = makeApply();
    const reverse = vi.fn();
    const captureUndo =
      vi.fn<NonNullable<SectionRewriteApply["captureUndo"]>>(() => reverse);
    const withUndo: SectionRewriteApply = { ...handlers, captureUndo };
    const onApplied = vi.fn();
    const el = render(
      createElement(ProposedPanel, {
        result: RESULT,
        onDismiss: vi.fn(),
        onApplied,
        applyBySection: new Map([["experience:0", withUndo]]),
      }),
    );

    click(
      [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Accept all",
      ) as HTMLButtonElement,
    );
    click(
      el.querySelector(
        'button[aria-label="Apply accepted changes to the resume"]',
      ) as HTMLButtonElement,
    );

    // The snapshot saw every write the loop was about to issue, and was taken
    // BEFORE any of them landed — otherwise it captures post-apply values.
    expect(captureUndo).toHaveBeenCalledTimes(1);
    expect(captureUndo.mock.calls[0]![0]).toEqual([
      { kind: "replace", obsId: "0|a", text: "Led a team of 5 engineers" },
      { kind: "add", text: "Mentored two interns" },
      { kind: "remove", obsId: "0|b" },
    ]);
    expect(captureUndo.mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(withUndo.onReplace).mock.invocationCallOrder[0]!,
    );

    const undo = onApplied.mock.calls[0]![2] as () => void;
    expect(undo).toBeTypeOf("function");
    expect(reverse).not.toHaveBeenCalled();
    undo();
    expect(reverse).toHaveBeenCalledTimes(1);
  });

  it("offers no undo when any written section can't be snapshotted", () => {
    // A written section with no `captureUndo` makes the batch unreversible.
    // A partial revert would leave the résumé in a state the user never
    // authored, so the control is withheld for the whole batch.
    const bare: SectionRewriteApply = {
      obsIds: ["0|a", "0|b"],
      onReplace: vi.fn(),
      onRemove: vi.fn(),
      onAdd: vi.fn(),
    };
    const onApplied = vi.fn();
    const el = render(
      createElement(ProposedPanel, {
        result: RESULT,
        onDismiss: vi.fn(),
        onApplied,
        applyBySection: new Map([["experience:0", bare]]),
      }),
    );
    click(
      [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Accept all",
      ) as HTMLButtonElement,
    );
    click(
      el.querySelector(
        'button[aria-label="Apply accepted changes to the resume"]',
      ) as HTMLButtonElement,
    );
    expect(onApplied.mock.calls[0]![2]).toBeUndefined();
  });

  it("falls back to read-only (no review controls) when no apply wiring is given", () => {
    const el = render(
      createElement(ProposedPanel, {
        result: RESULT,
        onDismiss: vi.fn(),
        onApplied: vi.fn(),
      }),
    );
    // No per-bullet Accept controls without an apply map; the diff still renders.
    const acceptButtons = [...el.querySelectorAll("button")].filter((b) =>
      b.getAttribute("aria-label")?.startsWith("Accept this"),
    );
    expect(acceptButtons.length).toBe(0);
    expect(el.textContent).toContain("Senior Engineer — Acme");
  });
});

// ── Summary section (#625) ────────────────────────────────────────────────────

/** A one-section proposal over the summary — the only section the panel used to
 *  render as a read-only redline, with no way to apply it. */
function summaryResult(proposed: string): ResumeRewriteResult {
  return {
    allNumbersPreserved: true,
    sections: [
      {
        kind: "summary",
        input: {
          kind: "summary",
          id: "summary",
          label: "Summary",
          text: "Engineer with ten years of experience.",
        },
        data: {
          text: proposed,
          numbersPreserved: true,
          droppedNumbers: [],
          addedNumbers: [],
        },
      },
    ],
  };
}

function summaryApply(): {
  map: ResumeRewriteApply;
  handlers: SectionRewriteApply;
} {
  // The real wiring from `summaryRewriteApply` — one positional slot, and every
  // verb pointed at the single `summaryOverride`.
  const handlers: SectionRewriteApply = {
    obsIds: ["summary"],
    onReplace: vi.fn(),
    onRemove: vi.fn(),
    onAdd: vi.fn(),
  };
  return { map: new Map([["summary", handlers]]), handlers };
}

describe("ProposedPanel — summary review + apply (issue 625)", () => {
  it("reviews the summary as one row, labelled as a summary and not a bullet", () => {
    const { map } = summaryApply();
    const el = render(
      createElement(ProposedPanel, {
        result: summaryResult("Platform engineer who cut deploy time 60%."),
        onDismiss: vi.fn(),
        onApplied: vi.fn(),
        applyBySection: map,
      }),
    );

    const accepts = [...el.querySelectorAll("button")].filter((b) =>
      b.getAttribute("aria-label")?.startsWith("Accept this"),
    );
    expect(accepts).toHaveLength(1);
    expect(accepts[0]!.getAttribute("aria-label")).toBe("Accept this edited summary");
    expect(el.textContent).toContain("Edited summary");
  });

  it("writes an accepted summary through the single override handler", () => {
    const { map, handlers } = summaryApply();
    const onApplied = vi.fn();
    const el = render(
      createElement(ProposedPanel, {
        result: summaryResult("Platform engineer who cut deploy time 60%."),
        onDismiss: vi.fn(),
        onApplied,
        applyBySection: map,
      }),
    );

    click(
      [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Accept all",
      ) as HTMLButtonElement,
    );
    click(
      el.querySelector(
        'button[aria-label="Apply accepted changes to the resume"]',
      ) as HTMLButtonElement,
    );

    expect(handlers.onReplace).toHaveBeenCalledWith(
      "summary",
      "Platform engineer who cut deploy time 60%.",
    );
    expect(handlers.onRemove).not.toHaveBeenCalled();
    expect(handlers.onAdd).not.toHaveBeenCalled();
    expect(onApplied).toHaveBeenCalledWith(1, ["Summary"], undefined);
  });

  // A degenerate model response must not offer an "accept" that silently blanks
  // the user's summary — clearing has its own affordance (emptying the field).
  it.each([
    ["a blank proposal", "   "],
    ["a proposal identical to the original", "Engineer with ten years of experience."],
  ])("falls back to the read-only redline for %s", (_label, proposed) => {
    const { map } = summaryApply();
    const el = render(
      createElement(ProposedPanel, {
        result: summaryResult(proposed),
        onDismiss: vi.fn(),
        onApplied: vi.fn(),
        applyBySection: map,
      }),
    );

    expect(
      [...el.querySelectorAll("button")].filter((b) =>
        b.getAttribute("aria-label")?.startsWith("Accept this"),
      ),
    ).toHaveLength(0);
    const apply = el.querySelector(
      'button[aria-label="Apply accepted changes to the resume"]',
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
  });

  it("stays a read-only redline when no summary writer is wired at all", () => {
    const el = render(
      createElement(ProposedPanel, {
        result: summaryResult("Platform engineer who cut deploy time 60%."),
        onDismiss: vi.fn(),
        onApplied: vi.fn(),
        applyBySection: new Map(),
      }),
    );
    expect(
      [...el.querySelectorAll("button")].filter((b) =>
        b.getAttribute("aria-label")?.startsWith("Accept this"),
      ),
    ).toHaveLength(0);
  });
});
