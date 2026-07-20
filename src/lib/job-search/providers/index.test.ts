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
import { KEYLESS_PROVIDERS, getProviders } from "./index.ts";

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

  it("getProviders resolves the keyless set today (the #320 seam)", () => {
    expect(getProviders()).toEqual(KEYLESS_PROVIDERS);
  });
});
