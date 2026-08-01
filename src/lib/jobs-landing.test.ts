// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * #707: the losing case matters as much as the winning one — a plain
 * `/jobs/` visit (no param) must still land on Search, or every existing
 * deep link and the FindJobsLauncher navigation would silently start
 * defaulting to the wrong tab.
 */

import { describe, it, expect } from "vitest";
import { resolveInitialJobsTab, savedJobsHref } from "./jobs-landing.ts";

describe("resolveInitialJobsTab", () => {
  it("lands on search when the param is absent", () => {
    expect(resolveInitialJobsTab("")).toBe("search");
  });

  it("lands on search for an unrelated query string", () => {
    expect(resolveInitialJobsTab("?foo=bar")).toBe("search");
  });

  it("lands on search for an unrecognized tab value", () => {
    expect(resolveInitialJobsTab("?tab=bogus")).toBe("search");
  });

  it("lands on library when tab=library", () => {
    expect(resolveInitialJobsTab("?tab=library")).toBe("library");
  });

  it("lands on library alongside other params", () => {
    expect(resolveInitialJobsTab("?foo=bar&tab=library")).toBe("library");
  });

  it("lands on search when the hash is absent (default param covers it)", () => {
    expect(resolveInitialJobsTab("")).toBe("search");
  });

  it("lands on search for an unrecognized hash", () => {
    expect(resolveInitialJobsTab("", "#bogus")).toBe("search");
  });

  it("lands on library for the #saved direct link (#715)", () => {
    expect(resolveInitialJobsTab("", "#saved")).toBe("library");
  });

  it("the #saved hash wins even alongside an unrelated query string", () => {
    expect(resolveInitialJobsTab("?foo=bar", "#saved")).toBe("library");
  });

  it.each(["#Saved", "#SAVED", "#saved?x=1", "#saved&utm=chat", "#saved/1"])(
    "matches %s — the fragment is hand-typed and re-pasted, so case and a tail must not miss",
    (hash) => {
      expect(resolveInitialJobsTab("", hash)).toBe("library");
    },
  );

  it("does NOT match a different anchor that merely starts the same way", () => {
    // Leniency is about DECORATION on the name, not about the name itself.
    expect(resolveInitialJobsTab("", "#savedjobs")).toBe("search");
    expect(resolveInitialJobsTab("", "#saved-search")).toBe("search");
  });

  it("treats a bare '#' and an empty hash as no hash at all", () => {
    expect(resolveInitialJobsTab("", "#")).toBe("search");
    expect(resolveInitialJobsTab("", "")).toBe("search");
  });
});

describe("savedJobsHref", () => {
  it("builds a base-aware URL landing on Saved jobs", () => {
    expect(savedJobsHref()).toBe(`${import.meta.env.BASE_URL}jobs/?tab=library`);
  });
});
