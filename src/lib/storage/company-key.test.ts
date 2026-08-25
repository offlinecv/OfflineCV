// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The company normaliser behind `LetterRecord.companyKey` (#766).
 *
 * Two properties matter and they pull against each other, so both are asserted
 * directly rather than through a sample of names: spellings of ONE employer
 * must converge on one key, and an absent name must yield `undefined` rather
 * than `""` — which the letter contract refuses, so an empty company that keyed
 * to `""` would make a letter unwritable instead of unscoped.
 *
 * Every company named here is fictional.
 */

import { describe, it, expect } from "vitest";
import { deriveCompanyKey } from "./company-key.ts";

describe("deriveCompanyKey (#766)", () => {
  it("maps every spelling of one employer to a single key", () => {
    const keys = [
      "Northwind",
      "northwind",
      "  Northwind  ",
      "Northwind Inc.",
      "northwind, inc.",
      "NORTHWIND INC",
      "Northwind LLC",
      "Northwind Ltd.",
      "Northwind Limited",
      "Northwind Corp.",
      "Northwind Corporation",
      "Northwind Co.",
      "Northwind GmbH",
      "Northwind S.A.",
      "Northwind B.V.",
      "Northwind Pty",
    ].map(deriveCompanyKey);

    expect(new Set(keys)).toEqual(new Set(["northwind"]));
  });

  it("collapses internal whitespace without joining separate words", () => {
    expect(deriveCompanyKey("Northwind   Systems\tGroup")).toBe("northwind systems group");
    // Under-merge on purpose: nothing says these are one employer, and a false
    // suggestion costs more than a missing one. See `LEGAL_SUFFIXES`.
    expect(deriveCompanyKey("Northwind Technologies")).not.toBe("northwind");
  });

  it("returns undefined when there is no name left to key", () => {
    expect(deriveCompanyKey("")).toBeUndefined();
    expect(deriveCompanyKey("   ")).toBeUndefined();
    expect(deriveCompanyKey("  ,  ")).toBeUndefined();
    expect(deriveCompanyKey("!!!")).toBeUndefined();
    expect(deriveCompanyKey(undefined)).toBeUndefined();
    // Every word was a suffix. `""` would be a key the contract refuses, so the
    // answer has to be "no key" and not "the empty key".
    expect(deriveCompanyKey("Inc.")).toBeUndefined();
    expect(deriveCompanyKey("S.A.")).toBeUndefined();
  });

  it("never returns an empty string, for any input that returns at all", () => {
    for (const input of ["", " ", ",", "Inc", "a", "北風", "Ltd Co", "3M"]) {
      const key = deriveCompanyKey(input);
      expect(key === undefined || key.length > 0).toBe(true);
    }
  });

  it("strips one trailing suffix, not a chain of them", () => {
    // "Ltd Co" is a (bad) company name, not two suffixes to peel: looping would
    // leave nothing, and "no key" is the wrong answer for a name that exists.
    expect(deriveCompanyKey("Ltd Co")).toBe("ltd");
    expect(deriveCompanyKey("Northwind Inc. Ltd.")).toBe("northwind inc");
  });

  it("only strips a suffix at the END, and only as a whole word", () => {
    expect(deriveCompanyKey("Inc Northwind")).toBe("inc northwind");
    expect(deriveCompanyKey("Incline Systems")).toBe("incline systems");
    expect(deriveCompanyKey("Cointreau")).toBe("cointreau");
  });

  it("keeps digits and non-Latin letters, which are name characters", () => {
    expect(deriveCompanyKey("3M")).toBe("3m");
    expect(deriveCompanyKey("北風 GmbH")).toBe("北風");
  });
});
