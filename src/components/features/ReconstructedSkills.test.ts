// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SkillsSection,
  partitionSkillCategories,
} from "./ReconstructedSkills.tsx";
import type { SkillCategory } from "../../lib/heuristics/types.ts";

const noop = () => {};

// ── partitionSkillCategories (#473 render helper, empty-but-present for #476) ──

describe("partitionSkillCategories", () => {
  const cats: SkillCategory[] = [
    { label: "Frontend", skills: ["React", "TypeScript"] },
    { label: "Backend", skills: ["Java", "Go"] },
  ];

  it("keeps categories intact when the flat list matches the flattened members", () => {
    const { rows, ungrouped } = partitionSkillCategories(
      ["React", "TypeScript", "Java", "Go"],
      cats,
    );
    expect(rows).toEqual(cats);
    expect(ungrouped).toEqual([]);
  });

  it("keeps an emptied category PRESENT (empty-but-present, issue 476)", () => {
    const { rows, ungrouped } = partitionSkillCategories(["Java", "Go"], cats);
    expect(rows).toEqual([
      { label: "Frontend", skills: [] },
      { label: "Backend", skills: ["Java", "Go"] },
    ]);
    expect(ungrouped).toEqual([]);
  });

  it("routes an uncovered skill into the ungrouped tail", () => {
    const { rows, ungrouped } = partitionSkillCategories(
      ["React", "TypeScript", "Java", "Go", "Rust"],
      cats,
    );
    expect(rows).toEqual(cats);
    expect(ungrouped).toEqual(["Rust"]);
  });
});

// ── SkillsSection rendering ────────────────────────────────────────────────────

describe("SkillsSection rendering", () => {
  const render = (skills: string[], skillCategories?: SkillCategory[]): string =>
    renderToStaticMarkup(
      createElement(SkillsSection, {
        skills,
        skillCategories,
        onAddSkill: noop,
        onRemoveSkill: noop,
        onRenameCategory: noop,
        onDeleteCategory: noop,
        onAddCategory: noop,
        onAddSkillToCategory: noop,
        onMoveSkill: noop,
        onRemoveCategorySkill: noop,
      }),
    );

  const cats: SkillCategory[] = [
    { label: "Frontend", skills: ["React", "TypeScript"] },
    { label: "Backend", skills: ["Java", "Go"] },
  ];

  it("renders one labelled, editable row per category with edit affordances", () => {
    const html = render(["React", "TypeScript", "Java", "Go"], cats);
    // Rename affordance (EditableField carries the aria-label).
    expect(html).toContain("Rename Frontend category");
    expect(html).toContain("Rename Backend category");
    // Delete-category and move affordances exist.
    expect(html).toContain("Delete Frontend category");
    expect(html).toContain("Move to another category");
    // Add-category affordance is offered on a categorised résumé.
    expect(html).toContain("Add category");
    expect(html).toContain("React");
    expect(html).toContain("Go");
  });

  it("shows an emptied category as present with a hint, not dropped", () => {
    const html = render(["Java", "Go"], cats);
    expect(html).toContain("Rename Frontend category");
    expect(html).toContain("empty");
  });

  it("renders a flat list with no category chrome when uncategorised", () => {
    const html = render(["React", "TypeScript"]);
    expect(html).not.toContain("Rename");
    expect(html).not.toContain("Add category");
    expect(html).toContain("React");
    expect(html).toContain("TypeScript");
  });

  it("gives an ungrouped chip a Move menu so it can be regrouped (issue 476 nit)", () => {
    // Rust falls outside both categories → lands in the ungrouped tail. Every
    // chip (4 categorised + 1 ungrouped) now carries a "Move to" affordance, so
    // an ungrouped skill is not stranded remove-only.
    const html = render(["React", "TypeScript", "Java", "Go", "Rust"], cats);
    expect(html).toContain("Rust");
    const moveMenus = html.split("Move to another category").length - 1;
    expect(moveMenus).toBe(5);
  });

  it("uncategorised flat chips stay remove-only (no move menu, nowhere to move)", () => {
    const html = render(["React", "TypeScript"]);
    expect(html).not.toContain("Move to another category");
  });
});
