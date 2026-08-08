// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * PasteJdPanel (#576) — the paste-a-JD disclosure on `/jobs/`.
 *
 * Focused on the Tailor affordance's render gate. The panel's docblock claims
 * it feeds "the same `onTailor` a `JobResultCard` uses"; that claim is only
 * true if the two agree on WHEN the button appears, and the sibling
 * `JobResultCard.test.tsx` pins the other half. A JD the résumé already covers
 * yields no steering, so the button must be absent rather than present and
 * inert.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { PasteJdPanel } from "./PasteJdPanel.tsx";
import { buildJdRewriteContext } from "../../lib/jd-match/rewrite-context.ts";
import { extractJdTerms, computeCoverage } from "../../lib/jd-match";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const JD_TEXT =
  "We are hiring a platform engineer. You will work with Kubernetes, " +
  "Terraform, and Go to run our production infrastructure.";

const SPARSE_RESUME: HeuristicParsedResume = {
  skills: ["React"],
  experience: [
    { title: "Frontend Engineer", company: "Acme", description: "Built UIs" },
  ],
  education: [],
} as unknown as HeuristicParsedResume;

const COVERING_RESUME: HeuristicParsedResume = {
  skills: ["Kubernetes", "Terraform", "Go"],
  experience: [
    {
      title: "Platform Engineer",
      company: "Acme",
      description:
        "Ran production infrastructure with Kubernetes, Terraform, and Go",
    },
  ],
  education: [],
} as unknown as HeuristicParsedResume;

let container: HTMLDivElement;
let root: Root;

/** Open the disclosure, type a JD, and flush the panel's input debounce. */
function renderWithJd(
  parsed: HeuristicParsedResume,
  onTailor?: (jdContext: string) => void,
) {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(PasteJdPanel, { parsed, onTailor }));
  });

  const disclosure = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Paste it"),
  ) as HTMLButtonElement;
  act(() => disclosure.click());

  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  act(() => {
    // React tracks the DOM value internally, so setting `.value` directly is
    // ignored on the next change event — go through the native setter the way
    // React's own synthetic events do.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, JD_TEXT);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    vi.advanceTimersByTime(500);
  });
  return container;
}

function tailorButton(el: HTMLElement): HTMLButtonElement | undefined {
  return [...el.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Tailor résumé to this job"),
  ) as HTMLButtonElement | undefined;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("PasteJdPanel tailor gate (#576)", () => {
  it("offers the Tailor button and hands over the built steering", () => {
    const onTailor = vi.fn();
    const el = renderWithJd(SPARSE_RESUME, onTailor);
    const button = tailorButton(el);
    expect(button).toBeTruthy();

    act(() => button?.click());
    // Same coverage the panel displayed, so the steering cannot disagree with
    // the match the user is looking at.
    const expected = buildJdRewriteContext(
      computeCoverage(SPARSE_RESUME, extractJdTerms(JD_TEXT).all),
    );
    expect(expected).toBeTruthy();
    expect(onTailor).toHaveBeenCalledTimes(1);
    expect(onTailor).toHaveBeenCalledWith(expected);
  });

  it("hides the Tailor button when the résumé already covers the JD", () => {
    // `buildJdRewriteContext` returns null here, so a rendered button would
    // no-op on click. The gate is that builder's own result — the failure the
    // `missing.length > 0` approximation allowed was a button that looked
    // live and did nothing.
    const coverage = computeCoverage(
      COVERING_RESUME,
      extractJdTerms(JD_TEXT).all,
    );
    expect(buildJdRewriteContext(coverage)).toBeNull();

    const el = renderWithJd(COVERING_RESUME, vi.fn());
    expect(tailorButton(el)).toBeUndefined();
  });

  it("omits the Tailor button entirely without an onTailor", () => {
    // Rendered outside `/jobs/`'s handoff-back-to-`/` context there is nowhere
    // to steer a rewrite from, so the affordance must not appear.
    const el = renderWithJd(SPARSE_RESUME);
    expect(tailorButton(el)).toBeUndefined();
  });
});
