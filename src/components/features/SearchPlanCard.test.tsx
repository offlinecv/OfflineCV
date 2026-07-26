// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The card's claim is that what it shows is what will be sent, and that the
 * **change** control is a real correction path rather than decoration. These
 * assert both from the outside: props in, callback out, no mocks — a click on a
 * picked chip must reach the parent's promote handler with that chip's own text.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SearchPlanCard } from "./SearchPlanCard.tsx";
import type { JobQuery } from "../../lib/job-search/query-builder.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(props: Parameters<typeof SearchPlanCard>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(SearchPlanCard, props));
  });
  return container;
}

function buttonByLabel(el: HTMLElement, label: string): HTMLButtonElement {
  const btn = [...el.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  );
  if (!btn) throw new Error(`no button labelled "${label}"`);
  return btn as HTMLButtonElement;
}

const noop = () => {};

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("SearchPlanCard", () => {
  const query: JobQuery = {
    titles: ["Founder & CEO", "VP Engineering", "Engineering Manager"],
    skills: ["cross-functional collaboration", "TypeScript"],
  };

  it("names the one title and the one skill that will be sent, and the company boards", () => {
    const el = render({
      query,
      companyCount: 14,
      onPromoteTitle: noop,
      onPromoteSkill: noop,
    });
    expect(el.textContent).toContain('"Founder & CEO"');
    expect(el.textContent).toContain('"cross-functional collaboration"');
    expect(el.textContent).toContain("14 company boards");
    expect(el.textContent).toContain("company name only");
    // The other half of the model: everything else stays here.
    expect(el.textContent).toMatch(/on your device/);
  });

  it("promotes the picked title through the parent handler", () => {
    let promoted: string | undefined;
    const el = render({
      query,
      companyCount: 0,
      onPromoteTitle: (t) => {
        promoted = t;
      },
      onPromoteSkill: noop,
    });

    act(() => buttonByLabel(el, "Change what Job feeds is searched for").click());
    const pick = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "VP Engineering",
    );
    if (!pick) throw new Error("no picker option for VP Engineering");
    act(() => pick.click());

    expect(promoted).toBe("VP Engineering");
  });

  it("promotes the picked skill through the parent handler", () => {
    let promoted: string | undefined;
    const el = render({
      query,
      companyCount: 0,
      onPromoteTitle: noop,
      onPromoteSkill: (s) => {
        promoted = s;
      },
    });

    act(() => buttonByLabel(el, "Change what Topic tag is searched for").click());
    const pick = [...el.querySelectorAll("button")].find((b) => b.textContent === "TypeScript");
    if (!pick) throw new Error("no picker option for TypeScript");
    act(() => pick.click());

    expect(promoted).toBe("TypeScript");
  });

  it("renders no change control when there is nothing else to pick", () => {
    const el = render({
      query: { titles: ["Staff Engineer"], skills: ["Kubernetes"] },
      companyCount: 1,
      onPromoteTitle: noop,
      onPromoteSkill: noop,
    });
    const labels = [...el.querySelectorAll("button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels.some((l) => l?.startsWith("Change what"))).toBe(false);
  });

  // With no title, `searchPhrase` falls back to the first three skills joined,
  // so the feeds row's displayed term matches no single chip. Filtering the
  // picker by that string would leave the already-primary skill on offer, and
  // promoting index 0 is a no-op — a control that does nothing when clicked.
  it("offers no no-op option on the title-less fallback", () => {
    const el = render({
      query: { titles: [], skills: ["Go", "Kubernetes", "Terraform"] },
      companyCount: 0,
      onPromoteTitle: noop,
      onPromoteSkill: noop,
    });
    const change = buttonByLabel(el, "Change what Job feeds is searched for");
    act(() => change.click());

    const options = [...el.querySelectorAll("button")]
      .map((b) => b.textContent)
      .filter((text) => text === "Go" || text === "Kubernetes");
    // "Go" is already `skills[0]`; picking it would change nothing.
    expect(options).not.toContain("Go");
    expect(options).toContain("Kubernetes");
  });

  it("renders a reason instead of empty quotes for a degenerate query", () => {
    const el = render({
      query: { titles: [], skills: [] },
      companyCount: 0,
      onPromoteTitle: noop,
      onPromoteSkill: noop,
    });
    expect(el.textContent).not.toContain('""');
    expect(el.textContent).toContain("add a title or a skill");
  });
});
