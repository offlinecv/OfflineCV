// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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

  it("finds a US number whose digit groups are split by a Unicode en-dash (#29)", () => {
    // Word/LaTeX templates render the separator as U+2013, e.g. "(718) 555–0100".
    // The ASCII-only PHONE_RE pre-filter used to gate this out before the
    // libphonenumber call ever ran; mightHavePhone now folds Unicode dashes.
    const result = findFirstPhone("Phone: (718) 555–0100");
    expect(result).toBeDefined();
    expect(result!.formatted).toBe("(718) 555-0100");
  });

  it("finds a US number split by an em-dash and a figure-dash (#29)", () => {
    expect(findFirstPhone("(718) 555—0100")?.formatted).toBe(
      "(718) 555-0100",
    );
    expect(findFirstPhone("(718) 555‒0100")?.formatted).toBe(
      "(718) 555-0100",
    );
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

  it("does not fabricate a phone from experience date digits (#480)", () => {
    // 06/2017 – 03/2021 folds to 2017032021 -> "(201) 703-2021", a VALID NJ
    // number that appears nowhere in the résumé. An invalid-but-phone-shaped
    // number in the header is what opens the scan, so it must be present.
    const raw = "(555) 018-2390\nEXPERIENCE\nStaff Engineer, Acme\n06/2017 – 03/2021";
    expect(findFirstPhone(raw, "US")).toBeUndefined();
  });

  it("still finds a valid contact phone ahead of a date range (#480)", () => {
    const raw = "(312) 555-0123\n06/2017 – 03/2021";
    expect(findFirstPhone(raw, "US")?.formatted).toBe("(312) 555-0123");
  });

  it("does not fabricate a phone from a dot-separated date range (#480)", () => {
    // 11.2022 – 05.2020 folds to "(202) 205-2020", a VALID DC number that
    // appears nowhere in the résumé. Same fabrication as the slash-separated
    // case, via the `.` month/year separator instead of `/`.
    const raw = "(555) 018-2390\nEXPERIENCE\nStaff Engineer, Acme\n11.2022 – 05.2020";
    expect(findFirstPhone(raw, "US")).toBeUndefined();
  });

  it("finds a German number using '/' as its area-code separator (#480)", () => {
    // 030/12345678 is a real Berlin number shape — banning `/` outright to
    // reject the date-range fabrication above would also reject this.
    const result = findFirstPhone("Tel: 030/12345678", "DE");
    expect(result).toBeDefined();
    expect(result!.formatted).toBe("+49 30 12345678");
    expect(result!.isValid).toBe(true);
  });

  it("finds a Hong Kong number whose 4+4 digit grouping is not a date range (#1054)", () => {
    // 2872-1234 is two bare 4-digit groups joined by a dash — the same shape
    // as a fabricated year range. Neither group is year-shaped (1900-2099),
    // so RESUME_YEAR keeps FABRICATED_DATE_RANGE_RE from rejecting it.
    const result = findFirstPhone("Tel: 2872-1234", "HK");
    expect(result).toBeDefined();
    expect(result!.formatted).toBe("+852 2872 1234");
    expect(result!.isValid).toBe(true);
  });

  it("finds a Taiwanese number whose trailing 4+4 group is not a date range (#1054)", () => {
    // The trailing "2345-6789" of "02-2345-6789" parses as an MM/YYYY-shaped
    // anchor ("02-2345") joined to a bare "6789" — both fail RESUME_YEAR,
    // since 2345 and 6789 land outside 1900-2099.
    const result = findFirstPhone("Tel: 02-2345-6789", "TW");
    expect(result).toBeDefined();
    expect(result!.formatted).toBe("+886 2 2345 6789");
    expect(result!.isValid).toBe(true);
  });

  it("finds a Hong Kong number even when both 4-digit groups are year-shaped (#1054)", () => {
    // "2019-2021" is two bare 4-digit groups that are BOTH RESUME_YEAR-shaped
    // (19xx/20xx), the exact case FABRICATED_DATE_RANGE_RE alone would reject
    // as a date range. NANP has no native bare 4+4 grouping (an area code is
    // always 3+ digits), so isFabricatedDateRange only rejects this shape for
    // US/CA — a non-NANP region gets the benefit of the doubt and the real
    // number is returned.
    const result = findFirstPhone("Tel: 2019-2021", "HK");
    expect(result).toBeDefined();
    expect(result!.formatted).toBe("+852 2019 2021");
    expect(result!.isValid).toBe(true);
  });

  it("skips a rejected date-range hit and still finds a real number that follows it (#1054)", () => {
    // The fabrication-shaped span is not necessarily the LAST candidate in
    // the text — hits.find() must keep scanning past a rejected hit rather
    // than stopping at the first candidate.
    const raw =
      "EXPERIENCE\nStaff Engineer, Acme\n06/2017 – 03/2021\nContact: (312) 555-0123";
    const result = findFirstPhone(raw, "US");
    expect(result?.formatted).toBe("(312) 555-0123");
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
