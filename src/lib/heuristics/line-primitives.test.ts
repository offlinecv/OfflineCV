// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for {@link isLoneDateRange}, the flush-right-date discriminator
 * used by the parser's `columnGapCuts` (`sections.ts`, default mode) and by
 * the exporter's `rightAlignEduDate` / Experience `headerLineDate` decision
 * (`ats-resume-model.ts`, `allowSingle: true` mode since #618).
 *
 * The `allowSingle: true` mode was added by #618 so a single graduation
 * year ("2023" — the common shape for certificates, bootcamps and
 * non-degree programs) also qualifies for the flush-right slot on export.
 * Ranges must still qualify under both modes, and every existing guard
 * (season lead, bare-numeric year gate) must still apply.
 */

import { describe, it, expect } from "vitest";
import { isLoneDateRange } from "./line-primitives.ts";

describe("isLoneDateRange — range behaviour is byte-identical (default and allowSingle)", () => {
  it.each([
    ["2019 - 2023"],
    ["2019 – 2023"], // en dash
    ["Jan 2020 – Present"],
    ["May 2019 - August 2021"],
    ["Jan 2019 - Mar 2021"],
  ])("range %s qualifies in default mode", (text) => {
    expect(isLoneDateRange(text)).toBe(true);
  });

  it.each([
    ["2019 - 2023"],
    ["2019 – 2023"],
    ["Jan 2020 – Present"],
    ["May 2019 - August 2021"],
  ])("range %s also qualifies with allowSingle", (text) => {
    expect(isLoneDateRange(text, { allowSingle: true })).toBe(true);
  });
});

describe("isLoneDateRange — season carve-out holds under both modes", () => {
  // The season carve-out is load-bearing for the openresume-laverne-word-quartz
  // fixture (see the const docblock). It must apply regardless of `allowSingle`.
  it.each([
    ["Fall 2013 – Spring 2014"],
    ["Summer 2013, 2014"],
    ["Winter 2018 - Winter 2019"],
    ["Autumn 2010 - Spring 2014"],
  ])("season-lead range %s stays SPLIT (default)", (text) => {
    expect(isLoneDateRange(text)).toBe(false);
  });

  it.each([
    ["Fall 2013 – Spring 2014"],
    ["Summer 2013, 2014"],
  ])("season-lead range %s stays SPLIT with allowSingle", (text) => {
    expect(isLoneDateRange(text, { allowSingle: true })).toBe(false);
  });
});

describe("isLoneDateRange — lone single year (#618)", () => {
  it.each([
    ["2023"],
    ["2019"],
    ["1999"],
    ["2000"],
    ["2099"],
  ])("bare 19xx/20xx year %s qualifies with allowSingle", (text) => {
    expect(isLoneDateRange(text, { allowSingle: true })).toBe(true);
  });

  it.each([
    ["2023"],
    ["2019"],
    ["1999"],
  ])(
    "bare 19xx/20xx year %s still returns false in default mode (range required)",
    (text) => {
      expect(isLoneDateRange(text)).toBe(false);
    },
  );

  it.each([
    ["  2023  "],
  ])("leading/trailing whitespace is trimmed under allowSingle", (text) => {
    expect(isLoneDateRange(text, { allowSingle: true })).toBe(true);
  });
});

describe("isLoneDateRange — bare-numeric guard is preserved under allowSingle (#618, #425)", () => {
  // The `(?:19|20)\d{2}` gate in `isLoneDateRange` is load-bearing.
  // A bare numeric column (a salary/score grid) MUST still split as a real
  // column — allowing it under allowSingle would merge a `5000` grid column
  // onto the org line and destroy column-major parsing.
  it.each([
    ["5000"], // salary column
    ["6000"],
    ["1899"], // pre-1900, not a plausible resume year
    ["3025"], // future beyond plausible
    ["1234"],
    ["9999"],
    ["100"], // 3-digit
    ["20"], // 2-digit
    ["20234"], // 5-digit
  ])("bare-numeric %s stays SPLIT (allowSingle)", (text) => {
    expect(isLoneDateRange(text, { allowSingle: true })).toBe(false);
  });

  it.each([
    ["5000 - 6000"], // numeric range — salary grid shape, neither side is a year
    ["3000 – 4000"], // en-dash variant; neither `3xxx` nor `4xxx` hits the year gate
    ["7000 - 8000"],
  ])("bare-numeric range %s still returns false (both modes)", (text) => {
    // A range containing `2000` (e.g. `1000 – 2000`) DOES qualify as a lone
    // date range because `2000` passes the `20\d{2}` year gate — that is
    // pre-existing behaviour, not a regression the `allowSingle` extension
    // widens. The test cases here deliberately pick ranges whose anchors
    // are both outside the year gate so the guard is exercised end-to-end.
    expect(isLoneDateRange(text)).toBe(false);
    expect(isLoneDateRange(text, { allowSingle: true })).toBe(false);
  });
});

describe("isLoneDateRange — allowSingle does NOT admit non-year single tokens", () => {
  // Keep the surface narrow — only bare 19xx/20xx years qualify under
  // allowSingle. A lone month or a bare month-year stays out; the exporter
  // does not need those routed to the flush-right slot, and admitting them
  // widens the parser's blast radius.
  it.each([
    ["May 2020"], // month + year — not a bare year
    ["Jan"], // lone month
    ["May"],
    ["Present"], // placeholder alone
    ["Ongoing"],
    ["'19"], // apostrophe year
    ["Fall 2013"], // season + year alone
  ])("%s does NOT qualify under allowSingle", (text) => {
    expect(isLoneDateRange(text, { allowSingle: true })).toBe(false);
  });
});

describe("isLoneDateRange — empty / whitespace / arbitrary text", () => {
  it.each([[""], ["   "], ["some text"], ["Institution Name"], ["Coursework: A, B"]])(
    "%s returns false (both modes)",
    (text) => {
      expect(isLoneDateRange(text)).toBe(false);
      expect(isLoneDateRange(text, { allowSingle: true })).toBe(false);
    },
  );
});
