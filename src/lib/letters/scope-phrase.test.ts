// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * scope-phrase — the letter surfaces' shared vocabulary (#767, #978).
 *
 * This file had no test at all while the phrases were built in two feature
 * components and only the casing rule lived in the lib (#767 review). The
 * builders moved here so a fourth scope is added in one place; these cases pin
 * the two properties that made the split dangerous:
 *
 *  - every builder returns a LOWERCASE FRAGMENT, so a render site that embeds
 *    it mid-sentence is correct and one that stands it alone capitalizes;
 *  - the company name is echoed as the user typed it, never normalised.
 */

import { describe, expect, it } from "vitest";
import {
  capitalizePhrase,
  companyScopeWord,
  inheritedPhrase,
  ownDraftPhrase,
  unreachablePhrase,
} from "./scope-phrase.ts";

describe("inheritedPhrase", () => {
  it("names the company on the company rung, and nothing on the standard one", () => {
    expect(inheritedPhrase("company", "Northwind")).toBe("your Northwind letter");
    expect(inheritedPhrase("standard", "Northwind")).toBe("your standard letter");
  });

  it("echoes the company name exactly as typed, never the derived key", () => {
    // `deriveCompanyKey` would answer "ebay" / "acme" — a lookup token. Printing
    // it back shows the user a lowercased, suffix-stripped version of their own
    // input.
    expect(inheritedPhrase("company", "eBay")).toBe("your eBay letter");
    expect(inheritedPhrase("company", "ACME Corp.")).toBe("your ACME Corp. letter");
  });

  it("returns a lowercase fragment, so it embeds mid-sentence", () => {
    for (const phrase of [
      inheritedPhrase("standard", "X"),
      inheritedPhrase("company", "northwind"),
    ]) {
      expect(phrase[0]).toBe(phrase[0]!.toLowerCase());
    }
  });
});

describe("unreachablePhrase", () => {
  it("keeps a labelled duplicate's own name — the only thing telling two apart", () => {
    expect(unreachablePhrase("Short version", "standard letter", 0, 2)).toBe(
      "Short version, an earlier standard letter",
    );
  });

  it("numbers an unlabelled duplicate ONLY when there is more than one", () => {
    expect(unreachablePhrase(undefined, "standard letter", 0, 1)).toBe(
      "an earlier standard letter",
    );
    expect(unreachablePhrase(undefined, "standard letter", 0, 2)).toBe(
      "an earlier standard letter (1)",
    );
    expect(unreachablePhrase(undefined, "standard letter", 1, 2)).toBe(
      "an earlier standard letter (2)",
    );
  });

  it("treats an empty label as absent rather than printing a bare comma", () => {
    expect(unreachablePhrase("", "standard letter", 0, 1)).toBe(
      "an earlier standard letter",
    );
  });

  it("takes a company tier word from companyScopeWord", () => {
    expect(
      unreachablePhrase(undefined, companyScopeWord("Northwind"), 0, 1),
    ).toBe("an earlier Northwind letter");
  });
});

describe("ownDraftPhrase", () => {
  it("uses the user's own label when there is one", () => {
    expect(ownDraftPhrase("Warm open")).toBe("Warm open");
  });

  it("falls back to the wording the reveal titles an unnamed draft with", () => {
    expect(ownDraftPhrase(undefined)).toBe("this job's letter");
    expect(ownDraftPhrase("")).toBe("this job's letter");
  });
});

describe("capitalizePhrase", () => {
  it("raises only the first character", () => {
    expect(capitalizePhrase("your standard letter")).toBe("Your standard letter");
  });

  it("leaves a deliberately-lowercase brand inside the phrase alone", () => {
    // Title-casing would mangle "eBay" into "EBay" — a name the user can see is
    // theirs beats one this app restyled.
    expect(capitalizePhrase("your eBay letter")).toBe("Your eBay letter");
  });

  it("is safe on an empty string", () => {
    expect(capitalizePhrase("")).toBe("");
  });
});
