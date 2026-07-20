// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { beforeEach, describe, expect, it } from "vitest";

import {
  _resetSectionRewriteLockForTesting,
  isSectionRewriteLocked,
  tryAcquireSectionRewriteLock,
} from "./useSectionRewriteLock.ts";

beforeEach(() => {
  _resetSectionRewriteLockForTesting();
});

describe("tryAcquireSectionRewriteLock", () => {
  it("starts unlocked", () => {
    expect(isSectionRewriteLocked()).toBe(false);
  });

  it("returns a release fn and flips isLocked", () => {
    const release = tryAcquireSectionRewriteLock();
    expect(release).not.toBeNull();
    expect(isSectionRewriteLocked()).toBe(true);
    release!();
    expect(isSectionRewriteLocked()).toBe(false);
  });

  it("two synchronous acquire calls — only the first succeeds (the real concurrency guarantee)", () => {
    // Simulates two onClick handlers fired in the same React batch.
    const first = tryAcquireSectionRewriteLock();
    const second = tryAcquireSectionRewriteLock();
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    first!();
    // After the first releases, a new acquire must succeed.
    const third = tryAcquireSectionRewriteLock();
    expect(third).not.toBeNull();
  });

  it("release is idempotent — double-release does not underflow", () => {
    const release = tryAcquireSectionRewriteLock();
    release!();
    release!();
    expect(isSectionRewriteLocked()).toBe(false);
    // Counter is at 0, not -1: a fresh acquire still succeeds.
    const again = tryAcquireSectionRewriteLock();
    expect(again).not.toBeNull();
  });

  it("does NOT leak the counter when the caller's body throws — `finally` release fires", () => {
    // Realistic call-site shape:
    //   const release = tryAcquireSectionRewriteLock();
    //   try { ...do work... } finally { release(); }
    // We assert the lock returns to unlocked even on a thrown error.
    expect(() => {
      const release = tryAcquireSectionRewriteLock();
      try {
        throw new Error("boom");
      } finally {
        release?.();
      }
    }).toThrow("boom");
    expect(isSectionRewriteLocked()).toBe(false);
  });

  it("flips isLocked synchronously with acquire/release", () => {
    expect(isSectionRewriteLocked()).toBe(false);
    const release = tryAcquireSectionRewriteLock();
    expect(isSectionRewriteLocked()).toBe(true);
    release!();
    expect(isSectionRewriteLocked()).toBe(false);
  });
});
