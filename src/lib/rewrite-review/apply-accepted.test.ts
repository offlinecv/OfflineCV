// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { alignBullets } from "./align-bullets.ts";
import {
  applyAcceptedBullets,
  resolveBulletActions,
  resolveSectionWrites,
  acceptedCount,
  type Decision,
} from "./apply-accepted.ts";

/** Build a decisions map from the aligned pairs by accepting the given ids. */
function accept(ids: string[]): Map<string, Decision> {
  return new Map(ids.map((id) => [id, "accepted" as const]));
}

describe("applyAcceptedBullets — matched replace", () => {
  const original = ["Managed a team of 5", "Wrote integration tests"];
  const proposed = ["Led a team of 5 engineers", "Wrote integration tests"];
  const pairs = alignBullets(original, proposed);

  it("undecided keeps every original (no silent changes)", () => {
    expect(applyAcceptedBullets(pairs, new Map())).toEqual(original);
  });

  it("accepting a matched pair replaces that original with the proposed text", () => {
    const matched = pairs.find((p) => p.kind === "matched" && p.originalIndex === 0)!;
    const out = applyAcceptedBullets(pairs, accept([matched.id]));
    expect(out).toEqual(["Led a team of 5 engineers", "Wrote integration tests"]);
  });

  it("rejecting a matched pair keeps the original", () => {
    const matched = pairs.find((p) => p.kind === "matched" && p.originalIndex === 0)!;
    const decisions = new Map<string, Decision>([[matched.id, "rejected"]]);
    expect(applyAcceptedBullets(pairs, decisions)).toEqual(original);
  });
});

describe("applyAcceptedBullets — additions", () => {
  const original = ["Shipped the API"];
  const proposed = ["Shipped the API", "Mentored two interns"];
  const pairs = alignBullets(original, proposed);

  it("accepting an addition inserts it", () => {
    const add = pairs.find((p) => p.kind === "added")!;
    expect(applyAcceptedBullets(pairs, accept([add.id]))).toEqual([
      "Shipped the API",
      "Mentored two interns",
    ]);
  });

  it("an un-accepted addition is not inserted", () => {
    expect(applyAcceptedBullets(pairs, new Map())).toEqual(["Shipped the API"]);
  });
});

describe("applyAcceptedBullets — removals", () => {
  const original = ["Shipped the API", "Did some filler work", "Wrote the docs"];
  const proposed = ["Shipped the API", "Wrote the docs"];
  const pairs = alignBullets(original, proposed);

  it("accepting a removal drops the original", () => {
    const del = pairs.find((p) => p.kind === "removed")!;
    expect(applyAcceptedBullets(pairs, accept([del.id]))).toEqual([
      "Shipped the API",
      "Wrote the docs",
    ]);
  });

  it("a rejected/undecided removal keeps the original", () => {
    expect(applyAcceptedBullets(pairs, new Map())).toEqual(original);
  });
});

describe("applyAcceptedBullets — edits", () => {
  const original = ["Managed a team of 5"];
  const proposed = ["Led a team of 5 engineers"];
  const pairs = alignBullets(original, proposed);
  const matched = pairs.find((p) => p.kind === "matched")!;

  it("an accepted edit overrides the proposed text", () => {
    const edits = new Map([[matched.id, "Directed a 5-person engineering team"]]);
    expect(applyAcceptedBullets(pairs, accept([matched.id]), edits)).toEqual([
      "Directed a 5-person engineering team",
    ]);
  });

  it("a blank edit falls back to the proposed text (never an empty bullet)", () => {
    const edits = new Map([[matched.id, "   "]]);
    expect(applyAcceptedBullets(pairs, accept([matched.id]), edits)).toEqual([
      "Led a team of 5 engineers",
    ]);
  });

  it("an edit without accept is inert", () => {
    const edits = new Map([[matched.id, "ignored"]]);
    expect(applyAcceptedBullets(pairs, new Map(), edits)).toEqual(original);
  });
});

describe("applyAcceptedBullets — combined M≠N scenario", () => {
  it("replace + remove + add together produce the right ordered list", () => {
    const original = ["Built feature A", "Old filler bullet", "Built feature C"];
    const proposed = [
      "Built and shipped feature A", // edit of #0
      "Built feature C", // match #2
      "Brand new achievement", // addition
    ];
    const pairs = alignBullets(original, proposed);
    // Accept everything the alignment produced.
    const out = applyAcceptedBullets(
      pairs,
      new Map(pairs.map((p) => [p.id, "accepted" as const])),
    );
    // Removal of #1 drops it; #0 replaced; #2 kept; addition lands in place.
    expect(out).toContain("Built and shipped feature A");
    expect(out).toContain("Built feature C");
    expect(out).toContain("Brand new achievement");
    expect(out).not.toContain("Old filler bullet");
    expect(out).toHaveLength(3);
  });
});

describe("resolveBulletActions", () => {
  it("emits replace/remove/add only for accepted, non-noop pairs", () => {
    // o0 reworded (replace), o1 dropped (remove), o2 unchanged (kept verbatim
    // via its proposed twin), plus a brand-new bullet (add).
    const original = ["Built feature A", "Old filler", "Kept verbatim exactly"];
    const proposed = [
      "Built and shipped feature A",
      "Kept verbatim exactly",
      "New bullet",
    ];
    const pairs = alignBullets(original, proposed);
    const actions = resolveBulletActions(
      pairs,
      new Map(pairs.map((p) => [p.id, "accepted" as const])),
    );

    const replaces = actions.filter((a) => a.kind === "replace");
    const removes = actions.filter((a) => a.kind === "remove");
    const adds = actions.filter((a) => a.kind === "add");

    expect(replaces).toEqual([
      { kind: "replace", originalIndex: 0, text: "Built and shipped feature A" },
    ]);
    expect(removes).toEqual([{ kind: "remove", originalIndex: 1 }]);
    expect(adds).toEqual([{ kind: "add", text: "New bullet" }]);
  });

  it("skips a matched-accept whose text is unchanged (no-op replace)", () => {
    const original = ["Unchanged bullet text here"];
    const proposed = ["Unchanged bullet text here"];
    const pairs = alignBullets(original, proposed);
    const actions = resolveBulletActions(
      pairs,
      new Map(pairs.map((p) => [p.id, "accepted" as const])),
    );
    expect(actions).toEqual([]);
  });

  it("ignores rejected/undecided pairs entirely", () => {
    const original = ["Built feature A"];
    const proposed = ["Built feature A reworded heavily now"];
    const pairs = alignBullets(original, proposed);
    expect(resolveBulletActions(pairs, new Map())).toEqual([]);
  });
});

describe("resolveSectionWrites — join section-relative index to obsIndex", () => {
  it("maps replace/remove originalIndex through obsIndices; adds pass through", () => {
    // original[0] replaced, original[1] removed, one pure add.
    const original = ["Managed a team of 5", "Filler bullet to drop"];
    const proposed = ["Led a team of 5 engineers", "Mentored two interns"];
    const pairs = alignBullets(original, proposed);
    // obsIndices: section bullet 0 → observation 12, bullet 1 → observation 7.
    const obsIndices = [12, 7];
    const writes = resolveSectionWrites(pairs, obsIndices, accept(pairs.map((p) => p.id)));

    const replace = writes.find((w) => w.kind === "replace");
    const remove = writes.find((w) => w.kind === "remove");
    const add = writes.find((w) => w.kind === "add");
    expect(replace).toMatchObject({ kind: "replace", obsIndex: 12 });
    expect(remove).toMatchObject({ kind: "remove", obsIndex: 7 });
    expect(add).toMatchObject({ kind: "add", text: "Mentored two interns" });
  });

  it("drops a write whose originalIndex has no (or a -1) observation index", () => {
    const original = ["Built feature A here", "Built feature B here"];
    const proposed = ["Built feature A reworded", "Built feature B reworded"];
    const pairs = alignBullets(original, proposed);
    // Second bullet maps to a -1 placeholder → its replace must be dropped.
    const writes = resolveSectionWrites(pairs, [9, -1], accept(pairs.map((p) => p.id)));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: "replace", obsIndex: 9 });
  });

  it("returns nothing when no pair is accepted", () => {
    const pairs = alignBullets(["a b c d"], ["a b c d e"]);
    expect(resolveSectionWrites(pairs, [3], new Map())).toEqual([]);
  });
});

describe("acceptedCount", () => {
  it("counts only accepted pairs", () => {
    const pairs = alignBullets(["a b c", "d e f"], ["a b c", "d e f", "g h i"]);
    const decisions = new Map<string, Decision>([
      [pairs[0]!.id, "accepted"],
      [pairs[1]!.id, "rejected"],
    ]);
    expect(acceptedCount(pairs, decisions)).toBe(1);
  });
});
