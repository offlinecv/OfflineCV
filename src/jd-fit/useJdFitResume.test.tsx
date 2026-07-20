// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Behavioral tests for the `/` → `/jd-fit` handoff (#456), exercised through a
 * probe component (the project has no @testing-library/react — same pattern as
 * `useAnalyzedResume.test.tsx`).
 *
 * The handoff hands over the PRISTINE parse plus the user's edit SNAPSHOT, and
 * /jd-fit replays the snapshot into its own edit layer. These tests pin the two
 * properties that made the previous design (hand over the override-APPLIED
 * result, start /jd-fit with an empty edit layer) wrong:
 *
 *   - the user's edits arrive, AND stay edits — an entry they added is still an
 *     added entry here, so it keeps its Remove button and its bullets;
 *   - replay is additive, so it must run exactly once — a naive re-seed appended
 *     every added entry a second time on the next render.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useJdFitResume, type JdFitResume } from "./useJdFitResume.ts";
import type { AnalyzedResume } from "../hooks/useAnalyzedResume.ts";
import type { EditSnapshot } from "../hooks/useEditableParse.ts";
import {
  JDFIT_HANDOFF_KEY,
  writeJdFitHandoff,
  type JdFitHandoff,
} from "../lib/jd-fit-handoff.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

const EMPTY_EDIT: EditSnapshot = {
  contactOverrides: {},
  experienceOverrides: {},
  bulletOverrides: {},
  removedBullets: [],
  educationOverrides: {},
  achievementOverrides: {},
  skillsOverride: { removed: [], added: [] },
  addedEntries: [],
  addedBullets: {},
  profileOverrides: [],
};

/** A pristine parse carrying one mis-typed achievement — the correction below
 *  is exactly the kind of edit that has to survive the navigation. */
function pristineResult(): CascadeResult {
  return {
    canonical: {
      fields: {
        full_name: "Jane Candidate",
        skills: [],
        experience: [],
        education: [],
        heuristic_achievements: [
          { type: "Pantent", title: "Bulk catalog editor" },
        ],
        projects: [
          { name: "Ledger", description: "Old prose blurb." },
        ],
      },
      sections: {
        byName: new Map<string, readonly string[]>(),
        accomplishmentSections: ["experience", "projects", "achievements"],
        source: "regex",
      },
      fieldConfidence: {},
    },
    confidence: 1,
    triggers: [],
    linkAnnotations: [],
    rawText: "",
  } as unknown as CascadeResult;
}

/** The local-DropZone lane, idle — so the handoff lane is the one under test. */
const IDLE_ANALYZED = {
  state: { phase: "idle" },
  edit: {},
  edited: null,
  reset: () => {},
} as unknown as AnalyzedResume;

let container: HTMLDivElement;
let root: Root;
let api: JdFitResume | null;

function Probe() {
  api = useJdFitResume(IDLE_ANALYZED);
  return null;
}

/** Mount under `<StrictMode>` — both entry points do (`jd-fit/main.tsx`), and
 *  the effects here are one-shot and NOT idempotent: the handoff read clears
 *  sessionStorage, and replay appends. StrictMode's dev-only double-invoke is
 *  precisely what surfaces a guard that doesn't hold, so the tests have to run
 *  the way the app does. Mounting bare hid a real bug (#456 review). */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    ),
  );
}

function seedHandoff(edit: EditSnapshot): void {
  writeJdFitHandoff({
    result: pristineResult(),
    score: { overall: 60, bullets: [] },
    edit,
  } as unknown as JdFitHandoff);
}

beforeEach(() => {
  (globalThis as { sessionStorage?: Storage }).sessionStorage =
    new MemoryStorage() as unknown as Storage;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("useJdFitResume — the handoff carries edit STATE (#456)", () => {
  it("replays a field correction from `/` onto the pristine parse", () => {
    seedHandoff({
      ...EMPTY_EDIT,
      contactOverrides: { full_name: "Jane Q. Candidate" },
      achievementOverrides: { 0: { type: "Patent" } },
    });
    mount();

    expect(api?.parsed.full_name).toBe("Jane Q. Candidate");
    // The achievement override lands on the real `type` field — the title is
    // untouched, and nothing re-derived either from a composed string.
    expect(api?.parsed.heuristic_achievements?.[0]).toMatchObject({
      type: "Patent",
      title: "Bulk catalog editor",
    });
  });

  it("replays a prose-description edit onto the pristine parse (#489)", () => {
    // A prose-body project blurb the user rewrote on `/` must apply to the
    // displayed/exported résumé here, not silently drop back to the original —
    // the 16th `applyOverrides` arg the handoff caller had missed.
    seedHandoff({
      ...EMPTY_EDIT,
      descriptionOverrides: { "projects:0": "New rewritten blurb." },
    });
    mount();

    expect(api?.parsed.projects?.[0].description).toBe("New rewritten blurb.");
  });

  it("keeps a user-ADDED entry editable here — it does not arrive baked in", () => {
    seedHandoff({
      ...EMPTY_EDIT,
      addedEntries: [
        {
          id: "added:0",
          section: "achievements",
          achievementType: "Talk",
          title: "KubeCon",
          year: "2024",
        },
      ],
    });
    mount();

    // It shows up in the résumé...
    const achievements = api?.parsed.heuristic_achievements ?? [];
    expect(achievements).toHaveLength(2);
    expect(achievements[1]).toMatchObject({ type: "Talk", title: "KubeCon" });
    // ...AND it is still an ADDED entry, not a parsed one. This is what the
    // old applied-result handoff destroyed: /jd-fit saw two parsed achievements
    // and no way to remove the one the user had added.
    expect(api?.edit.addedEntries).toHaveLength(1);
    expect(api?.edit.addedEntries[0].section).toBe("achievements");
  });

  it("replays exactly once — editing here does not re-append the added entry", () => {
    seedHandoff({
      ...EMPTY_EDIT,
      addedEntries: [
        { id: "added:0", section: "achievements", title: "KubeCon" },
      ],
    });
    mount();
    expect(api?.edit.addedEntries).toHaveLength(1);

    // Replay is ADDITIVE — `addEntry` mints a fresh id per call, so replaying a
    // second time would append a DUPLICATE rather than converge. Drive the
    // renders a real session drives: edits on /jd-fit, each re-running the
    // apply memo and the replay effect's dependency check.
    act(() => api!.edit.setContactField("full_name", "Jane Q. Candidate"));
    act(() => api!.edit.setAchievementField(0, "type", "Patent"));

    expect(api?.edit.addedEntries).toHaveLength(1);
    expect(api?.parsed.heuristic_achievements).toHaveLength(2);
    // The local edits still apply on top of the replayed ones.
    expect(api?.parsed.full_name).toBe("Jane Q. Candidate");
    expect(api?.parsed.heuristic_achievements?.[0].type).toBe("Patent");
  });

  it("survives StrictMode's double effect invoke — the handoff lands, once", () => {
    // Both one-shot effects here are non-idempotent, and StrictMode runs an
    // effect setup→cleanup→setup in one commit with no re-render between, so a
    // `useState` guard captures the same stale closure in both setups and does
    // not short-circuit. Two distinct failures if the guards aren't refs:
    //   - the handoff READ clears sessionStorage → the second read returns null
    //     → `setHandoff(null)` wins → the résumé vanishes and /jd-fit shows the
    //     DropZone (dev only, but the feature is simply broken there);
    //   - REPLAY appends → the added entry lands twice.
    seedHandoff({
      ...EMPTY_EDIT,
      addedEntries: [
        { id: "added:0", section: "achievements", title: "KubeCon" },
      ],
    });
    mount();

    expect(api).not.toBeNull();
    expect(api?.edit.addedEntries).toHaveLength(1);
    expect(api?.parsed.heuristic_achievements).toHaveLength(2);
  });

  it("consumes the handoff — the key is cleared so a reload falls back to the DropZone", () => {
    seedHandoff(EMPTY_EDIT);
    mount();
    expect(api).not.toBeNull();
    expect(globalThis.sessionStorage.getItem(JDFIT_HANDOFF_KEY)).toBeNull();
  });

  it("returns null with no handoff and an idle local lane", () => {
    mount();
    expect(api).toBeNull();
  });
});
