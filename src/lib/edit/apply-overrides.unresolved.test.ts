// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `applyOverrides` reports the bullet instructions it cannot land (#769).
 *
 * A stored override map replayed over a base that has moved since the delta
 * was written can name a line that is no longer there. The fold used to skip
 * such an entry silently; it now lists it on `unresolved`. These tests pin
 * that channel — what is reported, what is deliberately NOT reported (a
 * composing chain, a no-op edit, the accepted normalise-equal twin case) — and
 * that the fold's existing contract (pure, total, same output) is untouched.
 *
 * Kept apart from `apply-overrides.test.ts` on purpose: the issue's acceptance
 * criterion is that the existing file passes UNMODIFIED, so nothing here may
 * change it.
 */

import { describe, it, expect } from "vitest";
import { bulletId } from "../score/bullet-id.ts";
import { normalizeBulletText } from "../score/group-bullets.ts";
import { applyOverrides } from "./apply-overrides.ts";
import type { EditBase, EditOverrides } from "./apply-overrides.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { BulletObservation } from "../score/score.ts";
import { countWords } from "../score/score.ts";
import type { SectionedResume } from "../heuristics/sections.ts";

function obs(index: number, text: string): BulletObservation {
  return {
    text,
    id: bulletId(text, 0),
    index,
    hasMetric: false,
    startsWithActionVerb: false,
    wellFormedLength: false,
    wordCount: countWords(text),
  };
}

function makeSections(experience: readonly string[]): SectionedResume {
  const byName = new Map<string, readonly string[]>();
  byName.set("experience", experience);
  return {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

/** A base whose one role carries exactly `bullets`, in every container. */
function baseFor(bullets: readonly string[]): EditBase {
  const marked = bullets.map((b) => `• ${b}`);
  const parsed: HeuristicParsedResume = {
    full_name: "Jane Doe",
    skills: [],
    experience: [
      {
        title: "Engineer",
        company: "Acme",
        start_date: "2020",
        end_date: "2022",
        description: bullets.join("\n"),
      },
    ],
    education: [],
  };
  return {
    parsed,
    rawText: marked.join("\n"),
    sections: makeSections(marked),
    observations: [],
  };
}

const A = "Built the ingest pipeline";
const B = "Built the ingest pipeline handling 2M events/day";
const C = "Rebuilt the ingest pipeline to handle 2M events/day";

describe("applyOverrides — unresolved bullet instructions (#769)", () => {
  it("is empty on a clean fold and on an absent snapshot", () => {
    expect(applyOverrides(baseFor([A])).unresolved).toEqual([]);
    expect(applyOverrides(baseFor([A]), {}).unresolved).toEqual([]);
  });

  it("is empty when the delta is replayed over the base it was written for", () => {
    const delta: EditOverrides = { bulletOverrides: { [bulletId(A, 0)]: B } };
    const out = applyOverrides(baseFor([A]), delta);
    expect(out.unresolved).toEqual([]);
    expect(out.fields.experience[0].description).toBe(B);
  });

  it("reports an edit whose target the base has since rewritten", () => {
    // The delta was written against a base that read A; the standard résumé
    // then edited A to A′. Nothing normalises to A any more.
    const delta: EditOverrides = { bulletOverrides: { [bulletId(A, 0)]: B } };
    const movedBase = baseFor(["Built the ingest pipeline from scratch"]);
    const out = applyOverrides(movedBase, delta);

    expect(out.unresolved).toEqual([
      {
        channel: "bulletOverrides",
        key: bulletId(A, 0),
        text: normalizeBulletText(A),
        edited: B,
      },
    ]);
    // The base's own text shows through, untouched — the stale edit landed
    // nowhere, and nowhere is where it must land.
    expect(out.fields.experience[0].description).toBe(
      "Built the ingest pipeline from scratch",
    );
    expect(out.rawText).toBe("• Built the ingest pipeline from scratch");
  });

  it("reports a removal whose bullet the base has since deleted — no crash, no silent drop", () => {
    const delta: EditOverrides = { removedBullets: [bulletId(A, 0)] };
    const out = applyOverrides(baseFor(["Shipped the dashboard"]), delta);

    expect(out.unresolved).toEqual([
      { channel: "removedBullets", key: bulletId(A, 0), text: normalizeBulletText(A) },
    ]);
    expect(out.fields.experience[0].description).toBe("Shipped the dashboard");
  });

  it("does not report a composing intra-session chain (A→B, then B→C)", () => {
    // `id("B")` never exists in the BASE — only in the views the first entry
    // produced. "At its turn" is what keeps the chain off the report.
    const delta: EditOverrides = {
      bulletOverrides: { [bulletId(A, 0)]: B, [bulletId(B, 0)]: C },
    };
    const out = applyOverrides(baseFor([A]), delta);
    expect(out.unresolved).toEqual([]);
    expect(out.fields.experience[0].description).toBe(C);
  });

  it("reports every link of a chain whose base has moved, in fold order", () => {
    // Base moved from A to A′: the first entry cannot land, so the second —
    // which expected the first to have produced B — cannot either. Both are
    // stale, and both are listed in the order the fold consumed them.
    const delta: EditOverrides = {
      bulletOverrides: { [bulletId(A, 0)]: B, [bulletId(B, 0)]: C },
    };
    const out = applyOverrides(baseFor(["Something else entirely"]), delta);
    expect(out.unresolved.map((u) => u.key)).toEqual([
      bulletId(A, 0),
      bulletId(B, 0),
    ]);
  });

  it("does not report a no-op edit — there is nothing to write, stale or not", () => {
    const delta: EditOverrides = {
      // NOT the `edited === original` guard: that compares the raw replacement
      // against the key's NORMALISED text, so `A` !== `"built the ingest…"`.
      // This one folds, matches, and is unreported because it matched.
      bulletOverrides: {
        [bulletId(A, 0)]: A,
        [bulletId(A, 1)]: "", // empty — skipped before the fold
      },
    };
    const out = applyOverrides(baseFor([A]), delta);
    expect(out.unresolved).toEqual([]);
    expect(out.fields.experience[0].description).toBe(A);
  });

  it("reports a key that names nothing in either key space, with no `text`", () => {
    // `"0|"` — an id minted for a marker-only line (#660) — and a legacy
    // numeric index with no observation behind it are both inert forever.
    const delta: EditOverrides = {
      bulletOverrides: { "0|": "anything" },
      removedBullets: [7],
    };
    const out = applyOverrides(baseFor([A]), delta);
    expect(out.unresolved).toEqual([
      { channel: "bulletOverrides", key: "0|", edited: "anything" },
      { channel: "removedBullets", key: "7" },
    ]);
  });

  it("resolves a legacy numeric key through the observations, and reports it only when its text is gone", () => {
    const stillThere = applyOverrides(
      { ...baseFor([A]), observations: [obs(0, A)] },
      { bulletOverrides: { "0": B } },
    );
    expect(stillThere.unresolved).toEqual([]);
    expect(stillThere.fields.experience[0].description).toBe(B);

    const moved = applyOverrides(
      { ...baseFor(["Rewritten since"]), observations: [obs(0, A)] },
      { bulletOverrides: { "0": B } },
    );
    expect(moved.unresolved).toEqual([
      { channel: "bulletOverrides", key: "0", text: normalizeBulletText(A), edited: B },
    ]);

    // Same key space on the removal channel — and the same normalised `text`
    // an id key reports (#993).
    const removedGone = applyOverrides(
      { ...baseFor(["Rewritten since"]), observations: [obs(0, A)] },
      { removedBullets: [0] },
    );
    expect(removedGone.unresolved).toEqual([
      { channel: "removedBullets", key: "0", text: normalizeBulletText(A) },
    ]);

    // Normalised, not merely lowercased: the legacy branch collapses the
    // observation's internal whitespace too, exactly as an id's text is.
    const spaced = applyOverrides(
      { ...baseFor(["Rewritten since"]), observations: [obs(0, "Built  the   Ingest pipeline")] },
      { removedBullets: [0] },
    );
    expect(spaced.unresolved).toEqual([
      { channel: "removedBullets", key: "0", text: "built the ingest pipeline" },
    ]);
  });

  it("two normalise-identical bullets keep #648's semantics — occurrence stays a discriminator", () => {
    // Both instructions land, both texts are correct, nothing is reported:
    // each key consumes the earliest remaining match of its text.
    const delta: EditOverrides = {
      bulletOverrides: {
        [bulletId(A, 1)]: B,
        [bulletId(A, 0)]: C,
      },
    };
    const out = applyOverrides(baseFor([A, A]), delta);
    expect(out.unresolved).toEqual([]);
    expect(out.fields.experience[0].description?.split("\n").sort()).toEqual(
      [B, C].sort(),
    );
  });

  it("ACCEPTED LIMIT: a target rewritten while a normalise-equal twin survives lands on the twin, unreported", () => {
    // The delta targeted the first "A"; the base rewrote that line but a
    // second line still normalises to A. An id carries no position, so the
    // twin IS the target as far as the key can tell — the bounded placement
    // tiebreak `bullet-id.ts` documents, now across time. Pinned so a future
    // reader finds the decision in a test rather than re-deriving it, and so
    // an Option-B anchor that closes it has to update this deliberately.
    const delta: EditOverrides = { bulletOverrides: { [bulletId(A, 0)]: B } };
    const out = applyOverrides(baseFor(["Rewritten", "  built the ingest PIPELINE"]), delta);
    expect(out.unresolved).toEqual([]);
    expect(out.fields.experience[0].description).toBe(`Rewritten\n${B}`);
  });

  it("stays pure: the base is not mutated even when every instruction is stale", () => {
    const base = baseFor([A]);
    const before = JSON.stringify(base);
    applyOverrides(base, {
      bulletOverrides: { [bulletId("gone", 0)]: B },
      removedBullets: [bulletId("also gone", 0)],
    });
    expect(JSON.stringify(base)).toBe(before);
  });
});
