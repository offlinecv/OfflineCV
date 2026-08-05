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
  REPOST_SPAN_DAYS,
  findDuplicatePairs,
  isActionableDuplicate,
  jobCompanyTitleKey,
  jobDuplicateConfidence,
  jobPairKey,
  withinRepostSpan,
} from "./job-duplicates.ts";
import type { JobRecord } from "./storage/index.ts";

const DAY = 24 * 60 * 60 * 1000;

/** Both records share `createdAt` unless a case overrides it, which since #754
 *  is load-bearing rather than incidental: capture proximity is the last
 *  corroborating signal, so a same-instant pair is the corroborated case and
 *  every `probable` expectation below rests on it. The uncorroborated case is
 *  its own block. */
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

describe("jobDuplicateConfidence: the `title-only` tier (#754)", () => {
  /** Two records of one role at one company, captured `days` apart, carrying
   *  whatever else the case is about. The captured record this models is title +
   *  company + url and nothing else — 523 of 544 in the measured library. */
  function apart(days: number, extra: Partial<JobRecord> = {}) {
    return [
      job({ id: "a", createdAt: 0, ...extra }),
      job({ id: "b", createdAt: days * DAY, ...extra }),
    ] as const;
  }

  it("company + identical title 49 days apart, with nothing else, is `title-only`", () => {
    // The core defect: this used to be `probable`, which put a destructive
    // **Merge** button on an employer's repost.
    const [a, b] = apart(49);
    expect(jobDuplicateConfidence(a, b)).toBe("title-only");
    expect(jobDuplicateConfidence(b, a)).toBe("title-only");
  });

  it("is below the bar for offering a merge", () => {
    expect(isActionableDuplicate("title-only")).toBe(false);
  });

  it("keeps the same-day double-capture at `probable`", () => {
    // 13 of the 98 measured pairs are same-day. Without proximity as a signal
    // these lose their merge offer too, and the feature stops working for the
    // case it exists for.
    const [a, b] = apart(0);
    expect(jobDuplicateConfidence(a, b)).toBe("probable");
  });

  it("treats a span of exactly REPOST_SPAN_DAYS as close enough, and one ms more as not", () => {
    expect(jobDuplicateConfidence(...apart(REPOST_SPAN_DAYS))).toBe("probable");
    const a = job({ id: "a", createdAt: 0 });
    const b = job({ id: "b", createdAt: REPOST_SPAN_DAYS * DAY + 1 });
    expect(jobDuplicateConfidence(a, b)).toBe("title-only");
  });
});

describe("jobDuplicateConfidence: what corroborates a title (#754)", () => {
  const JD =
    "This is a role recruiting on behalf of one of our customers. Own the platform roadmap, hire the team, and ship.";

  function apart(days: number, extra: Partial<JobRecord> = {}) {
    return [
      job({ id: "a", createdAt: 0, ...extra }),
      job({ id: "b", createdAt: days * DAY, ...extra }),
    ] as const;
  }

  it("an identical description lifts a 49-day-apart pair back to `probable`", () => {
    // The motivating cluster's six postings had byte-identical descriptions —
    // evidence that existed and was simply never captured.
    expect(jobDuplicateConfidence(...apart(49, { jdText: JD }))).toBe("probable");
  });

  it("two ABSENT descriptions corroborate nothing", () => {
    expect(jobDuplicateConfidence(...apart(49, { jdText: "" }))).toBe("title-only");
  });

  it("a merely OVERLAPPING description does not corroborate — identity or nothing", () => {
    const a = job({ id: "a", createdAt: 0, jdText: JD });
    const b = job({
      id: "b",
      createdAt: 49 * DAY,
      jdText: `${JD} You will also own hiring for the data team and the on-call rota.`,
    });
    expect(jobDuplicateConfidence(a, b)).toBe("title-only");
  });

  it("the same declared datePosted corroborates", () => {
    expect(jobDuplicateConfidence(...apart(49, { datePosted: "2026-06-15" }))).toBe(
      "probable",
    );
  });

  it("a DIFFERENT datePosted does not — that is what a repost changes", () => {
    const a = job({ id: "a", createdAt: 0, datePosted: "2026-06-15" });
    const b = job({ id: "b", createdAt: 49 * DAY, datePosted: "2026-08-03" });
    expect(jobDuplicateConfidence(a, b)).toBe("title-only");
  });

  it("location AND salaryRange together corroborate", () => {
    expect(
      jobDuplicateConfidence(
        ...apart(49, { location: "Austin, TX", salaryRange: "$225k – $325k" }),
      ),
    ).toBe("probable");
  });

  it("location alone does not — every role at a company shares one", () => {
    expect(jobDuplicateConfidence(...apart(49, { location: "Remote (US)" }))).toBe(
      "title-only",
    );
  });

  it("salaryRange alone does not — a band repeats across a level", () => {
    expect(jobDuplicateConfidence(...apart(49, { salaryRange: "$225k – $325k" }))).toBe(
      "title-only",
    );
  });

  it("a matching location with a DIFFERENT salary does not corroborate", () => {
    const a = job({ id: "a", createdAt: 0, location: "Austin, TX", salaryRange: "$180k" });
    const b = job({
      id: "b",
      createdAt: 49 * DAY,
      location: "Austin, TX",
      salaryRange: "$260k",
    });
    expect(jobDuplicateConfidence(a, b)).toBe("title-only");
  });

  it("a shared URL still outranks everything — 49 days apart is still `certain`", () => {
    const url = "https://boards.example.com/bellhaven/jobs/4012345";
    const a = job({ id: "a", createdAt: 0, url });
    const b = job({ id: "b", createdAt: 49 * DAY, url: `${url}?utm_source=li` });
    expect(jobDuplicateConfidence(a, b)).toBe("certain");
  });

  it("degrades to `title-only` — never a throw — when the corroborating fields are the wrong types", () => {
    // The totality rule, extended to every field #754 added. A record that
    // predates these fields, or a producer that wrote a number into one, must
    // read as "no evidence" and therefore no merge offer.
    const a = job({ id: "a", createdAt: 0 });
    const b = job({ id: "b", createdAt: 49 * DAY });
    Object.assign(a, { datePosted: 20260615, location: {}, salaryRange: [], jdText: 7 });
    Object.assign(b, { datePosted: 20260615, location: {}, salaryRange: [], jdText: 7 });
    expect(jobDuplicateConfidence(a, b)).toBe("title-only");
  });

  it("an unreadable createdAt is missing evidence, not a zero-length span", () => {
    const a = job({ id: "a" });
    const b = job({ id: "b" });
    Object.assign(a, { createdAt: "yesterday" });
    Object.assign(b, { createdAt: undefined });
    expect(jobDuplicateConfidence(a, b)).toBe("title-only");
  });
});

describe("withinRepostSpan", () => {
  it("is inclusive at the boundary", () => {
    expect(withinRepostSpan(0, REPOST_SPAN_DAYS * DAY)).toBe(true);
    expect(withinRepostSpan(0, REPOST_SPAN_DAYS * DAY + 1)).toBe(false);
  });

  it("is symmetric", () => {
    expect(withinRepostSpan(49 * DAY, 0)).toBe(false);
    expect(withinRepostSpan(0, 49 * DAY)).toBe(false);
  });

  it("answers false for anything that is not a finite number", () => {
    for (const bad of ["0", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(withinRepostSpan(0, bad)).toBe(false);
      expect(withinRepostSpan(bad, 0)).toBe(false);
    }
  });
});

describe("jobCompanyTitleKey", () => {
  it("is one key for two spellings of one role", () => {
    expect(jobCompanyTitleKey(job({ company: "Acme, Inc.", title: "Staff Engineer" }))).toBe(
      jobCompanyTitleKey(job({ company: "acme", title: "  staff/engineer " })),
    );
  });

  it("is null when either side is blank — missing evidence, not sameness", () => {
    expect(jobCompanyTitleKey(job({ company: "" }))).toBeNull();
    expect(jobCompanyTitleKey(job({ title: "" }))).toBeNull();
  });

  it("is null for a record whose fields are not strings", () => {
    const hostile = job({ id: "a" });
    Object.assign(hostile, { company: 42, title: null });
    expect(jobCompanyTitleKey(hostile)).toBeNull();
  });

  it("cannot collide two roles that share a concatenation", () => {
    expect(jobCompanyTitleKey(job({ company: "Acme", title: "Corp Dev" }))).not.toBe(
      jobCompanyTitleKey(job({ company: "Acme Corp", title: "Dev" })),
    );
  });
});

describe("jobPairKey", () => {
  it("is the same key whichever side asks", () => {
    expect(jobPairKey("a", "b")).toBe(jobPairKey("b", "a"));
  });

  it("cannot collide two different pairings that share a concatenation", () => {
    expect(jobPairKey("a b", "c")).not.toBe(jobPairKey("a", "b c"));
  });

  it("has the SHAPE `job-duplicate-dismissals.ts` already stored (#754 must not change it)", () => {
    // Dismissals are persisted under this exact string. Changing the shape
    // would silently un-dismiss every pairing a user has already judged, so the
    // literal is pinned rather than left to the two `toBe` comparisons above.
    expect(jobPairKey("b", "a")).toBe("a\u0000b");
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

  it("still REPORTS an uncorroborated pairing, at `title-only` (#754)", () => {
    // The sweep's job is to report every tier it can distinguish; dropping the
    // pairing here would leave `job-repost-clusters.ts` nothing to explain and
    // the user with two unexplained rows.
    expect(
      findDuplicatePairs([
        job({ id: "a", createdAt: 0 }),
        job({ id: "b", createdAt: 49 * DAY }),
      ]),
    ).toEqual([{ a: "a", b: "b", confidence: "title-only" }]);
  });

  it("keeps the URL evidence over an uncorroborated title match", () => {
    expect(
      findDuplicatePairs([
        job({ id: "a", createdAt: 0, url: AGGREGATOR }),
        job({ id: "b", createdAt: 49 * DAY, url: ATS, aliasUrls: [AGGREGATOR] }),
      ]),
    ).toEqual([{ a: "a", b: "b", confidence: "certain" }]);
  });

  it("finds a pair by alias-alias intersection when neither has it as canonical url", () => {
    const a = job({ id: "a", url: "https://first-canonical.com/1", aliasUrls: [AGGREGATOR] });
    const b = job({ id: "b", url: "https://second-canonical.com/2", aliasUrls: [AGGREGATOR], company: "Acme Corp" });
    expect(findDuplicatePairs([a, b])).toEqual([{ a: "a", b: "b", confidence: "certain" }]);
  });
});
