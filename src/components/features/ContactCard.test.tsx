// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Render tests for the centered visual ContactCard (#146). The pure data layer
 * (grouping, gating, slug formatting) is covered in `src/lib/contact.test.ts`;
 * this file covers the React surface — that each `group`/`gated`/`reason`
 * combination paints the right DOM: name heading vs. muted fallback, the
 * pipe-joined contact line with discernible "not detected" tokens, low-confidence dotted
 * values, clickable slug links, and the audit footer.
 *
 * Runs in jsdom (per the `@vitest-environment jsdom` pragma) so React +
 * `react-dom/client` have a document to render into; uses raw `createRoot`
 * rather than RTL, matching `useModelSelection.integration.test.tsx`.
 */

import { describe, expect, it, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ContactCard } from "./ContactCard.tsx";
import type { CascadeResult } from "../../lib/heuristics/types.ts";

function makeResult(
  parsedOverrides: Partial<CascadeResult["parsed"]> = {},
  confidenceOverrides: Partial<CascadeResult["fieldConfidence"]> = {},
): CascadeResult {
  return {
    parsed: {
      skills: [],
      experience: [],
      education: [],
      ...parsedOverrides,
    },
    fieldConfidence: confidenceOverrides,
  } as CascadeResult;
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(
  result: CascadeResult,
  editProps?: Pick<
    Parameters<typeof ContactCard>[0],
    "overrides" | "onFieldChange"
  >,
): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(ContactCard, { result, ...editProps }));
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("ContactCard", () => {
  it("renders the name as the heading when confidently detected", () => {
    const el = render(
      makeResult({ full_name: "Jane Doe" }, { full_name: 0.9 }),
    );
    const heading = el.querySelector("h2");
    expect(heading?.textContent).toBe("Jane Doe");
  });

  it("shows a muted 'Name not detected' when the name is absent", () => {
    const el = render(makeResult());
    expect(el.querySelector("h2")?.textContent).toBe("Name not detected");
  });

  it("renders present contact values and a discernible 'not detected' token for a missing required field", () => {
    const el = render(
      makeResult({ email: "jane@example.com" }, { email: 0.95 }),
    );
    const text = el.textContent ?? "";
    expect(text).toContain("jane@example.com");
    // Phone is required but absent → discernible warning token (set apart so the
    // gap is spotted at a glance), not a loud chip.
    expect(text).toContain("Phone not detected");
  });

  it("marks a low-confidence value with a dotted underline + tooltip", () => {
    const floor = 0.5 - 0.01;
    const el = render(
      makeResult({ email: "jane@example.com" }, { email: floor }),
    );
    const dotted = el.querySelector('[title="low confidence"]');
    expect(dotted?.textContent).toBe("jane@example.com");
    expect(dotted?.className).toContain("decoration-dotted");
  });

  it("renders a detected link as a clickable new-tab slug anchor", () => {
    const el = render(
      makeResult(
        { linkedin_url: "https://www.linkedin.com/in/jane-doe" },
        { linkedin_url: 0.9 },
      ),
    );
    const anchor = el.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe(
      "https://www.linkedin.com/in/jane-doe",
    );
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor?.textContent).toBe("linkedin.com/in/jane-doe");
  });

  it("gives a present LinkedIn a navigate-and-edit dual affordance when editable", () => {
    const el = render(
      makeResult(
        { linkedin_url: "https://www.linkedin.com/in/jane-doe" },
        { linkedin_url: 0.9 },
      ),
      { overrides: {}, onFieldChange: () => {} },
    );
    // Slug is the click-to-edit target (operates on the full URL)…
    const edit = el.querySelector('[aria-label="Edit LinkedIn"]');
    expect(edit?.textContent).toBe("linkedin.com/in/jane-doe");
    // …and a separate ↗ anchor still opens the real URL in a new tab.
    const open = el.querySelector('a[aria-label="Open LinkedIn in a new tab"]');
    expect(open?.getAttribute("href")).toBe(
      "https://www.linkedin.com/in/jane-doe",
    );
    expect(open?.getAttribute("target")).toBe("_blank");
  });

  it("makes a detected github link editable with the dual affordance", () => {
    const el = render(
      makeResult(
        { github_url: "https://github.com/janedoe" },
        { github_url: 0.9 },
      ),
      { overrides: {}, onFieldChange: () => {} },
    );
    expect(el.querySelector('[aria-label="Edit GitHub"]')?.textContent).toBe(
      "github.com/janedoe",
    );
    expect(
      el.querySelector('a[aria-label="Open GitHub in a new tab"]'),
    ).not.toBeNull();
  });

  it("keeps a missing required field discernible even while editable", () => {
    const el = render(
      makeResult({ email: "jane@example.com" }, { email: 0.95 }),
      { overrides: {}, onFieldChange: () => {} },
    );
    expect(el.textContent).toContain("Phone not detected");
    expect(el.querySelector('[aria-label="Edit Phone"]')).not.toBeNull();
  });

  it("renders the audit footer with the detected/total ratio", () => {
    const el = render(
      makeResult(
        {
          full_name: "Jane Doe",
          email: "jane@example.com",
          phone: "(312) 555-0100",
          linkedin_url: "https://linkedin.com/in/jane",
          location: "Chicago, IL",
        },
        {
          full_name: 0.9,
          email: 0.95,
          phone: 0.9,
          linkedin_url: 0.8,
          location: 0.8,
        },
      ),
    );
    // All five required rows detected, none gated.
    expect(el.textContent).toContain("5 of 5 fields detected");
  });
});
