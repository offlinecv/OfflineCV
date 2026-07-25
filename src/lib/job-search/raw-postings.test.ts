// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The snapshot arithmetic behind the asymmetric company selector: removing a
 * company target must be free and exact, and adding one must not duplicate a
 * posting the original fan-out already admitted.
 */

import { describe, it, expect } from "vitest";
import {
  dedupKey,
  dropCompanyPostings,
  mergeRawPostings,
} from "./raw-postings.ts";
import type { JobPosting } from "./types.ts";

function posting(id: string, title: string, company: string): JobPosting {
  return {
    id,
    title,
    company,
    location: "Remote",
    url: "https://example.com/job",
    description: "",
    source: id.split(":")[0],
  };
}

describe("dedupKey", () => {
  it("collapses case and whitespace differences between feeds", () => {
    expect(dedupKey(posting("a:1", "Staff  Engineer ", "Acme"))).toBe(
      dedupKey(posting("b:2", "staff engineer", "acme")),
    );
  });

  it("normalizes the fields independently, so the join can't shift", () => {
    // "ab" + "" must not collide with "a" + "b".
    expect(dedupKey(posting("a:1", "ab", ""))).not.toBe(
      dedupKey(posting("a:2", "a", "b")),
    );
  });
});

describe("mergeRawPostings", () => {
  it("appends only the postings that are new", () => {
    const existing = [posting("remotive:1", "SRE", "Acme")];
    const merged = mergeRawPostings(existing, [
      posting("greenhouse:acme:9", "sre", "ACME"),
      posting("greenhouse:acme:10", "Platform Engineer", "Acme"),
    ]);
    expect(merged.map((p) => p.id)).toEqual([
      "remotive:1",
      "greenhouse:acme:10",
    ]);
  });

  it("keeps the existing copy of a duplicate, not the incoming one", () => {
    // The existing copy may already be hydrated and already ranked on screen.
    const existing = [
      { ...posting("remotive:1", "SRE", "Acme"), description: "hydrated" },
    ];
    const merged = mergeRawPostings(existing, [posting("lever:acme:2", "SRE", "Acme")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe("hydrated");
  });

  it("dedups within the incoming batch too", () => {
    const merged = mergeRawPostings([], [
      posting("greenhouse:a:1", "SRE", "Acme"),
      posting("greenhouse:b:1", "SRE", "Acme"),
    ]);
    expect(merged).toHaveLength(1);
  });

  it("does not mutate either input", () => {
    const existing = [posting("remotive:1", "SRE", "Acme")];
    mergeRawPostings(existing, [posting("lever:x:2", "PM", "Other")]);
    expect(existing).toHaveLength(1);
  });
});

describe("dropCompanyPostings", () => {
  const raw = [
    posting("remotive:1", "SRE", "Acme"),
    posting("greenhouse:acme:9", "SRE", "Acme Corp"),
    posting("lever:acme-labs:3", "SRE", "Acme Labs"),
  ];

  it("removes only the named company's board postings", () => {
    expect(dropCompanyPostings(raw, ["greenhouse:acme"]).map((p) => p.id)).toEqual([
      "remotive:1",
      "lever:acme-labs:3",
    ]);
  });

  it("does not let one slug strip a longer slug that starts with it", () => {
    // The prefix must be `lever:acme:`, not `lever:acme` — otherwise
    // deselecting `lever:acme` would silently drop `lever:acme-labs` too.
    expect(dropCompanyPostings(raw, ["lever:acme"]).map((p) => p.id)).toContain(
      "lever:acme-labs:3",
    );
  });

  it("never touches keyless-feed postings", () => {
    const kept = dropCompanyPostings(raw, [
      "greenhouse:acme",
      "lever:acme-labs",
    ]);
    expect(kept.map((p) => p.id)).toEqual(["remotive:1"]);
  });

  it("is a copy, not the same array, when nothing is removed", () => {
    const kept = dropCompanyPostings(raw, []);
    expect(kept).toEqual(raw);
    expect(kept).not.toBe(raw);
  });
});
