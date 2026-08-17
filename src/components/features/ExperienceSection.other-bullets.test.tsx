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
      base.canonical.fields,
      base.rawText,
      base.canonical.sections,
      edit.contactOverrides,
      edit.experienceOverrides,
      edit.bulletOverrides,
      [],
      edit.educationOverrides,
      edit.skillsOverride,
      edit.addedEntries,
      edit.addedBullets,
      edit.removedBullets,
      edit.profileOverrides,
      base.canonical.fieldConfidence,
      edit.achievementOverrides,
      edit.descriptionOverrides,
      edit.summaryOverride,
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
    // false → no ModelSelector / rewrite CTA chrome in the test DOM.
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

  it("splices the FIRST bucket even when the SECOND row was clicked (#683, known)", async () => {
    // Two added roles each holding a contentless line of the SAME verbatim text.
    // `sameBulletLine`'s verbatim fallback tells `"3."` from `"4."` but cannot
    // tell one `"3."` from another, so `findAddedBulletEntry` falls back to
    // first-bucket-wins and BOTH rows resolve to the same bucket.
    //
    // This case CLICKS THE SECOND ROW on purpose. It used to click the first —
    // the row whose bucket wins the tiebreak — which made it green whether the
    // resolver was right or wrong, and that blindness is why #683 survived two
    // review rounds. Clicking the loser is what makes the assertion mean
    // something.
    //
    // What it pins is therefore the KNOWN-WRONG behaviour, so it goes red when
    // #683 is fixed — which is the point. The harm is bounded (only contentless
    // lines reach this branch, the undo snapshot agrees with the splice, and a
    // second click converges), which is why it ships open rather than blocking.
    // See #683 for the two candidate fixes and what each costs.
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
    await click(
      rows[1]!.querySelector<HTMLButtonElement>('[aria-label="Remove bullet"]')!,
    );

    // #683: the SECOND row was clicked, but the FIRST bucket in insertion order
    // is what loses its line — the clicked row's own bucket is untouched. Exactly
    // one line goes per click (a resolver returning every match would empty
    // both), and nothing is filed by id, so the bucket splice did report success.
    expect("experience:0" in api.addedBullets).toBe(false);
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
  function expectDegenerateRow(el: HTMLDivElement): HTMLButtonElement {
    expect(el.textContent).toContain("Other bullets");
    expect(api.addedBullets).toEqual({});
    expect(bulletId("4.", 0)).toBe("0|");
    return removeButtonFor(el, "4.");
  }

  it("files no unresolvable id and arms no strip for it", async () => {
    extraPooledLines = [PARSED_DEGENERATE];
    const el = await render();
    await act(async () => {});

    await click(expectDegenerateRow(el));

    // Pre-fix this was `Set { "0|" }` — an id `resolveOverrideOriginal` resolves
    // to nothing, so it removed nothing yet stayed in the set forever, keeping
    // the résumé permanently "dirty" with a phantom edit no Undo could clear.
    expect(api.removedBullets.size).toBe(0);
    expect(api.hasEdits).toBe(false);
    // #659 AC 1 — a removal that did nothing renders no "Removed" strip. Both
    // ACs ride the same `false`, which is why one guard closes them together.
    expect(el.textContent).not.toContain("Removed 1 change");
    // The row itself is still there, and that is the honest post-fix state: the
    // click is now a truthful no-op instead of a lie. Making the line removable
    // means keeping it out of the pool, which moves the Specificity denominator
    // for every résumé carrying one — a scoring change, filed on its own.
    expect(
      Array.from(el.querySelectorAll("li")).filter((li) =>
        li.textContent?.includes("4."),
      ),
    ).toHaveLength(1);
  });

  it("does the same for the #30 lone-bullet-merge shape", async () => {
    // The glyph and its text in separate extracted lines — what a Word table
    // emits when they sit in separate cells. `extractBulletsFromLines` merges
    // them, so the pool holds one `"4."` row and this is the SAME defect arriving
    // by the path #30 exists for, not a variant of it.
    extraPooledLines = ["•", "4."];
    const el = await render();
    await act(async () => {});

    await click(expectDegenerateRow(el));

    expect(api.removedBullets.size).toBe(0);
    expect(api.hasEdits).toBe(false);
    expect(el.textContent).not.toContain("Removed 1 change");
  });

  it("does not splice a DIFFERENT role's contentless line (wrong-bucket splice)", async () => {
    // The resolver runs before the id-shape guard, so a bucket it wrongly matches
    // is spliced and reported as success — the guard never sees the call. Both
    // texts normalise to `""`, so the normalised key cannot discriminate them:
    // the parsed row reads "4." and the bucket holds "1.".
    extraPooledLines = [PARSED_DEGENERATE];
    const el = await render();
    mintDegenerateLine("1.");
    await act(async () => {});

    // Two degenerate rows, both in "Other bullets" (the grouper skips the empty
    // key, so neither can be attributed to the entry that owns it).
    expect(el.textContent).toContain("Other bullets");
    expect(api.addedBullets).toEqual({ "experience:0": ["1."] });

    await click(removeButtonFor(el, "4."));

    // The clicked row is PARSED and in no bucket, so nothing may be spliced. Left
    // unguarded, `findAddedBulletEntry` matched `""` against the `"1."` bucket and
    // `removeAddedBulletLine` — which matches on the same normalised form —
    // deleted a line the user never clicked, from another role, and returned true.
    expect(api.addedBullets).toEqual({ "experience:0": ["1."] });
    expect(api.removedBullets.size).toBe(0);
    expect(el.textContent).not.toContain("Removed 1 change");
    // Both rows still rendered: the clicked one (nothing can remove it yet) and
    // the bystander (nothing should).
    expect(removeButtonFor(el, "4.")).toBeTruthy();
    expect(removeButtonFor(el, "1.")).toBeTruthy();
    // `hasEdits` stays TRUE here, and correctly so — the user really did add and
    // edit a bullet. It is the bystander bucket, not this flag, that carries the
    // signal in this case.
    expect(api.hasEdits).toBe(true);
  });

  it("still splices the RIGHT bucket when the clicked row is the added one", async () => {
    // The other side of the discrimination, and the reason the fix cannot simply
    // refuse an empty normalised target: #660 half 2 IS a degenerate row
    // resolving to its own bucket. Same tree shape as the case above — a parsed
    // "4." row present — with the click on the added "1." row instead.
    extraPooledLines = [PARSED_DEGENERATE];
    const el = await render();
    mintDegenerateLine("1.");
    await act(async () => {});

    await click(removeButtonFor(el, "1."));

    expect(api.addedBullets).toEqual({});
    expect(api.removedBullets.size).toBe(0);
    expect(el.textContent).toContain("Removed 1 change");
    // The parsed degenerate row is the bystander this time, and is untouched.
    expect(removeButtonFor(el, "4.")).toBeTruthy();
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

  it("holds the added role its splice emptied back from the section-exit prune", async () => {
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

    // The hold is a lease on the LIVE strip, not an exemption. This control
    // registers no host element — `host` governs only the release prune (#658),
    // and the subtree that could answer it is the emptied role's, not this
    // section's — so a collapse stands down rather than pruning, and the
    // section-exit pass is what eventually sweeps the ghost.
    await collapseStrip();
    expect(el.textContent).not.toContain("Removed 1 change");
    expect(api.addedEntries.map((e) => e.id)).toEqual([added]);

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
    // (identical text is #683, a separate defect): one in the added role's
    // bucket, one in the parsed `experience:0` bucket.
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
