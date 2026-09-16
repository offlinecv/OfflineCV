// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";
import {
  countryCodeForToken,
  countryDisplayName,
  isoCountryForBareCode,
  isUsStateToken,
  usStateName,
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

  it("folds a USPS code and its spelled-out name onto one state name", () => {
    expect(usStateName("TX")).toBe("texas");
    expect(usStateName(" Texas ")).toBe("texas");
    expect(usStateName("dc")).toBe("district of columbia");
    expect(usStateName("District of Columbia")).toBe("district of columbia");
    // Not a state: a country, a city, a Canadian province code.
    expect(usStateName("India")).toBeUndefined();
    expect(usStateName("Austin")).toBeUndefined();
    expect(usStateName("ON")).toBeUndefined();
    // Not a state either: an `Object.prototype` member the table never declared.
    expect(usStateName("constructor")).toBeUndefined();
    expect(isUsStateToken("constructor")).toBe(false);
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

  it("resolves a bare alpha-2 only when no state or province claims it (#905 review)", () => {
    expect(isoCountryForBareCode("FR")).toBe("FR");
    expect(isoCountryForBareCode(" gb ")).toBe("GB");
    expect(isoCountryForBareCode("JP")).toBe("JP");
    // US states first, as everywhere else in this file.
    expect(isoCountryForBareCode("CA")).toBeUndefined();
    expect(isoCountryForBareCode("IN")).toBeUndefined();
    expect(isoCountryForBareCode("DE")).toBeUndefined();
    // Canadian, Australian and Indian subnational codes that spell like a
    // country — the collision the forward table's omission exists to prevent.
    expect(isoCountryForBareCode("NL")).toBeUndefined();
    expect(isoCountryForBareCode("PE")).toBeUndefined();
    expect(isoCountryForBareCode("SA")).toBeUndefined();
    expect(isoCountryForBareCode("BR")).toBeUndefined();
    expect(isoCountryForBareCode("TR")).toBeUndefined();
    // Not two letters, or not a code we carry.
    expect(isoCountryForBareCode("USA")).toBeUndefined();
    expect(isoCountryForBareCode("XX")).toBeUndefined();
  });
});
