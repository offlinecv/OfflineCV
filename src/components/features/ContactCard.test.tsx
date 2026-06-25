// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Render tests for the centered visual ContactCard (#146). The pure data layer
 * (grouping, gating, slug formatting) is covered in `src/lib/contact.test.ts`;
 * this file covers the React surface — that each `group`/`gated`/`reason`
 * combination paints the right DOM: name heading vs. muted fallback, the
 * pipe-joined contact line with quiet "not found" tokens, low-confidence dotted
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

function render(result: CascadeResult): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(ContactCard, { result }));
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

  it("renders present contact values and a quiet 'not found' token for a missing required field", () => {
    const el = render(
      makeResult({ email: "jane@example.com" }, { email: 0.95 }),
    );
    const text = el.textContent ?? "";
    expect(text).toContain("jane@example.com");
    // Phone is required but absent → quiet inline token, not a warning chip.
    expect(text).toContain("phone not found");
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
    expect(anchor?.textContent).toBe("in/jane-doe");
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
