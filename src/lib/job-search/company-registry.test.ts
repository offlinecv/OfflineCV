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

  /**
   * The original #532 list was 162 hand-curated, unverified entries and
   * asserted 150–250. The #533 existence audit fetched every one of them and
   * removed the 48 whose board could not be found on any supported vendor, so
   * the floor drops to ~100. Deliberately NOT re-pinned to exactly 114: entries
   * will be pruned and added as boards churn, and a hard equality here would
   * turn every routine refresh into a test edit.
   */
  it("seeds ~100-250 companies", () => {
    expect(COMPANY_REGISTRY.length).toBeGreaterThanOrEqual(100);
    expect(COMPANY_REGISTRY.length).toBeLessThanOrEqual(250);
  });

  /**
   * The audit pruned unevenly across sectors, so this guards the property that
   * actually matters after a prune: `companiesForSector` must never hand the
   * #533 fan-out an empty set for a sector the classifier can return. A bare
   * ">= 1" would pass with a single company — too thin to be a useful search.
   */
  it("leaves every non-'other' sector with enough companies to search", () => {
    const MIN_PER_SECTOR = 5;
    // Collect the shortfalls rather than asserting in the loop, so a failure
    // names the starved sector instead of just "expected 3 to be >= 5".
    const starved = SECTORS.filter(
      (sector) =>
        sector !== "other" &&
        COMPANY_REGISTRY.filter((e) => e.sectors.includes(sector)).length <
          MIN_PER_SECTOR,
    );
    expect(starved).toEqual([]);
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

  /**
   * #542 raised `COMPANY_LIMIT` (`useCompanyTargets.ts`) from 8 to 14 — the
   * largest per-sector count the registry has today (fintech, devtools). This
   * guards the premise: if a future prune shrinks every sector back under 8,
   * the cap raise silently stops mattering and nobody would notice.
   */
  it("has at least one sector with 14 or more entries, justifying the #542 cap", () => {
    const withFourteenOrMore = SECTORS.filter(
      (sector) =>
        sector !== "other" &&
        COMPANY_REGISTRY.filter((e) => e.sectors.includes(sector)).length >= 14,
    );
    expect(withFourteenOrMore.length).toBeGreaterThan(0);
  });
});
