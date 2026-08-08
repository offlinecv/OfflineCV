// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect, beforeEach } from "vitest";
import {
  TAILOR_HANDOFF_KEY,
  writeTailorHandoff,
  consumeTailorHandoff,
  fingerprintParse,
} from "./tailor-handoff.ts";
import type { HeuristicParsedResume } from "./heuristics/types.ts";

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

function parsed(title: string): HeuristicParsedResume {
  return {
    skills: [],
    experience: [{ title }],
    education: [],
  } as unknown as HeuristicParsedResume;
}

const RESUME_A = parsed("Platform Engineer");
const RESUME_B = parsed("Data Scientist");
const FP_A = fingerprintParse(RESUME_A);
const FP_B = fingerprintParse(RESUME_B);

beforeEach(() => {
  (globalThis as { sessionStorage?: Storage }).sessionStorage =
    new MemoryStorage() as unknown as Storage;
});

describe("fingerprintParse (#576)", () => {
  it("is stable for the same fields and differs across résumés", () => {
    expect(fingerprintParse(RESUME_A)).toBe(FP_A);
    expect(FP_A).not.toBe(FP_B);
  });

  it("survives the sessionStorage JSON round trip the handoff puts it through", () => {
    // `/jobs/` fingerprints the parse it received through `jobs-handoff`, i.e.
    // a JSON.parse of what `/` serialized — so the two sides only agree if a
    // round trip is identity for this function. If it were not, the tailor
    // flow would reject every handoff it ever wrote.
    const roundTripped = JSON.parse(
      JSON.stringify(RESUME_A),
    ) as HeuristicParsedResume;
    expect(fingerprintParse(roundTripped)).toBe(FP_A);
  });
});

describe("tailor handoff (#576)", () => {
  it("round-trips a jdContext payload", () => {
    writeTailorHandoff({
      jdContext: "Prefer wording that surfaces Kubernetes",
      parseFingerprint: FP_A,
    });
    const got = consumeTailorHandoff(FP_A);
    expect(got?.jdContext).toBe("Prefer wording that surfaces Kubernetes");
  });

  it("consumes the key so a reload falls back to the generic rewrite", () => {
    writeTailorHandoff({ jdContext: "some instruction", parseFingerprint: FP_A });
    expect(consumeTailorHandoff(FP_A)).not.toBeNull();
    // Second read finds nothing — one-shot.
    expect(consumeTailorHandoff(FP_A)).toBeNull();
    expect(globalThis.sessionStorage.getItem(TAILOR_HANDOFF_KEY)).toBeNull();
  });

  it("rejects a handoff stamped for a different résumé", () => {
    // The failure this guards: the user tailors against résumé A, but `/` is
    // not restored from bfcache (tab reloaded, résumé reset) and they drop
    // résumé B instead. One-shot alone would happily hand A's steering to B.
    writeTailorHandoff({ jdContext: "surface Kubernetes", parseFingerprint: FP_A });
    expect(consumeTailorHandoff(FP_B)).toBeNull();
  });

  it("clears a mismatched handoff rather than leaving it to ambush the next parse", () => {
    writeTailorHandoff({ jdContext: "surface Kubernetes", parseFingerprint: FP_A });
    expect(consumeTailorHandoff(FP_B)).toBeNull();
    expect(globalThis.sessionStorage.getItem(TAILOR_HANDOFF_KEY)).toBeNull();
    // And the résumé it WAS written for cannot pick it up later either — the
    // payload is gone, not merely skipped.
    expect(consumeTailorHandoff(FP_A)).toBeNull();
  });

  it("returns null for a missing key", () => {
    expect(consumeTailorHandoff(FP_A)).toBeNull();
  });

  it("returns null for malformed JSON (not a re-arm)", () => {
    globalThis.sessionStorage.setItem(TAILOR_HANDOFF_KEY, "{not json");
    expect(consumeTailorHandoff(FP_A)).toBeNull();
  });

  it("rejects a payload missing jdContext", () => {
    globalThis.sessionStorage.setItem(
      TAILOR_HANDOFF_KEY,
      JSON.stringify({ notContext: "x", parseFingerprint: FP_A }),
    );
    expect(consumeTailorHandoff(FP_A)).toBeNull();
  });

  it("rejects an empty jdContext (nothing useful to steer with)", () => {
    globalThis.sessionStorage.setItem(
      TAILOR_HANDOFF_KEY,
      JSON.stringify({ jdContext: "", parseFingerprint: FP_A }),
    );
    expect(consumeTailorHandoff(FP_A)).toBeNull();
  });

  it("rejects a payload with no fingerprint at all", () => {
    // A pre-fingerprint payload left over in a tab that was open across a
    // deploy: no stamp means nothing vouches for which résumé it belongs to,
    // so it is not usable steering.
    globalThis.sessionStorage.setItem(
      TAILOR_HANDOFF_KEY,
      JSON.stringify({ jdContext: "surface Kubernetes" }),
    );
    expect(consumeTailorHandoff(FP_A)).toBeNull();
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
    expect(() =>
      writeTailorHandoff({ jdContext: "x", parseFingerprint: FP_A }),
    ).not.toThrow();
    expect(consumeTailorHandoff(FP_A)).toBeNull();
  });
});
