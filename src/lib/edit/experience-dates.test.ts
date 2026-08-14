// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The #672 date-anchor rule, asserted on values rather than on shape.
 *
 * What makes these worth reading: the SHAPES ARE INDISTINGUISHABLE downstream.
 * `{end_date: "2022"}` and `{start_date: "2022"}` draw the identical bare "2022"
 * into the exported header, and the parser reads that token as a start date on
 * the way back — so the only place the difference can be resolved is here, before
 * the value reaches the model.
 */

import { describe, it, expect } from "vitest";
import {
  applyNormalizedDateOverrides,
  applyNormalizedExperienceDates,
  normalizeExperienceDates,
  relocatedEndAnchor,
} from "./experience-dates.ts";

describe("normalizeExperienceDates", () => {
  it("leaves a two-sided range alone — it is representable as drawn", () => {
    expect(normalizeExperienceDates({ start_date: "2019", end_date: "2022" })).toEqual({
      start_date: "2019",
      end_date: "2022",
    });
  });

  it("leaves a lone start date alone — the #358 case already round-trips", () => {
    expect(normalizeExperienceDates({ start_date: "2022" })).toEqual({
      start_date: "2022",
    });
  });

  it("moves a lone end date into the anchor slot", () => {
    // The defect verbatim: exported as a bare "2022", re-parsed as a start date.
    // Doing it here makes the collapse the user's own edit, visible in the card,
    // instead of a silent rewrite inside Download-PDF.
    expect(normalizeExperienceDates({ end_date: "2022" })).toEqual({
      start_date: "2022",
    });
  });

  it("does not repeat the anchor as an end date", () => {
    // Guarding a tempting "fill both slots" variant: it draws "2022 – 2022",
    // which is a claim the résumé never made.
    const out = normalizeExperienceDates({ end_date: "May 2022" });
    expect(out.end_date).toBeUndefined();
    expect(out.start_date).toBe("May 2022");
  });

  it("treats a cleared field as absent, not as a value", () => {
    // The literal repro: the user clears the start date on a dated role. Before
    // #672 this stored `start_date: ""` beside a live `end_date` — the exact
    // unrepresentable pair, and unlike `location`/`team` two lines above it in
    // `applyExperienceHeaderOverrides`, the empty string was stored verbatim.
    expect(normalizeExperienceDates({ start_date: "", end_date: "2022" })).toEqual({
      start_date: "2022",
    });
    expect(normalizeExperienceDates({ start_date: "   ", end_date: "" })).toEqual({});
  });

  it("keeps is_current when there is a start date to anchor it", () => {
    expect(
      normalizeExperienceDates({ start_date: "2019", is_current: true }),
    ).toEqual({ start_date: "2019", is_current: true });
  });

  it("drops is_current when the anchor came from an end date", () => {
    // The pair is self-contradictory — ended AND ongoing — and the end date is
    // the half the user actually typed. Keeping the flag would read the role back
    // as "joined 2022, still there", the rewrite this module exists to stop.
    expect(
      normalizeExperienceDates({ end_date: "2022", is_current: true }),
    ).toEqual({ start_date: "2022" });
  });

  it("drops is_current when an end date sits beside the start date", () => {
    // The same rule as the case above, with an anchor to keep. It matters on its
    // own because this pair fails in the OPPOSITE direction: `experienceDateRange`
    // and the `AtsEntryFields` builder both let `is_current` win, so leaving the
    // flag on draws "2020 – Present" and silently discards the end date the user
    // typed — the #672 rewrite, pointing the other way.
    expect(
      normalizeExperienceDates({
        start_date: "2020",
        end_date: "2022",
        is_current: true,
      }),
    ).toEqual({ start_date: "2020", end_date: "2022" });
  });

  it("drops is_current when no date anchors it", () => {
    // `experienceDateRange` would draw a bare "Present" into the header, which
    // re-parses to no date field and no flag — the value is lost either way. It
    // is lost here at edit time, where the card shows it, instead of at download.
    expect(normalizeExperienceDates({ is_current: true })).toEqual({});
    expect(normalizeExperienceDates({ start_date: "", is_current: true })).toEqual({});
  });

  it("does not mutate its input", () => {
    const input = { start_date: "", end_date: "2022" };
    normalizeExperienceDates(input);
    expect(input).toEqual({ start_date: "", end_date: "2022" });
  });
});

describe("applyNormalizedExperienceDates", () => {
  it("deletes cleared keys rather than setting them to undefined", () => {
    // `"end_date" in entry` is how the round-trip gates tell absent from empty,
    // and `toJsonResume` serialises any own key it finds.
    const entry: { start_date?: string; end_date?: string; is_current?: boolean } = {
      start_date: "",
      end_date: "2022",
      is_current: true,
    };
    applyNormalizedExperienceDates(entry);
    expect(entry.start_date).toBe("2022");
    expect("end_date" in entry).toBe(false);
    expect("is_current" in entry).toBe(false);
  });

  it("leaves an already-canonical pair byte-identical", () => {
    const entry = { start_date: "2019", end_date: "2022" };
    applyNormalizedExperienceDates(entry);
    expect(entry).toEqual({ start_date: "2019", end_date: "2022" });
  });
});

describe("applyNormalizedDateOverrides", () => {
  // The two-step date sequence (#672), at the seam. Clearing the Start cell is
  // the case the issue is about; typing an end date after it is the case
  // render-only normalisation gets wrong.
  //
  // These cases hand a role with NO override yet, so the resolved entry and the
  // parse coincide and `prior` is empty. The sequence where they diverge — a
  // second edit, where the resolved entry already carries the first — cannot be
  // written honestly here, because it needs the real reducer feeding the real
  // `applyOverrides` output back in. That lives in
  // `hooks/useEditableParse.date-slot-sequence.repro.test.tsx`.
  const parsed = { start_date: "2019", end_date: "2022" };

  it("writes the collapsed pair back, so a later edit resolves from what the card shows", () => {
    // Clear the Start cell. The end date becomes the anchor, and that has to land
    // in the MAP; storing the raw `{start_date: ""}` is what let the next commit
    // discard the 2022 the user was looking at.
    const entry: Record<string, unknown> = { start_date: "" };
    applyNormalizedDateOverrides(entry, parsed);
    expect(entry).toEqual({ start_date: "2022", end_date: "" });
  });

  it("deletes a key whose normalised value already equals the parse", () => {
    // An override map is a delta. Storing a no-op edit keeps `hasEdits` true for
    // the rest of the session over a value the user never changed.
    const entry: Record<string, unknown> = { start_date: "2019" };
    applyNormalizedDateOverrides(entry, parsed);
    expect("start_date" in entry).toBe(false);
    expect("end_date" in entry).toBe(false);
  });

  it("keeps a key that ALREADY carries an override, even when it equals the resolved value", () => {
    // The delete-if-inert test is only valid where "resolved" is also "parsed",
    // i.e. on a key with no override yet. Once a key has one, the resolved entry
    // CONTAINS it — comparing against it would make the key delete itself and
    // resurrect the value the previous edit replaced. `prior` is what draws that
    // line.
    const resolved = { start_date: "2022" }; // = parse + `{start_date:"2022"}`
    const prior = { start_date: "2022", end_date: "" };
    const entry: Record<string, unknown> = { ...prior, end_date: "2024" };
    applyNormalizedDateOverrides(entry, resolved, prior);
    expect(entry).toEqual({ start_date: "2022", end_date: "2024" });
  });

  it("clears an unanchored 'ongoing' claim through the map", () => {
    // A bare "Present" with no start date draws into the header and re-parses to
    // nothing. Dropping the flag at edit time makes the loss visible.
    const current = { start_date: "2019", is_current: true };
    const entry: Record<string, unknown> = { start_date: "" };
    applyNormalizedDateOverrides(entry, current);
    expect(entry).toEqual({ start_date: "", is_current: false });
  });

  it("does not mutate the entry it resolves against", () => {
    const base = { start_date: "2019", end_date: "2022" };
    applyNormalizedDateOverrides({ start_date: "" }, base);
    expect(base).toEqual({ start_date: "2019", end_date: "2022" });
  });
});

describe("relocatedEndAnchor", () => {
  // The value the rule MOVES, which is the value a writer has to be able to hand
  // back (#814). Every case here is a pair the rule is about to rewrite — the
  // predicate reports what it takes out of the End cell, not what it leaves.
  it("reports the end date when there is no start date to anchor the pair", () => {
    expect(relocatedEndAnchor({ end_date: "2022" })).toBe("2022");
    expect(relocatedEndAnchor({ start_date: "", end_date: "2022" })).toBe("2022");
    expect(relocatedEndAnchor({ start_date: "  ", end_date: " 2022 " })).toBe("2022");
  });

  it("reports nothing when the pair has a start date of its own", () => {
    // Nothing moves, so nothing is owed: a two-sided range is representable, and
    // a lone start date is the shape the rule already leaves alone (#358).
    expect(relocatedEndAnchor({ start_date: "2019", end_date: "2022" })).toBeUndefined();
    expect(relocatedEndAnchor({ start_date: "2019" })).toBeUndefined();
  });

  it("reports nothing for a pair with no end date at all", () => {
    expect(relocatedEndAnchor({})).toBeUndefined();
    expect(relocatedEndAnchor({ end_date: "" })).toBeUndefined();
    expect(relocatedEndAnchor({ is_current: true })).toBeUndefined();
  });
});
