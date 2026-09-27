// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * #860 — `EntryRemoveButton`'s own arm/confirm/disarm contract, pinned
 * directly rather than only through a section that happens to wire it in.
 *
 * jsdom + raw `createRoot`, matching `ReconstructedResume.remove-parsed-entry.
 * test.tsx` and the other component suites in this directory (the project has
 * no @testing-library/react).
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { EntryRemoveButton } from "./ReconstructedAdd.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function removeButton(label = "Remove role"): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
}

function cancelButton(): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>("button")].find(
    (b) => b.textContent === "Cancel",
  );
}

function render(bulletCount: number, onRemove = vi.fn()): typeof onRemove {
  act(() =>
    root.render(
      createElement(EntryRemoveButton, {
        label: "Remove role",
        entryNoun: "role",
        bulletCount,
        onRemove,
      }),
    ),
  );
  return onRemove;
}

describe("EntryRemoveButton (#860)", () => {
  it("renders the bare RemoveButton at rest — no write until armed", () => {
    const onRemove = render(2);
    expect(removeButton()).not.toBeNull();
    expect(container.textContent).not.toContain("Remove this role");
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("arms on the first click, naming the entry's bullet count", () => {
    render(2);
    act(() => removeButton()!.click());
    expect(container.textContent).toContain(
      "Remove this role and its 2 bullets?",
    );
  });

  it("uses singular 'bullet' for exactly one", () => {
    render(1);
    act(() => removeButton()!.click());
    expect(container.textContent).toContain("Remove this role and its 1 bullet?");
    expect(container.textContent).not.toContain("1 bullets");
  });

  it("drops the bullet clause entirely for zero (Education)", () => {
    render(0);
    act(() => removeButton()!.click());
    expect(container.textContent).toContain("Remove this role?");
  });

  it("writes nothing until the confirm (second) click, then calls onRemove", () => {
    const onRemove = render(3);
    act(() => removeButton()!.click());
    expect(onRemove).not.toHaveBeenCalled();
    act(() => removeButton()!.click());
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("Escape disarms with no write", () => {
    const onRemove = render(3);
    act(() => removeButton()!.click());
    act(() =>
      removeButton()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(container.textContent).not.toContain("Remove this role and");
    expect(removeButton()).not.toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("an explicit Cancel disarms with no write", () => {
    const onRemove = render(3);
    act(() => removeButton()!.click());
    const cancel = cancelButton();
    expect(cancel).toBeDefined();
    act(() => cancel!.click());
    expect(removeButton()).not.toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("disarms with no write when focus leaves the confirm control", async () => {
    const onRemove = render(3);
    act(() => removeButton()!.click());
    expect(container.textContent).toContain("Remove this role and");

    // "focusout" is the idiom `sectionExitBlur` answers to — see its docblock
    // and `ReconstructedResume.remove-parsed-entry.test.tsx`'s sibling case —
    // and the disarm is deferred one macrotask, same as that helper.
    await act(async () => {
      removeButton()!.dispatchEvent(
        new FocusEvent("focusout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).not.toContain("Remove this role and");
    expect(removeButton()).not.toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
