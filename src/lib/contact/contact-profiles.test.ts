// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `deriveContactProfiles` is the ONE consolidated contact-link list the scorer +
 * ContactCard read since #427. These tests pin the load-bearing invariant: an
 * entry's `confidence` mirrors the source slot's `fieldConfidence`, so gating the
 * list at the 0.5 floor reproduces the pre-#427 `Boolean(slot) && conf >= floor`
 * read byte-for-byte — plus the `legacyKey` tagging and extras handling.
 */

import { describe, it, expect } from "vitest";
import {
  deriveContactProfiles,
  isProfileConfident,
  primaryProfileFor,
  CONTACT_LINK_CONFIDENCE_FLOOR,
} from "./contact-profiles.ts";
import type { ContactProfileSource } from "./contact-profiles.ts";

describe("deriveContactProfiles (#427)", () => {
  it("stamps each legacy slot with its legacyKey + fieldConfidence", () => {
    const parsed: ContactProfileSource = {
      linkedin_url: "https://linkedin.com/in/jane",
      github_url: "https://github.com/jane",
    };
    const out = deriveContactProfiles(parsed, {
      linkedin_url: 0.9,
      github_url: 0.4,
    });
    expect(out).toEqual([
      expect.objectContaining({
        network: "LinkedIn",
        kind: "social",
        legacyKey: "linkedin_url",
        confidence: 0.9,
      }),
      expect.objectContaining({
        network: "GitHub",
        kind: "code",
        legacyKey: "github_url",
        confidence: 0.4,
      }),
    ]);
  });

  it("defaults a slot with a value but no confidence entry to 0 (old `?? 0` gate)", () => {
    const out = deriveContactProfiles(
      { linkedin_url: "https://linkedin.com/in/jane" },
      {},
    );
    expect(out[0].confidence).toBe(0);
    // …so it does NOT clear the floor — byte-identical to the old gated read.
    expect(isProfileConfident(out[0])).toBe(false);
  });

  it("gates at the 0.5 floor: confident vs low-confidence", () => {
    const [confident] = deriveContactProfiles(
      { linkedin_url: "https://linkedin.com/in/a" },
      { linkedin_url: CONTACT_LINK_CONFIDENCE_FLOOR },
    );
    const [low] = deriveContactProfiles(
      { github_url: "https://github.com/a" },
      { github_url: 0.49 },
    );
    expect(isProfileConfident(confident)).toBe(true);
    expect(isProfileConfident(low)).toBe(false);
  });

  it("keeps a present-but-unclassifiable slot (presence must match Boolean(slot))", () => {
    const out = deriveContactProfiles(
      { linkedin_url: "not a url" },
      { linkedin_url: 1 },
    );
    expect(out).toHaveLength(1);
    expect(primaryProfileFor(out, "linkedin_url")).toBeDefined();
  });

  it("appends extras (profiles beyond the four slots) after, at confidence 1", () => {
    const parsed: ContactProfileSource = {
      linkedin_url: "https://linkedin.com/in/jane",
      profiles: [
        { url: "https://linkedin.com/in/jane", network: "LinkedIn", kind: "social" },
        { url: "https://gitlab.com/jane", network: "GitLab", kind: "code" },
      ],
    };
    const out = deriveContactProfiles(parsed, { linkedin_url: 0.9 });
    // The LinkedIn extra collapses into the legacy slot (same slug); GitLab rides
    // as an extra with no legacyKey, user-affirmed confidence.
    expect(out).toEqual([
      expect.objectContaining({ legacyKey: "linkedin_url", confidence: 0.9 }),
      expect.objectContaining({
        network: "GitLab",
        legacyKey: undefined,
        confidence: 1,
      }),
    ]);
  });

  it("returns [] when no slots and no extras", () => {
    expect(deriveContactProfiles({}, {})).toEqual([]);
  });
});
