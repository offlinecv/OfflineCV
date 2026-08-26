// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The job → company → standard resolution chain (#767).
 *
 * Every case here is about ORDER and about what must NOT match — the two
 * properties a surface downstream cannot check for itself. A wrong rung shows
 * an employer prose the user never wrote for them, which is the failure the
 * whole three-tier design is arranged around.
 *
 * Minimal typed stubs rather than full records, the pattern `contact.test.ts`
 * sets: the chain reads four fields and inventing the rest would only make a
 * later field addition break these tests for no reason.
 */

import { describe, it, expect } from "vitest";
import {
  inheritedLetterForJob,
  isCompanyLetter,
  resolveLetterForJob,
} from "./resolve-letter.ts";
import type { JobRecord, LetterRecord } from "../storage/types.ts";

/** A letter carrying only what the chain reads. `updatedAt` defaults distinct
 *  per call so "most recent wins" cases can override just the one they mean. */
function letter(fields: Partial<LetterRecord> & { id: string }): LetterRecord {
  return { body: "", createdAt: 0, updatedAt: 1, ...fields } as LetterRecord;
}

const job = (company: string, id = "job-1"): Pick<JobRecord, "id" | "company"> => ({
  id,
  company,
});

describe("resolveLetterForJob (#767)", () => {
  it("prefers the job's own letter over a company and a standard one", () => {
    const resolved = resolveLetterForJob(job("Northwind"), [
      letter({ id: "standard" }),
      letter({ id: "company", companyKey: "northwind" }),
      letter({ id: "own", jobId: "job-1" }),
    ]);
    expect(resolved).toEqual({
      letter: expect.objectContaining({ id: "own" }),
      scope: "job",
    });
  });

  it("falls to the company letter when the job has none of its own", () => {
    const resolved = resolveLetterForJob(job("Northwind"), [
      letter({ id: "standard" }),
      letter({ id: "company", companyKey: "northwind" }),
      // Another job's letter at the same company must not be reachable.
      letter({ id: "other-job", jobId: "job-2" }),
    ]);
    expect(resolved?.scope).toBe("company");
    expect(resolved?.letter.id).toBe("company");
  });

  it("falls to the standard letter when neither of the first two rungs matches", () => {
    const resolved = resolveLetterForJob(job("Northwind"), [
      letter({ id: "standard" }),
      letter({ id: "elsewhere", companyKey: "contoso" }),
    ]);
    expect(resolved?.scope).toBe("standard");
    expect(resolved?.letter.id).toBe("standard");
  });

  it("resolves to nothing when the user has written nothing reachable", () => {
    expect(resolveLetterForJob(job("Northwind"), [])).toBeUndefined();
    expect(
      resolveLetterForJob(job("Northwind"), [letter({ id: "other", jobId: "job-2" })]),
    ).toBeUndefined();
  });

  it("matches the company rung through the normaliser, not by raw name", () => {
    // The letter was saved under the derived key; the job's free text differs
    // in case, punctuation and legal suffix. They are one employer.
    const resolved = resolveLetterForJob(job("  Northwind, Inc. "), [
      letter({ id: "company", companyKey: "northwind" }),
    ]);
    expect(resolved?.scope).toBe("company");
  });

  it("NEVER matches a company letter for a job whose company is empty", () => {
    // The acceptance criterion stated directly: a blank company must skip the
    // rung, not match a blank key. `""` is not a company that letters belong to.
    for (const blank of ["", "   ", "  ,  "]) {
      const resolved = resolveLetterForJob(job(blank), [
        letter({ id: "company", companyKey: "northwind" }),
        letter({ id: "standard" }),
      ]);
      expect(resolved?.scope).toBe("standard");
    }
  });

  it("never inherits a letter that names another job, even at the same company", () => {
    // A both-keyed record is refused by `validateLetterRecord`, but the store
    // does not enforce the contract. If one exists it names a SPECIFIC posting,
    // so it must not leak to a sibling job — see the chain's own comment.
    const resolved = resolveLetterForJob(job("Northwind"), [
      letter({ id: "both", jobId: "job-2", companyKey: "northwind" }),
      letter({ id: "standard" }),
    ]);
    expect(resolved?.letter.id).toBe("standard");
  });

  it("reads a both-keyed record as this job's own when the ids match", () => {
    // The same reading `useJobLetters`' `groupByScope` gives it — job first.
    const resolved = resolveLetterForJob(job("Northwind"), [
      letter({ id: "both", jobId: "job-1", companyKey: "northwind" }),
    ]);
    expect(resolved).toEqual({
      letter: expect.objectContaining({ id: "both" }),
      scope: "job",
    });
  });

  it("picks the most recently updated letter within a rung", () => {
    const resolved = resolveLetterForJob(job("Northwind"), [
      letter({ id: "old", jobId: "job-1", updatedAt: 10 }),
      letter({ id: "new", jobId: "job-1", updatedAt: 20 }),
      letter({ id: "middle", jobId: "job-1", updatedAt: 15 }),
    ]);
    expect(resolved?.letter.id).toBe("new");
  });

  it("keeps the earlier element on an updatedAt tie, so the answer is stable", () => {
    const tied = [
      letter({ id: "first", companyKey: "northwind", updatedAt: 7 }),
      letter({ id: "second", companyKey: "northwind", updatedAt: 7 }),
    ];
    expect(resolveLetterForJob(job("Northwind"), tied)?.letter.id).toBe("first");
  });

  it("a newer standard letter does not outrank an older company letter", () => {
    // Specificity beats recency — the rungs are ordered, not scored. A user who
    // updated their standard letter yesterday still gets the company letter
    // they wrote for this employer last month.
    const resolved = resolveLetterForJob(job("Northwind"), [
      letter({ id: "company", companyKey: "northwind", updatedAt: 1 }),
      letter({ id: "standard", updatedAt: 999 }),
    ]);
    expect(resolved?.scope).toBe("company");
  });
});

/**
 * The second entry (#767 review). `resolveLetterForJob` answers "which letter
 * applies"; a surface offering to inherit needs "what would this job inherit if
 * it had none of its own". The two coincide only for a job that owns nothing —
 * so a caller that asks the first and drops the `"job"` answer gets `undefined`
 * for exactly the jobs that HAVE their own letters, which is the set whose
 * reveal opens. That is how the inherited half of #906's reveal shipped dead.
 */
describe("inheritedLetterForJob (#767 review)", () => {
  it("ignores the job's own letter entirely — the case the filtered form got wrong", () => {
    const letters = [
      letter({ id: "own", jobId: "job-1", updatedAt: 9 }),
      letter({ id: "standard", updatedAt: 2 }),
    ];
    // `resolveLetterForJob` answers the job's own letter here, so the filtered
    // form answered `undefined` and the caller offered nothing to inherit.
    expect(resolveLetterForJob(job("Northwind"), letters)?.scope).toBe("job");
    expect(inheritedLetterForJob(job("Northwind"), letters)).toEqual({
      letter: expect.objectContaining({ id: "standard" }),
      scope: "standard",
    });
  });

  it("never answers the job scope, even for a both-keyed record naming this job", () => {
    // A record carrying both keys is refused by the contract but the store does
    // not enforce it. It names a SPECIFIC posting, so it is not inheritable by
    // anyone — including the job it names, which reaches it as its own letter.
    const resolved = inheritedLetterForJob(job("Northwind"), [
      letter({ id: "both", jobId: "job-1", companyKey: "northwind" }),
    ]);
    expect(resolved).toBeUndefined();
  });

  it("keeps the chain's order — company beats a newer standard letter", () => {
    const resolved = inheritedLetterForJob(job("Northwind"), [
      letter({ id: "standard", updatedAt: 99 }),
      letter({ id: "company", companyKey: "northwind", updatedAt: 1 }),
    ]);
    expect(resolved?.scope).toBe("company");
  });

  it("skips the company rung for a job with no company to key on", () => {
    const resolved = inheritedLetterForJob(job("   "), [
      letter({ id: "company", companyKey: "northwind" }),
      letter({ id: "standard" }),
    ]);
    expect(resolved).toEqual({
      letter: expect.objectContaining({ id: "standard" }),
      scope: "standard",
    });
  });

  it("answers undefined when there is nothing to inherit", () => {
    expect(
      inheritedLetterForJob(job("Northwind"), [
        letter({ id: "own", jobId: "job-1" }),
      ]),
    ).toBeUndefined();
  });
});

/**
 * The rung's membership test, exported so the surfaces that WRITE the company
 * tier agree with the chain that READS it — without it, the reveal's company
 * offer forked a duplicate off the company's own letter (#767 review).
 */
describe("isCompanyLetter (#767 review)", () => {
  it("is true only for a general letter at that key", () => {
    expect(isCompanyLetter(letter({ id: "c", companyKey: "northwind" }), "northwind")).toBe(true);
  });

  it("is false for another company's letter", () => {
    expect(isCompanyLetter(letter({ id: "c", companyKey: "contoso" }), "northwind")).toBe(false);
  });

  it("is false for the standard letter, which has no key at all", () => {
    expect(isCompanyLetter(letter({ id: "s" }), "northwind")).toBe(false);
  });

  it("is false for a both-keyed record, which names one posting", () => {
    // Same reading `groupByScope` and the chain apply: a `jobId` makes it a job
    // letter whatever else it carries.
    expect(
      isCompanyLetter(
        letter({ id: "both", jobId: "job-1", companyKey: "northwind" }),
        "northwind",
      ),
    ).toBe(false);
  });
});
