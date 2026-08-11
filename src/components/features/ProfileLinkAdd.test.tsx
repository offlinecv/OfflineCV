// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render tests for the guided ProfileLinkAdd affordance (#335-followup). Covers
 * the collapse→expand progressive disclosure, the derived network chips, the
 * tap-a-chip-pre-fills-the-prefix flow, and commit. Raw createRoot + act (no
 * RTL), matching the sibling ContactCard render tests.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ProfileLinkAdd } from "./ProfileLinkAdd.tsx";
import { PROFILE_QUICK_PICKS } from "../../lib/contact/profile-registry.ts";

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(props: Parameters<typeof ProfileLinkAdd>[0]): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(ProfileLinkAdd, props));
  });
  return container;
}

function click(el: Element | null) {
  act(() => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("ProfileLinkAdd", () => {
  it("starts collapsed as a labelled add pill", () => {
    const el = render({ onAdd: () => undefined, label: "Add a professional profile" });
    const pill = el.querySelector('[aria-label="Add a professional profile"]');
    expect(pill).not.toBeNull();
    // No network chips until it is expanded.
    expect(el.querySelector('[aria-label="Add LinkedIn"]')).toBeNull();
  });

  it("expands to show a chip per quick-pick network", () => {
    const el = render({ onAdd: () => undefined, label: "Add a profile" });
    click(el.querySelector('[aria-label="Add a profile"]'));
    for (const pick of PROFILE_QUICK_PICKS) {
      expect(
        el.querySelector(`[aria-label="Add ${pick.label}"]`),
      ).not.toBeNull();
    }
  });

  it("tapping a network chip pre-fills its prefix into the input", () => {
    const el = render({ onAdd: () => undefined, label: "Add a profile" });
    click(el.querySelector('[aria-label="Add a profile"]'));
    click(el.querySelector('[aria-label="Add GitHub"]'));
    const input = el.querySelector("input");
    expect(input?.value).toBe("https://github.com/");
  });

  it("commits the entered URL and collapses when stayOpenAfterAdd is unset", () => {
    const onAdd = vi.fn(() => "profile:0");
    const el = render({ onAdd, label: "Add a professional profile" });
    click(el.querySelector('[aria-label="Add a professional profile"]'));
    click(el.querySelector('[aria-label="Add LinkedIn"]'));
    // The primary Add button shares the field's aria-label; it is the <button>.
    const addBtn = el.querySelector('button[aria-label="Add a professional profile"]');
    click(addBtn);
    expect(onAdd).toHaveBeenCalledWith("https://linkedin.com/in/");
    // Collapsed again → chips gone.
    expect(el.querySelector('[aria-label="Add GitHub"]')).toBeNull();
  });

  it("rejected input keeps the draft, stays expanded, and renders an alert (#790)", () => {
    const onAdd = vi.fn(() => undefined);
    const el = render({ onAdd, label: "Add a profile" });
    click(el.querySelector('[aria-label="Add a profile"]'));
    const input = el.querySelector("input") as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new Event("focus"));
    });
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "US Citizen");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const addBtn = el.querySelector('button[aria-label="Add a profile"]');
    click(addBtn);

    expect(onAdd).toHaveBeenCalledWith("US Citizen");
    // Draft survives — not cleared on rejection.
    expect(input.value).toBe("US Citizen");
    // Still expanded — chips still present.
    expect(el.querySelector('[aria-label="Add GitHub"]')).not.toBeNull();
    // Visible, announced error.
    const alert = el.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toMatch(/doesn't look like a link/i);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("clears the error on the next keystroke", () => {
    const onAdd = vi.fn(() => undefined);
    const el = render({ onAdd, label: "Add a profile" });
    click(el.querySelector('[aria-label="Add a profile"]'));
    const input = el.querySelector("input") as HTMLInputElement;
    const setValue = (v: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      act(() => {
        setter.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    setValue("US Citizen");
    click(el.querySelector('button[aria-label="Add a profile"]'));
    expect(el.querySelector('[role="alert"]')).not.toBeNull();

    setValue("US Citizen2");
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });
});
