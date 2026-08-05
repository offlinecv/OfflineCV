// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * letter-egress-ack (#715). The module is four lines of `try`/`catch`, and the
 * whole point is what happens in the `catch` — so the HOSTILE-STORAGE path is
 * the case worth pinning, not the happy one.
 *
 * FAIL CLOSED is the contract its docblock asserts: when `localStorage` is
 * unavailable (Safari private browsing, a blocked-storage policy, a full
 * quota), `hasAcknowledgedLetterEgress()` must answer FALSE and
 * `recordLetterEgressAcknowledged()` must not throw. False means the
 * acknowledgement dialog reappears — annoying, and the safe direction; true, or
 * a throw out of a click handler, would either skip the disclosure entirely or
 * take the Saved jobs row down with it.
 *
 * Both accessors read `globalThis.localStorage` fresh on every call (see the
 * module docblock on why nothing caches it), which is what makes swapping the
 * property per test a faithful stand-in for a hostile browser.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  hasAcknowledgedLetterEgress,
  recordLetterEgressAcknowledged,
} from "./letter-egress-ack.ts";

const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function useStorage(get: () => Storage | undefined) {
  Object.defineProperty(globalThis, "localStorage", {
    get,
    configurable: true,
  });
}

afterEach(() => {
  // `real` is captured at module-eval time, before any `beforeEach` has run, so
  // it is `undefined` whenever this file is the first in its worker to touch
  // `localStorage`. Deleting rather than leaving the getter in place matters:
  // the accessor `useStorage` installs has no setter, so anything that survives
  // this hook breaks the next assignment to the global.
  if (real) Object.defineProperty(globalThis, "localStorage", real);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
  globalThis.localStorage?.clear();
});

describe("letter-egress-ack — the working case", () => {
  it("is false until recorded, then true", () => {
    expect(hasAcknowledgedLetterEgress()).toBe(false);
    recordLetterEgressAcknowledged();
    expect(hasAcknowledgedLetterEgress()).toBe(true);
  });

  it("is idempotent — recording twice is still one acknowledgement", () => {
    recordLetterEgressAcknowledged();
    recordLetterEgressAcknowledged();
    expect(hasAcknowledgedLetterEgress()).toBe(true);
  });

  it("does not read some other key's value as an acknowledgement", () => {
    localStorage.setItem("offlinecv:letters:something-else", "1");
    expect(hasAcknowledgedLetterEgress()).toBe(false);
  });
});

describe("letter-egress-ack — hostile storage fails CLOSED", () => {
  it("answers false when reading localStorage THROWS", () => {
    // Safari with cookies/storage blocked: the property access itself throws
    // `SecurityError` before any method is called, so the optional chaining in
    // the module is not what saves it — the `try` is.
    useStorage(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(hasAcknowledgedLetterEgress()).toBe(false);
  });

  it("does not throw when WRITING to a throwing localStorage", () => {
    useStorage(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => recordLetterEgressAcknowledged()).not.toThrow();
  });

  it("answers false when getItem itself throws", () => {
    useStorage(() => ({
      getItem() {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem() {},
    }) as unknown as Storage);
    expect(hasAcknowledgedLetterEgress()).toBe(false);
  });

  it("does not throw when setItem rejects the write (quota exceeded)", () => {
    useStorage(() => ({
      getItem: () => null,
      setItem() {
        throw new DOMException("quota", "QuotaExceededError");
      },
    }) as unknown as Storage);
    expect(() => recordLetterEgressAcknowledged()).not.toThrow();
  });

  it("answers false when there is no localStorage at all", () => {
    // A non-browser or stripped-down global — the optional-chaining branch.
    useStorage(() => undefined);
    expect(hasAcknowledgedLetterEgress()).toBe(false);
    expect(() => recordLetterEgressAcknowledged()).not.toThrow();
  });

  it("still asks again on the NEXT session after a write silently failed", () => {
    // The end-to-end shape of the defect the "confirm once" copy had to be
    // softened for: the user clicks "Got it", the write is swallowed, and the
    // dialog is back next time. Pinned so the copy and the code agree.
    useStorage(() => ({
      getItem: () => null,
      setItem() {
        throw new DOMException("quota", "QuotaExceededError");
      },
    }) as unknown as Storage);
    recordLetterEgressAcknowledged();
    expect(hasAcknowledgedLetterEgress()).toBe(false);
  });
});
