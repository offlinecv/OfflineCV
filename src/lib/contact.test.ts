// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import {
  applyContactOverrides,
  buildContactFields,
  contactCompleteness,
  criticalDownloadGate,
  formatLinkDisplay,
  isScoreRevealed,
  CONTACT_DISPLAY_CONFIDENCE_FLOOR,
} from "./contact.ts";
import type { CascadeResult } from "./heuristics/types.ts";

// Minimal CascadeResult stub — only the fields buildContactFields reads.
function makeCascade(
  parsedOverrides: Partial<CascadeResult["parsed"]> = {},
  confidenceOverrides: Partial<CascadeResult["fieldConfidence"]> = {},
): Pick<CascadeResult, "parsed" | "fieldConfidence"> {
  return {
    parsed: {
      skills: [],
      experience: [],
      education: [],
      ...parsedOverrides,
    },
    fieldConfidence: confidenceOverrides,
  };
}

describe("buildContactFields", () => {
  it("returns the 5 required rows (no GitHub) when GitHub is absent", () => {
    const fields = buildContactFields(makeCascade());
    expect(fields).toHaveLength(5);
    expect(fields.map((f) => f.key)).toEqual([
      "full_name",
      "email",
      "phone",
      "linkedin_url",
      "location",
    ]);
  });

  it("includes the GitHub row only when it is confidently detected", () => {
    const fields = buildContactFields(
      makeCascade(
        { github_url: "https://github.com/jane" },
        { github_url: 0.95 },
      ),
    );
    expect(fields.map((f) => f.key)).toEqual([
      "full_name",
      "email",
      "phone",
      "linkedin_url",
      "github_url",
      "location",
    ]);
    const gh = fields.find((f) => f.key === "github_url")!;
    expect(gh.gated).toBe(false);
    expect(gh.value).toBe("https://github.com/jane");
  });

  it("omits the GitHub row when present but below the confidence floor", () => {
    const fields = buildContactFields(
      makeCascade(
        { github_url: "https://github.com/jane" },
        { github_url: CONTACT_DISPLAY_CONFIDENCE_FLOOR - 0.01 },
      ),
    );
    expect(fields.some((f) => f.key === "github_url")).toBe(false);
    expect(fields).toHaveLength(5);
  });

  it("shows a field (gated=false) when value is present and confidence is above the floor", () => {
    const fields = buildContactFields(
      makeCascade(
        { full_name: "Jane Doe" },
        { full_name: CONTACT_DISPLAY_CONFIDENCE_FLOOR },
      ),
    );
    const nameField = fields.find((f) => f.key === "full_name")!;
    expect(nameField.gated).toBe(false);
    expect(nameField.value).toBe("Jane Doe");
    expect(nameField.reason).toBeUndefined();
  });

  it("gates a low-confidence field but retains its value for subtle display (#146)", () => {
    const conf = CONTACT_DISPLAY_CONFIDENCE_FLOOR - 0.01;
    const fields = buildContactFields(
      makeCascade({ email: "jane@example.com" }, { email: conf }),
    );
    const emailField = fields.find((f) => f.key === "email")!;
    expect(emailField.gated).toBe(true);
    expect(emailField.reason).toBe("low_confidence");
    // Retained (not blanked) so the card can render it dotted/muted; `gated`
    // still keeps it out of the detected count and score-facing consumers.
    expect(emailField.value).toBe("jane@example.com");
  });

  it("gates a field with reason=absent when no value is present", () => {
    const fields = buildContactFields(makeCascade()); // no phone
    const phoneField = fields.find((f) => f.key === "phone")!;
    expect(phoneField.gated).toBe(true);
    expect(phoneField.reason).toBe("absent");
    expect(phoneField.value).toBe("");
  });

  it("shows all six fields when all are present and above the confidence floor", () => {
    const fields = buildContactFields(
      makeCascade(
        {
          full_name: "Jane Doe",
          email: "jane@example.com",
          phone: "555-0100",
          linkedin_url: "https://linkedin.com/in/jane",
          github_url: "https://github.com/jane",
          location: "San Francisco, CA",
        },
        {
          full_name: 0.9,
          email: 0.95,
          phone: 0.85,
          linkedin_url: 0.8,
          github_url: 0.8,
          location: 0.75,
        },
      ),
    );
    expect(fields.every((f) => !f.gated)).toBe(true);
    expect(fields.map((f) => f.value)).toEqual([
      "Jane Doe",
      "jane@example.com",
      "555-0100",
      "https://linkedin.com/in/jane",
      "https://github.com/jane",
      "San Francisco, CA",
    ]);
  });

  it("tags each row with its visual group (#146)", () => {
    const fields = buildContactFields(makeCascade());
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f.group]));
    expect(byKey.full_name).toBe("identity");
    expect(byKey.email).toBe("contact");
    expect(byKey.phone).toBe("contact");
    expect(byKey.location).toBe("contact");
    expect(byKey.linkedin_url).toBe("link");
  });

  it("includes portfolio and website link rows only when confidently detected (#146)", () => {
    const fields = buildContactFields(
      makeCascade(
        {
          portfolio_url: "https://jane.dev",
          website_url: "https://janedoe.com",
        },
        { portfolio_url: 0.9, website_url: 0.9 },
      ),
    );
    const portfolio = fields.find((f) => f.key === "portfolio_url");
    const website = fields.find((f) => f.key === "website_url");
    expect(portfolio?.group).toBe("link");
    expect(portfolio?.gated).toBe(false);
    expect(website?.gated).toBe(false);
    // Absent by default — no gap, no penalty.
    expect(buildContactFields(makeCascade()).some((f) => f.key === "portfolio_url")).toBe(false);
    expect(buildContactFields(makeCascade()).some((f) => f.key === "website_url")).toBe(false);
  });
});

describe("applyContactOverrides", () => {
  it("passes fields through untouched when no overrides given", () => {
    const fields = buildContactFields(makeCascade());
    expect(applyContactOverrides(fields, undefined)).toBe(fields);
  });

  it("a non-empty override marks an absent field detected", () => {
    const fields = buildContactFields(makeCascade());
    const out = applyContactOverrides(fields, { email: "jane@example.com" });
    const email = out.find((f) => f.key === "email");
    expect(email?.value).toBe("jane@example.com");
    expect(email?.gated).toBe(false);
    expect(email?.reason).toBeUndefined();
  });

  it("an empty-string override clears a detected field back to gated/absent", () => {
    const fields = buildContactFields(
      makeCascade({ email: "jane@example.com" }, { email: 0.95 }),
    );
    const out = applyContactOverrides(fields, { email: "" });
    const email = out.find((f) => f.key === "email");
    expect(email?.value).toBe("");
    expect(email?.gated).toBe(true);
    expect(email?.reason).toBe("absent");
  });
});

describe("contactCompleteness", () => {
  it("counts detected vs total and lists the gated required fields", () => {
    const fields = buildContactFields(
      makeCascade({ email: "jane@example.com" }, { email: 0.95 }),
    );
    const { detected, total, missing } = contactCompleteness(fields);
    // 5 required rows, only email detected.
    expect(total).toBe(5);
    expect(detected).toBe(1);
    expect(missing.map((f) => f.key)).toEqual([
      "full_name",
      "phone",
      "linkedin_url",
      "location",
    ]);
  });

  it("reports zero missing when every required field is detected", () => {
    const fields = buildContactFields(
      makeCascade(
        {
          full_name: "Jane Doe",
          email: "jane@example.com",
          phone: "(312) 555-0100",
          linkedin_url: "https://linkedin.com/in/jane",
          location: "Chicago, IL",
        },
        {
          full_name: 0.9,
          email: 0.95,
          phone: 0.9,
          linkedin_url: 0.8,
          location: 0.8,
        },
      ),
    );
    const { detected, total, missing } = contactCompleteness(fields);
    expect(detected).toBe(5);
    expect(total).toBe(5);
    expect(missing).toHaveLength(0);
  });
});

describe("criticalDownloadGate", () => {
  it("returns nothing when name, a contact method, and experience are all present", () => {
    const fields = buildContactFields(
      makeCascade(
        { full_name: "Jane Doe", email: "jane@example.com" },
        { full_name: 0.9, email: 0.95 },
      ),
    );
    expect(criticalDownloadGate(fields, true)).toEqual([]);
  });

  it("flags Name when full_name is gated (absent or low-confidence)", () => {
    const fields = buildContactFields(
      makeCascade({ email: "jane@example.com" }, { email: 0.95 }),
    );
    const items = criticalDownloadGate(fields, true);
    expect(items).toEqual([{ key: "full_name", label: "Name" }]);
  });

  it("does NOT flag contact when only one of email/phone is present", () => {
    const fields = buildContactFields(
      makeCascade(
        { full_name: "Jane Doe", email: "jane@example.com" },
        { full_name: 0.9, email: 0.95 },
      ),
    );
    // phone absent, email present — should not trigger the contact gap.
    expect(criticalDownloadGate(fields, true)).toEqual([]);
  });

  it("flags contact only when BOTH email and phone are gated", () => {
    const fields = buildContactFields(
      makeCascade({ full_name: "Jane Doe" }, { full_name: 0.9 }),
    );
    const items = criticalDownloadGate(fields, true);
    expect(items).toEqual([
      { key: "contact", label: "Contact (email or phone)" },
    ]);
  });

  it("flags experience when hasExperience is false", () => {
    const fields = buildContactFields(
      makeCascade(
        { full_name: "Jane Doe", phone: "(312) 555-0100" },
        { full_name: 0.9, phone: 0.9 },
      ),
    );
    const items = criticalDownloadGate(fields, false);
    expect(items).toEqual([{ key: "experience", label: "Experience" }]);
  });

  it("flags all three in order when nothing is present", () => {
    const fields = buildContactFields(makeCascade());
    const items = criticalDownloadGate(fields, false);
    expect(items).toEqual([
      { key: "full_name", label: "Name" },
      { key: "contact", label: "Contact (email or phone)" },
      { key: "experience", label: "Experience" },
    ]);
  });
});

describe("isScoreRevealed", () => {
  // #313 — shared score-reveal predicate for both the upload path (Result)
  // and the from-scratch authoring path (App's "authoring" branch).

  it("is false for a blank/empty resume (no contact, no experience)", () => {
    const cascade = makeCascade();
    expect(isScoreRevealed(cascade, undefined)).toBe(false);
  });

  it("is false when experience is missing even though contact is complete", () => {
    const cascade = makeCascade(
      { full_name: "Jane Doe", email: "jane@example.com" },
      { full_name: 0.9, email: 0.95 },
    );
    expect(isScoreRevealed(cascade, undefined)).toBe(false);
  });

  it("is false when contact is missing even though experience is present", () => {
    const cascade = makeCascade({
      experience: [
        {
          title: "Engineer",
          company: "Acme",
          start_date: "2020",
          end_date: "2022",
          description: "",
        },
      ],
    });
    expect(isScoreRevealed(cascade, undefined)).toBe(false);
  });

  it("is true once contact (name + email/phone) and experience are both present", () => {
    const cascade = makeCascade(
      {
        full_name: "Jane Doe",
        email: "jane@example.com",
        experience: [
          {
            title: "Engineer",
            company: "Acme",
            start_date: "2020",
            end_date: "2022",
            description: "",
          },
        ],
      },
      { full_name: 0.9, email: 0.95 },
    );
    expect(isScoreRevealed(cascade, undefined)).toBe(true);
  });

  it("flips true once an inline edit fills the missing contact field", () => {
    const cascade = makeCascade({
      experience: [
        {
          title: "Engineer",
          company: "Acme",
          start_date: "2020",
          end_date: "2022",
          description: "",
        },
      ],
    });
    expect(isScoreRevealed(cascade, undefined)).toBe(false);
    expect(
      isScoreRevealed(cascade, {
        full_name: "Jane Doe",
        email: "jane@example.com",
      }),
    ).toBe(true);
  });
});

describe("formatLinkDisplay", () => {
  it("keeps the host+path for a LinkedIn profile (protocol/www/slash stripped)", () => {
    expect(formatLinkDisplay("https://www.linkedin.com/in/jane-doe")).toBe(
      "linkedin.com/in/jane-doe",
    );
    expect(formatLinkDisplay("https://linkedin.com/in/jane-doe/")).toBe(
      "linkedin.com/in/jane-doe",
    );
  });

  it("keeps the host+path for a GitHub profile", () => {
    expect(formatLinkDisplay("https://github.com/javery")).toBe(
      "github.com/javery",
    );
  });

  it("strips protocol/www/trailing-slash for other links", () => {
    expect(formatLinkDisplay("https://www.jane.dev/")).toBe("jane.dev");
    expect(formatLinkDisplay("http://janedoe.com/portfolio")).toBe(
      "janedoe.com/portfolio",
    );
  });
});
