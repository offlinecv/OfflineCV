// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression for #686 — `is_current` is now reachable from the edit lane
 * (the "Current role" checkbox), and withdrawing an end date that this
 * module's own pair rule used to drop the flag for must restore it.
 *
 * Same real-hook-plus-real-`applyOverrides` harness as
 * `useEditableParse.date-slot-sequence.repro.test.tsx`, for the same reason:
 * `applyNormalizedDateOverrides`'s own unit tests hand it a hand-written
 * `resolvedEntry`, which cannot reproduce the aliasing a SECOND commit
 * produces once `resolvedEntry` is the overrides-APPLIED entry from a real
 * re-render.
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
    { parsed, rawText: "raw", sections: makeSections(), observations: [] },
    { experienceOverrides: api.experienceOverrides },
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

/** One header-cell commit, wired the way `ReconstructedResume` wires it: the
 *  resolved entry is read off the CURRENT map, not captured once up front. */
function commit(
  parsed: HeuristicParsedResume,
  field: "start_date" | "end_date" | "is_current",
  value: string | boolean,
) {
  const resolved = appliedRole(parsed, api);
  act(() => api.setExperienceField(0, field, value, resolved));
}

describe("#686 — ticking/unticking 'Current role' from a parsed role", () => {
  it("marks a non-current role current and clears the End cell", () => {
    const parsed = parsedWith({ start_date: "2019", end_date: "2022" });

    commit(parsed, "is_current", true);
    expect(appliedRole(parsed, api).is_current).toBe(true);
    expect("end_date" in appliedRole(parsed, api)).toBe(false);
  });

  it("unticks an ongoing role without requiring an end date", () => {
    const parsed = parsedWith({ start_date: "2019", is_current: true });

    commit(parsed, "is_current", false);
    expect("is_current" in appliedRole(parsed, api)).toBe(false);
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2019" });
    expect("end_date" in appliedRole(parsed, api)).toBe(false);
  });

  it("still un-currents a role when an end date is typed after ticking (#682, unchanged)", () => {
    const parsed = parsedWith({ start_date: "2019", end_date: "2022" });

    commit(parsed, "is_current", true);
    commit(parsed, "end_date", "2025");
    expect(appliedRole(parsed, api)).toMatchObject({
      start_date: "2019",
      end_date: "2025",
    });
    expect("is_current" in appliedRole(parsed, api)).toBe(false);
  });
});

describe("#686 — withdrawing an end date restores the parsed flag", () => {
  it("drops the flag when an end date is committed, and restores it when that end date is withdrawn", () => {
    const parsed = parsedWith({ start_date: "2019", is_current: true });

    // Step 1 — End = 2022. An end date says the role ended (#672), so the
    // flag drops and the card would read "2019 – 2022".
    commit(parsed, "end_date", "2022");
    expect(appliedRole(parsed, api)).toMatchObject({
      start_date: "2019",
      end_date: "2022",
    });
    expect("is_current" in appliedRole(parsed, api)).toBe(false);

    // Step 2 — clear End. Before #686 this pinned `is_current: false`
    // forever; the role PARSED as ongoing, so withdrawing the end date that
    // justified the drop restores it.
    commit(parsed, "end_date", "");
    expect(appliedRole(parsed, api).is_current).toBe(true);
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2019" });
    expect("end_date" in appliedRole(parsed, api)).toBe(false);
  });

  it("does not resurrect a flag the role was never parsed with", () => {
    // Control: a role that was NOT parsed as ongoing stays not-current after
    // the same End-then-clear sequence — the restore targets the PARSED
    // value, not "whatever was true a moment ago".
    const parsed = parsedWith({ start_date: "2019" });

    commit(parsed, "end_date", "2022");
    expect(appliedRole(parsed, api)).toMatchObject({
      start_date: "2019",
      end_date: "2022",
    });

    commit(parsed, "end_date", "");
    expect("is_current" in appliedRole(parsed, api)).toBe(false);
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2019" });
    expect("end_date" in appliedRole(parsed, api)).toBe(false);
  });

  it("keeps the restore across a title edit sandwiched in between", () => {
    // The pristine `is_current` is cached off the FIRST commit seen for this
    // role, whichever field it lands on — an unrelated title edit between the
    // two date commits must not cost the restore.
    const parsed = parsedWith({ start_date: "2019", is_current: true });

    const resolved0 = appliedRole(parsed, api);
    act(() => api.setExperienceField(0, "title", "Senior Analyst", resolved0));

    commit(parsed, "end_date", "2022");
    commit(parsed, "end_date", "");
    expect(appliedRole(parsed, api).is_current).toBe(true);
    expect(appliedRole(parsed, api).title).toBe("Senior Analyst");
  });
});
