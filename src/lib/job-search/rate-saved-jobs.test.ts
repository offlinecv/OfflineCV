// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `rateSavedJobs` (#700). The three properties the saved library's rating has to
 * hold — not-rated is distinct from zero, nothing is written back to the record,
 * and (since #716) a record's rating depends only on that record and the résumé
 * — plus parity with `rankPostings` on the shared fitness base.
 */

import { describe, it, expect } from "vitest";
import { rateSavedJobs, type RatableSavedJob } from "./rate-saved-jobs.ts";
import { rankPostings } from "./rank.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { JobPosting } from "./types.ts";

const parsed: HeuristicParsedResume = {
  skills: ["React", "TypeScript"],
  experience: [
    { title: "Frontend Engineer", company: "Acme", description: "Built React apps" },
  ],
  education: [],
};

const STRONG_JD =
  "We need a React and TypeScript engineer to build our frontend web application.";
/** Deliberately PARTIALLY covered, not uncovered: an all-missing JD scores 0,
 *  and 0 is 0 both in a set and alone, so the set-independence test below would
 *  pass for the wrong reason. One skill hits, five miss. */
const WEAK_JD =
  "We need Rust, Kubernetes, Terraform, Go and Postgres experts, with some React exposure, for our infrastructure platform team.";

function saved(over: Partial<RatableSavedJob> & { id: string }): RatableSavedJob {
  return { title: "Engineer", ...over };
}

function posting(id: string, description: string): JobPosting {
  return {
    id,
    title: "Engineer",
    company: "Co",
    location: "",
    url: `https://x/${id}`,
    description,
    source: "Test",
  };
}

describe("rateSavedJobs", () => {
  it("omits a record with no jdText — 'not rated' is absence, never a zero", () => {
    const ratings = rateSavedJobs(
      [saved({ id: "with", jdText: STRONG_JD }), saved({ id: "without" })],
      parsed,
    );
    expect(ratings.has("with")).toBe(true);
    // The row renderer reads absence as "not rated". A 0-star entry here would
    // read as "terrible fit" when the truth is "no description to match".
    expect(ratings.has("without")).toBe(false);
    expect(ratings.get("without")).toBeUndefined();
  });

  it("treats a blank/whitespace jdText as no description at all", () => {
    const ratings = rateSavedJobs(
      [saved({ id: "blank", jdText: "   \n\t " }), saved({ id: "empty", jdText: "" })],
      parsed,
    );
    expect(ratings.size).toBe(0);
  });

  it("omits a record whose jdText carries no extractable terms", () => {
    // The losing input is prose, not blankness: a capture that saved only a
    // pointer to the posting passes any `jdText.trim() !== ""` gate, extracts
    // zero terms, and coverage scores an empty requirement set 0 — which would
    // paint an EMPTY 5-star widget labelled "Weak fit" on a job we simply have
    // no description for. Text is not a description.
    const noTerms = [
      "Apply on our website.",
      "See job posting.",
      "Full job description available at the link below.",
      "-",
    ];
    const ratings = rateSavedJobs(
      [
        saved({ id: "real", jdText: STRONG_JD }),
        ...noTerms.map((jdText, i) => saved({ id: `bare${i}`, jdText })),
      ],
      parsed,
    );
    expect(ratings.has("real")).toBe(true);
    for (let i = 0; i < noTerms.length; i++) {
      expect(ratings.has(`bare${i}`)).toBe(false);
    }
    expect(ratings.size).toBe(1);
  });

  it("does not rate a library whose every record is term-less", () => {
    // The whole-set path, where a 0 would also have been the set's max and so
    // could not be spotted by comparing rows against each other.
    const ratings = rateSavedJobs(
      [
        saved({ id: "a", jdText: "Apply on our website." }),
        saved({ id: "b", jdText: "See job posting." }),
      ],
      parsed,
    );
    expect(ratings.size).toBe(0);
  });

  it("rates a record off that record alone — saving another job cannot move it", () => {
    // Property 3, post-#716, and it asserts the OPPOSITE of what it used to. The
    // fitness axis was hybrid absolute + SET-relative, so the weakest member of a
    // library sat at the bottom of the stretch and rated strictly lower than it
    // did on its own — the library's stars moved every time an unrelated job was
    // saved or deleted. The axis is absolute now, so the two must be identical.
    const asSet = rateSavedJobs(
      [saved({ id: "strong", jdText: STRONG_JD }), saved({ id: "weak", jdText: WEAK_JD })],
      parsed,
    );
    const alone = rateSavedJobs([saved({ id: "weak", jdText: WEAK_JD })], parsed);

    const weakInSet = asSet.get("weak");
    const weakAlone = alone.get("weak");
    expect(weakInSet).toBeDefined();
    expect(weakAlone).toBeDefined();
    expect(weakInSet!.fitness).toBe(weakAlone!.fitness);
    expect(weakInSet!.overall).toBe(weakAlone!.overall);

    // Not vacuous — WEAK_JD is partially covered, so this is a real non-zero
    // rating — and the two records still order correctly against each other.
    expect(weakInSet!.fitness).toBeGreaterThan(0);
    expect(asSet.get("strong")!.overall).toBeGreaterThan(weakInSet!.overall);
  });

  it("never writes a rating back onto the record it rated", () => {
    const record = saved({ id: "j1", jdText: STRONG_JD });
    const before = JSON.stringify(record);
    rateSavedJobs([record], parsed);
    // Recomputed on view: a stored score would go stale the moment the résumé is
    // edited, and JobRecord's shape is a public capture contract.
    expect(JSON.stringify(record)).toBe(before);
    expect(Object.keys(record).sort()).toEqual(["id", "jdText", "title"]);
  });

  it("returns an empty map for an empty library", () => {
    expect(rateSavedJobs([], parsed).size).toBe(0);
  });

  it("only the fitness axis is present — the library carries no query", () => {
    const rating = rateSavedJobs([saved({ id: "j1", jdText: STRONG_JD })], parsed).get("j1")!;
    expect(rating.compensation).toBeNull();
    expect(rating.location).toBeNull();
    expect(rating.seniority).toBeNull();
    // With every other axis absent, the blend is fitness alone.
    expect(rating.overall).toBeCloseTo(rating.fitness, 10);
  });

  it("agrees with the search lane on the same JD text and résumé", () => {
    // Same chain, same constants: a posting rated through `rankPostings` with no
    // query and the same description must land on the identical fitness. This is
    // the property that would break if a second RatingInput mapping existed.
    const [ranked] = rankPostings(parsed, [posting("p1", STRONG_JD)]);
    const rating = rateSavedJobs([saved({ id: "p1", jdText: STRONG_JD })], parsed).get("p1")!;
    expect(rating.fitness).toBeCloseTo(ranked.rating.fitness, 10);
    expect(rating.overall).toBeCloseTo(ranked.rating.overall, 10);
  });
});
