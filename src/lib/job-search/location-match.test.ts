// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  filterPostingsByLocation,
  isRemotePosting,
  locationMatches,
} from "./location-match.ts";

/** Minimal structural stub — the filter reads `location` and nothing else. */
function at(id: string, location: string) {
  return { id, location };
}

describe("locationMatches", () => {
  it("matches on the leading city token, so a feed's longer form still counts", () => {
    expect(locationMatches("Austin, TX", "Austin, TX, USA")).toBe(true);
  });

  it("matches either-direction substrings for postings that aren't 'City, ST'", () => {
    expect(locationMatches("Berlin", "Berlin Office")).toBe(true);
    expect(locationMatches("Greater Boston", "Boston")).toBe(true);
  });

  it("rejects a different city", () => {
    expect(locationMatches("Austin, TX", "Seattle, WA")).toBe(false);
  });

  it("rejects a same-named city in a different state or country (#905 review)", () => {
    expect(locationMatches("Portland, OR", "Portland, ME")).toBe(false);
    expect(locationMatches("Columbus, OH", "Columbus, GA")).toBe(false);
    expect(locationMatches("Kansas City, MO", "Kansas City, KS")).toBe(false);
    expect(locationMatches("San Jose, CA", "San Jose, Costa Rica")).toBe(false);
  });

  it("compares whole words, so a bare state code isn't a substring match", () => {
    expect(locationMatches("Austin, TX", "IN")).toBe(false);
    expect(locationMatches("Norwich, UK", "OR")).toBe(false);
  });

  it("keeps a city the feed spells one word longer", () => {
    expect(locationMatches("New York, NY", "New York City, NY")).toBe(true);
  });

  it("still matches when only one side names a state", () => {
    expect(locationMatches("Austin, TX", "Austin")).toBe(true);
    expect(locationMatches("Austin", "Austin, TX")).toBe(true);
  });

  it("folds a state code onto its name and a state into its country (#905 review)", () => {
    // Four same-city pairs the exact-equality qualifier check read as a
    // contradiction; all four match on `main`'s predicate and must keep doing so.
    expect(locationMatches("Austin, TX", "Austin, Texas")).toBe(true);
    expect(locationMatches("Austin, TX", "Austin, United States")).toBe(true);
    expect(locationMatches("Hyderabad, India", "Hyderabad, Telangana, India")).toBe(true);
    expect(locationMatches("United States", "Austin, United States")).toBe(true);
    // The fold does not loosen the state check: a spelled-out other state is
    // still the other state, and the country both sides imply does not rescue it.
    expect(locationMatches("Portland, OR", "Portland, Maine")).toBe(false);
    expect(locationMatches("Portland, OR, USA", "Portland, ME, USA")).toBe(false);
  });

  it("places a remote-only board's eligibility region (#905 review)", () => {
    // Remotive's `candidate_required_location` / Jobicy's `jobGeo` name where
    // the candidate must LIVE, not where the job is — and an Austin candidate
    // is eligible for all of these.
    for (const eligible of ["USA", "United States", "USA, Canada", "US"]) {
      expect(locationMatches("Austin, TX", eligible)).toBe(true);
    }
    // …and not for a region that does not contain them.
    expect(locationMatches("Austin, TX", "Europe")).toBe(false);
    expect(locationMatches("Austin, TX", "Canada")).toBe(false);
    expect(locationMatches("Toronto, Canada", "USA, Canada")).toBe(true);
    expect(locationMatches("Berlin, Germany", "Germany")).toBe(true);
  });

  it("matches a region-only query against the qualifiers of a posting (#905 review)", () => {
    expect(locationMatches("California", "San Jose, CA")).toBe(true);
    expect(locationMatches("CA", "San Jose, California")).toBe(true);
    expect(locationMatches("Telangana", "Hyderabad, Telangana, India")).toBe(true);
    expect(locationMatches("India", "Bangalore, India")).toBe(true);
    expect(locationMatches("Texas", "Portland, OR")).toBe(false);
    expect(locationMatches("India", "Indianapolis, IN")).toBe(false);
  });

  it("documents the limits of a vocabulary without a gazetteer", () => {
    // A bare state name reads as the state — "New York" keeps Buffalo. The
    // city is "New York, NY", which is what the résumé parser emits.
    expect(locationMatches("New York", "Buffalo, NY")).toBe(true);
    expect(locationMatches("New York, NY", "Buffalo, NY")).toBe(false);
    // A region-only posting cannot be placed for a query with no state/country.
    expect(locationMatches("Austin", "USA")).toBe(false);
    // Nothing here knows Berlin is in Europe.
    expect(locationMatches("Berlin, Germany", "Europe")).toBe(false);
  });

  it("reads an ISO country code the registry carries as that country (#905 review)", () => {
    expect(locationMatches("Paris, France", "Paris, FR")).toBe(true);
    expect(locationMatches("Amsterdam, Netherlands", "Amsterdam, NL")).toBe(true);
    expect(locationMatches("London, United Kingdom", "London, GB")).toBe(true);
    expect(locationMatches("Paris, TX", "Paris, FR")).toBe(false);
    // Known limit: a code that is also a USPS code is the US state first, so
    // Germany's "DE" is Delaware and India's "IN" is Indiana.
    expect(locationMatches("Berlin, Germany", "Berlin, DE")).toBe(false);
    expect(locationMatches("Bangalore, India", "Bangalore, IN")).toBe(false);
  });

  it("matches a multi-office posting on any of its offices (#905 review)", () => {
    expect(locationMatches("New York, NY", "San Francisco, CA; New York, NY")).toBe(true);
    expect(locationMatches("New York, NY", "San Francisco, CA | New York, NY")).toBe(true);
    expect(locationMatches("Austin, TX", "Dallas, TX; Austin, TX")).toBe(true);
    expect(locationMatches("Austin, TX", "Dallas, TX; Seattle, WA")).toBe(false);
    expect(locationMatches("Austin, TX", "Dallas, TX; Remote")).toBe(true);
  });

  it("counts every remote spelling as a match for any query location", () => {
    for (const remote of ["Remote", "Worldwide", "Anywhere", "WFH"]) {
      expect(isRemotePosting(remote)).toBe(true);
      expect(locationMatches("Austin, TX", remote)).toBe(true);
    }
  });

  it("treats an unstated posting location as no evidence, not as a match", () => {
    expect(locationMatches("Austin, TX", "")).toBe(false);
    expect(locationMatches("Austin, TX", "   ")).toBe(false);
  });
});

describe("filterPostingsByLocation (issue 809)", () => {
  it("keeps the whole set when no location is given — the toggle is inert", () => {
    const postings = [at("a", "Austin, TX"), at("b", "Seattle, WA")];
    expect(filterPostingsByLocation(postings, undefined)).toEqual({
      postings,
      suppressed: false,
    });
    expect(filterPostingsByLocation(postings, "  ")).toEqual({
      postings,
      suppressed: false,
    });
  });

  it("drops postings elsewhere and keeps local + remote ones", () => {
    const result = filterPostingsByLocation(
      [
        at("local", "Austin, TX, USA"),
        at("far", "Seattle, WA"),
        at("remote", "Remote"),
      ],
      "Austin, TX",
    );
    expect(result.postings.map((p) => p.id)).toEqual(["local", "remote"]);
    expect(result.suppressed).toBe(false);
  });

  it("keeps a remote-only board's eligibility regions the candidate sits in (#905 review)", () => {
    // The reviewer's simulated default set for an Austin candidate: three
    // keyless feeds plus a Greenhouse board. Before the registry fold this
    // dropped 7 of 11 and 6 of those were wrong.
    const result = filterPostingsByLocation(
      [
        at("remotive:1", "USA"),
        at("remotive:2", "Worldwide"),
        at("remotive:3", "USA, Canada"),
        at("remotive:4", "Anywhere"),
        at("jobicy:1", "USA"),
        at("jobicy:2", "Anywhere"),
        at("jobicy:3", "United States"),
        at("arbeitnow:1", "Berlin"),
        at("gh:1", "Austin, TX"),
        at("gh:2", "Austin, Texas"),
        at("gh:3", "Austin, United States"),
      ],
      "Austin, TX",
    );
    expect(result.postings.map((p) => p.id)).not.toContain("arbeitnow:1");
    expect(result.postings).toHaveLength(10);
    expect(result.suppressed).toBe(false);
  });

  it("keeps a posting whose feed stated no location — unknown is not far (#905 review)", () => {
    const result = filterPostingsByLocation(
      [at("local", "Austin, TX"), at("far", "Seattle, WA"), at("unstated", "")],
      "Austin, TX",
    );
    expect(result.postings.map((p) => p.id)).toEqual(["local", "unstated"]);
    expect(result.suppressed).toBe(false);
  });

  it("never fails closed: a set it would empty is kept whole and flagged", () => {
    const postings = [at("far", "Seattle, WA"), at("further", "Portland, ME")];
    const result = filterPostingsByLocation(postings, "Austin, TX");
    expect(result.postings.map((p) => p.id)).toEqual(["far", "further"]);
    expect(result.suppressed).toBe(true);
  });

  it("does not flag suppression for an already-empty input", () => {
    expect(filterPostingsByLocation([], "Austin, TX")).toEqual({
      postings: [],
      suppressed: false,
    });
  });
});
