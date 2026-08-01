// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render coverage for JobResultCard (#319). Drives the card with a real
 * `RankedJob` built through `rankPostings` (no hand-mocked coverage) so the
 * star-rating headline, matched/missing chips, external link, and the "View
 * match detail" toggle → inline `<JdMatch>` all exercise. Raw createRoot + act,
 * matching the other feature render tests (no @testing-library in this repo).
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JobResultCard } from "./JobResultCard.tsx";
import { rankPostings, type RankedJob } from "../../lib/job-search/rank.ts";
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
  return renderJob(job);
}

function renderJob(job: RankedJob) {
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
  it("renders title, meta line, a star rating headline, and a safe external link (issue 561)", () => {
    const el = render();
    expect(el.textContent).toContain("Senior Frontend Engineer");
    expect(el.textContent).toContain("Globex");
    expect(el.textContent).toContain("Remotive");
    expect(el.textContent).toContain("Remote");
    // Star rating replaces the fit percentage. No "/100" percentage anywhere.
    expect(el.textContent).not.toContain("/100");
    const overall = el.querySelector('[role="img"][aria-label^="Overall match"]');
    expect(overall).toBeTruthy();
    expect(overall!.getAttribute("aria-label")).toMatch(/out of 5 stars$/);

    const link = el.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.com/jobs/1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows exactly ONE star widget — no fit/pay sub-stars (issue 569)", () => {
    const compPosting = {
      ...posting,
      id: "remotive:9",
      description: `${posting.description} Salary: $180,000 - $240,000.`,
    };
    const [job] = rankPostings(parsed, [compPosting]);
    const el = renderJob(job);
    // Comp IS extracted here, so the old card would have rendered a "pay"
    // sub-star alongside the "fit" one. Both are gone; the axes are words now.
    expect(el.querySelectorAll('[role="img"]')).toHaveLength(1);
    expect(el.querySelector('[role="img"][aria-label^="Fit:"]')).toBeNull();
    expect(el.querySelector('[role="img"][aria-label^="Pay:"]')).toBeNull();
  });

  it("prints the rating numeral beside the stars (issue 569)", () => {
    const [job] = rankPostings(parsed, [posting]);
    const el = renderJob(job);
    const shown = (Math.round(job.rating.overall * 10) / 10).toFixed(1);
    expect((el.querySelector('[role="img"]') as HTMLElement).textContent).toContain(shown);
  });

  it("shows the coverage denominator as VISIBLE text, not a tooltip (issue 569)", () => {
    const el = render();
    const [job] = rankPostings(parsed, [posting]);
    const covered = job.jdMatch.coverage.covered.length;
    const total = covered + job.jdMatch.coverage.missing.length;
    expect(total).toBeGreaterThan(0);
    // Was a `title` on the fit sub-star — unreachable by touch and keyboard.
    expect(el.textContent).toContain(`${covered} of ${total} terms`);
    const tooltipped = [...el.querySelectorAll("span")].find((s) =>
      s.getAttribute("title")?.includes("terms"),
    );
    expect(tooltipped).toBeUndefined();
  });

  it("renders a reason phrase per rating axis (issue 569)", () => {
    const el = render();
    // Fitness is always present, so a fit phrase always renders.
    expect(el.textContent).toMatch(/(Excellent fit|Strong fit|Partial fit|Weak fit)/);
  });

  it("drops a source that only repeats the company name (issue 569)", () => {
    // Company-board adapters set `source` to the company's own display name.
    const boardPosting = { ...posting, id: "greenhouse:1", source: "Globex" };
    const [job] = rankPostings(parsed, [boardPosting]);
    const el = renderJob(job);
    expect(el.textContent).toContain("Globex");
    expect(el.textContent).not.toContain("Globex · Globex");
  });

  it("collapses a multi-location posting to first + count (issue 569)", () => {
    const multi = {
      ...posting,
      id: "greenhouse:2",
      location: "San Francisco, CA | New York City, NY | Seattle, WA",
    };
    const [job] = rankPostings(parsed, [multi]);
    const el = renderJob(job);
    expect(el.textContent).toContain("San Francisco, CA +2");
    expect(el.textContent).not.toContain("Seattle, WA");
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

  it("shows an extracted compensation range with the raw text as a tooltip (issue 564)", () => {
    const compPosting = {
      ...posting,
      id: "remotive:2",
      description: `${posting.description} Salary: $180,000 - $240,000.`,
    };
    const [job] = rankPostings(parsed, [compPosting]);
    const el = renderJob(job);
    expect(el.textContent).toContain("$180,000–$240,000/yr");
    const range = [...el.querySelectorAll("span")].find((s) =>
      s.textContent?.includes("$180,000–$240,000/yr"),
    ) as HTMLSpanElement;
    expect(range.getAttribute("title")).toContain("$180,000 - $240,000");
    // No floor set — no badge.
    expect(el.textContent).not.toContain("Below your floor");
  });

  it("renders nothing compensation-related for a posting with no extractable range (issue 564)", () => {
    const el = render();
    expect(el.textContent).not.toContain("/yr");
    expect(el.textContent).not.toContain("/hr");
    expect(el.textContent).not.toContain("Below your floor");
  });

  it("badges a below-floor posting without hiding it (issue 564)", () => {
    const compPosting = {
      ...posting,
      id: "remotive:3",
      description: `${posting.description} Salary: $80,000 - $90,000.`,
    };
    const [job] = rankPostings(parsed, [compPosting], { compFloor: 200000 });
    expect(job.belowFloor).toBe(true);
    const el = renderJob(job);
    expect(el.textContent).toContain("$80,000–$90,000/yr");
    expect(el.textContent).toContain("Below your floor");
  });
});
