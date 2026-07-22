// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Direct tests for the apply-confirmation strip (issues 508 and 510). Until
 * now it was only exercised through its two callers, which is how a batch of
 * defects reached review: the strip announced a count its callers had already
 * inflated, and rendered a dangling em dash for an empty section list. Those
 * are properties of THIS component's contract — what it announces, for how
 * long, and what a screen reader hears — so they are pinned here rather than
 * re-derived at each callsite.
 *
 * jsdom via the pragma, raw `createRoot` + `act`, matching the sibling
 * `ResumeRewriteProposed.test.tsx`. Timers are faked because the whole point
 * of the strip is that it holds for a bounded window and then collapses.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import {
  ApplyConfirmation,
  UndoBatchButton,
  UNDO_HOLD_MS,
} from "./ApplyConfirmation.tsx";

/** The strip's own default hold, asserted rather than imported — it is
 *  deliberately not exported, and a silent change to it is a behaviour change. */
const DEFAULT_HOLD_MS = 3000;
/** The collapse animation the strip waits out before calling `onCollapse`. */
const EXIT_MS = 150;

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

/** Advance past the enter frame so `visible` has flipped. */
function settle() {
  act(() => {
    vi.advanceTimersByTime(16);
  });
}

function strip(el: HTMLDivElement): HTMLElement {
  const node = el.querySelector('[role="status"]');
  expect(node).not.toBeNull();
  return node as HTMLElement;
}

/** What a screen reader reads: the live region minus anything aria-hidden. */
function announced(el: HTMLDivElement): string {
  const clone = strip(el).cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[aria-hidden]").forEach((n) => n.remove());
  return clone.textContent ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

describe("ApplyConfirmation — what it announces", () => {
  it("names the count and the sections touched", () => {
    const el = render(
      createElement(ApplyConfirmation, {
        count: 2,
        sections: ["Senior Engineer — Acme", "Staff Engineer — Globex"],
        onCollapse: vi.fn(),
      }),
    );
    settle();
    expect(strip(el).textContent).toContain(
      "Applied 2 changes — Senior Engineer — Acme, Staff Engineer — Globex",
    );
  });

  it("says 'change' not 'changes' for a single write", () => {
    const el = render(
      createElement(ApplyConfirmation, {
        count: 1,
        sections: ["Senior Engineer — Acme"],
        onCollapse: vi.fn(),
      }),
    );
    settle();
    expect(strip(el).textContent).toContain("Applied 1 change —");
    expect(strip(el).textContent).not.toContain("1 changes");
  });

  it("renders no dangling em dash when no section is named", () => {
    const el = render(
      createElement(ApplyConfirmation, {
        count: 1,
        sections: [],
        onCollapse: vi.fn(),
      }),
    );
    settle();
    expect(strip(el).textContent).toContain("Applied 1 change");
    expect(strip(el).textContent).not.toMatch(/—\s*$/);
  });

  it("treats a blank label as naming nothing, not as a section", () => {
    // The guard keys off content, not array length: [""] has length 1 but
    // names nothing, and would otherwise render "Applied 1 change — ".
    const el = render(
      createElement(ApplyConfirmation, {
        count: 1,
        sections: ["", "   "],
        onCollapse: vi.fn(),
      }),
    );
    settle();
    expect(strip(el).textContent).not.toMatch(/—\s*$/);
  });

  it("drops blank labels but keeps the real ones", () => {
    const el = render(
      createElement(ApplyConfirmation, {
        count: 2,
        sections: ["", "Senior Engineer — Acme"],
        onCollapse: vi.fn(),
      }),
    );
    settle();
    expect(strip(el).textContent).toContain(
      "Applied 2 changes — Senior Engineer — Acme",
    );
  });

  it("acknowledges the reverse trip with the same strip", () => {
    const el = render(
      createElement(ApplyConfirmation, {
        count: 2,
        sections: ["Senior Engineer — Acme"],
        onCollapse: vi.fn(),
        verb: "Reverted",
      }),
    );
    settle();
    expect(strip(el).textContent).toContain(
      "Reverted 2 changes — Senior Engineer — Acme",
    );
    expect(strip(el).textContent).not.toContain("Applied");
  });
});

describe("ApplyConfirmation — accessibility", () => {
  it("is a polite live region", () => {
    const el = render(
      createElement(ApplyConfirmation, {
        count: 1,
        sections: ["Senior Engineer — Acme"],
        onCollapse: vi.fn(),
      }),
    );
    settle();
    expect(strip(el).getAttribute("aria-live")).toBe("polite");
  });

  it("announces the verb exactly once — the badge repeats it visually only", () => {
    const el = render(
      createElement(ApplyConfirmation, {
        count: 2,
        sections: ["Senior Engineer — Acme"],
        onCollapse: vi.fn(),
      }),
    );
    settle();
    // The badge carries the word too, but aria-hidden, so the reader does not
    // hear "AppliedApplied 2 changes".
    expect(announced(el).match(/Applied/g)).toHaveLength(1);
    // Meaning is still not carried by colour alone: the word is in the line.
    expect(announced(el)).toContain("Applied 2 changes");
  });

  it("keeps the animation opt-out on the strip", () => {
    const el = render(
      createElement(ApplyConfirmation, {
        count: 1,
        sections: ["Senior Engineer — Acme"],
        onCollapse: vi.fn(),
      }),
    );
    settle();
    expect(strip(el).className).toContain("motion-reduce:transition-none");
    expect(strip(el).className).toContain("motion-reduce:duration-0");
  });
});

describe("ApplyConfirmation — timing", () => {
  it("holds ~3s, then collapses and hands control back", () => {
    const onCollapse = vi.fn();
    const el = render(
      createElement(ApplyConfirmation, {
        count: 1,
        sections: ["Senior Engineer — Acme"],
        onCollapse,
      }),
    );
    settle();

    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOLD_MS - 100);
    });
    expect(onCollapse).not.toHaveBeenCalled();
    expect(strip(el).className).not.toContain("grid-rows-[0fr]");

    // Hold elapses: the strip starts collapsing but has not yet handed back.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(strip(el).className).toContain("grid-rows-[0fr]");
    expect(onCollapse).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(EXIT_MS);
    });
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("holds longer when the caller asks for the undo window", () => {
    const onCollapse = vi.fn();
    render(
      createElement(ApplyConfirmation, {
        count: 1,
        sections: ["Senior Engineer — Acme"],
        onCollapse,
        holdMs: UNDO_HOLD_MS,
        action: createElement(UndoBatchButton, { onUndo: vi.fn() }),
      }),
    );
    settle();

    // An undo the user cannot reach is not a recovery path: at the default
    // hold the strip is still up and still undoable.
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOLD_MS + EXIT_MS);
    });
    expect(onCollapse).not.toHaveBeenCalled();

    // The exit timer is only scheduled once the hold's state update commits,
    // so it has to be advanced in its own act — same as the default-hold case.
    act(() => {
      vi.advanceTimersByTime(UNDO_HOLD_MS - DEFAULT_HOLD_MS);
    });
    expect(onCollapse).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(EXIT_MS);
    });
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("does not fire onCollapse after unmount", () => {
    const onCollapse = vi.fn();
    render(
      createElement(ApplyConfirmation, {
        count: 1,
        sections: ["Senior Engineer — Acme"],
        onCollapse,
      }),
    );
    settle();
    act(() => {
      root?.unmount();
    });
    root = null;
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOLD_MS + EXIT_MS);
    });
    expect(onCollapse).not.toHaveBeenCalled();
  });
});

describe("ApplyConfirmation — the action slot", () => {
  it("renders the undo control the caller passes", () => {
    const onUndo = vi.fn();
    const el = render(
      createElement(ApplyConfirmation, {
        count: 1,
        sections: ["Senior Engineer — Acme"],
        onCollapse: vi.fn(),
        action: createElement(UndoBatchButton, { onUndo }),
      }),
    );
    settle();

    const undo = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Undo",
    ) as HTMLButtonElement;
    expect(undo).toBeDefined();
    // Named for the résumé, not just "Undo" — the strip is one of several
    // live regions on the page.
    expect(undo.getAttribute("aria-label")).toBe(
      "Undo the changes just applied to the résumé",
    );

    act(() => {
      undo.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("renders no control when the batch is not reversible", () => {
    const el = render(
      createElement(ApplyConfirmation, {
        count: 1,
        sections: ["Senior Engineer — Acme"],
        onCollapse: vi.fn(),
      }),
    );
    settle();
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });
});
