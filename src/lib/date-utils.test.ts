// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timeAgo } from "./date-utils.ts";

const NOW = new Date("2026-06-15T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("timeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns '' for empty / nullish input", () => {
    expect(timeAgo("")).toBe("");
    expect(timeAgo(null)).toBe("");
    expect(timeAgo(undefined)).toBe("");
  });

  it("returns '' for an unparseable date", () => {
    expect(timeAgo("not-a-date")).toBe("");
  });

  it("returns '' for a future date (clock skew)", () => {
    expect(timeAgo(new Date(NOW.getTime() + HOUR).toISOString())).toBe("");
  });

  it("renders 'now' under a minute", () => {
    expect(timeAgo(ago(30 * SEC))).toBe("now");
  });

  it("renders minutes", () => {
    expect(timeAgo(ago(7 * MIN))).toBe("7m ago");
    expect(timeAgo(ago(59 * MIN))).toBe("59m ago");
  });

  it("renders hours", () => {
    expect(timeAgo(ago(2 * HOUR))).toBe("2h ago");
    expect(timeAgo(ago(23 * HOUR))).toBe("23h ago");
  });

  it("renders days", () => {
    expect(timeAgo(ago(4 * DAY))).toBe("4d ago");
    expect(timeAgo(ago(29 * DAY))).toBe("29d ago");
  });

  it("renders months", () => {
    expect(timeAgo(ago(60 * DAY))).toBe("2mo ago");
  });

  it("renders an absolute date past ~12 months, with the year when it differs", () => {
    // ~14 months back from 2026-06-15 → 2025 → includes the year.
    expect(timeAgo("2025-04-05T12:00:00Z")).toBe("Apr 5, 2025");
  });
});
