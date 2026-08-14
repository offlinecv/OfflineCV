// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the local test selector (#828).
 *
 * `decideSelection` is the whole gate — every path below it either runs vitest
 * or does not — and it only ever gets one thing wrong in a way that matters:
 * scoping a run that should have been full. So the assertions here are about
 * what it REFUSES to scope. Each case is a real input class that carries a
 * regression vitest's module graph cannot see: a fixture PDF and a JSON baseline
 * (read off disk, never imported), a deletion (absent from the graph it used to
 * be in), a lockfile (pdfjs-dist and pdf-lib both live behind it).
 *
 * The single "scoped" case is deliberately outnumbered. Under-running is the
 * failure mode with teeth; over-running only costs time.
 */

import { describe, expect, it } from "vitest";

import { decideSelection } from "./select-tests.mjs";

const mode = (changes) => decideSelection(changes).mode;

describe("decideSelection", () => {
  it("scopes when every change is added-or-modified TS under src/", () => {
    expect(
      mode([
        { status: "M", path: "src/lib/heuristics/openresume.ts" },
        { status: "A", path: "src/components/features/CritiquePanel.tsx" },
      ]),
    ).toBe("changed");
  });

  it("runs everything when a fixture PDF changes — the corpus reads it off disk, so the graph is blind to it", () => {
    expect(
      mode([{ status: "A", path: "tests/fixtures/pdfs/latex/new-persona.pdf" }]),
    ).toBe("full");
  });

  it("runs everything when a JSON baseline changes, for the same reason as the PDF", () => {
    expect(
      mode([
        { status: "M", path: "src/lib/heuristics/corpus-roundtrip.known-failures.json" },
      ]),
    ).toBe("full");
  });

  it("runs everything on a deletion — the dependents of a deleted module are not in the graph either", () => {
    expect(mode([{ status: "D", path: "src/lib/heuristics/sweep.ts" }])).toBe(
      "full",
    );
  });

  it("runs everything on a rename, which git reports with a similarity score", () => {
    expect(mode([{ status: "R096", path: "src/lib/score/score.ts" }])).toBe(
      "full",
    );
  });

  it("runs everything when the lockfile moves — pdfjs-dist and pdf-lib are behind it", () => {
    expect(mode([{ status: "M", path: "package-lock.json" }])).toBe("full");
  });

  it("runs everything for a change under scripts/, which is outside src/", () => {
    expect(mode([{ status: "M", path: "scripts/check-fixture-pii.mjs" }])).toBe(
      "full",
    );
  });

  it("runs everything when the range resolves to nothing, rather than becoming a no-op gate", () => {
    expect(mode([])).toBe("full");
  });

  it("runs everything when one path in an otherwise-scopable set disqualifies it", () => {
    expect(
      mode([
        { status: "M", path: "src/lib/heuristics/openresume.ts" },
        { status: "M", path: "vite.config.ts" },
      ]),
    ).toBe("full");
  });

  it("names the disqualifying path, so a full run is explainable rather than mysterious", () => {
    expect(
      decideSelection([{ status: "M", path: "vite.config.ts" }]).reason,
    ).toContain("vite.config.ts");
  });
});
