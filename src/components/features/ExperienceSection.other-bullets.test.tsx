// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression test for #660 half 2 — Remove was inert on a bullet that fell
 * through to the "Other bullets" group while its line lived in an `addedBullets`
 * bucket.
 *
 * That group owns no entry, so it has no `entryKey` to build an `AddedBulletRef`
 * from; it used to drop the row's text outright and remove by id alone. For a
 * line whose normalised key is EMPTY that id is `"<n>|"`, which
 * `resolveOverrideOriginal` resolves to nothing — so the click removed nothing,
 * confirmed "Removed 1 change" anyway, and left a permanently unresolvable entry
 * in `removedBullets` that keeps the résumé "dirty". The fix resolves the bucket
 * from the row's text (`findAddedBulletEntry`).
 *
 * Both surfaces are driven for real: the section renders over the REAL
 * `useEditableParse` and the REAL `applyOverrides` → `computeAnonymousAtsScore` →
 * `groupBulletsByExperience` chain, so the degenerate row appears in "Other
 * bullets" because the shipped code put it there.
 *
 * How the degenerate line is created matters, so it is created the one way that
 * is still REACHABLE after half 1: an in-place EDIT. `addBullet` now refuses a
 * contentless line, but `replaceAddedBulletLine` rejects only a BLANK
 * replacement, so committing `"3."` over a real added bullet still writes it to
 * the bucket. Nothing here is staged by hand.
 *
 * `ORPHAN_BULLET` is the control: a pooled rawText line no description carries,
 * so it sits in "Other bullets" permanently and is NOT in any bucket. Removing it
 * must still file its id — that is what "the ref costs nothing when it misses"
 * means, and it is the behaviour a too-eager resolver would break.
 *
 * The last block is the OTHER half of AC 2, which the bucket resolver cannot
 * reach at all: a degenerate line that came straight out of the PDF is in no
 * bucket either, so it misses the resolver exactly as ORPHAN_BULLET does and
 * falls through to the id-keyed path carrying the same unresolvable `"<n>|"`.
 * AC 2 is unconditional ("No removal on the Other-bullets path pushes an
 * observation index that resolves to nothing"), so the id-keyed path itself has
 * to refuse such an id — which also satisfies #659 AC 1, since only a `false`
 * suppresses the "Removed" strip. `PARSED_DEGENERATE` is that input, and it is
 * reachable from a real Word export rather than synthetic (see its own note).
 *
 * The last describe block is what half 2 COST, and neither of the two defects it
 * pins was reachable before it: the removal only ever wrote `removedBullets`
 * until half 2 taught it to splice a real bucket. Both are the same shape as the
 * bugs #659 and #637 half 2 fixed, arriving on the one path neither covered —
 * which is why the coverage hole was that no case above ever CLICKS the Undo the
 * removal arms.
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
  collapseStrip,
  exitSection,
} from "./__test-utils__/experience-section-dom.ts";

const PARSED_BULLET = "Cut p99 checkout latency by 38% via edge caching.";
/** Pooled from the section but absent from every description → "Other". */
const ORPHAN_BULLET = "Presented quarterly reviews to the exec staff.";
const ADDED_BULLET = "Shipped a design system used by 40 engineers.";
/** The contentless replacement. Numbered rather than a glyph on purpose: a lone
 *  glyph scores 0 words and `extractBulletsFromLines` drops it, so it never
 *  becomes a row at all — only a numbered marker reaches the pool. */
const DEGENERATE = "3.";
/**
 * A degenerate line straight out of the PDF, needing no edit to exist.
 *
 * `BULLET_MARKER_RE` strips the `"• "`, leaving `"4."`; `countWords` sees the
 * digit through `\p{N}` and returns 1, so `ANON_BULLET_MIN_WORDS` does not filter
 * it and it enters the pool as a row with its own Remove control. Its normalised
 * key is then empty (`LEADING_MARKER_RE` eats `\d+[.)]`), so the grouper skips it
 * and it lands in "Other bullets" — with `"0|"` for an id.
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
 *
 * Kept OUT of the default fixture deliberately: a second empty-key line would
 * take ordinal `0|` and push the added degenerate line to `1|`, breaking the
 * `expect(degenerateId).toBe("0|")` the added-half tests rest on.
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

/** The "Remove bullet" control on the ONE row rendering `text`. Asserting
 *  uniqueness is what keeps the test from silently clicking a neighbour after a
 *  layout change. */
function removeButtonFor(el: HTMLDivElement, text: string): HTMLButtonElement {
  const rows = Array.from(el.querySelectorAll("li")).filter((li) =>
    li.textContent?.includes(text),
  );
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
  const rows = Array.from(el.querySelectorAll("li")).filter((li) =>
    li.textContent?.includes(text),
  );
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
 * Add a real bullet to the parsed role, then commit a contentless line over it —
 * the shipped `ResumeBulletRow` edit call, with the `AddedBulletRef` that row
 * supplies. Returns the id the degenerate row will carry.
 *
 * `degenerate` is a parameter because which contentless text a bucket holds is
 * the discriminator for the wrong-bucket case below: two DIFFERENT markers both
 * normalise to `""`, so a resolver keyed on the normalised form cannot tell them
 * apart.
 */
function mintDegenerateLine(degenerate: string = DEGENERATE): string {
  act(() => api.addBullet("experience:0", ADDED_BULLET));
  act(() =>
    api.setBulletField(bulletId(ADDED_BULLET, 0), degenerate, {
      entryKey: "experience:0",
      text: ADDED_BULLET,
    }),
  );
  expect(api.addedBullets["experience:0"]).toEqual([degenerate]);
  return bulletId(degenerate, 0);
}

describe("ExperienceSection — 'Other bullets' Remove on an added line (#660 half 2)", () => {
  it("drops the degenerate line from the bucket, the pool and the DOM", async () => {
    const el = await render();
    mintDegenerateLine();
    await act(async () => {});

    // It really did fall through to the group with no entry.
    expect(el.textContent).toContain("Other bullets");
    expect(removeButtonFor(el, DEGENERATE)).toBeTruthy();

    await click(removeButtonFor(el, DEGENERATE));

    // Spliced out of the bucket that actually held it…
    expect(api.addedBullets).toEqual({});
    // …and gone from the rendered résumé.
    expect(
      Array.from(el.querySelectorAll("li")).filter((li) =>
        li.textContent?.includes(DEGENERATE),
      ),
    ).toHaveLength(0);
    // The confirmation strip belongs in THIS assertion, not its own test: it
    // armed pre-fix too (the inert write still returned true, #659's false
    // "Removed"), so a strip assertion alone can never go red. Paired with the
    // splice above it says the thing that is newly true — the strip now
    // confirms a removal that happened. Hosted by the SECTION, because the
    // group vanished with its last bullet.
    expect(el.textContent).toContain("Removed 1 change");
  });

  it("files NO unresolvable id for it (AC 2)", async () => {
    const el = await render();
    const degenerateId = mintDegenerateLine();
    await act(async () => {});

    // `"<n>|"` — the id shape whose normalised text is empty, which
    // `resolveOverrideOriginal` cannot resolve.
    expect(degenerateId).toBe("0|");

    await click(removeButtonFor(el, DEGENERATE));

    expect(api.removedBullets.size).toBe(0);
    // No permanent phantom edit left behind either.
    expect(api.hasEdits).toBe(false);
  });

  it("still removes a genuinely-unmatched PARSED bullet by id", async () => {
    // The control, and deliberately green BOTH ways: ORPHAN_BULLET is in no
    // bucket, so the resolver finds nothing and the removal must fall through to
    // `removedBullets` exactly as before — the "costs nothing when it misses"
    // half of the fix. It fails only if the resolver over-reaches.
    const el = await render();
    expect(el.textContent).toContain("Other bullets");

    await click(removeButtonFor(el, ORPHAN_BULLET));

    expect(api.removedBullets.has(bulletId(ORPHAN_BULLET, 0))).toBe(true);
    expect(api.addedBullets).toEqual({});
    expect(el.textContent).not.toContain(ORPHAN_BULLET);
    expect(el.textContent).toContain("Removed 1 change");
  });

  it("renders BOTH tied rows read-only rather than let either guess (#683, #1052)", async () => {
    // Two added roles each holding a contentless line of the SAME verbatim text.
    // `sameBulletLine`'s verbatim fallback tells `"3."` from `"4."` but cannot
    // tell one `"3."` from another, so both rows in "Other bullets" name the same
    // ambiguous target text — `resolveOtherBulletRef` refuses to pick one (#683),
    // which since #1052 means NEITHER row offers an action: the write is exactly
    // as un-landable as the unambiguous unresolvable case is, even though both
    // lines are otherwise user-added (#1048).
    const el = await render();
    mintDegenerateLine();
    let second = "";
    act(() => {
      second = api.addEntry("experience");
    });
    act(() => api.addBullet(second, ADDED_BULLET));
    act(() =>
      api.setBulletField(bulletId(ADDED_BULLET, 0), DEGENERATE, {
        entryKey: second,
        text: ADDED_BULLET,
      }),
    );
    await act(async () => {});
    expect(api.addedBullets["experience:0"]).toEqual([DEGENERATE]);
    expect(api.addedBullets[second]).toEqual([DEGENERATE]);

    const rows = Array.from(el.querySelectorAll("li")).filter((li) =>
      li.textContent?.includes(DEGENERATE),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(
        row.querySelector('[aria-label="Remove bullet"]'),
      ).toBeNull();
      expect(row.querySelector('[role="button"]')).toBeNull();
    }

    // Neither bucket is touched merely by rendering, and nothing is filed by id.
    expect(api.addedBullets["experience:0"]).toEqual([DEGENERATE]);
    expect(api.addedBullets[second]).toEqual([DEGENERATE]);
    expect(api.removedBullets.size).toBe(0);
  });
});

describe("ExperienceSection — a PARSED degenerate line (#660 AC 2, unconditional)", () => {
  /**
   * The row, plus the two facts that make it the AC-2 case: it is in NO bucket
   * (nothing was ever added), so `findAddedBulletEntry` misses and the removal
   * falls through to the id-keyed path — carrying an id whose text half is empty.
   */
  /** Since #1052, the row itself carries neither Remove nor click-to-edit — a
   *  write can never land here, so the click-then-assert-no-op shape the tests
   *  below used pre-#1052 no longer applies; asserting the row's rendering is
   *  the whole test now. */
  function expectDegenerateRowReadOnly(el: HTMLDivElement): void {
    expect(el.textContent).toContain("Other bullets");
    expect(bulletId("4.", 0)).toBe("0|");
    const rows = rowsFor(el, "4.");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector('[aria-label="Remove bullet"]')).toBeNull();
    expect(rows[0]!.querySelector('[role="button"]')).toBeNull();
  }

  it("renders read-only: no Remove, no click-to-edit, and no phantom edit (#1052)", async () => {
    extraPooledLines = [PARSED_DEGENERATE];
    const el = await render();
    await act(async () => {});
    expect(api.addedBullets).toEqual({});

    expectDegenerateRowReadOnly(el);

    // Pre-#1052 a click here filed `Set { "0|" }` — an id `resolveOverrideOriginal`
    // resolves to nothing, so it removed nothing yet stayed in the set forever,
    // keeping the résumé permanently "dirty" with a phantom edit no Undo could
    // clear. With no control to click, none of that can happen at all.
    expect(api.removedBullets.size).toBe(0);
    expect(api.hasEdits).toBe(false);
    expect(el.textContent).not.toContain("Removed 1 change");
  });

  it("does the same for the #30 lone-bullet-merge shape", async () => {
    // The glyph and its text in separate extracted lines — what a Word table
    // emits when they sit in separate cells. `extractBulletsFromLines` merges
    // them, so the pool holds one `"4."` row and this is the SAME defect arriving
    // by the path #30 exists for, not a variant of it.
    extraPooledLines = ["•", "4."];
    const el = await render();
    await act(async () => {});
    expect(api.addedBullets).toEqual({});

    expectDegenerateRowReadOnly(el);

    expect(api.removedBullets.size).toBe(0);
    expect(api.hasEdits).toBe(false);
    expect(el.textContent).not.toContain("Removed 1 change");
  });

  it("never risks splicing a DIFFERENT role's contentless line (wrong-bucket splice)", async () => {
    // Pre-#1052 this clicked the parsed "4." row's Remove to prove the resolver
    // does not mismatch it against the unrelated "1." bucket. That control no
    // longer renders at all — both texts normalise to `""`, so the normalised
    // key cannot discriminate them, and `findAddedBulletEntry` is exercised
    // directly in `added-bullets.test.ts` (#683). Here the only thing left to
    // pin is that the parsed row stays read-only while its added bystander does
    // not.
    extraPooledLines = [PARSED_DEGENERATE];
    const el = await render();
    mintDegenerateLine("1.");
    await act(async () => {});

    // Two degenerate rows, both in "Other bullets" (the grouper skips the empty
    // key, so neither can be attributed to the entry that owns it).
    expect(el.textContent).toContain("Other bullets");
    expect(api.addedBullets).toEqual({ "experience:0": ["1."] });

    expectDegenerateRowReadOnly(el);
    // The bystander is user-added and unambiguous, so it keeps its Remove.
    expect(removeButtonFor(el, "1.")).toBeTruthy();
    // `hasEdits` stays TRUE here, and correctly so — the user really did add and
    // edit a bullet.
    expect(api.hasEdits).toBe(true);
  });

  it("still splices the RIGHT bucket when the clicked row is the added one", async () => {
    // The other side of the discrimination: #660 half 2 IS a degenerate row
    // resolving to its own bucket, which stays actionable. Same tree shape as
    // the case above — a read-only parsed "4." row present — with the click on
    // the added "1." row instead.
    extraPooledLines = [PARSED_DEGENERATE];
    const el = await render();
    mintDegenerateLine("1.");
    await act(async () => {});

    await click(removeButtonFor(el, "1."));

    expect(api.addedBullets).toEqual({});
    expect(api.removedBullets.size).toBe(0);
    expect(el.textContent).toContain("Removed 1 change");
    // The parsed degenerate row is the bystander this time: still rendered,
    // still read-only.
    expectDegenerateRowReadOnly(el);
  });

  it("still removes the genuinely-unmatched orphan alongside it", async () => {
    // The guard is on the id's SHAPE, not on the fall-through: a real bullet that
    // misses the bucket resolver must still be removable by id. Run with the
    // degenerate line present so the two are decided in the same mounted tree.
    extraPooledLines = [PARSED_DEGENERATE];
    const el = await render();
    await act(async () => {});

    await click(removeButtonFor(el, ORPHAN_BULLET));

    expect(api.removedBullets.has(bulletId(ORPHAN_BULLET, 0))).toBe(true);
    expect(el.textContent).not.toContain(ORPHAN_BULLET);
    expect(el.textContent).toContain("Removed 1 change");
  });
});

/**
 * A user-ADDED role whose one and only bullet has been edited down to a
 * contentless line, so that line is the whole of its bucket.
 *
 * Built the same reachable way as {@link mintDegenerateLine} — add a real bullet,
 * then commit a contentless replacement over it through the shipped
 * `setBulletField` — but under an ADDED entry, which is the difference that
 * matters: the splice then empties an entry `pruneEmptyAddedEntries` can drop,
 * and the role has a blank header, so `isAddedEntryEmpty` is true the moment the
 * bucket goes. A role with a typed title would never be prunable and a test built
 * on one would pass with the hold ripped out.
 *
 * Returns the entry id.
 */
function mintDegenerateAddedRole(): string {
  let added = "";
  act(() => {
    added = api.addEntry("experience");
  });
  act(() => api.addBullet(added, ADDED_BULLET));
  act(() =>
    api.setBulletField(bulletId(ADDED_BULLET, 0), DEGENERATE, {
      entryKey: added,
      text: ADDED_BULLET,
    }),
  );
  expect(api.addedBullets[added]).toEqual([DEGENERATE]);
  return added;
}

/** The one row rendering `text`, or none. */
function rowsFor(el: HTMLDivElement, text: string): HTMLLIElement[] {
  return Array.from(el.querySelectorAll("li")).filter((li) =>
    li.textContent?.includes(text),
  );
}

describe("ExperienceSection — the Undo this Remove arms must actually revert it", () => {
  it("puts the line back in the bucket the removal spliced (#660 half 2 × #659)", async () => {
    // The gap every case above left open: none of them clicks Undo. The strip is
    // section-hosted, so it survives the group's disappearance and the button is
    // mounted and clickable either way — what it RESTORES is the only thing that
    // can tell a correct snapshot from a snapshot of a bucket nobody wrote.
    //
    // With a placeholder entry key, `captureBulletUndoSnapshot` read
    // `addedBullets["other-bullets"]` as `[]` while the removal spliced
    // `experience:0`, so the undo deleted a key that never existed and the line
    // was gone for good behind a strip reporting "Reverted 1 change".
    const el = await render();
    mintDegenerateLine();
    await act(async () => {});
    expect(rowsFor(el, DEGENERATE)).toHaveLength(1);

    await click(removeButtonFor(el, DEGENERATE));
    expect(api.addedBullets).toEqual({});

    const undo = el.querySelector<HTMLElement>(`[aria-label="${UNDO_LABEL}"]`);
    expect(undo).not.toBeNull();
    await click(undo!);

    // The real bucket, restored to its exact pre-remove value.
    expect(api.addedBullets).toEqual({ "experience:0": [DEGENERATE] });
    // And back on screen, in the group it grouped into before.
    expect(el.textContent).toContain("Other bullets");
    expect(rowsFor(el, DEGENERATE)).toHaveLength(1);
    expect(el.textContent).toContain("Reverted 1 change");
    // Nothing leaked to the id-keyed path on the way out or back.
    expect(api.removedBullets.size).toBe(0);
    // TRUE, and correctly so: the user really did add a bullet and edit it, and
    // the undo just put that back. `hasEdits` reads the restored bucket, so a
    // "clean after undo" assertion here would be asserting the line is still
    // gone — which is the defect, not the fix.
    expect(api.hasEdits).toBe(true);
  });

  it("holds the added role its splice emptied back from the section-exit prune, THEN prunes it on release (#684)", async () => {
    // #637 half 2, one level up. Half 2 of #660 made this removal splice a real
    // bucket, so it can empty a user-added ROLE — while the strip holding that
    // role's Undo is hosted by the SECTION, which the prune never unmounts. The
    // hold in `ReconstructedRole` cannot cover it: the holder for this control is
    // the "Other bullets" `RoleEntry`, whose `entryKey` is undefined, so its
    // `useHoldWhile` is a no-op. Unheld, `sectionExitBlur` dropped the whole role
    // one tick after the next blur, with the Undo still on screen offering to
    // restore it.
    const el = await render();
    const added = mintDegenerateAddedRole();
    await act(async () => {});
    expect(api.addedEntries.map((e) => e.id)).toEqual([added]);

    await click(removeButtonFor(el, DEGENERATE));
    // The role is NOW genuinely empty — blank header, bucket spliced away — so
    // the prune would take it.
    expect(api.addedBullets).toEqual({});
    expect(el.textContent).toContain("Removed 1 change");

    await exitSection(el);

    expect(api.addedEntries.map((e) => e.id)).toEqual([added]);
    expect(el.querySelector(`[aria-label="${UNDO_LABEL}"]`)).not.toBeNull();

    // #684: the strip collapses with the role holding neither focus nor an open
    // draft, so `pruneHold.getHost(added)` — published by `ReconstructedRole`
    // under its own `entryKey`, since it is a different subtree than this
    // control's own — reads it as no longer in use, and the release prune drops
    // it immediately. No more waiting on a section exit the user may never
    // trigger.
    await collapseStrip();
    expect(el.textContent).not.toContain("Removed 1 change");
    expect(api.addedEntries).toHaveLength(0);

    // Idempotent: a section exit finding nothing left to prune is a no-op, not
    // an error.
    await exitSection(el);
    expect(api.addedEntries).toHaveLength(0);
  });

  it("still leaves the emptied role to the section-exit pass while it holds an open draft (#684)", async () => {
    // The live-input gate `useAddedEntryPruneHold` already enforces for a role
    // holding ITSELF (#658) has to hold here too, now that the release prune can
    // reach a role via a DIFFERENT holder's release. Typing into the emptied
    // role's own title while its Undo collapses must not yank the row out from
    // under that draft.
    const el = await render();
    const added = mintDegenerateAddedRole();
    await act(async () => {});

    await click(removeButtonFor(el, DEGENERATE));
    await exitSection(el);
    expect(api.addedEntries.map((e) => e.id)).toEqual([added]);

    // The one field every `RoleEntry` renders even with a blank header — empty,
    // so its accessible name is "Add …" rather than "Edit …" (EditableField),
    // which is also what tells it apart from the parsed role's own filled title.
    const titleField = el.querySelector<HTMLElement>(
      '[aria-label="Add Job title"]',
    )!;
    await click(titleField);
    // Multiline `EditableField` commits only on an explicit Save, so this stays
    // mounted regardless of focus — the open-draft half of the gate, not focus
    // containment.
    expect(el.querySelector('[aria-label="Job title"]')).not.toBeNull();

    await collapseStrip();

    // Spared: `pruneHold.getHost(added)` finds the role's own root, which
    // `keepsEntry` reads as still holding an open text control.
    expect(api.addedEntries.map((e) => e.id)).toEqual([added]);

    // The section-exit pass has always treated an open draft as emptiness
    // (pre-existing, filed separately) — it eventually sweeps the ghost either
    // way, so this is not a permanent reprieve.
    await exitSection(el);
    expect(api.addedEntries).toHaveLength(0);
  });

  it("does not let a PARSED entry's splice displace a live added role's hold", async () => {
    // `heldEntry` is a SINGLE value, so every landed removal overwrites it. That
    // is safe only because the write is gated on the resolved key being an ADDED
    // one: a parsed entry is never prunable, so holding its key would buy
    // nothing — and would silently release the added role whose strip is still
    // live, handing it straight back to the section-exit prune.
    //
    // Two degenerate rows with DIFFERENT markers so the resolver is unambiguous
    // (identical text is the #683 ambiguous-resolution case, exercised on its
    // own above): one in the added role's bucket, one in the parsed
    // `experience:0` bucket.
    const el = await render();
    const added = mintDegenerateAddedRole();
    mintDegenerateLine("1.");
    await act(async () => {});
    expect(api.addedEntries.map((e) => e.id)).toEqual([added]);

    // Empties the added role and takes the hold.
    await click(removeButtonFor(el, DEGENERATE));
    expect(api.addedEntries.map((e) => e.id)).toEqual([added]);

    // Lands under `experience:0` — a PARSED key. It must not become the held id.
    await click(removeButtonFor(el, "1."));
    expect(api.addedBullets).toEqual({});

    // Still held by the first removal, so the strip's Undo still has a role to
    // restore into. Drop the `isAddedEntryKey` gate and this is where it dies.
    await exitSection(el);
    expect(api.addedEntries.map((e) => e.id)).toEqual([added]);
  });

  it("and that surviving Undo restores the role's bucket, not a phantom one", async () => {
    // Both halves in one flow, which is the state the user is actually in: the
    // role is spared, so the Undo has something to restore INTO — and it has to
    // name the bucket the splice took the line out of.
    const el = await render();
    const added = mintDegenerateAddedRole();
    await act(async () => {});

    await click(removeButtonFor(el, DEGENERATE));
    await exitSection(el);

    await click(el.querySelector<HTMLElement>(`[aria-label="${UNDO_LABEL}"]`)!);

    expect(api.addedBullets[added]).toEqual([DEGENERATE]);
    expect(api.addedEntries.map((e) => e.id)).toEqual([added]);
    expect(rowsFor(el, DEGENERATE)).toHaveLength(1);
    expect(el.textContent).toContain("Reverted 1 change");
    expect(api.removedBullets.size).toBe(0);

    // No longer empty, so the next prune pass leaves it alone — the restored
    // bullet is what keeps it, decided by `pruneEmptyAddedEntries` at prune time
    // rather than by anything this path closed over.
    await collapseStrip();
    await exitSection(el);
    expect(api.addedEntries.map((e) => e.id)).toEqual([added]);
    expect(api.addedBullets[added]).toEqual([DEGENERATE]);
  });
});

/**
 * Regression test for #679 — the mirror image of #660 half 2, on the EDIT half
 * of the same pair of call sites. The "Other bullets" group's Remove already
 * resolved its bucket from the row's text; its edit path did not, so
 * committing an edit on a degenerate row (via the Save button — a `multiline`
 * `EditableField` ignores Enter) filed a `bulletOverrides` entry keyed `"<n>|"`
 * that `resolveOverrideOriginal` can never resolve: the edit was inert AND
 * permanent, riding along in every snapshot with `hasEdits` stuck true.
 *
 * Two shapes, same as #660's own split:
 *   - a degenerate line inside an `addedBullets` bucket (added the reachable
 *     way — an in-place edit down to a marker-only line, `mintDegenerateLine`)
 *     now resolves through `findAddedBulletEntry` exactly as Remove already
 *     did, so committing a real replacement lands IN the bucket instead of
 *     filing an unresolvable override.
 *   - a PARSED degenerate line belongs to no bucket at all, so the resolver
 *     cannot help it; `setBulletField`'s own `isUnresolvableBulletKey` guard
 *     (mirroring `removeBullet`'s) refuses the write outright rather than
 *     filing the phantom.
 *
 * Both are driven through the real `ResumeBulletRow` → `EditableField` Save
 * button, over the real `useEditableParse` + `ExperienceSection` wiring — a
 * hook-level call to `setBulletField` alone would not exercise the component
 * wiring the issue's actual bug lived in (the "Other bullets" `RoleEntry`
 * always resolved `undefined`, having no `entryKey` of its own).
 */
describe("ExperienceSection — 'Other bullets' Edit on a degenerate ADDED line (#679)", () => {
  it("writes the edit into the bucket instead of filing a permanent override", async () => {
    const el = await render();
    mintDegenerateLine();
    await act(async () => {});
    expect(rowsFor(el, DEGENERATE)).toHaveLength(1);

    const REAL_TEXT = "Shipped a real bullet with 30% impact.";
    await editBulletViaSave(el, DEGENERATE, REAL_TEXT);

    // Landed in the bucket the degenerate line actually lived in…
    expect(api.addedBullets).toEqual({ "experience:0": [REAL_TEXT] });
    // …not as an unresolvable override.
    expect(api.bulletOverrides).toEqual({});
    // The row now renders the edited text, not the marker it replaced.
    expect(el.textContent).toContain(REAL_TEXT);
    expect(rowsFor(el, DEGENERATE)).toHaveLength(0);
  });

  it("keeps the edit reachable by a later Remove (no ordering hazard)", async () => {
    // Same trap #657's own ordering case guards: had the edit been recorded as
    // an override instead of landing in the bucket, the bucket would still read
    // the PRE-edit text while the row (and the Remove's `AddedBulletRef.text`)
    // read the edited one, and a later Remove would miss.
    const el = await render();
    mintDegenerateLine();
    const REAL_TEXT = "Recovered a real bullet with 30% impact.";
    await editBulletViaSave(el, DEGENERATE, REAL_TEXT);

    await click(removeButtonFor(el, REAL_TEXT));

    expect(api.addedBullets).toEqual({});
    expect(api.removedBullets.size).toBe(0);
    expect(el.textContent).not.toContain(REAL_TEXT);
  });
});

describe("ExperienceSection — Edit on a PARSED degenerate line is refused, not filed (#679, #1052)", () => {
  it("offers no click-to-edit at all, so no override can ever be filed", async () => {
    extraPooledLines = [PARSED_DEGENERATE];
    const el = await render();
    await act(async () => {});
    expect(api.addedBullets).toEqual({});

    // Pre-#1052 this row offered a click-to-edit that `setBulletField` always
    // refused; since #1052 the row renders with none of the affordances a
    // refused write would sit behind (`ResumeBulletRow`'s `editable` and
    // `RemoveButton` are both driven by the presence of a callback).
    const rows = rowsFor(el, "4.");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector('[role="button"]')).toBeNull();
    expect(rows[0]!.querySelector('[aria-label="Remove bullet"]')).toBeNull();

    expect(api.bulletOverrides).toEqual({});
    expect(api.hasEdits).toBe(false);
  });

  it("still lets a genuinely-unmatched PARSED bullet be edited normally", async () => {
    // The control: ORPHAN_BULLET is real text in no bucket, so it must still
    // resolve to the ordinary override path — the guard is on the id's SHAPE,
    // not on "Other bullets" membership.
    const el = await render();

    const EDITED = "Presented quarterly reviews to the whole company.";
    await editBulletViaSave(el, ORPHAN_BULLET, EDITED);

    expect(Object.values(api.bulletOverrides)).toEqual([EDITED]);
    expect(el.textContent).toContain(EDITED);
  });
});
