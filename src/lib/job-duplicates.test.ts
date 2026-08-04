// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Duplicate detection (#746). The four cases the issue names are the spine —
 * an alias hit, same company + title, same company + DIFFERENT title (must not
 * match), different company + same title (must not match) — because the last
 * two are what stop the tracker offering a merge that destroys a record.
 *
 * Minimal typed stubs over full fixtures, the shape `contact.test.ts` uses:
 * every field this module reads is named in the stub, and nothing else matters
 * to it.
 */

import { describe, expect, it } from "vitest";
import {
  findDuplicatePairs,
  isActionableDuplicate,
  jobDuplicateConfidence,
  jobPairKey,
} from "./job-duplicates.ts";
import type { JobRecord } from "./storage/index.ts";

function job(over: Partial<JobRecord>): JobRecord {
  return {
    id: over.id ?? "job-x",
    createdAt: 1,
    updatedAt: 1,
    title: "Senior Frontend Engineer",
    company: "Acme",
    status: "interested",
    ...over,
  };
}

const AGGREGATOR = "https://jobs.example.com/listing/4012345";
const ATS = "https://boards.greenhouse.io/acme/jobs/4012345";

describe("jobDuplicateConfidence: the four cases the issue names", () => {
  it("alias hit — one record's url is in the other's aliasUrls — is `certain`", () => {
    const a = job({ id: "a", url: AGGREGATOR });
    const b = job({ id: "b", url: ATS, aliasUrls: [AGGREGATOR], company: "Acme Corp" });
    // Both directions, and across a company disagreement the URL evidence
    // outranks: an aggregator and an ATS routinely spell the company apart.
    expect(jobDuplicateConfidence(a, b)).toBe("certain");
    expect(jobDuplicateConfidence(b, a)).toBe("certain");
  });

  it("alias-alias intersection — both records share a common alias URL — is `certain`", () => {
    const a = job({ id: "a", url: "https://first-canonical.com/1", aliasUrls: [AGGREGATOR] });
    const b = job({ id: "b", url: "https://second-canonical.com/2", aliasUrls: [AGGREGATOR], company: "Acme Corp" });
    expect(jobDuplicateConfidence(a, b)).toBe("certain");
    expect(jobDuplicateConfidence(b, a)).toBe("certain");
  });

  it("same company + same title is `probable`", () => {
    const a = job({ id: "a", url: AGGREGATOR });
    const b = job({ id: "b", url: ATS });
    expect(jobDuplicateConfidence(a, b)).toBe("probable");
  });

  it("same company + DIFFERENT title does NOT match", () => {
    const a = job({ id: "a", title: "Senior Frontend Engineer" });
    const b = job({ id: "b", title: "Director of Finance" });
    expect(jobDuplicateConfidence(a, b)).toBeNull();
  });

  it("different company + same title does NOT match", () => {
    const a = job({ id: "a", company: "Acme" });
    const b = job({ id: "b", company: "Globex" });
    expect(jobDuplicateConfidence(a, b)).toBeNull();
  });
});

describe("jobDuplicateConfidence: what must never pair", () => {
  // The single most reachable over-match: `company` is documented as "may be
  // empty when the user hasn't filled it in yet", so a library of half-filled
  // rows would otherwise be one giant duplicate cluster.
  it("two blank companies are not a match, whatever the titles say", () => {
    const a = job({ id: "a", company: "", title: "Engineer" });
    const b = job({ id: "b", company: "", title: "Engineer" });
    expect(jobDuplicateConfidence(a, b)).toBeNull();
  });

  it("two blank titles at one company are not a match", () => {
    const a = job({ id: "a", title: "" });
    const b = job({ id: "b", title: "" });
    expect(jobDuplicateConfidence(a, b)).toBeNull();
  });

  it("an alias that is not an absolute http(s) URL matches nothing", () => {
    const a = job({ id: "a", url: AGGREGATOR, company: "Acme" });
    const b = job({ id: "b", company: "Globex", aliasUrls: ["jobs.example.com/listing/4012345"] });
    expect(jobDuplicateConfidence(a, b)).toBeNull();
  });

  it("survives a record whose fields are not the types they claim", () => {
    // Reachable: `saveJob` writes whatever a caller supplies and a restored
    // backup predates every field here. A throw would take the whole tracker
    // render down.
    const hostile = { id: "b", createdAt: 1, updatedAt: 1, status: "interested" } as unknown as JobRecord;
    Object.assign(hostile, { title: 42, company: null, aliasUrls: "not-an-array", url: 7 });
    expect(jobDuplicateConfidence(job({ id: "a" }), hostile)).toBeNull();
  });
});

describe("jobDuplicateConfidence: normalisation", () => {
  it("ignores case, punctuation and a trailing legal form on the company", () => {
    const a = job({ id: "a", company: "Acme, Inc." });
    const b = job({ id: "b", company: "acme" });
    expect(jobDuplicateConfidence(a, b)).toBe("probable");
  });

  it("keeps a company whose whole name is a legal form, so it cannot normalise to blank", () => {
    const a = job({ id: "a", company: "Limited" });
    const b = job({ id: "b", company: "" });
    expect(jobDuplicateConfidence(a, b)).toBeNull();
  });

  it("ignores case and punctuation in the title", () => {
    const a = job({ id: "a", title: "Senior Frontend Engineer" });
    const b = job({ id: "b", title: "  senior  frontend/engineer " });
    expect(jobDuplicateConfidence(a, b)).toBe("probable");
  });

  it("matches an alias across a `www.` prefix and a tracking parameter", () => {
    // Canonicalisation is READ from `job-url.ts`, never reimplemented — the same
    // rules that decide identity decide whether two spellings are one alias.
    const a = job({ id: "a", url: "https://www.jobs.example.com/listing/4012345?utm_source=li" });
    const b = job({ id: "b", company: "Globex", aliasUrls: [AGGREGATOR] });
    expect(jobDuplicateConfidence(a, b)).toBe("certain");
  });

  it("treats two records holding the same posting URL as `certain`", () => {
    // The duplicate a user can make entirely inside this app: "Add a job" mints
    // a UUID rather than deriving an id, so pasting one URL twice makes two rows.
    const a = job({ id: "a", url: ATS, company: "Acme" });
    const b = job({ id: "b", url: `${ATS}#apply`, company: "Globex", title: "Something else" });
    expect(jobDuplicateConfidence(a, b)).toBe("certain");
  });
});

describe("jobDuplicateConfidence: the `possible` tier", () => {
  const JD_A =
    "Build and ship the customer dashboard in React and TypeScript. Own accessibility, performance budgets and the design system.";
  const JD_B =
    "Own accessibility, performance budgets and the design system. Build and ship the customer dashboard in React and TypeScript, with a focus on testing.";

  it("same company + similar title + overlapping description is `possible`", () => {
    const a = job({ id: "a", title: "Senior Frontend Engineer", jdText: JD_A });
    const b = job({ id: "b", title: "Frontend Engineer II", jdText: JD_B });
    expect(jobDuplicateConfidence(a, b)).toBe("possible");
  });

  it("a similar title with NO overlapping description does not match", () => {
    const a = job({ id: "a", title: "Senior Frontend Engineer", jdText: JD_A });
    const b = job({
      id: "b",
      title: "Frontend Engineer II",
      jdText: "Maintain the payroll batch pipeline in COBOL for our banking clients.",
    });
    expect(jobDuplicateConfidence(a, b)).toBeNull();
  });

  it("a similar title with no descriptions at all does not match", () => {
    const a = job({ id: "a", title: "Senior Frontend Engineer" });
    const b = job({ id: "b", title: "Frontend Engineer II" });
    expect(jobDuplicateConfidence(a, b)).toBeNull();
  });

  it("is below the bar for offering a merge", () => {
    expect(isActionableDuplicate("possible")).toBe(false);
    expect(isActionableDuplicate("probable")).toBe(true);
    expect(isActionableDuplicate("certain")).toBe(true);
  });
});

describe("jobPairKey", () => {
  it("is the same key whichever side asks", () => {
    expect(jobPairKey("a", "b")).toBe(jobPairKey("b", "a"));
  });

  it("cannot collide two different pairings that share a concatenation", () => {
    expect(jobPairKey("a b", "c")).not.toBe(jobPairKey("a", "b c"));
  });
});

describe("findDuplicatePairs", () => {
  it("reports one pairing once, with `a` < `b`", () => {
    const pairs = findDuplicatePairs([
      job({ id: "b", url: ATS }),
      job({ id: "a", url: AGGREGATOR }),
    ]);
    expect(pairs).toEqual([{ a: "a", b: "b", confidence: "probable" }]);
  });

  it("finds an alias hit across a company disagreement, which no company bucket could", () => {
    const pairs = findDuplicatePairs([
      job({ id: "a", url: AGGREGATOR, company: "Acme via ExampleJobs", title: "Frontend dev" }),
      job({ id: "b", url: ATS, company: "Acme", aliasUrls: [AGGREGATOR] }),
    ]);
    expect(pairs).toEqual([{ a: "a", b: "b", confidence: "certain" }]);
  });

  it("keeps the STRONGEST confidence when both passes find one pairing", () => {
    // Same company + title (probable) AND an alias hit (certain). The alias is
    // the evidence somebody actually recorded, so it must win.
    const pairs = findDuplicatePairs([
      job({ id: "a", url: AGGREGATOR }),
      job({ id: "b", url: ATS, aliasUrls: [AGGREGATOR] }),
    ]);
    expect(pairs).toEqual([{ a: "a", b: "b", confidence: "certain" }]);
  });

  it("never pairs a record with itself", () => {
    const self = job({ id: "a", url: AGGREGATOR, aliasUrls: [AGGREGATOR] });
    expect(findDuplicatePairs([self])).toEqual([]);
  });

  it("reports nothing for a library of unrelated jobs", () => {
    expect(
      findDuplicatePairs([
        job({ id: "a", company: "Acme", title: "Frontend Engineer" }),
        job({ id: "b", company: "Globex", title: "Backend Engineer" }),
        job({ id: "c", company: "Initech", title: "" }),
      ]),
    ).toEqual([]);
  });

  it("finds a pair by alias-alias intersection when neither has it as canonical url", () => {
    const a = job({ id: "a", url: "https://first-canonical.com/1", aliasUrls: [AGGREGATOR] });
    const b = job({ id: "b", url: "https://second-canonical.com/2", aliasUrls: [AGGREGATOR], company: "Acme Corp" });
    expect(findDuplicatePairs([a, b])).toEqual([{ a: "a", b: "b", confidence: "certain" }]);
  });
});
