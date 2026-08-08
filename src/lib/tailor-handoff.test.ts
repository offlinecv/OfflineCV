// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect, beforeEach } from "vitest";
import {
  TAILOR_HANDOFF_KEY,
  writeTailorHandoff,
  consumeTailorHandoff,
} from "./tailor-handoff.ts";

// Vitest defaults to Node env (per vite.config.ts), where `sessionStorage`
// isn't defined. Provide a tiny in-memory shim so the handoff read/write/clear
// path has something real to drive.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  (globalThis as { sessionStorage?: Storage }).sessionStorage =
    new MemoryStorage() as unknown as Storage;
});

describe("tailor handoff (#576)", () => {
  it("round-trips a jdContext payload", () => {
    writeTailorHandoff({ jdContext: "Prefer wording that surfaces Kubernetes" });
    const got = consumeTailorHandoff();
    expect(got?.jdContext).toBe(
      "Prefer wording that surfaces Kubernetes",
    );
  });

  it("consumes the key so a reload falls back to the generic rewrite", () => {
    writeTailorHandoff({ jdContext: "some instruction" });
    expect(consumeTailorHandoff()).not.toBeNull();
    // Second read finds nothing — one-shot.
    expect(consumeTailorHandoff()).toBeNull();
    expect(globalThis.sessionStorage.getItem(TAILOR_HANDOFF_KEY)).toBeNull();
  });

  it("returns null for a missing key", () => {
    expect(consumeTailorHandoff()).toBeNull();
  });

  it("returns null for malformed JSON (not a re-arm)", () => {
    globalThis.sessionStorage.setItem(TAILOR_HANDOFF_KEY, "{not json");
    expect(consumeTailorHandoff()).toBeNull();
  });

  it("rejects a payload missing jdContext", () => {
    globalThis.sessionStorage.setItem(
      TAILOR_HANDOFF_KEY,
      JSON.stringify({ notContext: "x" }),
    );
    expect(consumeTailorHandoff()).toBeNull();
  });

  it("rejects an empty jdContext (nothing useful to steer with)", () => {
    globalThis.sessionStorage.setItem(
      TAILOR_HANDOFF_KEY,
      JSON.stringify({ jdContext: "" }),
    );
    expect(consumeTailorHandoff()).toBeNull();
  });

  it("does not throw when storage is inaccessible", () => {
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(() => writeTailorHandoff({ jdContext: "x" })).not.toThrow();
    expect(consumeTailorHandoff()).toBeNull();
  });
});
