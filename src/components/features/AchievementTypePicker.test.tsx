// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * AchievementTypePicker (issue 456). The property that matters: the picker offers a
 * closed grid of presets WITHOUT closing the model — `type` is free text lifted
 * from a real PDF, so a label no preset covers must survive being shown and stay
 * editable. A picker that silently normalized it to the nearest preset would
 * rewrite what the résumé actually said.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AchievementTypePicker } from "./AchievementTypePicker.tsx";
import { matchAchievementPreset } from "../../lib/achievements/presets.ts";

/** Read the glyph from the catalog rather than repeating it as an escape — the
 *  test then can't drift from the presets it is asserting about. */
function emojiFor(label: string): string {
  const preset = matchAchievementPreset(label);
  if (!preset) throw new Error(`no preset "${label}"`);
  return preset.emoji;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;
let committed: string[];

function mount(value: string | undefined) {
  committed = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <AchievementTypePicker
        value={value}
        onSelect={(v) => committed.push(v)}
      />,
    ),
  );
}

/** The popover only exists once the trigger is clicked. */
function openMenu() {
  const trigger = container.querySelector("button");
  act(() => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function menu(): HTMLElement | null {
  return container.querySelector('[role="menu"]');
}

function menuItem(label: string): HTMLButtonElement {
  const items = [
    ...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
  ];
  const found = items.find((el) => el.textContent?.includes(label));
  if (!found) throw new Error(`no menu item "${label}"`);
  return found;
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("AchievementTypePicker (issue 456)", () => {
  it("shows the preset emoji beside a recognized label", () => {
    mount("Patent");
    expect(container.textContent).toContain("Patent");
    expect(container.textContent).toContain(emojiFor("Patent"));
  });

  it("shows a parser-lifted label that matches no preset, verbatim and emoji-less", () => {
    mount("Best Paper Award");
    // Rendered as-is — NOT normalized to the "Award" preset.
    expect(container.textContent).toContain("Best Paper Award");
    expect(container.textContent).not.toContain(emojiFor("Award"));
  });

  it("falls back to a 'type' placeholder when the achievement has no label", () => {
    mount(undefined);
    expect(container.textContent).toContain("type");
  });

  it("commits the preset label — not a slug — when one is picked", () => {
    mount(undefined);
    openMenu();
    act(() =>
      menuItem("Talk").dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    // The label string is what lands on `HeuristicAchievement.type` and what the
    // exporter bolds, so it must be "Talk", not "talk".
    expect(committed).toEqual(["Talk"]);
  });

  it("closes the menu after a pick", () => {
    mount(undefined);
    openMenu();
    expect(menu()).not.toBeNull();
    act(() =>
      menuItem("Book").dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(menu()).toBeNull();
  });

  it("marks the current label as the checked option", () => {
    mount("Award");
    openMenu();
    expect(menuItem("Award").getAttribute("aria-checked")).toBe("true");
    expect(menuItem("Talk").getAttribute("aria-checked")).toBe("false");
  });

  it("closes on Escape without committing", () => {
    mount("Patent");
    openMenu();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(menu()).toBeNull();
    expect(committed).toEqual([]);
  });

  it("closes on an outside click without committing", () => {
    mount("Patent");
    openMenu();
    act(() => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(committed).toEqual([]);
  });
});
