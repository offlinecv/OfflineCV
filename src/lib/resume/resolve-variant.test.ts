// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The résumé variant resolution chain (#770).
 *
 * Every case here is about ORDER and about what must NOT match — a wrong rung
 * exports a résumé tailored for a different employer, which the scope label
 * downstream cannot catch. Minimal typed stubs, per `contact.test.ts`: the
 * chain reads three fields, and the stubs carry an `id` only so assertions can
 * name which one came back.
 */

import { describe, it, expect } from "vitest";
import { isCompanyVariant, resolveVariantForJob } from "./resolve-variant.ts";
import type { VariantScopeKeys } from "./resolve-variant.ts";
import type { JobRecord } from "../storage/types.ts";

type Stub = VariantScopeKeys & { id: string };

const variant = (fields: Partial<Stub> & { id: string }): Stub => ({
  updatedAt: 1,
  ...fields,
});

const job = (company: string, id = "job-1"): Pick<JobRecord, "id" | "company"> => ({
  id,
  company,
});

/** The id of whatever the chain landed on, or `"base"` for the standard rung. */
function landed(resolved: ReturnType<typeof resolveVariantForJob<Stub>>): string {
  return resolved.scope === "standard" ? "base" : resolved.variant.id;
}

describe("resolveVariantForJob (#770)", () => {
  it("prefers the job's own variant over a company variant", () => {
    const resolved = resolveVariantForJob(job("Northwind"), [
      variant({ id: "company", companyKey: "northwind" }),
      variant({ id: "own", jobId: "job-1" }),
    ]);
    expect(resolved.scope).toBe("job");
    expect(landed(resolved)).toBe("own");
  });

  it("falls to the company variant when the job has none of its own", () => {
    const resolved = resolveVariantForJob(job("Northwind"), [
      variant({ id: "company", companyKey: "northwind" }),
      // Another job's variant at the same company must not be reachable.
      variant({ id: "other-job", jobId: "job-2" }),
    ]);
    expect(resolved.scope).toBe("company");
    expect(landed(resolved)).toBe("company");
  });

  it("falls to the base when no variant reaches the job", () => {
    const resolved = resolveVariantForJob(job("Northwind"), [
      variant({ id: "elsewhere", companyKey: "contoso" }),
      variant({ id: "other-job", jobId: "job-2" }),
    ]);
    expect(resolved).toEqual({ scope: "standard" });
  });

  it("resolves a résumé with no variants to the base", () => {
    expect(resolveVariantForJob(job("Northwind"), [])).toEqual({ scope: "standard" });
  });

  it("matches the company rung through the normaliser, not by raw name", () => {
    const resolved = resolveVariantForJob(job("  Northwind, Inc. "), [
      variant({ id: "company", companyKey: "northwind" }),
    ]);
    expect(resolved.scope).toBe("company");
  });

  it("NEVER resolves to a company variant for a job whose company is empty", () => {
    for (const blank of ["", "   ", "  ,  "]) {
      const resolved = resolveVariantForJob(job(blank), [
        variant({ id: "company", companyKey: "northwind" }),
      ]);
      expect(resolved).toEqual({ scope: "standard" });
    }
  });

  it("never inherits a variant that names another job, even at the same company", () => {
    const resolved = resolveVariantForJob(job("Northwind"), [
      variant({ id: "both", jobId: "job-2", companyKey: "northwind" }),
    ]);
    expect(resolved).toEqual({ scope: "standard" });
  });

  it("reads a both-keyed record as this job's own when the ids match", () => {
    const resolved = resolveVariantForJob(job("Northwind"), [
      variant({ id: "both", jobId: "job-1", companyKey: "northwind" }),
    ]);
    expect(resolved.scope).toBe("job");
    expect(landed(resolved)).toBe("both");
  });

  it("does not stack a job variant on its company variant", () => {
    // Flat over the base (#770): the answer is ONE delta, not a composition.
    const resolved = resolveVariantForJob(job("Northwind"), [
      variant({ id: "company", companyKey: "northwind" }),
      variant({ id: "own", jobId: "job-1" }),
    ]);
    expect(resolved).toEqual({
      scope: "job",
      variant: expect.objectContaining({ id: "own" }),
    });
  });

  it("picks the most recently updated variant within a rung", () => {
    const resolved = resolveVariantForJob(job("Northwind"), [
      variant({ id: "older", companyKey: "northwind", updatedAt: 1 }),
      variant({ id: "newer", companyKey: "northwind", updatedAt: 5 }),
    ]);
    expect(landed(resolved)).toBe("newer");
  });

  it("keeps the earlier variant on an updatedAt tie", () => {
    const resolved = resolveVariantForJob(job("Northwind"), [
      variant({ id: "first", jobId: "job-1", updatedAt: 3 }),
      variant({ id: "second", jobId: "job-1", updatedAt: 3 }),
    ]);
    expect(landed(resolved)).toBe("first");
  });
});

describe("isCompanyVariant (#770)", () => {
  it("accepts a company-keyed variant with no job", () => {
    expect(isCompanyVariant(variant({ id: "c", companyKey: "northwind" }), "northwind")).toBe(true);
  });

  it("rejects a different company, a job variant, and a both-keyed record", () => {
    expect(isCompanyVariant(variant({ id: "c", companyKey: "contoso" }), "northwind")).toBe(false);
    expect(isCompanyVariant(variant({ id: "j", jobId: "job-1" }), "northwind")).toBe(false);
    expect(
      isCompanyVariant(variant({ id: "b", jobId: "job-1", companyKey: "northwind" }), "northwind"),
    ).toBe(false);
  });
});
