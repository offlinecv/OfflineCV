// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import {
  validateDate,
  validateEmail,
  validateUrl,
  validatePhone,
} from "./field-validators.ts";

describe("validateDate", () => {
  it("accepts the résumé date forms the parser understands", () => {
    const clean = [
      "Present",
      "Current",
      "Now",
      "Ongoing",
      "2020",
      "1998",
      "Jan 2020",
      "January 2020",
      "Jan. 2020",
      "Sept 2019",
      "May '19",
      "08/2020",
      "8/2020",
      "Summer 2013",
      "20XX", // redacted placeholder — odd but real, must not flag
      "2020 – 2023",
      "2020 - 2023",
      "Jan 2020 – Present",
      "May 2019 to Aug 2021",
      "March 20XX – December 20XX", // redacted range
    ];
    for (const v of clean) {
      expect(validateDate(v), `expected clean: ${v}`).toBeNull();
    }
  });

  it("does not flag a future year (parser audit, not a judge)", () => {
    expect(validateDate("2035")).toBeNull();
    expect(validateDate("Jan 2099")).toBeNull();
  });

  it("treats an empty / cleared field as clean, never a typo", () => {
    expect(validateDate("")).toBeNull();
    expect(validateDate("   ")).toBeNull();
  });

  it("flags a bare word or garbage typed into a date field", () => {
    for (const v of ["banana", "asdf", "hello world", "N/A", "12345", "sometime"]) {
      expect(validateDate(v), `expected flag: ${v}`).not.toBeNull();
    }
  });

  it("flags a value that merely CONTAINS a date but is not a date shape", () => {
    // Guards against the `^a|b$` anchor trap — a leading garbage token must fail.
    expect(validateDate("banana 2020")).not.toBeNull();
    expect(validateDate("hired 2020")).not.toBeNull();
  });
});

describe("validateEmail", () => {
  it("accepts RFC-ish addresses incl. synthetic fixtures", () => {
    for (const v of [
      "alice@example.com",
      "a.b+tag@sub.example.co.uk",
      "jane_doe@example.org",
    ]) {
      expect(validateEmail(v), `expected clean: ${v}`).toBeNull();
    }
  });

  it("treats an empty field as clean", () => {
    expect(validateEmail("")).toBeNull();
  });

  it("flags non-email shapes", () => {
    for (const v of ["banana", "alice@example", "alice example.com", "@example.com", "alice@"]) {
      expect(validateEmail(v), `expected flag: ${v}`).not.toBeNull();
    }
  });
});

describe("validateUrl", () => {
  it("accepts URL-ish link shapes incl. synthetic fixtures", () => {
    for (const v of [
      "linkedin.com/in/janedoe",
      "example.com/in/janedoe",
      "https://www.linkedin.com/in/janedoe",
      "https://github.com/janedoe",
      "github.com/janedoe",
      "janedoe.dev",
      "https://janedoe.example.com/portfolio?ref=cv",
    ]) {
      expect(validateUrl(v), `expected clean: ${v}`).toBeNull();
    }
  });

  it("treats an empty field as clean", () => {
    expect(validateUrl("")).toBeNull();
  });

  it("flags non-URL shapes", () => {
    for (const v of ["banana", "just some text", "alice@example.com", "in/janedoe"]) {
      expect(validateUrl(v), `expected flag: ${v}`).not.toBeNull();
    }
  });
});

describe("validatePhone", () => {
  it("accepts a valid synthetic reserved US number", () => {
    // Real area code + 555-01xx fictional range — passes libphonenumber isValid().
    expect(validatePhone("(312) 555-0123")).toBeNull();
    expect(validatePhone("312-555-0123")).toBeNull();
  });

  it("accepts a valid international number", () => {
    expect(validatePhone("+44 20 7946 0958")).toBeNull();
  });

  it("treats an empty field as clean", () => {
    expect(validatePhone("")).toBeNull();
  });

  it("flags a bare word or an unparseable / too-short number", () => {
    for (const v of ["banana", "123", "call me", "(555) 010-0123"]) {
      expect(validatePhone(v), `expected flag: ${v}`).not.toBeNull();
    }
  });
});
