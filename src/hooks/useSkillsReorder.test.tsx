// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * useSkillsReorder — the apply/undo/dismiss lifecycle around the pure
 * `computeSkillsOrderFinding` heuristic (#544). The heuristic's own scoring
 * rules are covered directly in `lib/heuristics/skills-order.test.ts`; this
 * file covers the STATEFUL wiring: apply writes through `reorderSkills`,
 * undo reverts to the pre-apply order, and `canApply` reflects a category
 * snapshot. Exercised through a probe component — the project has no
 * @testing-library/react (same pattern as `useEditableParse.test.tsx`).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import { useSkillsReorder, type SkillsReorderController } from "./useSkillsReorder.ts";
import type { SkillCategory } from "../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const SKILLS = ["Docker", "AWS", "Kubernetes", "Engineering Leadership", "Terraform"];
const TITLES = ["Engineering Manager"];

let container: HTMLDivElement;
let root: Root;
let api: SkillsReorderController;
let writes: string[][];

function Probe({
  skillCategories,
}: {
  skillCategories?: SkillCategory[];
}) {
  const [skills, setSkills] = useState<string[]>(SKILLS);
  const reorderSkills = (order: readonly string[]) => {
    writes.push([...order]);
    setSkills([...order]);
  };
  api = useSkillsReorder(skills, skillCategories, TITLES, reorderSkills);
  return null;
}

beforeEach(() => {
  writes = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useSkillsReorder", () => {
  it("starts with a finding, not applied, and canApply true (flat skills)", () => {
    expect(api.finding?.buried).toEqual(["Engineering Leadership"]);
    expect(api.canApply).toBe(true);
    expect(api.applied).toBe(false);
  });

  it("apply() writes the suggested order and flips to applied", () => {
    act(() => api.apply());
    expect(writes).toEqual([
      ["Engineering Leadership", "Docker", "AWS", "Kubernetes", "Terraform"],
    ]);
    expect(api.applied).toBe(true);
    // Reordered — the finding recomputes to undefined (no longer buried).
    expect(api.finding).toBeUndefined();
  });

  it("undo() reverts to the pre-apply order and clears applied", () => {
    act(() => api.apply());
    act(() => api.undo());
    expect(writes[1]).toEqual(SKILLS);
    expect(api.applied).toBe(false);
    // Back to the original order — the finding fires again.
    expect(api.finding?.buried).toEqual(["Engineering Leadership"]);
  });

  it("dismiss() clears applied without reverting the write", () => {
    act(() => api.apply());
    act(() => api.dismiss());
    expect(api.applied).toBe(false);
    // Only one write ever happened — dismiss is not an undo.
    expect(writes).toHaveLength(1);
  });

  it("canApply is false while a non-empty category snapshot exists, and apply() no-ops", () => {
    const cats: SkillCategory[] = [{ label: "Cloud", skills: ["AWS", "Docker"] }];
    act(() => root.render(<Probe skillCategories={cats} />));
    expect(api.canApply).toBe(false);
    act(() => api.apply());
    expect(writes).toHaveLength(0);
    expect(api.applied).toBe(false);
  });
});
