// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render + interaction coverage for `JobResultRefineStrip` (#809).
 *
 * The three assertions that matter are the three #809 acceptance criteria this
 * component is responsible for: the local-only toggle exists and writes
 * `locationOnly`; the level control is present for a query that derived NO
 * seniority (the fresher case the form's `AddPill` gate hides); and every edit
 * goes through the caller's single `onChange` — the strip owns no query state
 * of its own, which is what keeps it from becoming a second query surface.
 *
 * Raw createRoot + act, matching `JobSearchResults.test.tsx`.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JobResultRefineStrip } from "./JobResultRefineStrip.tsx";
import type { JobQuery } from "../../lib/job-search/query-builder.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

/** Renders the strip and returns the container plus every query the component
 *  asked for. `onChange` takes an updater, so applying it here is what the real
 *  `FindJobsPanel` `setQuery` does. */
function render(query: JobQuery) {
  const seen: JobQuery[] = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(JobResultRefineStrip, {
        query,
        onChange: (next: (q: JobQuery) => JobQuery) => seen.push(next(query)),
      }),
    );
  });
  return { el: container, seen };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

/** The checkbox whose label mentions locality — found by label text, the way a
 *  user finds it, rather than by DOM position. */
function localOnlyBox(el: HTMLElement): HTMLInputElement {
  const label = [...el.querySelectorAll("label")].find((l) =>
    /only jobs near/i.test(l.textContent ?? ""),
  );
  const input = label?.querySelector("input[type=checkbox]");
  if (!input) throw new Error("local-only checkbox not found");
  return input as HTMLInputElement;
}

function levelButton(el: HTMLElement, label: string): HTMLButtonElement {
  const button = [...el.querySelectorAll("button[role=radio]")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!button) throw new Error(`level "${label}" not found`);
  return button as HTMLButtonElement;
}

const baseQuery: JobQuery = { titles: ["Frontend Engineer"], skills: ["React"] };

describe("JobResultRefineStrip (issue 809)", () => {
  it("names the user's own location in the toggle, so it can be checked", () => {
    const { el } = render({ ...baseQuery, location: "Austin, TX" });
    expect(el.textContent).toContain("Only jobs near Austin, TX");
  });

  it("turning the toggle on sets locationOnly through the caller's onChange", () => {
    const { el, seen } = render({ ...baseQuery, location: "Austin, TX" });
    act(() => {
      localOnlyBox(el).click();
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].locationOnly).toBe(true);
    // The whole rest of the query is carried through untouched — the strip
    // replaces the query wholesale, same contract as `JobQueryEditor`.
    expect(seen[0].titles).toEqual(["Frontend Engineer"]);
    expect(seen[0].location).toBe("Austin, TX");
  });

  it("turning it back off clears the flag rather than storing false", () => {
    const { el, seen } = render({
      ...baseQuery,
      location: "Austin, TX",
      locationOnly: true,
    });
    act(() => {
      localOnlyBox(el).click();
    });
    expect(seen[0].locationOnly).toBeUndefined();
  });

  it("disables the toggle until a location is set, and says why", () => {
    const { el } = render(baseQuery);
    expect(localOnlyBox(el).disabled).toBe(true);
    expect(el.textContent).toContain("Add a location above to turn this on.");
  });

  it("offers the level control to a query that derived no seniority (the fresher case)", () => {
    const { el, seen } = render(baseQuery);
    expect(baseQuery.seniority).toBeUndefined();
    act(() => {
      levelButton(el, "Junior").click();
    });
    expect(seen[0].seniority).toBe("Junior");
  });

  it("offers the entry-level rungs, not just the ones a title can derive", () => {
    const { el } = render(baseQuery);
    for (const level of ["Intern", "Junior", "Mid"]) {
      expect(levelButton(el, level)).toBeTruthy();
    }
  });

  it("adds an exclude term through the same onChange", () => {
    const { el, seen } = render({ ...baseQuery, excludeTerms: ["Sales"] });
    const input = el.querySelector<HTMLInputElement>(
      'input[aria-label="Add exclude term"]',
    );
    if (!input) throw new Error("exclude input not found");
    // React tracks the DOM node's value, so assigning `.value` directly is
    // swallowed as a no-op change — go through the prototype setter, same as
    // `JobQueryEditor.test.tsx`'s `setNativeValue`.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(input, "Manager");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const add = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Add",
    );
    if (!add) throw new Error("Add button not found");
    act(() => add.click());
    expect(seen.at(-1)?.excludeTerms).toEqual(["Sales", "Manager"]);
  });

  it("removes an exclude term through the same onChange", () => {
    const { el, seen } = render({ ...baseQuery, excludeTerms: ["Sales"] });
    const remove = [...el.querySelectorAll("button")].find((b) =>
      /remove/i.test(b.getAttribute("aria-label") ?? ""),
    );
    if (!remove) throw new Error("remove control not found");
    act(() => remove.click());
    expect(seen.at(-1)?.excludeTerms).toEqual([]);
  });
});
