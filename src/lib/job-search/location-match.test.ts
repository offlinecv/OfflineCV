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
