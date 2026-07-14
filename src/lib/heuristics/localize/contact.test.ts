// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { localizeContact, rawTextCandidates } from "./contact.ts";
import { mkCascade } from "./__test-utils__.ts";

describe("localizeContact", () => {
  it("emits no defects when every field is present", () => {
    const cascade = mkCascade({
      fields: {
        full_name: "Jordan Rivera",
        email: "jordan.rivera@example.com",
        phone: "(312) 555-0123",
        location: "Chicago, IL",
      },
      sections: { profile: ["Jordan Rivera", "jordan.rivera@example.com"] },
    });
    const out = localizeContact(cascade);
    expect(out.defects).toEqual([]);
    expect(out.derived).toEqual({
      emailInRawTextButNotParsed: false,
      phoneInRawTextButNotParsed: false,
      locationInRawTextButNotParsed: false,
    });
    expect(out.verify.map((v) => v.verdict)).toEqual(["ok", "ok", "ok"]);
  });

  it("localizes a PARSER-MISS when a field is empty but recoverable from rawText", () => {
    const cascade = mkCascade({
      fields: { email: undefined },
      rawText: "Contact jordan.rivera@example.com for details",
      sections: { profile: [] },
    });
    const out = localizeContact(cascade);
    expect(out.defects).toEqual(["contact-email-parser-miss"]);
    expect(out.derived.emailInRawTextButNotParsed).toBe(true);
    expect(
      out.verify.find((v) => v.field === "email")?.verdict,
    ).toBe("PARSER-MISS (in rawText, not in field)");
  });

  it("reports a genuinely absent field as absent-in-pdf, not a defect", () => {
    const cascade = mkCascade({
      fields: { phone: undefined },
      rawText: "no phone number anywhere in this document",
      sections: { profile: [] },
    });
    const out = localizeContact(cascade);
    expect(out.defects).toEqual([]);
    expect(out.derived.phoneInRawTextButNotParsed).toBe(false);
    expect(
      out.verify.find((v) => v.field === "phone")?.verdict,
    ).toBe("absent-in-pdf");
  });

  it("rawTextCandidates finds the first email/phone/location in loose text", () => {
    const cand = rawTextCandidates(
      "Reach me at a@example.com or (312) 555-0100, based in Austin, TX",
    );
    expect(cand.email).toBe("a@example.com");
    expect(cand.phone).toBeTruthy();
    expect(cand.location).toBeTruthy();
  });
});
