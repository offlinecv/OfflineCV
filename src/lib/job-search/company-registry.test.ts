// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { COMPANY_REGISTRY, companiesForSector } from "./company-registry.ts";
import { SECTORS, isSector } from "./sector.ts";
import type { Ats } from "./company-registry.ts";

const VALID_ATS: readonly Ats[] = ["greenhouse", "lever", "ashby"];

describe("COMPANY_REGISTRY", () => {
  it("tags every entry with a supported ats vendor", () => {
    for (const entry of COMPANY_REGISTRY) {
      expect(VALID_ATS).toContain(entry.ats);
    }
  });

  it("tags every entry's sectors with values from the slice-3 taxonomy", () => {
    for (const entry of COMPANY_REGISTRY) {
      expect(entry.sectors.length).toBeGreaterThan(0);
      for (const sector of entry.sectors) {
        expect(isSector(sector)).toBe(true);
      }
    }
  });

  it("has a non-empty name and slug on every entry", () => {
    for (const entry of COMPANY_REGISTRY) {
      expect(entry.name.trim().length).toBeGreaterThan(0);
      expect(entry.slug.trim().length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate (ats, slug) pairs", () => {
    const seen = new Set<string>();
    for (const entry of COMPANY_REGISTRY) {
      const key = `${entry.ats}:${entry.slug}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("seeds ~150-250 companies", () => {
    expect(COMPANY_REGISTRY.length).toBeGreaterThanOrEqual(150);
    expect(COMPANY_REGISTRY.length).toBeLessThanOrEqual(250);
  });

  it("populates every non-'other' sector with at least one company", () => {
    for (const sector of SECTORS) {
      if (sector === "other") continue;
      const count = COMPANY_REGISTRY.filter((e) => e.sectors.includes(sector)).length;
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("companiesForSector", () => {
  it("returns at most `limit` entries, all tagged with the requested sector", () => {
    const results = companiesForSector("fintech", 5);
    expect(results.length).toBeLessThanOrEqual(5);
    for (const entry of results) {
      expect(entry.sectors).toContain("fintech");
    }
  });

  it("returns entries in deterministic order across repeated calls", () => {
    const first = companiesForSector("devtools", 10);
    const second = companiesForSector("devtools", 10);
    expect(second.map((e) => e.slug)).toEqual(first.map((e) => e.slug));
  });

  it("returns an empty array for a sector with a limit of 0", () => {
    expect(companiesForSector("fintech", 0)).toEqual([]);
  });

  it("returns fewer than `limit` when the sector has fewer matches", () => {
    const results = companiesForSector("government-defense", 1000);
    expect(results.length).toBeLessThan(1000);
    expect(results.length).toBeGreaterThan(0);
  });
});
