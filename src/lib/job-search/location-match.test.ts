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

  it("never fails closed: a set it would empty is kept whole and flagged", () => {
    const postings = [at("far", "Seattle, WA"), at("unstated", "")];
    const result = filterPostingsByLocation(postings, "Austin, TX");
    expect(result.postings.map((p) => p.id)).toEqual(["far", "unstated"]);
    expect(result.suppressed).toBe(true);
  });

  it("does not flag suppression for an already-empty input", () => {
    expect(filterPostingsByLocation([], "Austin, TX")).toEqual({
      postings: [],
      suppressed: false,
    });
  });
});
