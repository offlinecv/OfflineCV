// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * "Other bullets" is the group `groupBulletsByExperience` returns for a pooled
 * bullet whose normalized text matches no experience's description
 * (`experienceIndex: null`, no `entryKey`). This file covers two disjoint
 * scenarios that land there:
 *
 *   - real, unattributable content (`ORPHAN_BULLET`): a genuine pooled line no
 *     entry's description happens to contain. Ordinary `removedBullets` /
 *     `bulletOverrides` handling applies — the coverage below is unaffected by
 *     #678 and is the CONTROL that proves the marker-only case is not just "no
 *     removal ever lands".
 *   - a marker-only line (`"4."`, `"• 4."`, or an added bullet edited down to
 *     `"3."`): historically (#660 half 2, #659, #679, #683, #684, #1052) this
 *     COULD reach the pool — `extractBulletsFromLines` accepted it because a
 *     bare digit clears `ANON_BULLET_MIN_WORDS` — normalize to the empty
 *     string, and land in "Other bullets" with no `entryKey` to resolve an
 *     `addedBullets` bucket from, which produced a cluster of "removed nothing
 *     but said Removed", "unresolvable phantom edit", and "two ambiguous rows"
 *     bugs.
 *
 * #678 closed the root cause: `extractBulletsFromLines` now refuses ANY line
 * whose `normalizeBulletText` is empty, so a marker-only line never enters the
 * bullet pool at all — not via a straight PDF parse and not via #30's lone-bullet
 * merge. An in-place edit that degenerates a real bullet is refused before it
 * is written (`setBulletField`), since the line it would store could never be
 * pooled — and so never shown, edited, removed or undone — again. That makes every "Other bullets" degenerate-row
 * scenario this file used to construct structurally unreachable: there is no
 * longer any row to click Remove or Edit on, so the resolver code those fixes
 * added (`findAddedBulletEntry`, `resolveOtherBulletRef`'s ambiguous-match
 * refusal) has no more input that reaches it. The tests below pin the new,
 * simpler invariant directly — no row renders for a marker-only line, from any
 * of the origins that used to produce one — rather than re-deriving it through
 * click sequences on controls that no longer exist.
 *
 * The general "remove a bullet, empty an added role, Undo, prune-hold" chain
 * this file also used to exercise via the degenerate detour is still covered
 * via the normal (non-degenerate, own-role-attributed) removal path in
 * `ExperienceSection.prune-hold.test.tsx` (#637 half 2, #684, #677, #659) — it
 * never depended on the bullet being unattributable, only on the role becoming
 * empty, so that coverage is unaffected by #678.
 *
 * Both surfaces are driven for real: the section renders over the REAL
 * `useEditableParse` and the REAL `applyOverrides` → `computeAnonymousAtsScore`
 * → `groupBulletsByExperience` chain.
 *
 * jsdom + raw `createRoot` + fake timers, matching `ExperienceSection.test.tsx`.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { createElement, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ExperienceSection } from "./ReconstructedResume.tsx";
import {
  useEditableParse,
  type EditableParse,
} from "../../hooks/useEditableParse.ts";
import { applyOverrides } from "../../lib/edit/apply-overrides.ts";
import { computeAnonymousAtsScore } from "../../lib/score/score.ts";
import {
  groupBulletsByExperience,
  type BulletGroup,
} from "../../lib/score/group-bullets.ts";
import { bulletId } from "../../lib/score/bullet-id.ts";
import { projectScoreSections } from "../../lib/heuristics/projections.ts";
import { buildBlankResult } from "../../lib/heuristics/empty-result.ts";
import { toCanonicalResume } from "../../lib/heuristics/canonical.ts";
import type { SectionedResume } from "../../lib/heuristics/sections.ts";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
// The two recipes that are easy to get silently wrong (see that module), shared
// with `ExperienceSection.prune-hold.test.tsx` rather than copied a third time.
import {
  UNDO_LABEL,
  exitSection,
} from "./__test-utils__/experience-section-dom.ts";

const PARSED_BULLET = "Cut p99 checkout latency by 38% via edge caching.";
/** Pooled from the section but absent from every description → "Other". */
const ORPHAN_BULLET = "Presented quarterly reviews to the exec staff.";
const ADDED_BULLET = "Shipped a design system used by 40 engineers.";
/**
 * The contentless replacement. Since #678, `extractBulletsFromLines` refuses
 * ANY line whose `normalizeBulletText` is empty — including this one, a bare
 * numbered marker — so storing it over a real bullet would leave an edit no row
 * renders. `setBulletField` therefore refuses the write and the bullet keeps
 * its text.
 */
const DEGENERATE = "3.";
/**
 * A degenerate line straight out of the PDF, needing no edit to exist.
 *
 * `BULLET_MARKER_RE` strips the `"• "`, leaving `"4."`; `countWords` sees the
 * digit through `\p{N}` and returns 1, so `ANON_BULLET_MIN_WORDS` alone would
 * not filter it — but `normalizeBulletText("4.")` is `""` (`LEADING_MARKER_RE`
 * eats a bare `\d+[.)]` too), and #678 filters on exactly that, so this line
 * never becomes a row.
 *
 * The `"• "` prefix is not the only reachable shape: #30's lone-bullet merge
 * joins a bare `"•"` line to the `"4."` on the next one, which is what real
 * Word-table exports emit when the glyph and its text land in separate cells.
 */
const PARSED_DEGENERATE = "• 4.";

/**
 * Extra pooled section lines for the test about to mount, appended to the two
 * below. Module-scoped because `Harness` builds its parse inside a `useMemo` and
 * takes no props; reset in `afterEach` so it cannot leak between tests.
 */
let extraPooledLines: readonly string[] = [];

/**
 * One parsed role whose description carries PARSED_BULLET only, plus a second
 * pooled section line (ORPHAN_BULLET) that no entry claims.
 */
function baseResult(): CascadeResult {
  const blank = buildBlankResult();
  const lines = [`• ${PARSED_BULLET}`, `• ${ORPHAN_BULLET}`, ...extraPooledLines];
  const byName = new Map<string, readonly string[]>([["experience", lines]]);
  const sections: SectionedResume = {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
  return {
    ...blank,
    rawText: lines.join("\n"),
    canonical: toCanonicalResume(
      {
        full_name: "Robin Vasquez",
        email: "robin.vasquez@example.com",
        skills: ["typescript"],
        education: [],
        experience: [
          {
            title: "Staff Engineer",
            company: "Northwind Systems",
            description: PARSED_BULLET,
          },
        ],
      },
      sections,
      {},
    ),
  };
}

let api: EditableParse;

/**
 * Mounts `ExperienceSection` over the real edit hook, building `groups` exactly
 * the way `ReconstructedResume` does: every parsed entry renders (the
 * `sliceGroups` empty-group fallback) and the "Other" group is appended last.
 */
function Harness() {
  const edit = useEditableParse();
  api = edit;

  const groups = useMemo<BulletGroup[]>(() => {
    const base = baseResult();
    const core = applyOverrides(
      {
        parsed: base.canonical.fields,
        rawText: base.rawText,
        sections: base.canonical.sections,
        observations: [],
        fieldConfidence: base.canonical.fieldConfidence,
      },
      // The WHOLE snapshot, not a hand-listed subset (#922 review): a channel
      // added to `EditSnapshot` then reaches this fold the same way it reaches
      // production's, instead of being silently dropped here. Listing them by
      // hand had already lost `certificationOverrides` (#884).
      edit.snapshot,
    );
    const score = computeAnonymousAtsScore({
      parsed: core.fields,
      fieldConfidence: core.fieldConfidence,
      triggers: base.triggers,
      rawText: core.rawText,
      sections: projectScoreSections(core),
    });
    const experiences = core.fields.experience;
    const grouped = groupBulletsByExperience(
      [...(score.bullets ?? [])],
      experiences,
    );
    const byIndex = new Map(
      grouped
        .filter((g) => g.experienceIndex !== null)
        .map((g) => [g.experienceIndex, g] as const),
    );
    const other = grouped.find((g) => g.experienceIndex === null);
    const roles = experiences.map(
      (exp, i) =>
        byIndex.get(i) ?? { experienceIndex: i, experience: exp, bullets: [] },
    );
    return other ? [...roles, other] : roles;
  }, [edit]);

  return createElement(ExperienceSection, {
    groups,
    resumeSections: [],
    // false → no model status line / rewrite CTA chrome in the test DOM.
    hasBullets: false,
    experienceOverrides: {},
    onExperienceFieldChange: () => {},
    onBulletChange: edit.setBulletField,
    onRemoveBullet: edit.removeBullet,
    addedBullets: edit.addedBullets,
    addedExperience: edit.addedEntries.filter((e) => e.section === "experience"),
    originalCount: 1,
    // Identity: no parsed entry is deleted here, so a render position IS its
    // parsed index (#856).
    parsedIndices: [0],
    onAddEntry: () => edit.addEntry("experience"),
    onRemoveEntry: edit.removeEntry,
    onEntryField: edit.setEntryField,
    onAddBullet: edit.addBullet,
    captureBulletUndo: edit.captureBulletUndo,
    summaryApply: {
      obsIds: [],
      onReplace: () => {},
      onRemove: () => {},
      onAdd: () => {},
    },
    onPruneEmpty: (isHeld) => edit.pruneEmptyAddedEntries("experience", isHeld),
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Harness));
  });
  await act(async () => {});
  return container;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  extraPooledLines = [];
  vi.useRealTimers();
});

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(16);
  });
}

/** The one row rendering `text`, or none. */
function rowsFor(el: HTMLDivElement, text: string): HTMLLIElement[] {
  return Array.from(el.querySelectorAll("li")).filter((li) =>
    li.textContent?.includes(text),
  );
}

/** The "Remove bullet" control on the ONE row rendering `text`. Asserting
 *  uniqueness is what keeps the test from silently clicking a neighbour after a
 *  layout change. */
function removeButtonFor(el: HTMLDivElement, text: string): HTMLButtonElement {
  const rows = rowsFor(el, text);
  expect(rows).toHaveLength(1);
  const button = rows[0]!.querySelector<HTMLButtonElement>(
    '[aria-label="Remove bullet"]',
  );
  expect(button).not.toBeNull();
  return button!;
}

/** The click-to-edit affordance (the bullet text itself) on the ONE row
 *  rendering `text`. Mirrors {@link removeButtonFor}'s uniqueness assertion. */
function bulletTextButtonFor(el: HTMLDivElement, text: string): HTMLElement {
  const rows = rowsFor(el, text);
  expect(rows).toHaveLength(1);
  const button = rows[0]!.querySelector<HTMLElement>('[role="button"]');
  expect(button).not.toBeNull();
  return button!;
}

/** Set a textarea's value through the native setter — a direct `el.value = x`
 *  bypasses React's value tracker, so the ensuing `input` event fires no
 *  `onChange` (house convention, matches `ResumeBulletRow.test.tsx`). */
function setTextareaValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Commit an edit on the row currently rendering `text`, through the real
 * `ResumeBulletRow` → `EditableField` Save button — the exact path the issue's
 * repro uses ("via the Save button — a multiline EditableField ignores Enter").
 * Only ever one row is in edit mode at a time here, so the textarea is found
 * without re-scoping to `text` (edit mode replaces the row's text content with
 * the draft textarea, which no longer contains the pre-edit `text`).
 */
async function editBulletViaSave(
  el: HTMLDivElement,
  text: string,
  next: string,
): Promise<void> {
  await click(bulletTextButtonFor(el, text));
  const textarea = el.querySelector<HTMLTextAreaElement>("li textarea");
  expect(textarea).not.toBeNull();
  setTextareaValue(textarea!, next);
  await click(
    el.querySelector<HTMLElement>('[aria-label="Save Bullet text"]')!,
  );
}

/**
 * Add a real bullet to the parsed role, then try to commit a contentless line
 * over it — the shipped `ResumeBulletRow` edit call, with the `AddedBulletRef`
 * that row supplies. The write is expected to be refused; callers assert that.
 *
 * `degenerate` is a parameter because two DIFFERENT markers both normalise to
 * `""`, which is what the "don't cross-contaminate" test below relies on to
 * tell two otherwise-identical-looking origins apart.
 */
function attemptDegenerateEdit(degenerate: string = DEGENERATE): void {
  act(() => api.addBullet("experience:0", ADDED_BULLET));
  act(() =>
    api.setBulletField(bulletId(ADDED_BULLET, 0), degenerate, {
      entryKey: "experience:0",
      text: ADDED_BULLET,
    }),
  );
}

describe("ExperienceSection — 'Other bullets' Remove on real orphaned content (unaffected by #678)", () => {
  it("still removes a genuinely-unmatched PARSED bullet by id", async () => {
    // The control, and deliberately unaffected by #678: ORPHAN_BULLET is real,
    // non-degenerate text pooled from the section but claimed by no entry's
    // description, so it is in no `addedBullets` bucket either. The removal
    // must fall through to `removedBullets` exactly as before.
    const el = await render();
    expect(el.textContent).toContain("Other bullets");

    await click(removeButtonFor(el, ORPHAN_BULLET));

    expect(api.removedBullets.has(bulletId(ORPHAN_BULLET, 0))).toBe(true);
    expect(api.addedBullets).toEqual({});
    expect(el.textContent).not.toContain(ORPHAN_BULLET);
    expect(el.textContent).toContain("Removed 1 change");
  });

  it("still removes the genuinely-unmatched orphan alongside an invisible marker-only line", async () => {
    // A marker-only PARSED line sits in the same section, but per #678 it never
    // reaches the pool — so it cannot interfere with the orphan's own removal.
    extraPooledLines = [PARSED_DEGENERATE];
    const el = await render();
    await act(async () => {});
    expect(rowsFor(el, "4.")).toHaveLength(0);

    await click(removeButtonFor(el, ORPHAN_BULLET));

    expect(api.removedBullets.has(bulletId(ORPHAN_BULLET, 0))).toBe(true);
    expect(el.textContent).not.toContain(ORPHAN_BULLET);
    expect(el.textContent).toContain("Removed 1 change");
  });
});

describe("ExperienceSection — Edit on real orphaned content (unaffected by #678)", () => {
  it("still lets a genuinely-unmatched PARSED bullet be edited normally", async () => {
    // The control: ORPHAN_BULLET is real text in no bucket, so it must still
    // resolve to the ordinary override path.
    const el = await render();

    const EDITED = "Presented quarterly reviews to the whole company.";
    await editBulletViaSave(el, ORPHAN_BULLET, EDITED);

    expect(Object.values(api.bulletOverrides)).toEqual([EDITED]);
    expect(el.textContent).toContain(EDITED);
  });
});

describe("ExperienceSection — a marker-only line never becomes a bullet row (#678)", () => {
  it("a line that is only a marker, straight from the PDF, produces no row", async () => {
    extraPooledLines = [PARSED_DEGENERATE];
    const el = await render();
    await act(async () => {});

    expect(rowsFor(el, "4.")).toHaveLength(0);
    expect(api.addedBullets).toEqual({});
    expect(api.hasEdits).toBe(false);
  });

  it("the #30 lone-bullet-merge shape produces no row either", async () => {
    // The glyph and its text in separate extracted lines — what a Word table
    // emits when they sit in separate cells. `extractBulletsFromLines` merges
    // them into one "4." line before the #678 empty-key check runs, so this is
    // the same defect arriving by the path #30 exists for, not a variant of it.
    extraPooledLines = ["•", "4."];
    const el = await render();
    await act(async () => {});

    expect(rowsFor(el, "4.")).toHaveLength(0);
  });

  it("an added bullet edited down to a bare marker is refused and keeps its row", async () => {
    // Pre-#678 this landed in "Other bullets" under an unresolvable id. With the
    // pool now dropping marker-only lines, storing it would leave an edit no row
    // renders — no per-row Edit, Remove or Undo, only `Reset to parsed`. So the
    // save is refused and the bullet stays exactly as it was.
    const el = await render();
    expect(rowsFor(el, ADDED_BULLET)).toHaveLength(0); // not added yet
    act(() => api.addBullet("experience:0", ADDED_BULLET));
    await act(async () => {});
    expect(rowsFor(el, ADDED_BULLET)).toHaveLength(1);

    await editBulletViaSave(el, ADDED_BULLET, DEGENERATE);

    expect(api.addedBullets).toEqual({ "experience:0": [ADDED_BULLET] });
    expect(rowsFor(el, ADDED_BULLET)).toHaveLength(1);
    expect(rowsFor(el, DEGENERATE)).toHaveLength(0);
  });

  it("a PARSED bullet edited down to a bare marker is refused too", async () => {
    // The override path has the same hole: an override of `"3."` would rewrite
    // the pooled line to something the pool drops, taking the row with it.
    const el = await render();

    await editBulletViaSave(el, PARSED_BULLET, DEGENERATE);

    expect(api.bulletOverrides).toEqual({});
    expect(api.hasEdits).toBe(false);
    expect(el.textContent).toContain(PARSED_BULLET);
  });

  it("a refused marker-only edit and a PARSED marker-only line never cross-contaminate", async () => {
    // Two independent origins for the same shape of line, mounted in the same
    // tree, to prove neither's handling is masking the other's.
    extraPooledLines = [PARSED_DEGENERATE];
    const el = await render();
    attemptDegenerateEdit("1.");
    await act(async () => {});

    expect(rowsFor(el, "4.")).toHaveLength(0);
    expect(rowsFor(el, "1.")).toHaveLength(0);
    expect(rowsFor(el, ADDED_BULLET)).toHaveLength(1);
    expect(api.addedBullets).toEqual({ "experience:0": [ADDED_BULLET] });
    expect(api.removedBullets.size).toBe(0);
  });

  it("a refused marker-only edit arms no Undo and survives a section exit", async () => {
    // #637 half 2, #684, #677 and #659 concern what happens when removing a
    // bullet empties a user-added ROLE; `ExperienceSection.prune-hold.test.tsx`
    // exercises that chain via a REAL bullet's normal Remove button. This test
    // only pins that the refused edit is not a removal in disguise: no Undo
    // strip, and the bullet is still there after the section exits.
    const el = await render();
    attemptDegenerateEdit();
    await act(async () => {});

    expect(el.querySelector(`[aria-label="${UNDO_LABEL}"]`)).toBeNull();

    await exitSection(el);

    expect(api.addedBullets).toEqual({ "experience:0": [ADDED_BULLET] });
    expect(el.querySelector(`[aria-label="${UNDO_LABEL}"]`)).toBeNull();
  });
});
