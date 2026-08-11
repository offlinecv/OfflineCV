// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Guards the MODULE-SCOPE half of `src/test-setup.ts` (#779).
 *
 * The `beforeEach` half needs no guard: every suite that reads `localStorage`
 * inside a test would fail loudly without it. The module-scope install is the
 * one that is invisible when it breaks — it only matters to a suite that reads
 * the global while its own module body is evaluating, which is rare enough that
 * the gap survived #398 and resurfaced in a file written after it.
 *
 * So the capture below is deliberately at module scope, not in a hook. It runs
 * at the exact moment `letter-egress-ack.test.ts` reads the descriptor it later
 * restores, and it is the moment that was broken: without the module-scope
 * install, this file sees Node 22+'s built-in `localStorage` accessor — whose
 * getter yields no usable `Storage` absent `--localstorage-file` — instead of
 * the shim. A suite that captures that and restores it afterwards clobbers the
 * working global for itself and for every test after it in the same worker.
 *
 * This file is why a NEW suite cannot reintroduce #779 by copying that
 * (entirely reasonable) save/restore pattern.
 */

import { describe, expect, it } from "vitest";

/** Captured at module scope, before any `beforeEach` has run — see above. */
const atImportTime = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

describe("test-setup provisions localStorage before test modules evaluate (#779)", () => {
  it("has already installed it by the time a test module body runs", () => {
    expect(atImportTime).toBeDefined();
  });

  it("is a data property, not Node's built-in accessor", () => {
    // The built-in is `{ get, set }`; the shim is `{ value, writable }`. This is
    // the discriminator — on the built-in, `.value` is undefined and every
    // `Storage` method is missing.
    expect(atImportTime?.get).toBeUndefined();
    expect(atImportTime?.value).toBeDefined();
  });

  it("exposes a working Storage, not one whose methods are absent", () => {
    const storage = atImportTime?.value as Storage | undefined;
    expect(typeof storage?.clear).toBe("function");
    expect(typeof storage?.setItem).toBe("function");
    expect(typeof storage?.getItem).toBe("function");
  });

  it("is configurable, so a suite may swap it and put it back", () => {
    expect(atImportTime?.configurable).toBe(true);
  });

  it("survives the capture/swap/restore cycle a hostile-storage suite performs", () => {
    // Exactly `letter-egress-ack.test.ts`'s shape: install a hostile accessor,
    // then restore the captured descriptor and use the global again. Before the
    // module-scope install this threw `localStorage.clear is not a function`,
    // because what got restored was the built-in accessor rather than the shim.
    // Guard before the swap, not after: with the module-scope install missing,
    // `atImportTime` is `undefined` and the restore below throws "Property
    // description must be an object" — naming this test's own scaffolding
    // instead of the defect it exists to report, and leaving the hostile
    // accessor installed for the rest of the case.
    expect(atImportTime).toBeDefined();

    Object.defineProperty(globalThis, "localStorage", {
      get: () => undefined,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", atImportTime!);

    expect(() => globalThis.localStorage.clear()).not.toThrow();
    globalThis.localStorage.setItem("ocv_probe", "1");
    expect(globalThis.localStorage.getItem("ocv_probe")).toBe("1");
  });
});
