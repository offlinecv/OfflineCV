// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect, beforeEach } from "vitest";
import {
  JDFIT_HANDOFF_KEY,
  writeJdFitHandoff,
  consumeJdFitHandoff,
  type JdFitHandoff,
} from "./jd-fit-handoff.ts";

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

// Minimal handoff payload — only the fields the shape-guard checks need to be
// present; the rest round-trips opaquely through JSON.
const samplePayload = {
  result: { parsed: { full_name: "Synthetic Persona" }, rawText: "x" },
  score: { overall: 72 },
} as unknown as JdFitHandoff;

describe("jd-fit handoff round-trip (#226)", () => {
  it("writes then consumes the same payload", () => {
    writeJdFitHandoff(samplePayload);
    const got = consumeJdFitHandoff();
    expect(got).toEqual(samplePayload);
  });

  it("is one-shot — a second consume returns null", () => {
    writeJdFitHandoff(samplePayload);
    expect(consumeJdFitHandoff()).not.toBeNull();
    expect(consumeJdFitHandoff()).toBeNull();
  });

  it("clears the key on consume", () => {
    writeJdFitHandoff(samplePayload);
    consumeJdFitHandoff();
    expect(globalThis.sessionStorage.getItem(JDFIT_HANDOFF_KEY)).toBeNull();
  });

  it("returns null when nothing was written", () => {
    expect(consumeJdFitHandoff()).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    globalThis.sessionStorage.setItem(JDFIT_HANDOFF_KEY, "{not json");
    expect(consumeJdFitHandoff()).toBeNull();
  });

  it("returns null for a structurally-incomplete payload", () => {
    // Missing result.parsed / score → shape guard rejects, falls back to DropZone.
    globalThis.sessionStorage.setItem(
      JDFIT_HANDOFF_KEY,
      JSON.stringify({ result: {} }),
    );
    expect(consumeJdFitHandoff()).toBeNull();
  });

  it("does not throw when sessionStorage is unavailable", () => {
    (globalThis as { sessionStorage?: Storage }).sessionStorage =
      undefined as unknown as Storage;
    expect(() => writeJdFitHandoff(samplePayload)).not.toThrow();
    expect(consumeJdFitHandoff()).toBeNull();
  });
});
