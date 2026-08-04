// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * What a merge keeps (#746). A merge is the one tracker action that destroys a
 * record, so these assert the direction of every rule: notes are added to and
 * never overwritten, the survivor's own values are never replaced, and the
 * absorbed record's URL becomes an alias rather than disappearing.
 */

import { describe, expect, it } from "vitest";
import { mergeJobRecords } from "./job-merge.ts";
import type { JobRecord } from "./storage/index.ts";

const AGGREGATOR = "https://jobs.example.com/listing/4012345";
const ATS = "https://boards.greenhouse.io/acme/jobs/4012345";

function job(over: Partial<JobRecord>): JobRecord {
  return {
    id: over.id ?? "job-x",
    createdAt: 1,
    updatedAt: 2,
    title: "Senior Frontend Engineer",
    company: "Acme",
    status: "interested",
    ...over,
  };
}

describe("mergeJobRecords: the surviving record", () => {
  it("carries both URLs — its own as `url`, the other's as an alias", () => {
    const merged = mergeJobRecords(
      job({ id: "a", url: ATS }),
      job({ id: "b", url: AGGREGATOR }),
    );
    expect(merged.url).toBe(ATS);
    expect(merged.aliasUrls).toEqual([AGGREGATOR]);
  });

  it("keeps the survivor's id, so identity cannot move", () => {
    const merged = mergeJobRecords(job({ id: "a", url: ATS }), job({ id: "b", url: AGGREGATOR }));
    expect(merged.id).toBe("a");
  });

  it("unions both records' existing aliases, deduplicated by canonical form", () => {
    const merged = mergeJobRecords(
      job({ id: "a", url: ATS, aliasUrls: [AGGREGATOR] }),
      job({
        id: "b",
        url: `${AGGREGATOR}?utm_source=li`,
        aliasUrls: ["https://www.jobs.example.com/listing/4012345", "https://acme.com/careers/7"],
      }),
    );
    // The three spellings of the aggregator listing collapse to the one the
    // survivor already held; the genuinely different URL is added.
    expect(merged.aliasUrls).toEqual([AGGREGATOR, "https://acme.com/careers/7"]);
  });

  it("never lists its own url as an alias of itself", () => {
    const merged = mergeJobRecords(
      job({ id: "a", url: ATS }),
      job({ id: "b", url: AGGREGATOR, aliasUrls: [`${ATS}#apply`] }),
    );
    expect(merged.aliasUrls).toEqual([AGGREGATOR]);
  });

  it("drops a stale alias list rather than leaving one the merge emptied", () => {
    // The survivor had no url and one alias; it adopts that alias as its `url`,
    // at which point nothing is an alias any more.
    const merged = mergeJobRecords(
      job({ id: "a", url: undefined, aliasUrls: [ATS] }),
      job({ id: "b", url: ATS }),
    );
    expect(merged.url).toBe(ATS);
    expect("aliasUrls" in merged).toBe(false);
  });

  it("drops an alias candidate that is not an absolute http(s) URL", () => {
    // §9 of the capture contract would refuse it on the next import, so writing
    // it would mean storing a record this build's own validator rejects.
    const merged = mergeJobRecords(
      job({ id: "a", url: ATS }),
      job({ id: "b", url: "acme.com/jobs/1" }),
    );
    expect(merged.aliasUrls).toBeUndefined();
  });
});

describe("mergeJobRecords: notes are concatenated, never overwritten", () => {
  it("keeps both, survivor first", () => {
    const merged = mergeJobRecords(
      job({ id: "a", notes: "Referred by Dana." }),
      job({ id: "b", notes: "Recruiter called 12 Aug." }),
    );
    expect(merged.notes).toBe("Referred by Dana.\n\nRecruiter called 12 Aug.");
  });

  it("takes the other's notes when the survivor has none", () => {
    const merged = mergeJobRecords(
      job({ id: "a" }),
      job({ id: "b", notes: "Recruiter called." }),
    );
    expect(merged.notes).toBe("Recruiter called.");
  });

  it("does not duplicate identical notes", () => {
    const merged = mergeJobRecords(
      job({ id: "a", notes: "Referred by Dana." }),
      job({ id: "b", notes: " Referred by Dana. " }),
    );
    expect(merged.notes).toBe("Referred by Dana.");
  });

  it("invents no `notes` key when neither record had one", () => {
    expect("notes" in mergeJobRecords(job({ id: "a" }), job({ id: "b" }))).toBe(false);
  });
});

describe("mergeJobRecords: fills gaps, keeps what the survivor has", () => {
  it("fills an absent field from the other record", () => {
    const merged = mergeJobRecords(
      job({ id: "a" }),
      job({ id: "b", salaryRange: "$180k – $220k", jdText: "We are hiring.", resumeId: "cv-1" }),
    );
    expect(merged.salaryRange).toBe("$180k – $220k");
    expect(merged.jdText).toBe("We are hiring.");
    expect(merged.resumeId).toBe("cv-1");
  });

  it("treats an empty string as a gap, not a statement", () => {
    const merged = mergeJobRecords(
      job({ id: "a", company: "", title: "" }),
      job({ id: "b", company: "Acme", title: "Senior Frontend Engineer" }),
    );
    expect(merged.company).toBe("Acme");
    expect(merged.title).toBe("Senior Frontend Engineer");
  });

  it("keeps the survivor's own value over the other's", () => {
    const merged = mergeJobRecords(
      job({ id: "a", company: "Acme", status: "interviewing", resumeId: "cv-1" }),
      job({ id: "b", company: "Acme Corp", status: "rejected", resumeId: "cv-2" }),
    );
    expect(merged.company).toBe("Acme");
    // The survivor's status wins even when the other's is further along — the
    // user chooses by choosing which row survives. See the module docblock.
    expect(merged.status).toBe("interviewing");
    expect(merged.resumeId).toBe("cv-1");
  });

  it("carries an unknown extra key over from the absorbed record", () => {
    // The capture contract preserves keys this build has never heard of; a
    // merge that dropped one would be the same silent loss, one step later.
    const absorbed = job({ id: "b" }) as unknown as Record<string, unknown>;
    absorbed.employerRating = 4.5;
    const merged = mergeJobRecords(job({ id: "a" }), absorbed as unknown as JobRecord);
    expect((merged as unknown as Record<string, unknown>).employerRating).toBe(4.5);
  });

  it("leaves the store's own fields alone", () => {
    const merged = mergeJobRecords(
      job({ id: "a", createdAt: 10, updatedAt: 20 }),
      job({ id: "b", createdAt: 1, updatedAt: 2 }),
    );
    expect(merged.createdAt).toBe(10);
    expect(merged.updatedAt).toBe(20);
  });

  it("does not inherit the absorbed record's provenance", () => {
    // `capture` and `origin` describe how a RECORD came to exist, so the
    // survivor cannot acquire them: a hand-typed row that absorbs an extension
    // capture would otherwise claim a producer that never wrote it, and render
    // "from a job alert" for a row the user typed. See `NOT_FILLED`.
    const merged = mergeJobRecords(
      job({ id: "a" }),
      job({
        id: "b",
        origin: "alert",
        capture: { contract: 2, producer: "offlinecv-extension", producerVersion: "1.2" },
      }),
    );
    expect("capture" in merged).toBe(false);
    expect("origin" in merged).toBe(false);
  });

  it("keeps its own provenance when it has some", () => {
    const merged = mergeJobRecords(
      job({ id: "a", origin: "manual", capture: { contract: 1, producer: "mine" } }),
      job({
        id: "b",
        origin: "alert",
        capture: { contract: 2, producer: "offlinecv-extension" },
      }),
    );
    expect(merged.origin).toBe("manual");
    expect(merged.capture).toEqual({ contract: 1, producer: "mine" });
  });

  it("mutates neither argument", () => {
    const survivor = job({ id: "a", url: ATS, notes: "Mine." });
    const absorbed = job({ id: "b", url: AGGREGATOR, notes: "Theirs." });
    const survivorBefore = JSON.stringify(survivor);
    const absorbedBefore = JSON.stringify(absorbed);
    mergeJobRecords(survivor, absorbed);
    expect(JSON.stringify(survivor)).toBe(survivorBefore);
    expect(JSON.stringify(absorbed)).toBe(absorbedBefore);
  });

  it("refuses to let a `__proto__` key on the absorbed record reach a prototype", () => {
    const absorbed = JSON.parse(
      '{"id":"b","createdAt":1,"updatedAt":2,"title":"SWE","company":"Acme","status":"interested","__proto__":{"polluted":true}}',
    ) as JobRecord;
    const merged = mergeJobRecords(job({ id: "a" }), absorbed);
    expect((merged as unknown as { polluted?: boolean }).polluted).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
