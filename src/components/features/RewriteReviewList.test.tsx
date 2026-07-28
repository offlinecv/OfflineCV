// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render tests for RewriteReviewList + its BulletReviewRow (#211). The decision
 * model itself is covered in `src/hooks/useRewriteReview.test.tsx`; this file
 * covers the React surface — that each `AlignedPair` kind paints the right
 * row (kind label, redline old/new sides, edit affordance only for
 * non-removals) and that the controls wire to the `RewriteReview` actions.
 *
 * Runs in jsdom (per the `@vitest-environment jsdom` pragma) with raw
 * `createRoot`, matching `ContactCard.test.tsx`.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { RewriteReviewList, BulletReviewRow } from "./RewriteReviewList.tsx";
import type { AlignedPair } from "../../lib/rewrite-review/align-bullets.ts";
import type { RewriteReview } from "../../hooks/useRewriteReview.ts";

const PAIRS: AlignedPair[] = [
  {
    kind: "matched",
    id: "m:0:0",
    original: "Led the migration",
    originalIndex: 0,
    proposed: "Led the database migration",
    proposedIndex: 0,
  },
  { kind: "added", id: "add:1", proposed: "Mentored two interns", proposedIndex: 1 },
  { kind: "removed", id: "del:1", original: "Misc filler bullet", originalIndex: 1 },
];

/** A `RewriteReview` stub: spy actions plus fixed decision/edit/count reads. */
function makeReview(overrides: Partial<RewriteReview> = {}): RewriteReview {
  return {
    decisions: new Map(),
    edits: new Map(),
    accept: vi.fn(),
    reject: vi.fn(),
    toggle: vi.fn(),
    setEdit: vi.fn(),
    acceptMany: vi.fn(),
    rejectMany: vi.fn(),
    acceptAll: vi.fn(),
    rejectAll: vi.fn(),
    reset: vi.fn(),
    acceptedCount: 0,
    decisionOf: () => undefined,
    ...overrides,
  };
}

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

describe("RewriteReviewList", () => {
  it("renders one row per pair with kind labels, edit only for non-removals", () => {
    const review = makeReview();
    const el = render(
      createElement(RewriteReviewList, {
        pairs: PAIRS,
        review,
        onApply: vi.fn(),
        onDiscard: vi.fn(),
      }),
    );

    expect(el.querySelectorAll("li")).toHaveLength(3);
    const labels = [...el.querySelectorAll("li span")].map((s) => s.textContent);
    expect(labels).toContain("Edited bullet");
    expect(labels).toContain("New bullet");
    expect(labels).toContain("Removed bullet");

    // EditableField (edit affordance) only renders for the two non-removed rows.
    const editControls = el.querySelectorAll(
      '[aria-label="Edit Edit proposed bullet"]',
    );
    expect(editControls.length).toBeGreaterThanOrEqual(2);

    // Footer summary + disabled Apply (nothing accepted yet).
    expect(el.textContent).toContain("3 changes proposed");
    const apply = el.querySelector(
      'button[aria-label="Apply accepted changes to the resume"]',
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
  });

  it("reflects accepted/rejected decision state on the controls", () => {
    const review = makeReview({
      acceptedCount: 1,
      decisionOf: (id) =>
        id === "m:0:0" ? "accepted" : id === "del:1" ? "rejected" : undefined,
    });
    const el = render(
      createElement(RewriteReviewList, {
        pairs: PAIRS,
        review,
        onApply: vi.fn(),
        onDiscard: vi.fn(),
      }),
    );

    // Accept/Reject are icon toggles: state shows via aria-pressed + title,
    // not visible label text.
    const acceptedBtn = el.querySelector(
      'button[aria-label="Accept this edited bullet"]',
    ) as HTMLButtonElement;
    expect(acceptedBtn.getAttribute("aria-pressed")).toBe("true");
    expect(acceptedBtn.getAttribute("title")).toBe("Accepted");
    const rejectedBtn = el.querySelector(
      'button[aria-label="Reject this removed bullet"]',
    ) as HTMLButtonElement;
    expect(rejectedBtn.getAttribute("aria-pressed")).toBe("true");
    expect(rejectedBtn.getAttribute("title")).toBe("Rejected");
    // One accepted → Apply enabled and counts.
    const apply = el.querySelector(
      'button[aria-label="Apply accepted changes to the resume"]',
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    expect(apply.textContent).toContain("Apply 1 change");
  });

  it("wires per-row and bulk controls to the review actions", () => {
    const review = makeReview();
    const onApply = vi.fn();
    const onDiscard = vi.fn();
    const el = render(
      createElement(RewriteReviewList, {
        pairs: PAIRS,
        review,
        onApply,
        onDiscard,
      }),
    );

    const click = (selector: string) => {
      const btn = el.querySelector(selector) as HTMLButtonElement;
      act(() => {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };

    click('button[aria-label="Accept this edited bullet"]');
    expect(review.accept).toHaveBeenCalledWith("m:0:0");
    click('button[aria-label="Reject this removed bullet"]');
    expect(review.reject).toHaveBeenCalledWith("del:1");

    const acceptAll = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Accept all",
    )!;
    act(() => acceptAll.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(review.acceptMany).toHaveBeenCalledWith(["m:0:0", "add:1", "del:1"]);
  });
});

describe("BulletReviewRow — the `noun` prop names the row's content everywhere", () => {
  // #625 gave the row a `noun` so the whole-résumé review could reuse it for the
  // one-field summary section. The prop reached the kind label and the two
  // control `aria-label`s but NOT the editor's placeholder or label, which stayed
  // hardcoded "bullet" — so accepting a summary rewrite read "Edited summary" in
  // the header and "edit this bullet" in the textarea, with the same mismatch in
  // the screen-reader label. Every user-visible noun on the row is asserted here
  // so a future control added without threading `noun` fails rather than ships.
  const filled: AlignedPair = {
    kind: "matched",
    id: "m:0:0",
    original: "Engineer with a decade of experience",
    originalIndex: 0,
    proposed: "Engineer with a decade of platform experience",
    proposedIndex: 0,
  };
  // The placeholder only paints when the edited side is empty, so it needs its
  // own pair — asserting it on `filled` would pass vacuously.
  const empty: AlignedPair = { ...filled, proposed: "" };

  it("names the noun on the kind label, both controls, and the editor label", () => {
    const el = render(
      createElement(BulletReviewRow, {
        pair: filled,
        review: makeReview(),
        noun: "summary",
      }),
    );

    expect(el.querySelector("li span")?.textContent).toBe("Edited summary");
    expect(
      el.querySelector('button[aria-label="Accept this edited summary"]'),
    ).not.toBeNull();
    expect(
      el.querySelector('button[aria-label="Reject this edited summary"]'),
    ).not.toBeNull();
    // The editor's own label — half of the pair that stayed hardcoded.
    expect(
      el.querySelector('[aria-label="Edit Edit proposed summary"]'),
    ).not.toBeNull();
    // Nothing anywhere on the row still calls it a bullet.
    expect(el.innerHTML).not.toContain("bullet");
  });

  it("names the noun in the empty-state placeholder — the other half", () => {
    const el = render(
      createElement(BulletReviewRow, {
        pair: empty,
        review: makeReview(),
        noun: "summary",
      }),
    );

    expect(el.textContent).toContain("edit this summary");
    expect(el.innerHTML).not.toContain("bullet");
  });

  it("defaults to \"bullet\", so every caller that omits the prop is unchanged", () => {
    const el = render(
      createElement(BulletReviewRow, { pair: empty, review: makeReview() }),
    );

    expect(el.querySelector("li span")?.textContent).toBe("Edited bullet");
    expect(
      el.querySelector('[aria-label="Edit Edit proposed bullet"]'),
    ).not.toBeNull();
    expect(el.textContent).toContain("edit this bullet");
  });
});
