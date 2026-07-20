// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Persistence back-compat for the #427 contact-link consolidation.
 *
 * Before #427 a saved blank-authoring draft (`ocv_blank_draft`) carried contact
 * LINK edits on `contactOverrides` under the four legacy `*_url` keys and had no
 * `profileOverrides` list. `migrateBlankDraft` upconverts such a draft on read
 * into the consolidated shape without losing edits, and leaves a current-shape
 * draft unchanged. (The #322 resume library persists an opaque `CascadeResult`,
 * not override channels, so it needs no migration — see the return note.)
 */

import { describe, it, expect } from "vitest";
import { migrateBlankDraft, type BlankDraftSnapshot } from "./useResumeAnalysis.ts";

/** A pre-#427 draft: link edits on `contactOverrides`, no `profileOverrides`. */
function legacyDraft(): BlankDraftSnapshot {
  return {
    // Cast: the persisted pre-#427 shape carried extra `*_url` keys that the
    // current `ContactOverrides` type no longer declares.
    contactOverrides: {
      full_name: "Jane Doe",
      linkedin_url: "https://linkedin.com/in/jane",
      github_url: "https://github.com/jane",
    } as BlankDraftSnapshot["contactOverrides"],
    experienceOverrides: {},
    bulletOverrides: {},
    removedBullets: [],
    educationOverrides: {},
    skillsOverride: { removed: [], added: [] },
    addedEntries: [],
    addedBullets: {},
  } as unknown as BlankDraftSnapshot;
}

describe("migrateBlankDraft (#427 persistence back-compat)", () => {
  it("moves legacy contactOverrides link keys into legacyKey-tagged profileOverrides", () => {
    const out = migrateBlankDraft(legacyDraft());

    // Link keys are lifted out of contactOverrides…
    expect(
      (out.contactOverrides as Record<string, unknown>).linkedin_url,
    ).toBeUndefined();
    expect(
      (out.contactOverrides as Record<string, unknown>).github_url,
    ).toBeUndefined();
    // …non-link contact fields are preserved.
    expect(out.contactOverrides.full_name).toBe("Jane Doe");

    // …and re-expressed as corrections in the consolidated list, in the fixed
    // legacy precedence order (linkedin before github), classified + tagged.
    expect(out.profileOverrides).toEqual([
      expect.objectContaining({
        url: "https://linkedin.com/in/jane",
        network: "LinkedIn",
        kind: "social",
        legacyKey: "linkedin_url",
      }),
      expect.objectContaining({
        url: "https://github.com/jane",
        network: "GitHub",
        kind: "code",
        legacyKey: "github_url",
      }),
    ]);
  });

  it("leaves a current-shape draft (already consolidated) unchanged", () => {
    const current: BlankDraftSnapshot = {
      contactOverrides: { full_name: "Jane Doe" },
      experienceOverrides: {},
      bulletOverrides: {},
      removedBullets: [],
      educationOverrides: {},
      skillsOverride: { removed: [], added: [] },
      addedEntries: [],
      addedBullets: {},
      profileOverrides: [
        {
          id: "profile:0",
          url: "https://gitlab.com/jane",
          network: "GitLab",
          kind: "code",
        },
      ],
    };
    const out = migrateBlankDraft(current);
    expect(out.contactOverrides).toEqual({ full_name: "Jane Doe" });
    expect(out.profileOverrides).toEqual(current.profileOverrides);
  });

  it("is idempotent — re-migrating a migrated draft is a no-op", () => {
    const once = migrateBlankDraft(legacyDraft());
    const twice = migrateBlankDraft(once);
    expect(twice.profileOverrides).toEqual(once.profileOverrides);
    expect(twice.contactOverrides).toEqual(once.contactOverrides);
  });

  it("keeps an empty-string clear as an authoritative clear correction", () => {
    const draft = {
      ...legacyDraft(),
      contactOverrides: {
        linkedin_url: "",
      } as BlankDraftSnapshot["contactOverrides"],
    } as unknown as BlankDraftSnapshot;
    const out = migrateBlankDraft(draft);
    expect(out.profileOverrides).toEqual([
      expect.objectContaining({ url: "", legacyKey: "linkedin_url" }),
    ]);
  });
});
