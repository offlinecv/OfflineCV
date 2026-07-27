// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Structural test for the promote control's expanded hit area (#591). Same
 * jsdom caveat as `design-system/primitives/Chip.test.tsx`: no layout engine,
 * so this asserts the CSS technique (an invisible vertical-only `after:`
 * overlay) is present rather than measuring rendered pixels. Real-browser
 * measurement is recorded in #591.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChipListEditor } from "./ChipListEditor.tsx";

function render(props: Parameters<typeof ChipListEditor>[0]): string {
  return renderToStaticMarkup(createElement(ChipListEditor, props));
}

describe("ChipListEditor promote control target size", () => {
  it("expands the non-primary promote control's hit area vertically to reach 24x24, without a horizontal overlay that could cross into the remove control", () => {
    const html = render({
      label: "Titles",
      items: ["Frontend Engineer", "Fullstack Engineer"],
      onAdd: () => {},
      onRemove: () => {},
      placeholder: "Add a title",
      addAriaLabel: "Add title",
      primaryIndex: 0,
      onPromote: () => {},
    });
    // The ~16px-tall `Button variant="link"` promote control gets a 4px
    // vertical-only overlay (16 + 4 + 4 = 24) — `after:inset-x-0` keeps the
    // horizontal edges unchanged so the overlay can't reach across the 4px
    // `gap-1` into the neighbouring remove control's hit area.
    expect(html).toContain("after:-inset-y-[4px]");
    expect(html).toContain("after:inset-x-0");
  });

  it("renders the primary chip's star mark without a promote control", () => {
    const html = render({
      label: "Titles",
      items: ["Frontend Engineer"],
      onAdd: () => {},
      onRemove: () => {},
      placeholder: "Add a title",
      addAriaLabel: "Add title",
      primaryIndex: 0,
      onPromote: () => {},
    });
    expect(html).toContain('aria-current="true"');
  });
});

/**
 * #597 extends the promote control to Skills, where `primaryKeyword` sends
 * `skills[0]`. The label was hardcoded to "title", which would have told a
 * screen-reader user that a skill chip promotes a title.
 */
describe("ChipListEditor promote label", () => {
  const base = {
    items: ["Kubernetes", "TypeScript"],
    onAdd: () => {},
    onRemove: () => {},
    placeholder: "Add a skill",
    addAriaLabel: "Add skill",
    primaryIndex: 0,
    onPromote: () => {},
  };

  it("names the list's own noun", () => {
    const html = render({ ...base, label: "Skills", primaryNoun: "skill" });
    expect(html).toContain('aria-label="Make TypeScript the primary skill"');
  });

  it("defaults to 'title' so the original Titles call site is unchanged", () => {
    const html = render({ ...base, label: "Titles" });
    expect(html).toContain('aria-label="Make TypeScript the primary title"');
  });
});

describe("ChipListEditor optional add and remove (issue 599)", () => {
  it("renders with no add input when onAdd is omitted", () => {
    const html = render({
      label: "Role Titles",
      items: ["Engineering Lead"],
    });
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Add");
  });

  it("renders non-removable chips when onRemove is omitted", () => {
    const html = render({
      label: "Role Titles",
      items: ["Engineering Lead", "Senior Developer"],
    });
    expect(html).not.toContain("Remove Engineering Lead");
    expect(html).not.toContain("Remove Senior Developer");
  });
});

