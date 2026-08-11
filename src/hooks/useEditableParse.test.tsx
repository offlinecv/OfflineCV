// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Tests for the empty-added-entry pruning that backs #379 — a "+ Add …" entry
 * the user opens and abandons without typing must not persist.
 *
 * `isAddedEntryEmpty` is pure and tested directly. `pruneEmptyAddedEntries` is
 * exercised through a probe component (the project has no
 * @testing-library/react — same pattern as `useAnalyzedResume.test.tsx`).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useEditableParse,
  isAddedEntryEmpty,
  type EditableParse,
  type AddedEntry,
} from "./useEditableParse.ts";
import type { SkillCategory } from "../lib/heuristics/types.ts";
import { computeEditedSkills } from "../lib/edit/skills-categories.ts";
import { summaryRewriteApply } from "../components/features/ReconstructedSummary.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("isAddedEntryEmpty", () => {
  const base: AddedEntry = { id: "added:0", section: "education", title: "" };

  it("is true for a freshly-added, untouched entry with no bullets", () => {
    expect(isAddedEntryEmpty(base, {})).toBe(true);
  });

  it("treats whitespace-only header fields as empty", () => {
    expect(isAddedEntryEmpty({ ...base, title: "   ", subtitle: "\t" }, {})).toBe(
      true,
    );
  });

  it("is false when any header field carries content", () => {
    expect(isAddedEntryEmpty({ ...base, title: "BSc CS" }, {})).toBe(false);
    expect(isAddedEntryEmpty({ ...base, subtitle: "State U" }, {})).toBe(false);
    expect(isAddedEntryEmpty({ ...base, start_date: "2019" }, {})).toBe(false);
  });

  it("is false when the entry has appended bullets, even with a blank header", () => {
    expect(isAddedEntryEmpty(base, { "added:0": ["Did a thing"] })).toBe(false);
  });
});

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

describe("useEditableParse — pruneEmptyAddedEntries (#379)", () => {
  it("drops a blank added entry in the target section", () => {
    let id = "";
    act(() => {
      id = api.addEntry("education");
    });
    expect(api.addedEntries).toHaveLength(1);

    act(() => api.pruneEmptyAddedEntries("education"));
    expect(api.addedEntries).toHaveLength(0);
    expect(id).toMatch(/^added:/);
  });

  it("keeps an entry that has any populated field", () => {
    let id = "";
    act(() => {
      id = api.addEntry("education");
      api.setEntryField(id, "title", "BSc CS");
    });

    act(() => api.pruneEmptyAddedEntries("education"));
    expect(api.addedEntries).toHaveLength(1);
    expect(api.addedEntries[0].title).toBe("BSc CS");
  });

  it("keeps a blank entry that has appended bullets", () => {
    let id = "";
    act(() => {
      id = api.addEntry("experience");
      api.addBullet(id, "Shipped a feature");
    });

    act(() => api.pruneEmptyAddedEntries("experience"));
    expect(api.addedEntries).toHaveLength(1);
  });

  it("prunes only the named section, leaving a fresh entry in another section", () => {
    act(() => {
      api.addEntry("education");
      api.addEntry("experience");
    });
    expect(api.addedEntries).toHaveLength(2);

    // Leaving Education must not nuke the just-added (still-blank) Experience one.
    act(() => api.pruneEmptyAddedEntries("education"));
    expect(api.addedEntries.map((e) => e.section)).toEqual(["experience"]);
  });

  it("is a no-op (stable identity) when nothing is empty", () => {
    act(() => {
      const id = api.addEntry("projects");
      api.setEntryField(id, "title", "Portfolio site");
    });
    const before = api.addedEntries;

    act(() => api.pruneEmptyAddedEntries("projects"));
    expect(api.addedEntries).toBe(before);
  });
});

describe("useEditableParse — Skills category edits (#476)", () => {
  const cats: SkillCategory[] = [
    { label: "Frontend", skills: ["React", "TypeScript"] },
    { label: "Backend", skills: ["Java"] },
  ];

  it("takes a grouping snapshot on the first category edit and marks hasEdits", () => {
    expect(api.skillsOverride.categories).toBeUndefined();
    expect(api.hasEdits).toBe(false);

    act(() => api.renameSkillCategory(cats, 0, "UI"));
    expect(api.skillsOverride.categories?.[0].label).toBe("UI");
    // Rename is label-only — members untouched.
    expect(api.skillsOverride.categories?.[0].skills).toEqual(["React", "TypeScript"]);
    expect(api.hasEdits).toBe(true);
  });

  it("moves a skill through the same path the DnD drop uses", () => {
    act(() => api.moveSkillToCategory(cats, "React", 1));
    const snap = api.skillsOverride.categories!;
    expect(snap[0].skills).toEqual(["TypeScript"]);
    expect(snap[1].skills).toContain("React");
  });

  it("resetAll clears the category snapshot back to pristine", () => {
    act(() => api.addSkillCategory(cats, cats.flatMap((c) => c.skills), "Data"));
    expect(api.skillsOverride.categories).toBeDefined();
    act(() => api.resetAll());
    expect(api.skillsOverride.categories).toBeUndefined();
    expect(api.hasEdits).toBe(false);
  });

  it("round-trips the snapshot through snapshot → replay", () => {
    act(() => api.renameSkillCategory(cats, 0, "UI"));
    // Second op composes on the flushed snapshot (mirrors the component reading
    // the applied `parsed.skillCategories` between edits).
    act(() => api.deleteSkillCategory(api.skillsOverride.categories!, 1));
    const saved = api.snapshot;
    act(() => api.resetAll());
    expect(api.skillsOverride.categories).toBeUndefined();
    act(() => api.replay(saved));
    expect(api.skillsOverride.categories?.map((c) => c.label)).toEqual(["UI"]);
  });

  it("replay restores the ungrouped remainder, not just the categories (#791)", () => {
    // Seeding the remainder needs a grouping that does NOT already cover every
    // skill — the flat-résumé case the "+ Add category" affordance unlocks.
    const flat = {
      skills: ["React", "TypeScript", "Figma"],
      skillCategories: undefined,
    };
    act(() => api.addSkillCategory([], flat.skills, "UI"));
    act(() => api.moveSkillToCategory(api.skillsOverride.categories!, "React", 0));
    expect(api.skillsOverride.ungrouped).toEqual(["TypeScript", "Figma"]);

    const saved = api.snapshot;
    act(() => api.resetAll());
    act(() => api.replay(saved));

    // Restoring `categories` alone would strand these two: `computeEditedSkills`
    // reads a missing `ungrouped` as "no remainder" and the flat list collapses
    // to the grouped member only — the #791 data loss, on the restore path.
    expect(api.skillsOverride.ungrouped).toEqual(["TypeScript", "Figma"]);
    expect(computeEditedSkills(flat, api.skillsOverride).skills).toEqual([
      "React",
      "TypeScript",
      "Figma",
    ]);
  });

  it("delete-all-categories then flat addSkill does NOT resurrect deleted skills (#415)", () => {
    // The pristine parse `applyOverrides` always re-folds against.
    const parsed = { skills: cats.flatMap((c) => c.skills), skillCategories: cats };

    // Delete every category. Each op composes on the current applied snapshot,
    // mirroring the component reading `parsed.skillCategories` between edits.
    act(() => api.deleteSkillCategory(cats, 0));
    act(() => api.deleteSkillCategory(api.skillsOverride.categories!, 0));
    // Degraded: an empty-but-present snapshot (`[]`), NOT absent — this is what
    // keeps computeEditedSkills out of the pristine flat branch.
    expect(api.skillsOverride.categories).toEqual([]);
    expect(computeEditedSkills(parsed, api.skillsOverride).skills).toEqual([]);

    // The flat AddSkillInput is now live; the user adds one skill.
    act(() => api.addSkill("Rust"));
    // addSkill must PRESERVE the `[]` snapshot (align with removeSkill), else the
    // override falls back to the pristine flat branch and every deleted skill
    // reappears — the #415 bug.
    expect(api.skillsOverride.categories).toEqual([]);
    expect(api.skillsOverride.added).toEqual(["Rust"]);
    expect(computeEditedSkills(parsed, api.skillsOverride).skills).toEqual([
      "Rust",
    ]);

    // …then removes it → back to empty (not resurrected).
    act(() => api.removeSkill("Rust"));
    expect(computeEditedSkills(parsed, api.skillsOverride).skills).toEqual([]);
  });

  it("delete-all then add twice keeps both adds, no pristine skills (#415)", () => {
    const parsed = { skills: cats.flatMap((c) => c.skills), skillCategories: cats };
    act(() => api.deleteSkillCategory(cats, 0));
    act(() => api.deleteSkillCategory(api.skillsOverride.categories!, 0));
    act(() => api.addSkill("Rust"));
    act(() => api.addSkill("Go"));
    expect(api.skillsOverride.categories).toEqual([]);
    expect(computeEditedSkills(parsed, api.skillsOverride).skills).toEqual([
      "Rust",
      "Go",
    ]);
  });

  it("headline override flips hasEdits to true and is cleared by resetAll (issue 599)", () => {
    expect(api.hasEdits).toBe(false);
    act(() => api.setContactField("headline", "Staff Engineer"));
    expect(api.contactOverrides.headline).toBe("Staff Engineer");
    expect(api.hasEdits).toBe(true);

    act(() => api.resetAll());
    expect(api.contactOverrides.headline).toBeUndefined();
    expect(api.hasEdits).toBe(false);
  });
});

describe("useEditableParse — ungrouped remainder on the first category (#791)", () => {
  const flat = ["Python", "SQL", "Excel"];

  it("creating the first category leaves every existing skill ungrouped, not swept in", () => {
    act(() => api.addSkillCategory([], flat, "Leadership"));
    expect(api.skillsOverride.categories).toEqual([
      { label: "Leadership", skills: [] },
    ]);

    const parsed = { skills: flat, skillCategories: undefined };
    const result = computeEditedSkills(parsed, api.skillsOverride);
    // Nothing was swept into the new category…
    expect(result.skillCategories![0].skills).toEqual([]);
    // …but the flat union still has every original skill.
    expect(new Set(result.skills)).toEqual(new Set(flat));
  });

  it("a second addSkillCategory call leaves the pool alone (the recompute is idempotent)", () => {
    act(() => api.addSkillCategory([], flat, "Leadership"));
    act(() =>
      api.addSkillCategory(api.skillsOverride.categories!, flat, "Backend"),
    );
    expect(api.skillsOverride.ungrouped).toEqual(flat);
  });

  // Both sequences below reach a state the old once-only seed left inconsistent:
  // a non-empty `categories` snapshot alongside populated flat `removed`/`added`.
  // `computeEditedSkills` treats that as unreachable — it throws in DEV and
  // ignores the flat edits in prod, i.e. the skill vanishes from the UI and the
  // exported PDF. Both are reachable because the flat chip row and
  // "+ Add category" now render together (#791).

  it("a flat remove made before the first category survives creating it", () => {
    const parsed = { skills: flat, skillCategories: undefined };
    act(() => api.removeSkill("Excel"));
    const rendered = computeEditedSkills(parsed, api.skillsOverride).skills;
    expect(rendered).toEqual(["Python", "SQL"]);

    act(() => api.addSkillCategory([], rendered, "Leadership"));
    expect(computeEditedSkills(parsed, api.skillsOverride).skills).toEqual([
      "Python",
      "SQL",
    ]);
    // Folded into the snapshot, not left dangling beside it.
    expect(api.skillsOverride.removed).toEqual([]);
  });

  it("a flat add made while degraded survives creating a category again", () => {
    const parsed = { skills: flat, skillCategories: undefined };
    // First category → delete it: the section degrades to uncategorised, so the
    // flat AddSkillInput is live again while `ungrouped` is already seeded.
    act(() => api.addSkillCategory([], flat, "Product"));
    act(() => api.deleteSkillCategory(api.skillsOverride.categories!, 0));
    act(() => api.addSkill("Rust"));
    const rendered = computeEditedSkills(parsed, api.skillsOverride).skills;
    expect(rendered).toContain("Rust");

    // "+ Add category" again. The seed must recompute from the rendered list, or
    // the categorised branch (which ignores `added`) drops "Rust" silently.
    act(() =>
      api.addSkillCategory(api.skillsOverride.categories!, rendered, "Product"),
    );
    const result = computeEditedSkills(parsed, api.skillsOverride);
    expect(new Set(result.skills)).toEqual(new Set([...flat, "Rust"]));
    expect(api.skillsOverride.added).toEqual([]);
  });

  it("moving an ungrouped skill into a category claims it (Move menu / DnD path)", () => {
    act(() => api.addSkillCategory([], flat, "Leadership"));
    act(() =>
      api.moveSkillToCategory(api.skillsOverride.categories!, "SQL", 0),
    );
    const parsed = { skills: flat, skillCategories: undefined };
    const result = computeEditedSkills(parsed, api.skillsOverride);
    expect(result.skillCategories![0].skills).toEqual(["SQL"]);
    // The flat SET is unchanged — SQL moved, nothing was lost or duplicated.
    expect(new Set(result.skills)).toEqual(new Set(flat));
  });

  it("removing an ungrouped skill deletes it — the trailing row's Remove button", () => {
    act(() => api.addSkillCategory([], flat, "Leadership"));
    act(() =>
      api.removeCategorySkill(api.skillsOverride.categories!, "Excel"),
    );
    const parsed = { skills: flat, skillCategories: undefined };
    const result = computeEditedSkills(parsed, api.skillsOverride);
    expect(result.skills).not.toContain("Excel");
    expect(new Set(result.skills)).toEqual(new Set(["Python", "SQL"]));
  });

  it("deleting a category destroys a skill moved into it — it does not fall back to ungrouped", () => {
    act(() => api.addSkillCategory([], flat, "Leadership"));
    act(() =>
      api.moveSkillToCategory(api.skillsOverride.categories!, "SQL", 0),
    );
    act(() => api.deleteSkillCategory(api.skillsOverride.categories!, 0));
    const parsed = { skills: flat, skillCategories: undefined };
    const result = computeEditedSkills(parsed, api.skillsOverride);
    // SQL was inside the deleted category — the confirm dialog's promise
    // ("removes the category and all the skills in it") must hold: SQL is
    // gone, not resurrected as ungrouped.
    expect(result.skills).toEqual(["Python", "Excel"]);
    expect(result.skillCategories).toBeUndefined();
  });

  // The flat setters are categorisation-aware (#791): `SkillTermGuidance` — and
  // any future flat writer — is wired to `addSkill`, which is reachable on a
  // categorised résumé now that "+ Add category" renders on a flat one. Routing
  // a flat write into `added`/`removed` while a non-empty snapshot exists is the
  // one state `computeEditedSkills` rejects: it throws in DEV (an ErrorBoundary
  // crash, since it runs in a render-phase memo) and drops the skill silently in
  // prod. The door is closed in the setter, not by convention at each call site.

  it("addSkill on a categorised résumé lands in ungrouped, not the flat `added`", () => {
    act(() => api.addSkillCategory([], flat, "Leadership"));
    act(() => api.addSkill("Kubernetes"));

    // Before the setters became categorisation-aware this threw here — and this
    // runs in a render-phase memo (`useAnalyzedResume`), so the throw was an
    // ErrorBoundary crash of the whole editor, two clicks from a fresh parse.
    const parsed = { skills: flat, skillCategories: undefined };
    const result = computeEditedSkills(parsed, api.skillsOverride);
    expect(result.skills).toContain("Kubernetes");
    expect(new Set(result.skills)).toEqual(new Set([...flat, "Kubernetes"]));

    expect(api.skillsOverride.added).toEqual([]);
    expect(api.skillsOverride.ungrouped).toEqual([...flat, "Kubernetes"]);
    expect(api.hasEdits).toBe(true);
  });

  it("addSkill while categorised canonicalizes and no-ops on blanks/dupes", () => {
    act(() => api.addSkillCategory([], flat, "Leadership"));
    act(() => api.addSkillToCategory(api.skillsOverride.categories!, 0, "SQL"));
    // Canonicalized, like the uncategorised path ("js" → "JavaScript").
    act(() => api.addSkill("js"));
    expect(api.skillsOverride.ungrouped).toContain("JavaScript");

    const before = api.skillsOverride.ungrouped;
    act(() => api.addSkill("   "));
    act(() => api.addSkill("javascript")); // already ungrouped (case-insensitive)
    act(() => api.addSkill("sql")); // already GROUPED — not a second copy
    expect(api.skillsOverride.ungrouped).toEqual(before);
    expect(api.skillsOverride.added).toEqual([]);
  });

  it("a categorised flat add survives snapshot → replay", () => {
    act(() => api.addSkillCategory([], flat, "Leadership"));
    act(() => api.addSkill("Kubernetes"));
    const saved = api.snapshot;
    // It rides in `ungrouped`, which replay restores WITH `categories` — the
    // `so.added.forEach(addSkill)` leg has nothing to replay.
    expect(saved.skillsOverride.added).toEqual([]);

    act(() => api.resetAll());
    act(() => api.replay(saved));

    const parsed = { skills: flat, skillCategories: undefined };
    expect(new Set(computeEditedSkills(parsed, api.skillsOverride).skills)).toEqual(
      new Set([...flat, "Kubernetes"]),
    );
  });

  it("removeSkill while categorised deletes from ungrouped AND from a category", () => {
    act(() => api.addSkillCategory([], flat, "Leadership"));
    act(() => api.moveSkillToCategory(api.skillsOverride.categories!, "SQL", 0));

    // An ungrouped skill…
    act(() => api.removeSkill("Excel"));
    // …and a grouped one. A flat remove must reach both, or the chip stays.
    act(() => api.removeSkill("SQL"));

    expect(api.skillsOverride.removed).toEqual([]);
    expect(api.skillsOverride.ungrouped).toEqual(["Python"]);
    expect(api.skillsOverride.categories).toEqual([
      { label: "Leadership", skills: [] },
    ]);

    const parsed = { skills: flat, skillCategories: undefined };
    expect(computeEditedSkills(parsed, api.skillsOverride).skills).toEqual([
      "Python",
    ]);
  });

  it("typing an ungrouped skill's name into a category's add-input also claims it (no stale duplicate)", () => {
    act(() => api.addSkillCategory([], flat, "Leadership"));
    act(() =>
      api.addSkillToCategory(api.skillsOverride.categories!, 0, "SQL"),
    );
    // A later delete of that category must not resurrect SQL via a stale
    // ungrouped entry.
    act(() => api.deleteSkillCategory(api.skillsOverride.categories!, 0));
    const parsed = { skills: flat, skillCategories: undefined };
    const result = computeEditedSkills(parsed, api.skillsOverride);
    expect(result.skills).toEqual(["Python", "Excel"]);
  });
});

// ── Summary override (#625) ───────────────────────────────────────────────────

/** The summary's SECOND writer, as the whole-résumé review drives it: build the
 *  apply wiring off the CURRENT slot (what the container's memo does), then fire
 *  the verb an accepted `matched` pair resolves to. */
function applyRewrite(text: string) {
  act(() =>
    summaryRewriteApply(api.summaryOverride, api.setSummaryField).onReplace(
      "summary",
      text,
    ),
  );
}

describe("useEditableParse — summaryOverride (#625)", () => {
  it("starts absent, so the parsed summary shows through", () => {
    expect(api.summaryOverride).toBeUndefined();
    expect(api.hasEdits).toBe(false);
  });

  it("records an edit, and treats a CLEAR as an edit too", () => {
    act(() => api.setSummaryField("Edited summary."));
    expect(api.summaryOverride).toBe("Edited summary.");
    expect(api.hasEdits).toBe(true);

    // "" is authoritative, not "no override" — `hasEdits` must not read it as
    // falsy or an emptied summary would never be persisted or flagged dirty.
    act(() => api.setSummaryField(""));
    expect(api.summaryOverride).toBe("");
    expect(api.hasEdits).toBe(true);
  });

  it("drops the override entirely on undefined", () => {
    act(() => api.setSummaryField("Edited summary."));
    act(() => api.setSummaryField(undefined));
    expect(api.summaryOverride).toBeUndefined();
    expect(api.hasEdits).toBe(false);
  });

  it("clears on resetAll", () => {
    act(() => api.setSummaryField(""));
    act(() => api.resetAll());
    expect(api.summaryOverride).toBeUndefined();
  });

  // AC6: ONE override, two writers. Whichever writes last wins, in BOTH
  // orderings — neither writer can resurrect the other's value, because there
  // is only one slot to write.
  it("lets a manual edit overwrite an accepted rewrite", () => {
    applyRewrite("Rewritten by the model.");
    expect(api.summaryOverride).toBe("Rewritten by the model.");

    act(() => api.setSummaryField("Typed by the user."));
    expect(api.summaryOverride).toBe("Typed by the user.");
    expect(api.snapshot.summaryOverride).toBe("Typed by the user.");
  });

  it("lets an accepted rewrite overwrite a manual edit", () => {
    act(() => api.setSummaryField("Typed by the user."));
    applyRewrite("Rewritten by the model.");
    expect(api.summaryOverride).toBe("Rewritten by the model.");
    expect(api.snapshot.summaryOverride).toBe("Rewritten by the model.");
  });

  it("undoes a rewrite back to the manual edit it overwrote", () => {
    act(() => api.setSummaryField("Typed by the user."));
    const apply = summaryRewriteApply(api.summaryOverride, api.setSummaryField);
    let undo = () => {};
    act(() => {
      undo = apply.captureUndo!([]);
      apply.onReplace("summary", "Rewritten by the model.");
    });
    expect(api.summaryOverride).toBe("Rewritten by the model.");

    act(() => undo());
    expect(api.summaryOverride).toBe("Typed by the user.");
  });

  it("undoes a rewrite made against an UNEDITED summary back to no override", () => {
    // Not to "" — pinning an empty override here would clear the parsed summary
    // from the export, which is the opposite of reverting.
    const apply = summaryRewriteApply(api.summaryOverride, api.setSummaryField);
    let undo = () => {};
    act(() => {
      undo = apply.captureUndo!([]);
      apply.onReplace("summary", "Rewritten by the model.");
    });
    act(() => undo());
    expect(api.summaryOverride).toBeUndefined();
  });

  it("routes the one-field section's add/remove verbs to the same slot", () => {
    const apply = () =>
      summaryRewriteApply(api.summaryOverride, api.setSummaryField);
    act(() => apply().onAdd("Authored by the model."));
    expect(api.summaryOverride).toBe("Authored by the model.");
    act(() => apply().onRemove("summary"));
    expect(api.summaryOverride).toBe("");
  });

  it("round-trips a CLEAR through snapshot → replay", () => {
    act(() => api.setSummaryField(""));
    const snap = api.snapshot;
    act(() => api.resetAll());
    expect(api.summaryOverride).toBeUndefined();

    act(() => api.replay(snap));
    expect(api.summaryOverride).toBe("");
  });

  it("replays no override from a pre-#625 snapshot that carries no key", () => {
    act(() => api.replay({ ...api.snapshot, summaryOverride: undefined }));
    expect(api.summaryOverride).toBeUndefined();
  });
});
