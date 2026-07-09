// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import {
  classifyProfile,
  profilesFromUrls,
  PROFILE_HOSTS,
} from "./profile-registry.ts";

describe("classifyProfile — known hosts", () => {
  it("classifies GitHub as code and normalizes a scheme-less URL", () => {
    const p = classifyProfile("github.com/janedoe");
    expect(p).toEqual({
      url: "https://github.com/janedoe",
      network: "GitHub",
      kind: "code",
    });
  });

  it("classifies LinkedIn profiles as social", () => {
    expect(classifyProfile("https://www.linkedin.com/in/jane-doe")).toEqual({
      url: "https://www.linkedin.com/in/jane-doe",
      network: "LinkedIn",
      kind: "social",
    });
  });

  it("classifies non-GitHub code hosts (GitLab, Codeberg, Kaggle, Hugging Face)", () => {
    expect(classifyProfile("https://gitlab.com/jane")?.network).toBe("GitLab");
    expect(classifyProfile("https://codeberg.org/jane")?.kind).toBe("code");
    expect(classifyProfile("https://kaggle.com/jane")?.network).toBe("Kaggle");
    expect(classifyProfile("https://huggingface.co/jane")?.network).toBe(
      "Hugging Face",
    );
  });

  it("classifies portfolio / academic / writing hosts", () => {
    expect(classifyProfile("https://behance.net/jane")?.kind).toBe("portfolio");
    expect(classifyProfile("https://dribbble.com/jane")?.kind).toBe("portfolio");
    expect(classifyProfile("https://orcid.org/0000-0002-1825-0097")?.kind).toBe(
      "academic",
    );
    expect(
      classifyProfile("https://scholar.google.com/citations?user=abc")?.network,
    ).toBe("Google Scholar");
    expect(classifyProfile("https://jane.substack.com")?.kind).toBe("writing");
    expect(classifyProfile("https://medium.com/@jane")?.network).toBe("Medium");
  });

  it("matches subdomains of a registry host", () => {
    // (^|\.)github\.com$ must match a subdomain host, not just the bare host.
    expect(classifyProfile("https://gist.github.com/jane")?.network).toBe(
      "GitHub",
    );
  });
});

describe("classifyProfile — unknown hosts are kept, never dropped", () => {
  it("keeps an unknown host as { network: hostname, kind: 'other' }", () => {
    expect(classifyProfile("https://jane.dev/portfolio")).toEqual({
      url: "https://jane.dev/portfolio",
      network: "jane.dev",
      kind: "other",
    });
  });

  it("strips a leading www. from the unknown-host network label", () => {
    expect(classifyProfile("https://www.janedoe.io")?.network).toBe(
      "janedoe.io",
    );
  });

  it("returns undefined for empty / unparseable input", () => {
    expect(classifyProfile("")).toBeUndefined();
    expect(classifyProfile("   ")).toBeUndefined();
  });
});

describe("classifyProfile — LinkedIn non-profile exclusion", () => {
  it.each([
    "https://www.linkedin.com/company/acme",
    "https://linkedin.com/jobs/view/12345",
    "https://linkedin.com/feed/",
    "https://www.linkedin.com/school/mit",
  ])("does not classify a non-profile LinkedIn URL as social: %s", (url) => {
    const p = classifyProfile(url);
    expect(p).toBeDefined();
    expect(p?.kind).not.toBe("social");
    expect(p?.kind).toBe("other");
    expect(p?.network).toBe("linkedin.com");
  });

  it("still classifies a real LinkedIn profile as social", () => {
    expect(classifyProfile("https://linkedin.com/in/jane")?.kind).toBe("social");
  });
});

describe("profilesFromUrls — legacy-key mirror derivation (#335 Phase 1)", () => {
  it("builds an ordered array from the four legacy link values", () => {
    const profiles = profilesFromUrls([
      "https://linkedin.com/in/jane",
      "https://github.com/jane",
      "https://jane.dev",
      undefined,
    ]);
    expect(profiles.map((p) => p.network)).toEqual([
      "LinkedIn",
      "GitHub",
      "jane.dev",
    ]);
    expect(profiles.map((p) => p.kind)).toEqual(["social", "code", "other"]);
  });

  it("skips undefined entries and preserves precedence order", () => {
    const profiles = profilesFromUrls([
      undefined,
      "https://github.com/jane",
      undefined,
      "https://portfolio.example.com",
    ]);
    expect(profiles.map((p) => p.network)).toEqual([
      "GitHub",
      "portfolio.example.com",
    ]);
  });

  it("deduplicates the same link reached via more than one slot", () => {
    const profiles = profilesFromUrls([
      "https://github.com/jane",
      "github.com/jane/", // same identity, different form
    ]);
    expect(profiles).toHaveLength(1);
  });

  it("returns an empty array when no link is present", () => {
    expect(profilesFromUrls([undefined, undefined])).toEqual([]);
  });
});

describe("PROFILE_HOSTS — contributor-extensible registry", () => {
  it("every rule carries a match, network, and kind", () => {
    for (const rule of PROFILE_HOSTS) {
      expect(rule.match).toBeInstanceOf(RegExp);
      expect(typeof rule.network).toBe("string");
      expect(rule.network.length).toBeGreaterThan(0);
    }
  });
});
