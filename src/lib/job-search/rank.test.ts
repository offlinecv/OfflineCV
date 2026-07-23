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

function posting(
  id: string,
  description: string,
  location = "Remote",
): JobPosting {
  return {
    id,
    title: `Job ${id}`,
    company: "Co",
    location,
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

  it("sorts by score alone when no location query is given (no regression, #545)", () => {
    const strong = posting("strong", "We need React and TypeScript experts.", "Austin, TX");
    const weak = posting("weak", "We need Rust and Kubernetes and Terraform experts.", "Austin, TX");
    const ranked = rankPostings(parsed, [weak, strong]);
    expect(ranked.map((j) => j.posting.id)).toEqual(["strong", "weak"]);
  });

  it("boosts a location-matching posting above a slightly-stronger non-local one (#545)", () => {
    // "local" has a lower raw coverage score than "faraway" (more uncovered
    // terms diluting its coverage %), but matches the query location — the
    // boost (10 points) should move it ahead in sort order without touching
    // either posting's displayed `score`.
    const local = posting(
      "local",
      "We need React experts, plus Rust, Kubernetes, Terraform, Golang, and GraphQL skills.",
      "Austin, TX",
    );
    const faraway = posting(
      "faraway",
      "We are hiring a React engineer. Familiarity with Rust, Kubernetes, Terraform, GraphQL helpful.",
      "Berlin, Germany",
    );
    const ranked = rankPostings(parsed, [local, faraway], { location: "Austin, TX" });
    const localScore = ranked.find((j) => j.posting.id === "local")!.score;
    const farawayScore = ranked.find((j) => j.posting.id === "faraway")!.score;
    // Sanity check the fixture: faraway scores at least as high as local on
    // raw coverage, and the gap is within the location boost, for this to be
    // a meaningful boost test (not just "local was already winning").
    expect(farawayScore).toBeGreaterThanOrEqual(localScore);
    expect(ranked[0].posting.id).toBe("local");
    // score parity is untouched by the boost — still equals coverage.score.
    const local2 = ranked.find((j) => j.posting.id === "local")!;
    expect(local2.score).toBe(local2.jdMatch.coverage.score);
  });

  it("does not drop a strong non-local match — soft boost, not a hard filter (#545)", () => {
    const strongFaraway = posting(
      "strong-faraway",
      "We need React and TypeScript experts.",
      "Berlin, Germany",
    );
    const weakLocal = posting("weak-local", "Rust and Kubernetes.", "Austin, TX");
    const ranked = rankPostings(parsed, [weakLocal, strongFaraway], {
      location: "Austin, TX",
    });
    // The strong non-local match still appears — it isn't filtered out.
    expect(ranked.map((j) => j.posting.id)).toContain("strong-faraway");
  });

  it("treats a Remote posting as matching any query location (#545)", () => {
    // Same description on both (tied raw coverage score) so the ONLY thing
    // that can break the tie is the location boost. The query location
    // ("Seattle, WA") doesn't textually match either posting's location, but
    // "Remote" must still count as a match — a remote posting fits any
    // candidate location — while "Austin, TX" (a real, non-matching, non-
    // remote city) must not.
    const remote = posting("remote", "We need React and TypeScript experts.", "Remote");
    const nonLocal = posting(
      "non-local",
      "We need React and TypeScript experts.",
      "Austin, TX",
    );
    const ranked = rankPostings(parsed, [nonLocal, remote], {
      location: "Seattle, WA",
    });
    expect(ranked[0].posting.id).toBe("remote");
  });
});
