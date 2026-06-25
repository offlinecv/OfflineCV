// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import {
  buildContactFields,
  formatLinkDisplay,
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

describe("formatLinkDisplay", () => {
  it("collapses a LinkedIn profile to in/<slug>", () => {
    expect(formatLinkDisplay("https://www.linkedin.com/in/jane-doe")).toBe(
      "in/jane-doe",
    );
    expect(formatLinkDisplay("https://linkedin.com/in/jane-doe/")).toBe(
      "in/jane-doe",
    );
  });

  it("collapses a GitHub profile to gh/<slug>", () => {
    expect(formatLinkDisplay("https://github.com/javery")).toBe("gh/javery");
  });

  it("falls back to the stripped host+path for other links", () => {
    expect(formatLinkDisplay("https://www.jane.dev/")).toBe("jane.dev");
    expect(formatLinkDisplay("http://janedoe.com/portfolio")).toBe(
      "janedoe.com/portfolio",
    );
  });
});
