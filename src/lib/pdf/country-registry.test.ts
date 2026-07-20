// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";
import {
  countryCodeForToken,
  countryDisplayName,
  isUsStateToken,
} from "./country-registry.ts";

// These pin the deliberate 2-letter ambiguity carve-out (#429): the forward
// table carries NO bare alpha-2 keys, so a résumé's "San Francisco, CA" resolves
// as California (a US state / region), never as Canada. A future contributor who
// adds `aliases: ["CA"]` to the Canada row — reintroducing the collision the
// docstring warns against — makes the first assertion below fail loudly.
describe("country-registry — CA-ambiguity invariant", () => {
  it("does NOT resolve a bare 2-letter US-state token to a country", () => {
    // "CA" (California), "GA" (Georgia), "IN" (Indiana) are US states, not
    // Canada / Gabon / India on the forward path.
    expect(countryCodeForToken("CA")).toBeUndefined();
    expect(countryCodeForToken("GA")).toBeUndefined();
    expect(countryCodeForToken("IN")).toBeUndefined();
  });

  it("treats those same tokens as US states", () => {
    expect(isUsStateToken("CA")).toBe(true);
    expect(isUsStateToken("GA")).toBe(true);
    expect(isUsStateToken("IN")).toBe(true);
  });

  it("resolves the spelled-out country name and unambiguous short forms", () => {
    expect(countryCodeForToken("Canada")).toBe("CA");
    expect(countryCodeForToken("USA")).toBe("US");
    expect(countryCodeForToken("United States")).toBe("US");
    expect(countryCodeForToken("UK")).toBe("GB");
  });

  it("reverse-maps an alpha-2 code to its ONE canonical display name", () => {
    expect(countryDisplayName("CA")).toBe("Canada");
    expect(countryDisplayName("US")).toBe("USA");
    expect(countryDisplayName("GB")).toBe("UK");
  });
});
