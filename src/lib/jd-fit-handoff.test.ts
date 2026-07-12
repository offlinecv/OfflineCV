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
// present; the rest round-trips opaquely through JSON. `canonical.sections`
// carries the `byName` / `sectionHeadings` Maps the scorer reads, so the sample
// exercises the Map-preserving serialization (#450), not just field passthrough.
const samplePayload = {
  result: {
    canonical: {
      fields: { full_name: "Synthetic Persona" },
      sections: {
        byName: new Map<string, readonly string[]>([
          ["experience", ["Did a thing at Acme"]],
          ["skills", ["TypeScript", "React"]],
        ]),
        accomplishmentSections: ["experience"],
        source: "regex",
        sectionHeadings: new Map<string, string>([["skills", "SKILLS"]]),
      },
      fieldConfidence: { full_name: 0.9 },
    },
    rawText: "x",
  },
  score: { overall: 72 },
} as unknown as JdFitHandoff;

describe("jd-fit handoff round-trip (#226)", () => {
  it("writes then consumes the same payload", () => {
    writeJdFitHandoff(samplePayload);
    const got = consumeJdFitHandoff();
    expect(got).toEqual(samplePayload);
  });

  it("revives sections.byName / sectionHeadings as real Maps (#450)", () => {
    // Regression: `JSON.stringify` drops Map entries to `{}`, so the scorer's
    // `sections.byName.get(...)` used to throw on /jd-fit. The revived payload
    // must carry live Maps, not plain objects.
    writeJdFitHandoff(samplePayload);
    const got = consumeJdFitHandoff();
    const sections = got?.result.canonical.sections as unknown as {
      byName: Map<string, readonly string[]>;
      sectionHeadings: Map<string, string>;
    };
    expect(sections.byName).toBeInstanceOf(Map);
    expect(sections.byName.get("skills")).toEqual(["TypeScript", "React"]);
    expect(sections.sectionHeadings).toBeInstanceOf(Map);
    expect(sections.sectionHeadings.get("skills")).toBe("SKILLS");
  });

  it("rejects a payload whose byName did not round-trip as a Map (#450)", () => {
    // A naively-stringified payload (no Map sentinel) revives byName as a plain
    // object → guard rejects so the scorer never hits `.get is not a function`.
    globalThis.sessionStorage.setItem(
      JDFIT_HANDOFF_KEY,
      JSON.stringify({
        result: { canonical: { sections: { byName: {} } } },
        score: { overall: 50 },
      }),
    );
    expect(consumeJdFitHandoff()).toBeNull();
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
