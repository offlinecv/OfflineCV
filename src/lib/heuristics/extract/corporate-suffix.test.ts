// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Tests for `composeSuffixRegex` (#917, part (c) of #653) and for the
 * constraint the issue exists to protect: the four generated corporate-suffix
 * sets keep their OWN membership, and the tail-deferral vocabulary
 * (`COMPANY_TAIL_TOKENS_RE`) stays deliberately broader than the strict one
 * (`COMPANY_SUFFIX_RE`).
 *
 * Section 1 proves each of the four sets' `.source`/`.flags` is byte-identical
 * to the literal that call site hand-wrote before this refactor (the safest
 * form of a behaviour-preserving proof). It asserts the EXPORTED constants,
 * which is the whole of its value: an earlier version rebuilt each regex from
 * a hand-typed token list, which proved only that the composer is
 * deterministic and left the `selectSuffixTokens([...])` key list at each call
 * site checked by nothing — adding a token there moved the real regex with
 * every test in `heuristics/` still green (#922 review). The fifth row is the
 * exception and stays a rebuild: `COMPANY_SUFFIX_RE` is hand-written in
 * `title-shape.ts` by design, so there is no composed constant to compare.
 *
 * Section 2 pins the actual membership divergence — `Media`/`Partners` must
 * stay IN the broad set and OUT of the strict one, including the real
 * "Media Director" regression the issue names — through the sets' real
 * observable behaviour rather than by re-deriving private internals.
 *
 * Section 3 pins the token base itself: that `SUFFIX_TOKENS` +
 * `selectSuffixTokens` emit exactly those strings in exactly that order, which
 * is what makes "the four sets are generated from one token base" (AC1) a
 * checked claim rather than a docblock one. It re-spells its key lists, so it
 * is not a drift gate — section 1 is; this is a statement about the base's
 * rendering.
 *
 * Sections 4 and 5 pin the composer's edge behaviours: the trailing-dot
 * allowance under a `\b` anchor, and the two constructions it refuses
 * outright — a stateful regex flag, and a dot subset naming a token that is
 * not in `tokens`. Both refusals exist because the alternative is silent.
 */

import { describe, it, expect } from "vitest";
import { composeSuffixRegex, selectSuffixTokens, SUFFIX_TOKENS } from "./corporate-suffix.ts";
import { COMPANY_SUFFIX_RE, looksLikeTitle } from "./title-shape.ts";
import {
  COMPANY_LEGAL_TAIL_RE,
  COMPANY_TAIL_TOKENS_RE,
  LEGAL_SUFFIX_RE,
} from "./experience-disambiguate.ts";
import { LEGAL_TERMINAL_SUFFIX_RE } from "../line-primitives.ts";
import { groupIntoLines, splitIntoSections, findSection } from "../sections.ts";
import { extractExperience } from "../extract-fields.ts";
import { mkItems } from "../__test-utils__/mkItem.ts";

describe("the four composed sets are byte-identical to the pre-#917 literals", () => {
  // These assert the PRODUCTION constants, not a rebuild of them from a
  // hand-typed token list. Rebuilding proved only that `composeSuffixRegex`
  // is deterministic: it left the `selectSuffixTokens([...])` key list at each
  // call site checked by nothing, so adding a token there changed the real
  // regex with every test in this file — and all 1682 in `heuristics/` —
  // still green (verified by mutation in the #922 review). Importing the
  // constant is what closes that gap, and it is why the four are exported.
  it.each([
    [
      "LEGAL_SUFFIX_RE (experience-disambiguate.ts)",
      LEGAL_SUFFIX_RE,
      /^(inc\.?|llc|l\.l\.c\.?|ltd\.?|corp\.?|co\.?|gmbh|plc|lp|llp|pc|s\.a\.?|n\.a\.?|sa)$/i,
    ],
    [
      "COMPANY_TAIL_TOKENS_RE (experience-disambiguate.ts)",
      COMPANY_TAIL_TOKENS_RE,
      /^(?:Bank|Co|Corp|Corporation|Group|Systems|Solutions|Technologies|Studios|Media|Software|Consulting|Partners|Ventures|Holdings|Industries|Financial|Health|Healthcare|Networks|Digital|Analytics|Labs|Ltd|LLC|Inc|GmbH|SA|PLC)\.?$/i,
    ],
    [
      "COMPANY_LEGAL_TAIL_RE (experience-disambiguate.ts)",
      COMPANY_LEGAL_TAIL_RE,
      /^(?:Inc\.?|LLC|L\.L\.C\.?|Ltd\.?|GmbH|PLC|Corp\.?|Corporation|Holdings)$/i,
    ],
    [
      "LEGAL_TERMINAL_SUFFIX_RE (line-primitives.ts)",
      LEGAL_TERMINAL_SUFFIX_RE,
      /\b(?:Inc|Corp|Corporation|Ltd|LLC|L\.L\.C|GmbH|PLC|Co|SA|NA|LP|LLP|PC)\.?$/i,
    ],
  ])("%s", (_name, actual, golden) => {
    expect(actual.source).toBe(golden.source);
    expect(actual.flags).toBe(golden.flags);
  });

  it("reproduces COMPANY_SUFFIX_RE's shape (title-shape.ts), even though that site stays hand-written for its own leaf-module reasons", () => {
    const re = composeSuffixRegex(
      [
        "Inc", "LLC", "Ltd", "Limited", "Corp", "Corporation", "Company", "Co",
        "GmbH", "S.A", "Pty", "plc", "Group", "Holdings", "Technologies",
        "Systems", "Labs", "Solutions",
      ],
      { anchor: "boundary", capture: true, allowTrailingDot: ["Inc", "Ltd", "Corp", "Co", "S.A", "Pty"] },
    );
    expect(re.source).toBe(COMPANY_SUFFIX_RE.source);
    expect(re.flags).toBe(COMPANY_SUFFIX_RE.flags);
  });
});

describe("dot handling is behaviour-preserving", () => {
  it("an outer allowTrailingDot:true tolerates a period after ANY token", () => {
    const re = composeSuffixRegex(["Inc", "LLC"], { anchor: "full", allowTrailingDot: true });
    expect(re.test("Inc.")).toBe(true);
    expect(re.test("LLC.")).toBe(true);
    expect(re.test("Inc")).toBe(true);
    expect(re.test("LLC")).toBe(true);
  });

  it("a subset allowTrailingDot only tolerates a period on named tokens", () => {
    const re = composeSuffixRegex(["Inc", "LLC"], { anchor: "full", allowTrailingDot: ["Inc"] });
    expect(re.test("Inc.")).toBe(true);
    expect(re.test("LLC.")).toBe(false);
  });

  it("omitting allowTrailingDot rejects a trailing period entirely", () => {
    const re = composeSuffixRegex(["Inc"], { anchor: "full" });
    expect(re.test("Inc.")).toBe(false);
    expect(re.test("Inc")).toBe(true);
  });
});

describe("the tail-deferral set stays broader than the strict set (#917 constraint)", () => {
  // AC: `Media`/`Partners` must be in the broad tail-deferral vocabulary and
  // OUT of the strict COMPANY_SUFFIX_RE — narrowing the strict set to match
  // would flip `looksLikeTitle` false on a real title like "Media Director".
  it.each(["Media", "Partners"])(
    "COMPANY_SUFFIX_RE (strict) does not match a bare %s",
    (token) => {
      expect(COMPANY_SUFFIX_RE.test(token)).toBe(false);
    },
  );

  it('the real-world regression: "Media Director" still reads as a title', () => {
    expect(COMPANY_SUFFIX_RE.test("Media Director")).toBe(false);
    expect(looksLikeTitle("Media Director")).toBe(true);
  });

  // Exercises the PRIVATE, production `COMPANY_TAIL_TOKENS_RE` through its
  // real effect on `extractExperience` (same technique as
  // experience.company-tail-state.test.ts's #641 regression) rather than
  // re-deriving it, so this pins the actual composed constant, not a copy.
  function roleFromHeader(header: string) {
    const sections = splitIntoSections(
      groupIntoLines(
        mkItems([
          { text: "EXPERIENCE", fontSize: 13 },
          { text: header, fontSize: 11 },
          { text: "04/2021 – 12/2023", fontSize: 11 },
          { text: "• Ran a cross-team migration to a shared platform.", fontSize: 11 },
        ]),
      ),
    );
    const experience = findSection(sections, "experience");
    expect(experience).toBeDefined();
    const roles = extractExperience(experience).value;
    expect(roles.length).toBeGreaterThanOrEqual(1);
    return roles[0];
  }

  it.each([
    ["Acme Media", "CA"],
    ["Acme Partners", "CA"],
  ])("`%s, %s` keeps the company whole (COMPANY_TAIL_TOKENS_RE defers on %s)", (company, state) => {
    const role = roleFromHeader(`Engineer · ${company}, ${state}`);
    expect(role.company).toBe(company);
    expect(role.location).toBe(state);
  });
});

describe("the token base is what the four sets select from (#917 AC1)", () => {
  // The goldens above prove `composeSuffixRegex(<these strings>) === <the
  // pre-#917 literal>`. These prove the BASE emits exactly those strings, in
  // that order — so "the four sets are generated from one token base" is a
  // checked claim rather than a docblock one. A key typo is already a compile
  // error; this catches a value edit that would silently move a set.
  it("renders LEGAL_SUFFIX_RE's vocabulary lowercase", () => {
    expect(
      selectSuffixTokens(
        ["INC", "LLC", "L_L_C", "LTD", "CORP", "CO", "GMBH", "PLC", "LP", "LLP", "PC", "S_A", "N_A", "SA"],
        { lowercase: true },
      ),
    ).toEqual(["inc", "llc", "l.l.c", "ltd", "corp", "co", "gmbh", "plc", "lp", "llp", "pc", "s.a", "n.a", "sa"]);
  });

  it("renders COMPANY_TAIL_TOKENS_RE's vocabulary canonically", () => {
    expect(
      selectSuffixTokens([
        "BANK", "CO", "CORP", "CORPORATION", "GROUP", "SYSTEMS", "SOLUTIONS",
        "TECHNOLOGIES", "STUDIOS", "MEDIA", "SOFTWARE", "CONSULTING", "PARTNERS",
        "VENTURES", "HOLDINGS", "INDUSTRIES", "FINANCIAL", "HEALTH", "HEALTHCARE",
        "NETWORKS", "DIGITAL", "ANALYTICS", "LABS", "LTD", "LLC", "INC", "GMBH",
        "SA", "PLC",
      ]),
    ).toEqual([
      "Bank", "Co", "Corp", "Corporation", "Group", "Systems", "Solutions",
      "Technologies", "Studios", "Media", "Software", "Consulting", "Partners",
      "Ventures", "Holdings", "Industries", "Financial", "Health", "Healthcare",
      "Networks", "Digital", "Analytics", "Labs", "Ltd", "LLC", "Inc", "GmbH",
      "SA", "PLC",
    ]);
  });

  it("renders COMPANY_LEGAL_TAIL_RE's and LEGAL_TERMINAL_SUFFIX_RE's vocabularies canonically", () => {
    expect(
      selectSuffixTokens(["INC", "LLC", "L_L_C", "LTD", "GMBH", "PLC", "CORP", "CORPORATION", "HOLDINGS"]),
    ).toEqual(["Inc", "LLC", "L.L.C", "Ltd", "GmbH", "PLC", "Corp", "Corporation", "Holdings"]);
    expect(
      selectSuffixTokens([
        "INC", "CORP", "CORPORATION", "LTD", "LLC", "L_L_C", "GMBH", "PLC", "CO",
        "SA", "NA", "LP", "LLP", "PC",
      ]),
    ).toEqual(["Inc", "Corp", "Corporation", "Ltd", "LLC", "L.L.C", "GmbH", "PLC", "Co", "SA", "NA", "LP", "LLP", "PC"]);
  });

  it("preserves the caller's order, not the base's declaration order", () => {
    expect(selectSuffixTokens(["LLC", "INC"])).toEqual(["LLC", "Inc"]);
    expect(selectSuffixTokens(["INC", "LLC"])).toEqual(["Inc", "LLC"]);
  });

  it("spells a token that two sets render differently exactly once", () => {
    // The divergence #917 exists to remove: `l.l.c` and `L.L.C` were two
    // hand-typed strings; they are now one entry rendered two ways.
    expect(SUFFIX_TOKENS.L_L_C).toBe("L.L.C");
    expect(selectSuffixTokens(["L_L_C"], { lowercase: true })).toEqual(["l.l.c"]);
  });
});

describe("allowTrailingDot under a boundary anchor", () => {
  // Latent bug found in review: `allowTrailingDot: true` used to be dropped on
  // the floor for `anchor: "boundary"` — no dot tolerance, no error. It now
  // emits its dot AFTER the closing `\b`, which is the only place a `\b`-anchored
  // pattern can consume one.
  it("consumes a trailing period when allowTrailingDot is true", () => {
    const re = composeSuffixRegex(["Inc", "LLC"], {
      anchor: "boundary",
      allowTrailingDot: true,
    });
    expect(re.source).toBe("\\b(?:Inc|LLC)\\b\\.?");
    expect(re.exec("Acme Inc. of Ohio")?.[0]).toBe("Inc.");
    expect(re.exec("Acme Inc of Ohio")?.[0]).toBe("Inc");
  });

  it("leaves an INLINE dot inert, because the closing \\b backtracks off it", () => {
    // Pre-existing, and pinned rather than fixed: this is the emission
    // `title-shape.ts`'s hand-written `COMPANY_SUFFIX_RE` has always had, and
    // the golden above holds it byte-exact.
    const re = composeSuffixRegex(["Inc"], {
      anchor: "boundary",
      allowTrailingDot: ["Inc"],
    });
    expect(re.source).toBe("\\b(?:Inc\\.?)\\b");
    expect(re.exec("Acme Inc. of Ohio")?.[0]).toBe("Inc");
  });
});

describe("an allowTrailingDot subset that names an unknown token is rejected", () => {
  // The array form matches by exact string, so an entry absent from `tokens`
  // contributes no dot and no error. The live trap is `lowercase`:
  // `LEGAL_SUFFIX_RE` passes it to BOTH `selectSuffixTokens` calls, and
  // omitting it on the dot-subset one makes every entry miss at once —
  // "Acme Inc." silently stops matching and #641 un-lands for that whole set.
  it("throws, naming the offending token", () => {
    expect(() =>
      composeSuffixRegex(selectSuffixTokens(["INC", "LLC"], { lowercase: true }), {
        anchor: "full",
        // Title case, where `tokens` is lowercase — the exact `lowercase`
        // mismatch, which used to compose a dot-less regex in silence.
        allowTrailingDot: selectSuffixTokens(["INC"]),
      }),
    ).toThrow(/allowTrailingDot names "Inc", which is not in tokens/);
  });

  it("accepts a subset that IS in tokens, in either rendering", () => {
    const lower = composeSuffixRegex(
      selectSuffixTokens(["INC", "LLC"], { lowercase: true }),
      { anchor: "full", allowTrailingDot: selectSuffixTokens(["INC"], { lowercase: true }) },
    );
    expect(lower.test("inc.")).toBe(true);
    expect(lower.test("llc.")).toBe(false);
  });

  it("does not fire when allowTrailingDot is `true` — there is no subset to check", () => {
    expect(() =>
      composeSuffixRegex(["anything"], { anchor: "full", allowTrailingDot: true }),
    ).not.toThrow();
  });
});

describe("flags are validated", () => {
  // A module-scope singleton with `g` or `y` carries `lastIndex` between calls,
  // so the same input matches or not depending on what ran before it.
  it.each(["g", "y", "gi", "iy"])("rejects the stateful flag set %s", (flags) => {
    expect(() =>
      composeSuffixRegex(["Inc"], { anchor: "full", flags }),
    ).toThrow(/stateful flags/);
  });

  it("still accepts the stateless flags the sets actually use", () => {
    expect(composeSuffixRegex(["Inc"], { anchor: "full", flags: "i" }).flags).toBe("i");
    expect(composeSuffixRegex(["Inc"], { anchor: "full", flags: "" }).flags).toBe("");
  });
});
