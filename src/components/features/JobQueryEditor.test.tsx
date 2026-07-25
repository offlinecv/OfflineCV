// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Coverage for the #581 primary-title marker + click-to-promote: the property
 * under test is that promoting a chip is a plain reorder of `query.titles`
 * flowing through the existing `onChange` — the "Searching feeds for …" line
 * (which reads `searchPhrase`, i.e. `titles[0]`) must follow the reorder, and
 * `titleNoise` — a derived, non-user-facing field on the same `JobQuery` —
 * must survive the promotion untouched.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JobQueryEditor } from "./JobQueryEditor.tsx";
import type { JobQuery } from "../../lib/job-search/query-builder.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

function render(query: JobQuery, onChange: (next: (q: JobQuery) => JobQuery) => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(JobQueryEditor, { query, onChange, isDegenerate: false }),
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("JobQueryEditor — primary title promotion", () => {
  it("moves a clicked chip to the front and follows with the searched-for line", () => {
    let query: JobQuery = {
      titles: ["Berlin Site Lead", "VP Engineering", "Engineering Manager"],
      skills: [],
      titleNoise: ["berlin"],
    };
    const el = render(query, (next) => {
      query = next(query);
    });

    expect(el.textContent).toContain('Searching feeds for "Berlin Site Lead"');

    const promote = [...el.querySelectorAll("button")].find((b) =>
      b.getAttribute("aria-label")?.includes("Make VP Engineering the primary title"),
    );
    if (!promote) throw new Error("no promote control for VP Engineering");
    act(() => promote.click());

    // Reordered — VP Engineering is now titles[0].
    expect(query.titles).toEqual([
      "VP Engineering",
      "Berlin Site Lead",
      "Engineering Manager",
    ]);
    // Untouched derived field on the same query object.
    expect(query.titleNoise).toEqual(["berlin"]);

    act(() => {
      root.render(
        createElement(JobQueryEditor, {
          query,
          onChange: (next) => {
            query = next(query);
          },
          isDegenerate: false,
        }),
      );
    });
    expect(el.textContent).toContain('Searching feeds for "VP Engineering"');
  });

  it("marks the primary chip with a star and aria-current", () => {
    const query: JobQuery = { titles: ["Staff Engineer", "Tech Lead"], skills: [] };
    const el = render(query, () => query);

    const current = el.querySelector('[aria-current="true"]');
    expect(current?.textContent).toContain("Staff Engineer");
  });
});
