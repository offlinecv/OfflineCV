// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `/jd-fit` grades edits through the SAME recipe as `/` (#648).
 *
 * `useJdFitResume` replays the user's `/` edit snapshot into its own edit layer
 * and folds it onto the pristine parse — so it is an override-applied grade, in
 * exactly the sense that makes `claimedBulletKeys` load-bearing. It used to call
 * `computeAnonymousAtsScore` directly, with no claimed keys, which is the whole
 * of #648's defect: the re-graded pool re-mints ids the live `bulletOverrides` /
 * `removedBullets` are already filed under, so B1 (an edit to one of two
 * identical bullets destroys the other), B2 (the second duplicate cannot be
 * removed) and B3 (an edit cycle diverges display from export) all reproduce
 * here for a real user, on a lane that ships. `src/hooks/useEditableParse.
 * duplicate-bullet-identity.repro.test.tsx` pins the same three on `/`.
 *
 * Every assertion below is an EQUALITY against `/`'s own pipeline rather than a
 * hand-written expected list: the claim is not "jd-fit produces this text", it
 * is "jd-fit produces what `/` produces from the same edits". A second lane that
 * drifts from the shared recipe fails here even if its own output looks
 * plausible in isolation.
 *
 * Mounted under `<StrictMode>` like `jd-fit/main.tsx` and
 * `useJdFitResume.test.tsx` — the handoff read and the replay are one-shot and
 * NOT idempotent.
 *
 * PII-free: synthetic persona, all fields fabricated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useJdFitResume, type JdFitResume } from "./useJdFitResume.ts";
import type { AnalyzedResume } from "../hooks/useAnalyzedResume.ts";
import type { EditSnapshot } from "../hooks/useEditableParse.ts";
import { writeJdFitHandoff, type JdFitHandoff } from "../lib/jd-fit-handoff.ts";
import { applyOverrides } from "../lib/edit/apply-overrides.ts";
import { scoreEditedResume } from "../lib/edit/score-edited.ts";
import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
  type BulletObservation,
} from "../lib/score/score.ts";
import { buildBlankResult } from "../lib/heuristics/empty-result.ts";
import { toCanonicalResume } from "../lib/heuristics/canonical.ts";
import type { SectionedResume } from "../lib/heuristics/sections.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** The duplicated line — a résumé that repeats a responsibility verbatim. */
const DUP = "Owned the release process end to end.";
const TAIL = "Reviewed 40 pull requests per month.";
const ALPHA = "Alpha shipped 12 releases with zero rollbacks.";
const BETA = "Beta shipped 20% faster releases.";

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

function sections(experience: readonly string[]): SectionedResume {
  const byName = new Map<string, readonly string[]>([["experience", experience]]);
  return {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

/** The pristine parse the handoff carries — one role, `lines` as its bullets. */
function baseResult(lines: readonly string[]): CascadeResult {
  const blank = buildBlankResult();
  return {
    ...blank,
    rawText: lines.map((b) => `• ${b}`).join("\n"),
    canonical: toCanonicalResume(
      {
        full_name: "Robin Vasquez",
        email: "robin.vasquez@example.com",
        phone: "(312) 555-0123",
        skills: ["typescript"],
        education: [],
        experience: [
          {
            title: "Staff Engineer",
            company: "Northwind Systems",
            start_date: "2020",
            end_date: "2024",
            description: lines.join("\n"),
          },
        ],
      },
      sections(lines.map((b) => `• ${b}`)),
      {},
    ),
  };
}

/** The pristine score the handoff carries, graded with NO claimed keys — the
 *  base parse has no edits against it (`assignBulletIds`' documented exception). */
function baseScore(base: CascadeResult): AnonymousAtsScore {
  return computeAnonymousAtsScore({
    parsed: base.canonical.fields,
    fieldConfidence: base.canonical.fieldConfidence,
    triggers: base.triggers,
    rawText: base.rawText,
    sections: base.canonical.sections,
  });
}

/** What `/` produces from the same base + the same two override maps — the
 *  reference every jd-fit assertion is compared against (`useAnalyzedResume`). */
function foldOnSlash(
  base: CascadeResult,
  observations: readonly BulletObservation[],
  bulletOverrides: Record<string, string>,
  removedBullets: ReadonlySet<string>,
): { displayed: string[]; described: string[] } {
  const core = applyOverrides(
    base.canonical.fields,
    base.rawText,
    base.canonical.sections,
    {},
    {},
    bulletOverrides,
    observations,
    {},
    { removed: [], added: [] },
    [],
    {},
    removedBullets,
    [],
    base.canonical.fieldConfidence,
  );
  const score = scoreEditedResume(core, base.triggers, [
    ...Object.keys(bulletOverrides),
    ...removedBullets,
  ]);
  return {
    displayed: (score.bullets ?? []).map((b) => b.text),
    described: describedOf(core.fields.experience[0].description),
  };
}

function describedOf(description: string | undefined): string[] {
  return (description ?? "").split("\n").filter((l) => l.length > 0);
}

let container: HTMLDivElement;
let root: Root;
let api: JdFitResume | null = null;
let BASE: CascadeResult;
let OBSERVATIONS: readonly BulletObservation[] = [];

function Probe() {
  // The local-DropZone lane is idle, so the handoff lane is the one under test.
  api = useJdFitResume({
    state: { phase: "idle" },
    edit: {},
    edited: null,
    reset: () => {},
  } as unknown as AnalyzedResume);
  return null;
}

/** Seed the handoff with the pristine parse + score and NO prior edits, then
 *  mount. Edits are then made HERE, on the jd-fit lane, which is the surface
 *  under test — a user who lands on /jd-fit and edits a bullet. */
function mountWith(lines: readonly string[]): void {
  BASE = baseResult(lines);
  OBSERVATIONS = baseScore(BASE).bullets ?? [];
  writeJdFitHandoff({
    result: BASE,
    score: baseScore(BASE),
    edit: EMPTY_EDIT,
  } as unknown as JdFitHandoff);
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

/** The live jd-fit surfaces: the graded rows the UI renders, and the résumé. */
function live(): { displayed: string[]; described: string[] } {
  expect(api, "jd-fit produced no résumé from the handoff").not.toBeNull();
  return {
    displayed: (api!.score.bullets ?? []).map((b) => b.text),
    described: describedOf(api!.parsed.experience[0].description),
  };
}

/** Commit an inline edit on the row jd-fit currently renders at `position`. */
function editRow(position: number, value: string): void {
  const id = (api!.score.bullets ?? [])[position]?.id;
  expect(id, `no bullet rendered at position ${position}`).toBeDefined();
  act(() => api!.edit.setBulletField(id, value));
}

/** Click "Remove bullet" on the row jd-fit currently renders at `position`. */
function removeRow(position: number): boolean {
  const id = (api!.score.bullets ?? [])[position]?.id;
  expect(id, `no bullet rendered at position ${position}`).toBeDefined();
  let recorded = false;
  act(() => {
    recorded = api!.edit.removeBullet(id);
  });
  return recorded;
}

/** `/`'s output for the edit state jd-fit currently holds. */
function reference(): { displayed: string[]; described: string[] } {
  return foldOnSlash(
    BASE,
    OBSERVATIONS,
    api!.edit.bulletOverrides,
    api!.edit.removedBullets,
  );
}

beforeEach(() => {
  (globalThis as { sessionStorage?: Storage }).sessionStorage =
    new MemoryStorage() as unknown as Storage;
  api = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("/jd-fit grades edits through the shared recipe (#648)", () => {
  it("B1 — keeps BOTH edits to two identical bullets, exactly as `/` does", () => {
    mountWith([DUP, DUP, TAIL]);

    editRow(0, ALPHA);
    expect(live().displayed).toEqual([ALPHA, DUP, TAIL]);

    editRow(1, BETA);

    // Two DISTINCT instructions. Without `claimedBulletKeys` the second edit
    // re-minted the first's id and overwrote it: ONE key, and ALPHA gone.
    expect(Object.keys(api!.edit.bulletOverrides)).toHaveLength(2);
    expect(Object.values(api!.edit.bulletOverrides)).toEqual([ALPHA, BETA]);
    expect(live().displayed).toEqual([ALPHA, BETA, TAIL]);
    expect(live().described).toEqual([ALPHA, BETA, TAIL]);
    // …and it is the SAME résumé `/` builds from the same two maps.
    expect(live()).toEqual(reference());
  });

  it("B2 — removes BOTH identical bullets, exactly as `/` does", () => {
    mountWith([DUP, DUP, TAIL]);

    expect(removeRow(0)).toBe(true);
    expect(live().displayed).toEqual([DUP, TAIL]);

    // The survivor: under a re-derived ordinal this re-minted the first
    // removal's key, `prev.has(id)` was already true, and the Set came back
    // unchanged — a silent no-op behind a "Removed · Undo" confirmation.
    expect(removeRow(0)).toBe(true);

    expect(api!.edit.removedBullets.size).toBe(2);
    expect(live().displayed).toEqual([TAIL]);
    expect(live().described).toEqual([TAIL]);
    expect(live()).toEqual(reference());
  });

  it("B3 — keeps an A→B→A→B edit cycle in sync, exactly as `/` does", () => {
    mountWith([DUP, TAIL]);

    editRow(0, ALPHA);
    editRow(0, DUP); // the user retypes the original text
    editRow(0, ALPHA); // …and re-applies the same edit

    // Under a re-derived ordinal the third write landed on the FIRST key, in
    // place, so the map was byte-identical to step 2: the row displayed ALPHA
    // while the résumé — and the JD coverage graded off it — still read DUP.
    expect(live().displayed).toEqual([ALPHA, TAIL]);
    expect(live().described).toEqual([ALPHA, TAIL]);
    expect(live()).toEqual(reference());
  });

  it("mints distinct ids across the two identical rows of one grade", () => {
    mountWith([DUP, DUP, TAIL]);
    const ids = (api!.score.bullets ?? []).map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
