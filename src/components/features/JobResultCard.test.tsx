// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Render coverage for JobResultCard (#319). Drives the card with a real
 * `RankedJob` built through `rankPostings` (no hand-mocked coverage) so the
 * fit-% headline, matched/missing chips, external link, and the "View match
 * detail" toggle → inline `<JdMatch>` all exercise. Raw createRoot + act,
 * matching the other feature render tests (no @testing-library in this repo).
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JobResultCard } from "./JobResultCard.tsx";
import { rankPostings } from "../../lib/job-search/rank.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";
import type { JobPosting } from "../../lib/job-search/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const parsed: HeuristicParsedResume = {
  skills: ["React", "TypeScript"],
  experience: [
    { title: "Frontend Engineer", company: "Acme", description: "Built React apps" },
  ],
  education: [],
};

const posting: JobPosting = {
  id: "remotive:1",
  title: "Senior Frontend Engineer",
  company: "Globex",
  location: "Remote",
  url: "https://example.com/jobs/1",
  description:
    "We want a React and TypeScript engineer. Rust and Kubernetes are a plus.",
  source: "Remotive",
};

let container: HTMLDivElement;
let root: Root;

function render() {
  const [job] = rankPostings(parsed, [posting]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(JobResultCard, { job }));
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("JobResultCard", () => {
  it("renders title, source line, fit %, and a safe external link", () => {
    const el = render();
    expect(el.textContent).toContain("Senior Frontend Engineer");
    expect(el.textContent).toContain("Globex");
    expect(el.textContent).toContain("Remotive");
    expect(el.textContent).toContain("Remote");
    expect(el.textContent).toContain("/100");
    expect(el.textContent).toContain("fit");

    const link = el.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.com/jobs/1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("toggles the inline JdMatch detail via View match detail", () => {
    const el = render();
    const toggle = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("View match detail"),
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(el.textContent).not.toContain("JD match");

    act(() => toggle.click());

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(el.textContent).toContain("Hide match detail");
    // Reused JdMatch detail is now inline.
    expect(el.textContent).toContain("JD match");
  });
});
