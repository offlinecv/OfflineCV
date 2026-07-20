// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { rankPostings } from "./rank.ts";
import { extractJdTerms } from "../jd-match/extract-jd-terms.ts";
import { computeCoverage } from "../jd-match/coverage.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { JobPosting } from "./types.ts";

const parsed: HeuristicParsedResume = {
  skills: ["React", "TypeScript"],
  experience: [
    { title: "Frontend Engineer", company: "Acme", description: "Built React apps" },
  ],
  education: [],
};

function posting(id: string, description: string): JobPosting {
  return {
    id,
    title: `Job ${id}`,
    company: "Co",
    location: "Remote",
    url: `https://x/${id}`,
    description,
    source: "Test",
  };
}

describe("rankPostings", () => {
  it("sorts by fit descending", () => {
    const strong = posting("strong", "We need React and TypeScript experts.");
    const weak = posting("weak", "We need Rust and Kubernetes and Terraform experts.");
    const ranked = rankPostings(parsed, [weak, strong]);
    expect(ranked[0].posting.id).toBe("strong");
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
  });

  it("guarantees card fit parity: job.score === job.jdMatch.coverage.score, and both equal a fresh computeCoverage", () => {
    const p = posting("p1", "Seeking a React and TypeScript developer.");
    const [job] = rankPostings(parsed, [p]);

    // Card reads job.score; detail view reads job.jdMatch.coverage.score.
    expect(job.score).toBe(job.jdMatch.coverage.score);

    // Independent recomputation over the same description must match exactly —
    // proves there is one coverage computation, not two divergent paths.
    const fresh = computeCoverage(parsed, extractJdTerms(p.description).all);
    expect(job.jdMatch.coverage.score).toBe(fresh.score);
    expect(job.jdMatch.path).toBe("keyword");
  });
});
