// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `scrollToSection` and the motion preference it has to consult itself.
 *
 * #823 gave this helper four call sites that previously involved no scroll at
 * all — the journey rail's Fix-it and Tailor stages, `ResumeQualityPanel`'s "go
 * to rewrite", and a consumed tailor handoff. Two of those run
 * `useJourneyGuidance`'s `scrollToJourney` in the SAME click, which already
 * reads the preference in JS. A hard-coded `behavior: "smooth"` here therefore
 * gave one user preference two answers on one click: an instant jump to the
 * top, then a full page-length animation down. The CSS cascade cannot fix it —
 * `scroll-behavior` does not reach a `behavior` passed to `scrollIntoView`, and
 * `styles.css` sets none anyway.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  SECTION_IDS,
  SCORE_TILE_SECTION_IDS,
  scrollToSection,
  prefersReducedMotion,
  type ScoreTileAnchor,
  type SectionAnchor,
} from "./anchors.ts";

/** Install a `matchMedia` that answers the reduced-motion query as given. */
function withReducedMotion(reduced: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion") && reduced,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

/** A target with the id `scrollToSection` looks up, plus a spy on its scroll. */
function target(): ReturnType<typeof vi.fn> {
  const el = document.createElement("div");
  el.id = SECTION_IDS.reconstructed;
  document.body.appendChild(el);
  const spy = vi.fn();
  el.scrollIntoView = spy;
  return spy;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("scrollToSection", () => {
  it("animates by default", () => {
    withReducedMotion(false);
    const spy = target();
    scrollToSection(SECTION_IDS.reconstructed);
    expect(spy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("jumps instantly when the user asked for less motion", () => {
    withReducedMotion(true);
    const spy = target();
    scrollToSection(SECTION_IDS.reconstructed);
    expect(spy).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });

  it("does not throw when the section is absent", () => {
    withReducedMotion(false);
    expect(() => scrollToSection(SECTION_IDS.contact)).not.toThrow();
  });
});

describe("prefersReducedMotion", () => {
  it("answers false where matchMedia does not exist (jsdom, embedded views)", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("SCORE_TILE_SECTION_IDS vs SECTION_IDS partition (#973)", () => {
  it("keeps documentBody out of score-tile targets", () => {
    expect(SCORE_TILE_SECTION_IDS).not.toHaveProperty("documentBody");
    const scoreTileIds = Object.values(SCORE_TILE_SECTION_IDS) as string[];
    expect(scoreTileIds).not.toContain(SECTION_IDS.documentBody);
  });

  it("includes all score-tile targets in SECTION_IDS", () => {
    for (const [key, value] of Object.entries(SCORE_TILE_SECTION_IDS)) {
      expect(SECTION_IDS).toHaveProperty(key, value);
    }
    expect(SECTION_IDS).toHaveProperty("documentBody", "resume-document-body");
  });

  it("enforces that ScoreTileAnchor excludes non-score-tile targets at compile time", () => {
    const validContact: ScoreTileAnchor = `#${SCORE_TILE_SECTION_IDS.contact}`;
    const validResume: ScoreTileAnchor = `#${SCORE_TILE_SECTION_IDS.reconstructed}`;
    expect(validContact).toBe("#contact");
    expect(validResume).toBe("#reconstructed-resume");

    const bodyAnchor: SectionAnchor = `#${SECTION_IDS.documentBody}`;
    expect(bodyAnchor).toBe("#resume-document-body");

    // @ts-expect-error — documentBody is in SectionAnchor but must be rejected by ScoreTileAnchor (#973)
    const _invalidTileAnchor: ScoreTileAnchor = `#${SECTION_IDS.documentBody}`;
    expect(_invalidTileAnchor).toBeDefined();
  });
});
