// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Pins that `installMemoryLocalStorage` can overwrite a `localStorage` global
 * left in a hostile descriptor state by a previously-run suite.
 *
 * This is a cross-file regression, so it cannot be reproduced by running the
 * offending suites together — vitest's worker reuse decides whether the polluted
 * global is ever observed, which is why the original defect presented as a rare
 * flake in whichever unrelated file happened to run next. These tests recreate
 * the two end states directly instead of trying to provoke the interleaving.
 */

import { describe, it, expect, afterEach } from "vitest";
import { installMemoryLocalStorage } from "./memory-storage.ts";

// Every test here deliberately corrupts the global; hand the next test a clean
// one rather than relying on the workload-wide `beforeEach` to survive it.
afterEach(() => {
  installMemoryLocalStorage();
});

describe("installMemoryLocalStorage — survives a polluted global (#398)", () => {
  it("overwrites a non-writable data property", () => {
    // The shape `Object.defineProperty(globalThis, "localStorage", { value })`
    // leaves behind when the property did not already exist: omitting
    // `writable` defaults it to false, so a plain assignment throws
    // "Cannot assign to read only property".
    delete (globalThis as { localStorage?: unknown }).localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: { getItem: () => "poisoned" },
      configurable: true,
    });
    expect(
      Object.getOwnPropertyDescriptor(globalThis, "localStorage")?.writable,
    ).toBe(false);

    expect(() => installMemoryLocalStorage()).not.toThrow();

    localStorage.setItem("k", "v");
    expect(localStorage.getItem("k")).toBe("v");
  });

  it("overwrites a getter-only accessor", () => {
    // The shape a suite faking a hostile/private-mode storage leaves behind.
    // An accessor with no setter rejects assignment too, with a different
    // message ("which has only a getter") — so a fix that handled only the
    // read-only data property would still leave this path broken.
    delete (globalThis as { localStorage?: unknown }).localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      get: () => {
        throw new Error("SecurityError: storage disabled");
      },
      configurable: true,
    });

    expect(() => installMemoryLocalStorage()).not.toThrow();

    localStorage.setItem("k", "v");
    expect(localStorage.getItem("k")).toBe("v");
  });

  it("hands each caller a storage that starts empty", () => {
    localStorage.setItem("stale", "1");
    installMemoryLocalStorage();
    expect(localStorage.getItem("stale")).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});
