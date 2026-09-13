// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression for the SECOND date edit on one role (#672).
 *
 * `applyNormalizedDateOverrides`'s own unit tests pass the same pristine pair on
 * both steps, which is not what production does and is why they could not see
 * this: `ReconstructedResume` hands `setExperienceField` `display.parsed`, the
 * overrides-APPLIED entry, so on the second edit the first edit's value is inside
 * the "base" the sparse write-back compares against — and the key deletes itself.
 *
 * Concretely, on a role parsed `{2019, 2022}`:
 *
 * ```
 *                     override map                       applied
 * step 1 clear Start  {start_date:"2022", end_date:""}   {s:"2022"}           ok
 * step 2 End = 2024   {end_date:"2024"}                  {s:"2019", e:"2024"} BUG
 * ```
 *
 * The 2019 the user cleared is back and the card re-renders it — #672's own
 * corruption, one edit later.
 *
 * So this drives the REAL hook and the REAL `applyOverrides`, re-deriving the
 * resolved entry between commits exactly as a re-render does. Every assertion is
 * on the APPLIED entry rather than on the override map, because the map is an
 * implementation detail and the applied entry is what the card renders and what
 * the exporter draws.
 *
 * Probe-component harness (the project has no @testing-library/react) — same
 * pattern as `useEditableParse.test.tsx`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useEditableParse, type EditableParse } from "./useEditableParse.ts";
import { applyOverrides } from "../lib/edit/apply-overrides.ts";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";
import type { SectionedResume } from "../lib/heuristics/sections.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function makeSections(): SectionedResume {
  return {
    byName: new Map() as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

function parsedWith(
  dates: { start_date?: string; end_date?: string; is_current?: boolean },
): HeuristicParsedResume {
  return {
    full_name: "Jane Candidate",
    email: "jane@example.com",
    phone: "(312) 555-0123",
    location: "Chicago, IL",
    skills: ["TypeScript"],
    experience: [
      {
        title: "Alpha Analyst",
        company: "Contoso",
        description: "Ran the alpha ledger.",
        ...dates,
      },
    ],
    education: [],
  };
}

/** What `ReconstructedResume` renders and hands back on the next commit: the
 *  overrides-APPLIED role, re-derived from the current map. */
function appliedRole(parsed: HeuristicParsedResume, api: EditableParse) {
  const applied = applyOverrides(
    {
      parsed,
      rawText: "raw",
      sections: makeSections(),
      observations: [],
    },
    {
      experienceOverrides: api.experienceOverrides,
    },
  );
  return applied.fields.experience[0];
}

let container: HTMLDivElement;
let root: Root;
let api: EditableParse;

function Probe() {
  api = useEditableParse();
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** One date-cell commit, wired the way the component wires it: the resolved
 *  entry is read off the CURRENT map, not captured once up front. */
function commit(
  parsed: HeuristicParsedResume,
  field: "start_date" | "end_date",
  value: string,
) {
  const resolved = appliedRole(parsed, api);
  act(() => api.setExperienceField(0, field, value, resolved));
}

describe("#672 — a second date edit resolves from what the card shows", () => {
  it("keeps the re-anchored start date when an end date is typed after it", () => {
    const parsed = parsedWith({ start_date: "2019", end_date: "2022" });

    // Step 1 — clear the Start cell. The end date becomes the anchor.
    commit(parsed, "start_date", "");
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2022" });
    expect("end_date" in appliedRole(parsed, api)).toBe(false);

    // Step 2 — type 2024 into the now-empty End cell. "2022 – 2024" is what the
    // card showed and what the user meant. The bug resurrected the cleared 2019.
    commit(parsed, "end_date", "2024");
    expect(appliedRole(parsed, api)).toMatchObject({
      start_date: "2022",
      end_date: "2024",
    });
  });

  it("clears the Start cell a second time instead of no-opping", () => {
    // Same aliasing, plainer symptom: with the previous override inside the
    // comparison base, the second clear wrote a key equal to "base" and deleted
    // itself, so the card snapped back to the value the user had just removed.
    const parsed = parsedWith({ start_date: "2019", end_date: "2022" });

    commit(parsed, "start_date", "");
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2022" });

    commit(parsed, "start_date", "");
    // Nothing is left to anchor the role, so both slots go.
    expect("start_date" in appliedRole(parsed, api)).toBe(false);
    expect("end_date" in appliedRole(parsed, api)).toBe(false);
  });

  it("still drops an override that lands back on the parsed value", () => {
    // The sparse write-back is what keeps `hasEdits` honest, and the fix must not
    // cost it: a first edit that re-types the parsed value stores nothing.
    const parsed = parsedWith({ start_date: "2019", end_date: "2022" });
    commit(parsed, "start_date", "2019");
    expect(api.experienceOverrides[0]).toEqual({});
  });

  it("gives up 'ongoing' when an end date is typed, and keeps it thereafter", () => {
    const parsed = parsedWith({ start_date: "2019", is_current: true });

    commit(parsed, "end_date", "2022");
    expect(appliedRole(parsed, api)).toMatchObject({
      start_date: "2019",
      end_date: "2022",
    });
    // The flag is DELETED, not stored as false: `applyExperienceHeaderOverrides`
    // drops the key, and `"is_current" in role` is what the round-trip gates and
    // `toJsonResume` read.
    expect("is_current" in appliedRole(parsed, api)).toBe(false);

    // A follow-up correction to the same cell must not resurrect the flag — the
    // second commit resolves against a pair the first one already collapsed.
    commit(parsed, "end_date", "2023");
    expect(appliedRole(parsed, api)).toMatchObject({
      start_date: "2019",
      end_date: "2023",
    });
    expect("is_current" in appliedRole(parsed, api)).toBe(false);
  });
});

describe("#814 — End typed before Start keeps both dates", () => {
  it("puts the re-anchored end date back when the real start date arrives", () => {
    // The regression this file exists to stop, one ordering later. On a role the
    // parser produced with NO dates, committing End first re-anchors 2022 into
    // the Start slot (#672's rule — a lone end date is not representable). The
    // user then types the start date they meant into the Start cell they can
    // see, and before #814 that overwrote the anchor: the 2022 was gone, with no
    // undo affordance pointing at it. `main` accumulated both, so this ordering
    // was a REGRESSION, not a pre-existing gap.
    const parsed = parsedWith({});

    commit(parsed, "end_date", "2022");
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2022" });
    expect("end_date" in appliedRole(parsed, api)).toBe(false);

    commit(parsed, "start_date", "2019");
    expect(appliedRole(parsed, api)).toMatchObject({
      start_date: "2019",
      end_date: "2022",
    });
  });

  it("puts it back after a cleared start re-anchored the pair", () => {
    // Same rule, reached from the other direction: clearing Start on {2019,2022}
    // re-anchors the 2022 exactly as an End-first commit does, so typing the
    // start date back in has to restore the end date rather than consume it.
    const parsed = parsedWith({ start_date: "2019", end_date: "2022" });

    commit(parsed, "start_date", "");
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2022" });

    commit(parsed, "start_date", "2020");
    expect(appliedRole(parsed, api)).toMatchObject({
      start_date: "2020",
      end_date: "2022",
    });
  });

  it("does not invent an end date from a start date the user typed as one", () => {
    // The control that makes the restore a rule rather than a guess: a Start
    // value the user typed into the Start cell was never relocated, so
    // correcting it is a plain overwrite. Only a value the rule MOVED out of the
    // End cell is owed a way back.
    const parsed = parsedWith({});

    commit(parsed, "start_date", "2022");
    commit(parsed, "start_date", "2019");
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2019" });
    expect("end_date" in appliedRole(parsed, api)).toBe(false);
  });

  it("does not resurrect an end date the user deliberately cleared", () => {
    // Nothing was relocated here either: the pair had a real start date all
    // along, so clearing End is a clear, and the next Start edit must not undo
    // it.
    const parsed = parsedWith({ start_date: "2019", end_date: "2022" });

    commit(parsed, "end_date", "");
    expect("end_date" in appliedRole(parsed, api)).toBe(false);

    commit(parsed, "start_date", "2020");
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2020" });
    expect("end_date" in appliedRole(parsed, api)).toBe(false);
  });

  it("does not turn the anchor into a range when the Start cell is blurred untouched", () => {
    // `EditableField.commit` (primitives/EditableField.tsx:208) fires from
    // onBlur with the untouched draft — no dirty check — so focusing the Start
    // cell and clicking away re-commits the value it is already showing. That is
    // the natural next click here, since the cell is showing a value the user
    // typed as an END date. A restore on that commit writes the anchor into both
    // slots and the export draws "2022 – 2022", which the parser reads back as a
    // real two-sided range.
    const parsed = parsedWith({});

    commit(parsed, "end_date", "2022");
    commit(parsed, "start_date", "2022");
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2022" });
    expect("end_date" in appliedRole(parsed, api)).toBe(false);
  });

  it("keeps the parking across an untouched blur, so the next real edit still restores", () => {
    // The other half: a stray blur must not DISARM the restore either, or the
    // start date typed after it loses the end date exactly as before.
    const parsed = parsedWith({});

    commit(parsed, "end_date", "2022");
    commit(parsed, "start_date", "2022"); // blur, nothing typed
    commit(parsed, "end_date", ""); // blur on the empty End cell too
    commit(parsed, "start_date", "2019");
    expect(appliedRole(parsed, api)).toMatchObject({
      start_date: "2019",
      end_date: "2022",
    });
  });

  it("does not restore against a pair another writer has replaced", () => {
    // The parking is keyed by the role's index, and a write that bypasses the
    // rule (`replay`, which passes no resolved entry) can leave the parked value
    // describing a pair that is no longer on screen. The restore is gated on the
    // parked value still BEING the anchor, so a stale one is dropped rather than
    // pushed into the End cell of a pair it never came from.
    const parsed = parsedWith({});

    commit(parsed, "end_date", "2022");
    act(() => api.setExperienceField(0, "start_date", "2020"));
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2020" });

    commit(parsed, "start_date", "2019");
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2019" });
    expect("end_date" in appliedRole(parsed, api)).toBe(false);
  });

  it("keeps Start-first ordering unchanged", () => {
    // The ordering that always worked, asserted beside the one that did not.
    const parsed = parsedWith({});

    commit(parsed, "start_date", "2019");
    commit(parsed, "end_date", "2022");
    expect(appliedRole(parsed, api)).toMatchObject({
      start_date: "2019",
      end_date: "2022",
    });
  });
});
