// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import {
  localizeRoundtripHop,
  contactFieldChanges,
  harnessDiff,
  invariantFailures,
} from "./roundtrip.ts";
import { mkCascade } from "./__test-utils__.ts";

describe("localizeRoundtripHop", () => {
  it("emits no defects when nothing changed across the hop", () => {
    const before = mkCascade({ fields: { full_name: "Jordan Rivera" } });
    const after = mkCascade({ fields: { full_name: "Jordan Rivera" } });
    const out = localizeRoundtripHop(before, after);
    expect(out.defects).toEqual([]);
    expect(out.derived.renderThrewOnRoundtrip).toBe(false);
  });

  it("localizes roundtrip-contact-value-changed when a contact field drifts", () => {
    const before = mkCascade({ fields: { email: "a@example.com" } });
    const after = mkCascade({ fields: { email: "b@example.com" } });
    const out = localizeRoundtripHop(before, after);
    expect(out.defects).toEqual(["roundtrip-contact-value-changed"]);
    expect(out.derived.emailChangedAcrossRoundtrip).toBe(true);
    expect(out.derived.phoneChangedAcrossRoundtrip).toBe(false);
  });

  it("localizes roundtrip-experience-value-changed on a title drift", () => {
    const before = mkCascade({
      fields: { experience: [{ title: "Engineer", company: "Acme" }] },
    });
    const after = mkCascade({
      fields: { experience: [{ title: "Senior Engineer", company: "Acme" }] },
    });
    const out = localizeRoundtripHop(before, after);
    expect(out.defects).toEqual(["roundtrip-experience-value-changed"]);
    expect(out.derived.experienceChangedAcrossRoundtrip).toBe(true);
  });

  it("localizes roundtrip-render-crash when the hop never produced an `after`", () => {
    const before = mkCascade({ fields: { email: "a@example.com" } });
    const out = localizeRoundtripHop(before, undefined, "boom");
    expect(out.defects).toEqual(["roundtrip-render-crash"]);
    expect(out.derived.renderThrewOnRoundtrip).toBe(true);
  });

  it("contactFieldChanges reports each field independently", () => {
    const c1 = { full_name: "A", email: "a@x.com" } as never;
    const c3 = { full_name: "A", email: "b@x.com" } as never;
    const changes = contactFieldChanges(c1, c3);
    expect(changes.fullName).toBe(false);
    expect(changes.email).toBe(true);
  });
});

describe("harnessDiff / invariantFailures", () => {
  it("harnessDiff carries values; invariantFailures carries field names only", () => {
    const before = mkCascade({
      fields: { experience: [{ title: "Engineer", company: "Acme" }] },
    });
    const after = mkCascade({
      fields: { experience: [{ title: "Senior Engineer", company: "Acme" }] },
    });
    const values = harnessDiff(before, after);
    const mapping = invariantFailures(before, after);
    expect(values.experience[0]).toContain("Engineer");
    expect(mapping.experience).toEqual(["role[0].title"]);
  });
});
