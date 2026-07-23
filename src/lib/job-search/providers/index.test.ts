// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Registry contract for the keyless provider set (#319).
 *
 * `getProviders` / `KEYLESS_PROVIDERS` are consumed by `search.ts` through a
 * dynamic `await import()` (the cascade-tier chunk-splitting pattern), which the
 * static dead-code graph can't follow — so this suite is also their first
 * static importer, pinning the shipped registry: the three CORS-verified
 * keyless feeds, in display order, each satisfying the `JobProvider` contract.
 */

import { describe, it, expect } from "vitest";
import { KEYLESS_PROVIDERS, getProviders, makeCompanyProvider } from "./index.ts";
import type { CompanyEntry } from "../company-registry.ts";
import type { JobProvider } from "../types.ts";

describe("keyless provider registry", () => {
  it("ships the three CORS-verified feeds in display order", () => {
    expect(KEYLESS_PROVIDERS.map((p) => p.id)).toEqual([
      "remotive",
      "arbeitnow",
      "jobicy",
    ]);
  });

  it("every provider satisfies the JobProvider contract", () => {
    for (const provider of KEYLESS_PROVIDERS) {
      expect(typeof provider.id).toBe("string");
      expect(provider.id.length).toBeGreaterThan(0);
      expect(typeof provider.label).toBe("string");
      expect(provider.label.length).toBeGreaterThan(0);
      expect(typeof provider.search).toBe("function");
    }
  });

  it("getProviders with no companies resolves exactly the keyless set", () => {
    expect(getProviders()).toEqual(KEYLESS_PROVIDERS);
  });
});

describe("makeCompanyProvider (#533)", () => {
  function entry(ats: CompanyEntry["ats"]): CompanyEntry {
    return { name: "Acme Corp", ats, slug: "acme", sectors: ["fintech"] };
  }

  it.each([
    ["greenhouse", "greenhouse:acme"],
    ["lever", "lever:acme"],
    ["ashby", "ashby:acme"],
  ] as const)("dispatches %s to the matching adapter factory", (ats, id) => {
    expect(makeCompanyProvider(entry(ats)).id).toBe(id);
  });

  it("threads the display name through as the label, not the ATS vendor", () => {
    for (const ats of ["greenhouse", "lever", "ashby"] as const) {
      // The card must read "Acme Corp", never "Greenhouse · acme".
      expect(makeCompanyProvider(entry(ats)).label).toBe("Acme Corp");
    }
  });
});

describe("getProviders composition (#533)", () => {
  const company: JobProvider = {
    id: "greenhouse:acme",
    label: "Acme Corp",
    search: async () => [],
  };

  it("appends company providers after the always-on keyless feeds", () => {
    const resolved = getProviders([company]);
    expect(resolved.map((p) => p.id)).toEqual([
      "remotive",
      "arbeitnow",
      "jobicy",
      "greenhouse:acme",
    ]);
  });

  it("never drops a keyless feed, whatever the company selection", () => {
    for (const selection of [[], [company], [company, company]]) {
      const ids = getProviders(selection).map((p) => p.id);
      for (const keyless of KEYLESS_PROVIDERS) {
        expect(ids).toContain(keyless.id);
      }
    }
  });
});
