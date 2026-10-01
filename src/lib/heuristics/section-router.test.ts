// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Direct coverage for `selectLineAction` (#655): the named vetoes and the
 * proposer priority order. The corpus pins the router transitively (every
 * fixture must parse byte-identically), but a corpus diff names a fixture,
 * not a rule; these cases name the rule, so a Stage 2 change that reorders
 * `PROPOSER_ORDER` or lets a veto fall through fails here first.
 *
 * Stubs are minimal typed `PdfLine` / `RouterContext` literals — no PDF, no
 * cascade — per the lib-unit-test exemplar in CLAUDE.md.
 */

import { describe, expect, it } from "vitest";
import { selectLineAction, type RouterContext } from "./section-router.ts";
import type { PdfLine } from "./line-model.ts";

const BODY = 10;

function line(text: string, maxFontSize = BODY): PdfLine {
  return { page: 1, y: 100, x: 72, items: [], text, maxFontSize, allCaps: text === text.toUpperCase(), gapAbove: 0 };
}

function ctx(over: Partial<RouterContext> = {}): RouterContext {
  return {
    lineIdx: 0,
    bodyBaseline: BODY,
    bodyLineHeight: 14,
    openedRealSection: true,
    seenContactInProfile: true,
    prevLineOpenedBoundary: false,
    columnBand: undefined,
    currentSection: "profile",
    singleColumn: true,
    nextLine: undefined,
    ...over,
  };
}

describe("selectLineAction — keyword proposer and the institution-repeat veto (#258/#310-311)", () => {
  // A qualified header that matches through the head-noun anchor-fallback tier.
  const institution = line("GRADUATE SCHOOL OF EDUCATION", 16);

  it("opens the section when no same-named section is open", () => {
    const { action, consumedLines } = selectLineAction(institution, ctx({ currentSection: "profile" }));
    expect(consumedLines).toBe(1);
    expect(action).toMatchObject({ kind: "open", name: "education" });
  });

  it("vetoes to `append` under an open education section — and does NOT fall through to the visual proposer", () => {
    // 16pt ALL-CAPS multi-word: the visual proposer would fire on this line if
    // consulted. The veto must return `append` directly, not decline.
    const { action } = selectLineAction(
      institution,
      ctx({ currentSection: "education", prevLineOpenedBoundary: true }),
    );
    expect(action).toEqual({ kind: "append", marksContactEnd: false });
  });

  it("exact-alias headers are never institution repeats: a second EDUCATION header still opens", () => {
    const { action } = selectLineAction(line("EDUCATION", 16), ctx({ currentSection: "education" }));
    expect(action).toMatchObject({ kind: "open", name: "education" });
  });
});

describe("selectLineAction — visual proposer and the name-block veto (#112/#216)", () => {
  const big = line("JANE Q DOE", 16);

  it("inside the name block (no contact seen, nothing open) a font-distinct line stays in profile", () => {
    const { action } = selectLineAction(big, ctx({ openedRealSection: false, seenContactInProfile: false }));
    expect(action).toEqual({ kind: "append", marksContactEnd: false });
  });

  it("the contact line that ends the name block is reported as such", () => {
    const { action } = selectLineAction(
      line("jane.doe@example.com · (312) 555-0123", 16),
      ctx({ openedRealSection: false, seenContactInProfile: false }),
    );
    expect(action).toEqual({ kind: "append", marksContactEnd: true });
  });

  it("past the name block the same signal opens the boundary-only `other` sink", () => {
    const { action } = selectLineAction(big, ctx({ openedRealSection: false, seenContactInProfile: true }));
    expect(action).toMatchObject({ kind: "open", name: "other" });
  });
});

describe("selectLineAction — sidebar anchor recovery (#117/#574)", () => {
  it("recovers a glued sidebar artifact only inside the sidebar band", () => {
    const glued = line("20% Projects");
    const inSidebar = selectLineAction(glued, ctx({ columnBand: "sidebar" })).action;
    expect(inSidebar).toMatchObject({ kind: "open", name: "projects", rawHeading: "Projects" });
    const inBody = selectLineAction(glued, ctx({ columnBand: "body" })).action;
    expect(inBody).toMatchObject({ kind: "append" });
  });

  it("holds out a dated entry line even in the sidebar band", () => {
    const dated = line("Harvard Business School");
    const { action } = selectLineAction(
      dated,
      ctx({ columnBand: "sidebar", nextLine: line("Jan 2020 – Dec 2021") }),
    );
    expect(action).toMatchObject({ kind: "append" });
  });
});

describe("selectLineAction — default", () => {
  it("a plain body line appends and never marks the contact end once a section is open", () => {
    const { action, consumedLines } = selectLineAction(line("Led the migration of 12 services."), ctx());
    expect(consumedLines).toBe(1);
    expect(action).toEqual({ kind: "append", marksContactEnd: false });
  });
});
