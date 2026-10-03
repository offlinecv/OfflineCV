// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `EditSnapshot`'s own docblock rule (#768, restating #425 / #455): "Every
 * override map must appear here. A silently-absent one is exactly how `team`
 * (#425) and `achievementType` (#455) got dropped on restore." Those two
 * were caught by a hand-written repro AFTER shipping, one field at a time —
 * this is the systematic version: populate every channel `EditSnapshot`
 * lists (contact, experience, bullet, description, removed bullets,
 * education, achievement, certification, skills, summary, added entries +
 * bullets, profile links, removed entries) through the hook's own public
 * setters, snapshot it, replay onto a FRESH hook instance, and assert every
 * channel survived. A future field added to the interface but never wired
 * into `replay` fails here rather than on the next dropped edit.
 *
 * Storing this snapshot in the library and reproducing it via
 * `computeSavableResult` (#768) is exercised separately
 * (`edit-pipeline.test.ts`, `resume-library.test.ts`); this file is scoped to
 * the snapshot ↔ replay contract alone.
 */

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useEditableParse,
  parsedEntryKey,
  type EditableParse,
} from "./useEditableParse.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function mountProbe(): { api: () => EditableParse; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let current: EditableParse | undefined;
  function Probe() {
    current = useEditableParse();
    return null;
  }
  act(() => root.render(<Probe />));
  return {
    api: () => {
      if (!current) throw new Error("hook not mounted");
      return current;
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const harnesses: Array<{ unmount: () => void }> = [];
afterEach(() => {
  harnesses.splice(0).forEach((h) => h.unmount());
});

describe("EditSnapshot — every channel survives snapshot → replay (#768)", () => {
  it("populates every override map and reproduces them all on a fresh instance", () => {
    const source = mountProbe();
    harnesses.push(source);
    const s = source.api();

    let addedRoleId = "";
    let achId = "";
    act(() => {
      // contactOverrides
      s.setContactField("full_name", "Jane Q. Doe");
      // experienceOverrides — including `is_current` (#686), the newest key
      // in this map and exactly the shape #425/#455 were lost as.
      s.setExperienceField(0, "title", "Staff Engineer");
      s.setExperienceField(0, "is_current", true);
      // bulletOverrides — a plausible id shape ("<occurrence>|<normalized text>").
      s.setBulletField("0|shipped a thing", "Shipped a rewritten thing.");
      // descriptionOverrides
      s.setDescriptionField(parsedEntryKey("projects", 0), "Rewritten blurb.");
      // removedBullets
      s.removeBullet("1|dropped this");
      // educationOverrides
      s.setEducationField(0, "degree", "B.S. Computer Science");
      // achievementOverrides
      s.setAchievementField(0, "type", "Patent");
      // certificationOverrides
      s.setCertificationField(0, "type", "AWS Certified");
      // skillsOverride
      s.addSkill("Kubernetes");
      // summaryOverride ("" is a real, authoritative value — use non-empty here
      // so a dropped key is distinguishable from an intentional clear).
      s.setSummaryField("Rewritten summary.");
      // addedEntries + addedBullets
      addedRoleId = s.addEntry("experience");
      s.setEntryField(addedRoleId, "title", "Contract Engineer");
      s.setEntryField(addedRoleId, "team", "Platform Infrastructure");
      s.setEntryField(addedRoleId, "start_date", "2023");
      // `is_current` (#686) on an ADDED entry too — its own field, separate
      // from the override-map key above.
      s.setEntryField(addedRoleId, "is_current", true);
      s.addBullet(addedRoleId, "Shipped an integration.");
      // achievements' own added-entry fields (achievementType), on a SEPARATE
      // added entry — `team` and `achievementType` are the two fields #425 /
      // #455 actually lost.
      achId = s.addEntry("achievements");
      s.setEntryField(achId, "achievementType", "Patent");
      s.setEntryField(achId, "title", "US 11,123,456");
      // profileOverrides
      s.addProfile("https://github.com/janedoe");
      // removedEntries
      s.removeEntry(parsedEntryKey("education", 0));
    });

    // Re-fetch after `act()`: `s` was captured before the updates above
    // committed, so its `snapshot` is the pre-edit one. The hook's setters
    // stay stable across renders, but the returned object is a fresh literal
    // every render.
    const snap = source.api().snapshot;

    // Every key `EditSnapshot` declares is present and non-default — if a
    // future channel is added to the interface but this test is never
    // updated, that omission is caught by the exhaustiveness this describes,
    // not by this specific assertion (the replay side below is the one that
    // actually catches a forgotten `replay` wire-up).
    expect(Object.keys(snap.contactOverrides).length).toBeGreaterThan(0);
    expect(Object.keys(snap.experienceOverrides).length).toBeGreaterThan(0);
    expect(Object.keys(snap.bulletOverrides).length).toBeGreaterThan(0);
    expect(Object.keys(snap.descriptionOverrides ?? {}).length).toBeGreaterThan(0);
    expect(snap.removedBullets.length).toBeGreaterThan(0);
    expect(Object.keys(snap.educationOverrides).length).toBeGreaterThan(0);
    expect(Object.keys(snap.achievementOverrides ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(snap.certificationOverrides ?? {}).length).toBeGreaterThan(0);
    expect(snap.skillsOverride.added.length).toBeGreaterThan(0);
    expect(snap.summaryOverride).toBe("Rewritten summary.");
    expect(snap.addedEntries.length).toBe(2);
    expect(Object.keys(snap.addedBullets).length).toBeGreaterThan(0);
    expect((snap.profileOverrides ?? []).length).toBeGreaterThan(0);
    expect((snap.removedEntries ?? []).length).toBeGreaterThan(0);

    // Replay onto a completely FRESH instance — nothing carries over except
    // the snapshot itself.
    const target = mountProbe();
    harnesses.push(target);
    act(() => target.api().replay(snap));
    const t = target.api();

    expect(t.contactOverrides.full_name).toBe("Jane Q. Doe");
    expect(t.experienceOverrides[0]?.title).toBe("Staff Engineer");
    expect(t.experienceOverrides[0]?.is_current).toBe(true);
    expect(t.bulletOverrides["0|shipped a thing"]).toBe(
      "Shipped a rewritten thing.",
    );
    expect(t.descriptionOverrides[parsedEntryKey("projects", 0)]).toBe(
      "Rewritten blurb.",
    );
    expect(t.removedBullets.has("1|dropped this")).toBe(true);
    expect(t.educationOverrides[0]?.degree).toBe("B.S. Computer Science");
    expect(t.achievementOverrides[0]?.type).toBe("Patent");
    expect(t.certificationOverrides[0]?.type).toBe("AWS Certified");
    expect(t.skillsOverride.added).toContain("Kubernetes");
    expect(t.summaryOverride).toBe("Rewritten summary.");
    expect(t.addedEntries).toHaveLength(2);
    const restoredRole = t.addedEntries.find((e) => e.section === "experience");
    expect(restoredRole?.title).toBe("Contract Engineer");
    // `team` — the #425 field.
    expect(restoredRole?.team).toBe("Platform Infrastructure");
    // `is_current` — the #686 field, on the ADDED-entry side.
    expect(restoredRole?.is_current).toBe(true);
    const restoredAch = t.addedEntries.find((e) => e.section === "achievements");
    // `achievementType` — the #455 field.
    expect(restoredAch?.achievementType).toBe("Patent");
    expect(restoredAch?.title).toBe("US 11,123,456");
    expect(t.addedBullets[restoredRole!.id]).toEqual([
      "Shipped an integration.",
    ]);
    expect(t.profileOverrides).toHaveLength(1);
    expect(t.profileOverrides[0]?.url).toBe("https://github.com/janedoe");
    expect(t.removedEntries.has(parsedEntryKey("education", 0))).toBe(true);
  });
});
