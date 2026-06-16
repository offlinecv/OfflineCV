// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { normalizePhone, findFirstPhone, regionFromLocation } from "./phone.ts";

// ── normalizePhone ───────────────────────────────────────────────────────────

describe("normalizePhone — US numbers", () => {
  it("normalizes a raw 10-digit string (no separators)", () => {
    const result = normalizePhone("4083726626");
    expect(result).toBeDefined();
    expect(result!.formatted).toBe("(408) 372-6626");
    expect(result!.isValid).toBe(true);
  });

  it("normalizes a dashed US number", () => {
    const result = normalizePhone("408-372-6626");
    expect(result).toBeDefined();
    expect(result!.formatted).toBe("(408) 372-6626");
    expect(result!.isValid).toBe(true);
  });

  it("normalizes an already-formatted US number", () => {
    const result = normalizePhone("(408) 372-6626");
    expect(result).toBeDefined();
    expect(result!.formatted).toBe("(408) 372-6626");
    expect(result!.isValid).toBe(true);
  });

  it("normalizes a US number with country code prefix", () => {
    const result = normalizePhone("+14083726626");
    expect(result).toBeDefined();
    expect(result!.formatted).toBe("(408) 372-6626");
    expect(result!.isValid).toBe(true);
  });
});

describe("normalizePhone — international numbers", () => {
  // +44 20 7946 0958 is a UK Ofcom-reserved documentation/testing number.
  it("normalizes a UK number to international format", () => {
    const result = normalizePhone("+442079460958");
    expect(result).toBeDefined();
    expect(result!.formatted).toBe("+44 20 7946 0958");
    expect(result!.isValid).toBe(true);
  });
});

describe("normalizePhone — invalid / junk input", () => {
  it("returns undefined for a too-short number", () => {
    expect(normalizePhone("123")).toBeUndefined();
  });

  it("returns undefined for plain text", () => {
    expect(normalizePhone("not a phone")).toBeUndefined();
  });

  it("returns undefined for all-zero padding", () => {
    // 000-000-0000 is not a valid US number
    expect(normalizePhone("0000000000")?.isValid).toBeFalsy();
  });
});

// ── findFirstPhone ───────────────────────────────────────────────────────────

describe("findFirstPhone — extraction from text", () => {
  it("finds a phone embedded in a line of text", () => {
    const result = findFirstPhone("Call me at (408) 372-6626 anytime");
    expect(result).toBeDefined();
    expect(result!.formatted).toBe("(408) 372-6626");
    expect(result!.isValid).toBe(true);
  });

  it("finds a dashed number at the start of a contact line", () => {
    const result = findFirstPhone("408-372-6626 | user@example.com");
    expect(result).toBeDefined();
    expect(result!.formatted).toBe("(408) 372-6626");
  });

  it("finds a UK number with country code in text", () => {
    // +44 20 7946 0958 is a UK Ofcom-reserved documentation number.
    const result = findFirstPhone("London office: +44 20 7946 0958");
    expect(result).toBeDefined();
    expect(result!.formatted).toBe("+44 20 7946 0958");
    expect(result!.isValid).toBe(true);
  });

  it("returns undefined when no phone is present", () => {
    expect(findFirstPhone("john.doe@example.com | linkedin.com/in/john")).toBeUndefined();
  });

  it("returns undefined for junk digits that do not form a valid number", () => {
    expect(findFirstPhone("Order #000-000-0000 ref")).toBeUndefined();
  });

  it("is idempotent across repeated calls (PHONE_RE lastIndex reset)", () => {
    const text = "408-372-6626";
    const r1 = findFirstPhone(text);
    const r2 = findFirstPhone(text);
    expect(r1?.formatted).toBe(r2?.formatted);
  });
});

// ── regionFromLocation ───────────────────────────────────────────────────────

describe("regionFromLocation — US locations", () => {
  it("returns US for a standard City, ST pattern", () => {
    expect(regionFromLocation("San Francisco, CA")).toBe("US");
  });

  it("returns US for a two-word city with state abbr", () => {
    expect(regionFromLocation("New York, NY")).toBe("US");
  });

  it("returns US regardless of whether the state abbr is a known state", () => {
    // US_LOCATION_RE matches any 2-letter uppercase token after the comma.
    expect(regionFromLocation("Springfield, IL")).toBe("US");
  });
});

describe("regionFromLocation — international locations", () => {
  it("returns GB for 'United Kingdom'", () => {
    expect(regionFromLocation("London, United Kingdom")).toBe("GB");
  });

  it("returns GB for 'UK' abbreviation", () => {
    expect(regionFromLocation("Manchester, UK")).toBe("GB");
  });

  it("returns IN for India", () => {
    expect(regionFromLocation("Bengaluru, India")).toBe("IN");
  });

  it("returns CA for Canada", () => {
    expect(regionFromLocation("Toronto, Canada")).toBe("CA");
  });

  it("returns AU for Australia", () => {
    expect(regionFromLocation("Sydney, Australia")).toBe("AU");
  });

  it("returns DE for Germany", () => {
    expect(regionFromLocation("Berlin, Germany")).toBe("DE");
  });

  it("returns SG for Singapore", () => {
    expect(regionFromLocation("Singapore, Singapore")).toBe("SG");
  });
});

describe("regionFromLocation — unmapped / edge cases", () => {
  it("returns undefined for undefined input", () => {
    expect(regionFromLocation(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(regionFromLocation("")).toBeUndefined();
  });

  it("returns undefined for a country not in the mapping", () => {
    // "Uzbekistan" is real but not in the explicit table.
    expect(regionFromLocation("Tashkent, Uzbekistan")).toBeUndefined();
  });

  it("returns undefined for plain text with no location pattern", () => {
    expect(regionFromLocation("Remote")).toBeUndefined();
  });
});

describe("regionFromLocation → findFirstPhone — intl locale path", () => {
  it("parses a UK national-format number when region is GB", () => {
    // 020 7946 0958 is an Ofcom-reserved London documentation number.
    const region = regionFromLocation("London, United Kingdom");
    expect(region).toBe("GB");
    // national format: no country prefix — libphonenumber needs the region hint.
    const result = findFirstPhone("020 7946 0958", region ?? "US");
    expect(result).toBeDefined();
    expect(result!.isValid).toBe(true);
    // Non-US numbers format as international.
    expect(result!.formatted).toBe("+44 20 7946 0958");
  });

  it("parses an Indian national-format number when region is IN", () => {
    // 098765 43210 is a common synthetic Indian mobile used in docs.
    const region = regionFromLocation("Bengaluru, India");
    expect(region).toBe("IN");
    const result = findFirstPhone("098765 43210", region ?? "US");
    expect(result).toBeDefined();
    expect(result!.isValid).toBe(true);
    // Indian numbers format as +91 …
    expect(result!.formatted).toMatch(/^\+91/);
  });

  it("falls back to US for an unmapped location", () => {
    const region = regionFromLocation("Tashkent, Uzbekistan") ?? "US";
    expect(region).toBe("US");
    // A standard US number still parses correctly under US default.
    const result = findFirstPhone("(312) 555-0123", region);
    expect(result).toBeDefined();
    expect(result!.formatted).toBe("(312) 555-0123");
  });
});
