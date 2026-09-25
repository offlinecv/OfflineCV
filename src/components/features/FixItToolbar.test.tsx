// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, act, Fragment } from "react";
import { EditableField, Popover } from "@design-system";
import { createRoot, type Root } from "react-dom/client";
import { FixItToolbar } from "./FixItToolbar.tsx";
import { SkillChip } from "./ReconstructedSkillControls.tsx";
import {
  computeScoreGuidance,
  type GuidanceItem,
} from "../../lib/score/guidance.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mockItems: GuidanceItem[] = [
  {
    id: "item-1",
    dimension: "specificity",
    dimensions: ["specificity"],
    location: "Experience → Dev · Acme → bullet 1",
    targetAnchor: "bullet-1",
    targetType: "bullet",
    issues: [
      {
        dimension: "specificity",
        title: "Missing measurable metric",
        suggestion: "Add numbers or percentages.",
      },
    ],
    summary: "Missing metric",
  },
  {
    id: "item-2",
    dimension: "structure",
    dimensions: ["structure"],
    location: "Experience → Dev · Acme → bullet 2",
    targetAnchor: "bullet-2",
    targetType: "bullet",
    issues: [
      {
        dimension: "structure",
        title: "Weak opening verb",
        suggestion: "Start with an action verb.",
      },
    ],
    summary: "Weak verb",
  },
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function renderToolbar(props: {
  items: readonly GuidanceItem[];
  currentIndex: number;
  onNavigate: (index: number) => void;
  onExit: () => void;
}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(FixItToolbar, props));
  });
  return host;
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  if (host) {
    host.remove();
    host = null;
  }
});

describe("FixItToolbar.tsx (#810)", () => {
  it("renders position indicator, dimension badge, and recommendation", () => {
    const onNavigate = vi.fn();
    const onExit = vi.fn();

    const dom = renderToolbar({
      items: mockItems,
      currentIndex: 0,
      onNavigate,
      onExit,
    });

    expect(dom.textContent).toContain("Step 1 of 2");
    expect(dom.textContent).toContain("Specificity");
    expect(dom.textContent).toContain("Missing measurable metric");
    expect(dom.textContent).toContain("Add numbers or percentages.");

    const prevBtn = dom.querySelector<HTMLButtonElement>(
      'button[aria-label="Previous guidance item"]',
    )!;
    expect(prevBtn.disabled).toBe(true);

    const nextBtn = dom.querySelector<HTMLButtonElement>(
      'button[aria-label="Next guidance item"]',
    )!;
    expect(nextBtn.disabled).toBe(false);

    act(() => {
      nextBtn.click();
    });
    expect(onNavigate).toHaveBeenCalledWith(1);

    const doneBtn = dom.querySelector<HTMLButtonElement>(
      'button[aria-label="Exit Fix It mode"]',
    )!;
    act(() => {
      doneBtn.click();
    });
    expect(onExit).toHaveBeenCalled();
  });

  it("steps past the last item into a finished panel that keeps the open count", () => {
    const onNavigate = vi.fn();
    const onExit = vi.fn();

    const dom = renderToolbar({
      items: mockItems,
      currentIndex: 1,
      onNavigate,
      onExit,
    });

    expect(dom.textContent).toContain("Step 2 of 2");
    const prevBtn = dom.querySelector<HTMLButtonElement>(
      'button[aria-label="Previous guidance item"]',
    )!;
    expect(prevBtn.disabled).toBe(false);
    act(() => {
      prevBtn.click();
    });
    expect(onNavigate).toHaveBeenCalledWith(0);
    onNavigate.mockClear();

    // #810: the finished state is reachable by stepping through everything —
    // without claiming the items it has not seen edited are resolved. Finish
    // steps to index `items.length`, which is what the mode reports back.
    const finishBtn = dom.querySelector<HTMLButtonElement>(
      'button[aria-label="Finish stepping through guidance"]',
    )!;
    expect(finishBtn.disabled).toBe(false);
    finishBtn.focus();
    act(() => {
      finishBtn.click();
    });
    expect(onNavigate).toHaveBeenCalledWith(2);
    onNavigate.mockClear();
    act(() => {
      root?.render(
        createElement(FixItToolbar, {
          items: mockItems,
          currentIndex: 2,
          onNavigate,
          onExit,
        }),
      );
    });
    // The pressed button unmounted with the dock; focus lands on Done, not <body>.
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Finish Fix It mode",
    );
    expect(dom.textContent).toContain("You've stepped through every item");
    expect(dom.textContent).toContain("2 items are still open");
    expect(dom.textContent).not.toContain("resolved");

    // Back returns to the last item.
    act(() => {
      dom
        .querySelector<HTMLButtonElement>('button[aria-label="Back to the last guidance item"]')!
        .click();
    });
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("keeps the dock the same width across the finished swap", () => {
    const dom = renderToolbar({
      items: mockItems,
      currentIndex: 0,
      onNavigate: vi.fn(),
      onExit: vi.fn(),
    });
    const stepping = dom.querySelector('[aria-label="Fix It guidance"]')!.className;
    act(() => {
      root?.render(
        createElement(FixItToolbar, {
          items: mockItems,
          currentIndex: 2,
          onNavigate: vi.fn(),
          onExit: vi.fn(),
        }),
      );
    });
    const finished = dom.querySelector('[aria-label="Fix It guidance complete"]')!;
    expect(finished.className).toBe(stepping);
  });

  it("publishes the room its dock covers while mounted, and clears it after (#1002)", () => {
    const clearance = () =>
      document.documentElement.style.getPropertyValue("--fixit-dock-clearance");
    expect(clearance()).toBe("");
    renderToolbar({ items: mockItems, currentIndex: 0, onNavigate: vi.fn(), onExit: vi.fn() });
    // jsdom lays nothing out, so the dock measures 0 and only the offset shows.
    expect(clearance()).toBe("40px");
    act(() => root?.unmount());
    root = null;
    expect(clearance()).toBe("");
  });

  it("stays on its step when Escape dismisses a popover (#1001)", () => {
    const onExit = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        createElement(
          Fragment,
          null,
          createElement(Popover, {
            label: "How is this scored?",
            triggerContent: "i",
            children: "Explainer",
          }),
          createElement(FixItToolbar, {
            items: mockItems,
            currentIndex: 0,
            onNavigate: vi.fn(),
            onExit,
          }),
        ),
      );
    });
    act(() => {
      host
        ?.querySelector<HTMLButtonElement>('button[aria-label="How is this scored?"]')
        ?.click();
    });
    expect(host.textContent).toContain("Explainer");

    act(() => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(host.textContent).not.toContain("Explainer"); // the popover closed…
    expect(onExit).not.toHaveBeenCalled(); // …and the mode stayed on
  });

  it("stands aside while a modal dialog is open", () => {
    const onNavigate = vi.fn();
    const onExit = vi.fn();
    renderToolbar({ items: mockItems, currentIndex: 0, onNavigate, onExit });

    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    try {
      const esc = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      act(() => {
        window.dispatchEvent(esc);
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
      });
      // Left for the dialog to close itself; preventing it would cancel that.
      expect(esc.defaultPrevented).toBe(false);
      expect(onExit).not.toHaveBeenCalled();
      expect(onNavigate).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });

  it("handles keyboard navigation via ArrowRight / ArrowLeft and Escape", () => {
    const onNavigate = vi.fn();
    const onExit = vi.fn();

    renderToolbar({
      items: mockItems,
      currentIndex: 0,
      onNavigate,
      onExit,
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    expect(onNavigate).toHaveBeenCalledWith(1);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onExit).toHaveBeenCalled();
  });

  it("leaves an Escape that cancelled an edit to the field (#810 review)", () => {
    // An `EditableField` cancels on Escape and calls `preventDefault`, but the
    // keydown still bubbles to `window`. Exiting there too threw away the
    // user's place in the mode they were editing in.
    const onExit = vi.fn();
    const onCommit = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        createElement(
          Fragment,
          null,
          createElement(EditableField, {
            value: "Shipped the thing",
            label: "Bullet",
            onCommit,
          }),
          createElement(FixItToolbar, {
            items: mockItems,
            currentIndex: 0,
            onNavigate: vi.fn(),
            onExit,
          }),
        ),
      );
    });
    act(() => {
      host?.querySelector<HTMLElement>('[role="button"]')?.click();
    });
    const input = host.querySelector("input");
    expect(input).not.toBeNull();

    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(host.querySelector("input")).toBeNull(); // the edit cancelled…
    expect(onExit).not.toHaveBeenCalled(); // …and the mode stayed on
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("leaves arrows to controls that use them, and to modified arrows", () => {
    const onNavigate = vi.fn();
    renderToolbar({ items: mockItems, currentIndex: 0, onNavigate, onExit: vi.fn() });

    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    // jsdom does not implement `isContentEditable`; the browser derives it.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    editable.tabIndex = 0;
    document.body.append(select, editable);
    try {
      for (const el of [select, editable]) {
        el.focus();
        act(() => {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
        });
      }
      select.blur();
      editable.blur();
      for (const mod of ["altKey", "metaKey", "ctrlKey", "shiftKey"] as const) {
        act(() => {
          window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowRight", [mod]: true }),
          );
        });
      }
      const claimed = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
      claimed.preventDefault();
      act(() => {
        window.dispatchEvent(claimed);
      });
      expect(onNavigate).not.toHaveBeenCalled();

      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
      });
      expect(onNavigate).toHaveBeenCalledWith(1);
    } finally {
      select.remove();
      editable.remove();
    }
  });

  it("stays on its step when Escape closes the skill-move picker (#1001)", () => {
    const onExit = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        createElement(
          Fragment,
          null,
          createElement(SkillChip, {
            skill: "TypeScript",
            onRemove: vi.fn(),
            moveTargets: [{ index: 1, label: "Tools" }],
            onMove: vi.fn(),
          }),
          createElement(FixItToolbar, {
            items: mockItems,
            currentIndex: 0,
            onNavigate: vi.fn(),
            onExit,
          }),
        ),
      );
    });
    act(() => {
      host
        ?.querySelector<HTMLButtonElement>('button[aria-label="Move to another category"]')
        ?.click();
    });
    const option = host.querySelector<HTMLButtonElement>('button[aria-label="Move to Tools"]');
    expect(option).not.toBeNull();

    act(() => {
      option?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(host.querySelector('button[aria-label="Move to Tools"]')).toBeNull();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("renders finished state affirmatively when items list is empty", () => {
    const onNavigate = vi.fn();
    const onExit = vi.fn();

    const dom = renderToolbar({
      items: [],
      currentIndex: 0,
      onNavigate,
      onExit,
    });

    expect(dom.textContent).toContain("All guidance items resolved!");
    // Nothing had focus to lose here, so the panel takes it; a field the user
    // is still in keeps it (see `FixItFinished`).
    const doneBtn = dom.querySelector<HTMLButtonElement>(
      'button[aria-label="Finish Fix It mode"]',
    )!;
    expect(doneBtn).toBeDefined();

    act(() => {
      doneBtn.click();
    });
    expect(onExit).toHaveBeenCalled();
  });

  it("shows a matched on-device critique finding the way it shows a heuristic issue (#1008)", () => {
    // Through the real join: the finding reaches the dock as the bullet's own
    // step — title plus the model's suggestion — not a second surface.
    const text = "Engineered high-throughput pipeline handling 100k requests daily";
    const score = {
      overall: 90,
      preLayoutOverall: 90,
      specificity: { score: 40, max: 40, gradable: true, metricBullets: 1, totalBullets: 1 },
      structure: {
        score: 30, max: 30, gradable: true,
        goodBullets: 1, verbLedBullets: 1, inWindowBullets: 1, totalBullets: 1,
      },
      completeness: { score: 30, max: 30, gradable: true, missing: [] },
      layout: { triggers: [], multiplier: 1, scanned: false },
      bullets: [
        {
          id: `0|${text.toLowerCase()}`, text, index: 0,
          hasMetric: true, startsWithActionVerb: true, wellFormedLength: true, wordCount: 8,
        },
      ],
    } as AnonymousAtsScore;
    const items = computeScoreGuidance(
      score,
      { experience: [{ title: "Dev", company: "Acme", description: text }] },
      [{ bullet: text, issue: "vague", suggestion: "Built the order pipeline" }],
    );
    expect(items).toHaveLength(1);

    const dom = renderToolbar({
      items,
      currentIndex: 0,
      onNavigate: vi.fn(),
      onExit: vi.fn(),
    });
    expect(dom.textContent).toContain("Step 1 of 1");
    expect(dom.textContent).toContain("Local AI: vague wording");
    expect(dom.textContent).toContain('"Built the order pipeline"');
    expect(dom.textContent).toContain("Experience → Dev — Acme → bullet 1");
  });
});
