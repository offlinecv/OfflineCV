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

/** A posting with an explicit title (so its parsed seniority level matters). */
function titledPosting(
  id: string,
  title: string,
  description: string,
): JobPosting {
  return { ...posting(id, description), title };
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

  it("breaks a genuine fit TIE toward the location-matching posting (#545)", () => {
    // Location is a minor rating axis (weight 0.1) — it edges an otherwise-equal
    // race toward the local posting, but (see the #570 test below) can never
    // overcome a real fit gap. Identical descriptions → identical fitness, so the
    // location nudge alone decides: the local one leads.
    const desc =
      "We need React experts, plus Rust, Kubernetes, Terraform, and GraphQL skills.";
    const local = posting("local", desc, "Austin, TX");
    const faraway = posting("faraway", desc, "Berlin, Germany");
    const ranked = rankPostings(parsed, [local, faraway], { location: "Austin, TX" });
    // Tied fitness (same description), so the location nudge is the tiebreaker.
    const localJob = ranked.find((j) => j.posting.id === "local")!;
    const farawayJob = ranked.find((j) => j.posting.id === "faraway")!;
    expect(localJob.score).toBe(farawayJob.score);
    expect(ranked[0].posting.id).toBe("local");
    // The local posting's location axis is a full 5★; the non-local one's is the
    // bounded non-match value — the nudge, not a fit difference, ordered them.
    expect(localJob.rating.location).toBeCloseTo(5, 5);
    expect(farawayJob.rating.location!).toBeLessThan(5);
    // Coverage parity is untouched — score still equals coverage.score.
    expect(localJob.score).toBe(localJob.jdMatch.coverage.score);
  });

  it("a weak local posting does NOT outrank a clearly-stronger non-local one — location is a minor axis (#570)", () => {
    // The #570 pathology: the old ranker added a FLAT +10 location boost to a
    // base that, on real compressed scores, tops out around ~20 — so location
    // was ~half the range and a weak local posting leapfrogged a much stronger
    // non-local one. In the star model location is a minor axis (weight 0.1), so
    // it can only trim the overall by a fraction of a star: "local" has a
    // distinctly lower fitness than "faraway", and the small location nudge
    // cannot close that gap — the stronger fit still leads.
    const local = posting(
      "local",
      "React developer wanted. Also Rust, Kubernetes, Terraform, and Golang.",
      "Austin, TX",
    );
    const faraway = posting(
      "faraway",
      "React and TypeScript engineer. Familiarity with Rust and Kubernetes a plus.",
      "Berlin, Germany",
    );
    const ranked = rankPostings(parsed, [local, faraway], { location: "Austin, TX" });
    const localScore = ranked.find((j) => j.posting.id === "local")!.score;
    const farawayScore = ranked.find((j) => j.posting.id === "faraway")!.score;
    // Fixture sanity: faraway is the genuinely stronger fit (covers React AND
    // TypeScript; local covers only React), so its displayed score is higher —
    // this is a real fit gap, not a tie the location nudge is meant to break.
    expect(farawayScore).toBeGreaterThan(localScore);
    // The stronger non-local fit still leads: the location axis (weight 0.1) can
    // only trim the overall by a fraction of a star, nowhere near the fitness gap.
    expect(ranked[0].posting.id).toBe("faraway");
    // Coverage parity untouched — the rating never edits the displayed score.
    const localJob = ranked.find((j) => j.posting.id === "local")!;
    expect(localJob.score).toBe(localJob.jdMatch.coverage.score);
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

  it("ranks a dense, well-matched posting above a thin fully-covered one (#561)", () => {
    // A senior résumé covering many technologies.
    const senior: HeuristicParsedResume = {
      skills: [
        "React",
        "TypeScript",
        "Node.js",
        "GraphQL",
        "PostgreSQL",
        "Docker",
        "AWS",
        "Python",
        "Kubernetes",
        "Go",
      ],
      experience: [
        {
          title: "Staff Engineer",
          company: "Acme",
          description:
            "Built React and TypeScript apps on Node.js with GraphQL, PostgreSQL, Docker, AWS, Python, Kubernetes and Go.",
        },
      ],
      education: [],
    };

    // Thin posting: a couple of terms, both covered → score 100 on a tiny
    // denominator.
    const thin = posting(
      "thin",
      "We are looking for a React and TypeScript engineer.",
    );
    // Dense, well-specified posting: many extracted terms, most covered, a few
    // not → a strong-but-sub-100 score over a large denominator.
    const dense = posting(
      "dense",
      "We need React, TypeScript, Node.js, GraphQL, PostgreSQL, Docker, AWS, " +
        "Python, Kubernetes, and Go. Exposure to Rust, Scala, and Elixir is a plus.",
    );

    const ranked = rankPostings(senior, [thin, dense]);

    const thinJob = ranked.find((j) => j.posting.id === "thin")!;
    const denseJob = ranked.find((j) => j.posting.id === "dense")!;

    // Fixture sanity: the thin posting really does score higher on the raw
    // coverage % (that is the pathology #561 fixes), yet the dense posting has
    // many more extracted terms.
    expect(thinJob.score).toBeGreaterThan(denseJob.score);
    expect(denseJob.jdMatch.terms.length).toBeGreaterThan(
      thinJob.jdMatch.terms.length,
    );

    // Despite its lower displayed %, the dense posting sorts first — the
    // specificity-weighted fitness base demotes the thin 100%.
    expect(ranked[0].posting.id).toBe("dense");

    // Parity untouched: displayed score still equals coverage.score for both.
    expect(thinJob.score).toBe(thinJob.jdMatch.coverage.score);
    expect(denseJob.score).toBe(denseJob.jdMatch.coverage.score);
  });

  it("keeps a no-extractable-terms posting at the bottom — no-op degenerate case (#561)", () => {
    const real = posting("real", "We need a React and TypeScript engineer.");
    // Lowercase filler with no skills, acronyms, or capitalized phrases.
    const empty = posting(
      "empty",
      "we support our people and help them grow a little every single day here.",
    );

    const ranked = rankPostings(parsed, [empty, real]);

    const emptyJob = ranked.find((j) => j.posting.id === "empty")!;
    // Degenerate posting yields no terms and a 0 score — unchanged from today.
    expect(emptyJob.jdMatch.terms.length).toBe(0);
    expect(emptyJob.score).toBe(0);
    // It cannot be promoted above a genuinely-matched posting: fitness 0.
    expect(ranked[ranked.length - 1].posting.id).toBe("empty");
  });

  it("ranks a level-matching posting above an equal-coverage far-off-level one (issue 562)", () => {
    // Identical description → identical coverage/base. The ONLY differentiator
    // is the parsed title level vs the query seniority.
    const desc = "We need React and TypeScript experts.";
    const director = titledPosting("director", "Director of Engineering", desc);
    const junior = titledPosting("junior", "Junior Engineer", desc);

    const ranked = rankPostings(parsed, [junior, director], {
      seniority: "Director",
    });

    // Equal base coverage, so the seniority penalty alone orders them.
    expect(ranked[0].posting.id).toBe("director");
    // Parity untouched: the penalty lives in the rating, not `score`.
    const d = ranked.find((j) => j.posting.id === "director")!;
    expect(d.score).toBe(d.jdMatch.coverage.score);
  });

  it("leaves ordering byte-identical when the query has no derived seniority (issue 562)", () => {
    // Titles carry levels, but with no query seniority no penalty is applied,
    // so ordering is pure coverage — higher-coverage Junior beats weak Director.
    const strongJunior = titledPosting(
      "strong-junior",
      "Junior Engineer",
      "We need React and TypeScript experts.",
    );
    const weakDirector = titledPosting(
      "weak-director",
      "Director of Engineering",
      "We need Rust, Go, and Kubernetes.",
    );

    const withoutSeniority = rankPostings(parsed, [weakDirector, strongJunior]);
    const emptySeniority = rankPostings(parsed, [weakDirector, strongJunior], {
      seniority: undefined,
    });

    // Higher coverage wins regardless of title level.
    expect(withoutSeniority.map((j) => j.posting.id)).toEqual([
      "strong-junior",
      "weak-director",
    ]);
    // Passing an undefined seniority is identical to passing no query at all.
    expect(emptySeniority.map((j) => j.posting.id)).toEqual(
      withoutSeniority.map((j) => j.posting.id),
    );
  });

  it("treats a posting with no recognizable title level as neutral, not penalized (issue 562)", () => {
    // Under a Director query: a title with NO level keyword must NOT be
    // penalized, so it outranks an equal-coverage Junior-titled posting (which
    // IS penalized for being far below the target).
    const desc = "We need React and TypeScript experts.";
    const noLevel = titledPosting("no-level", "Data Analyst", desc);
    const junior = titledPosting("junior", "Junior Engineer", desc);

    const ranked = rankPostings(parsed, [junior, noLevel], {
      seniority: "Director",
    });

    expect(ranked[0].posting.id).toBe("no-level");
  });

  it("soft-penalizes, never drops: a far-off-level posting still appears (issue 562)", () => {
    // A heavily level-mismatched posting (Junior under a Director query) is
    // demoted — a many-rung gap SHOULD sink hard — but it is a penalty, not a
    // filter: the posting is still in the results, never removed.
    const junior = titledPosting(
      "junior",
      "Junior Engineer",
      "We need React and TypeScript experts.",
    );
    const director = titledPosting(
      "director",
      "Director of Engineering",
      "We need React and TypeScript experts.",
    );

    const ranked = rankPostings(parsed, [director, junior], {
      seniority: "Director",
    });

    // Both survive — nothing is dropped by the soft penalty.
    expect(ranked).toHaveLength(2);
    expect(ranked.map((j) => j.posting.id)).toContain("junior");
    // The level-matched posting still leads.
    expect(ranked[0].posting.id).toBe("director");
  });

  it("sinks an adjacent-level posting only mildly — a clear coverage lead holds (issue 562)", () => {
    // Staff query. The Manager posting (1 rung off, −5) has a decisive coverage
    // advantage over an exact-level Staff posting with almost no overlap, so the
    // mild adjacent-level penalty does NOT overturn the coverage order.
    const rich: HeuristicParsedResume = {
      skills: ["React", "TypeScript", "Node.js", "GraphQL", "PostgreSQL", "AWS"],
      experience: [{ title: "Staff Engineer", company: "Acme", description: "" }],
      education: [],
    };
    const managerStrong = titledPosting(
      "manager-strong",
      "Engineering Manager",
      "We need React, TypeScript, Node.js, GraphQL, PostgreSQL, and AWS.",
    );
    const staffWeak = titledPosting(
      "staff-weak",
      "Staff Engineer",
      "We need Rust, Go, Kubernetes, Terraform, Scala, and Elixir.",
    );

    const ranked = rankPostings(rich, [staffWeak, managerStrong], {
      seniority: "Staff",
    });

    expect(ranked[0].posting.id).toBe("manager-strong");
  });

  it("extracts compensation once per posting and exposes it on RankedJob.posting (issue 564)", () => {
    const p = posting(
      "comp",
      "We need React and TypeScript experts. Salary: $180,000 - $240,000.",
    );
    const [job] = rankPostings(parsed, [p]);
    expect(job.posting.compensation).toBeDefined();
    expect(job.posting.compensation!.min).toBe(180000);
    expect(job.posting.compensation!.max).toBe(240000);
    expect(job.posting.compensation!.raw).toContain("180,000");
  });

  it("SILENCE IS NEUTRAL: a posting with no extractable range ranks unchanged, floor or not (issue 564)", () => {
    const noComp = posting("no-comp", "We need React and TypeScript experts.");
    const withoutFloor = rankPostings(parsed, [noComp]);
    const withFloor = rankPostings(parsed, [noComp], { compFloor: 500000 });
    expect(withoutFloor[0].belowFloor).toBe(false);
    expect(withFloor[0].belowFloor).toBe(false);
    // Sort key is unaffected — same score, same (sole) position either way.
    expect(withoutFloor[0].score).toBe(withFloor[0].score);
  });

  it("soft-penalizes a below-floor posting in the rating without dropping it (issue 564)", () => {
    // Identical descriptions → identical base coverage. The ONLY
    // differentiator is one posting's stated comp falling below the floor.
    const desc = "We need React and TypeScript experts.";
    const belowFloor = posting("below", `${desc} Pay: $80,000 - $90,000.`);
    const aboveFloor = posting("above", `${desc} Pay: $250,000 - $300,000.`);

    const ranked = rankPostings(parsed, [belowFloor, aboveFloor], {
      compFloor: 200000,
    });

    const below = ranked.find((j) => j.posting.id === "below")!;
    const above = ranked.find((j) => j.posting.id === "above")!;
    expect(below.belowFloor).toBe(true);
    expect(above.belowFloor).toBe(false);
    // Both still present — soft penalty, never a filter.
    expect(ranked).toHaveLength(2);
    expect(ranked[0].posting.id).toBe("above");
    // Ranking parity untouched: displayed score is still coverage.score.
    expect(below.score).toBe(below.jdMatch.coverage.score);
  });

  it("never penalizes when no compFloor is set, even for a low-paying posting (issue 564)", () => {
    const lowPay = posting("low", "We need React and TypeScript experts. Pay: $50,000.");
    const [job] = rankPostings(parsed, [lowPay]);
    expect(job.belowFloor).toBe(false);
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
