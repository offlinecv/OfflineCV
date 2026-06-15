// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { normalizePhone, findFirstPhone } from "./phone.ts";

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
