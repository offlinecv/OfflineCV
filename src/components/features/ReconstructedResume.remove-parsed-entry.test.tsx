// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * #856 — the rendered delete affordance on a PARSED entry, and the index it
 * writes with.
 *
 * Two things can only be caught here, above the hook and below the pipeline:
 *
 * 1. The affordance EXISTS on a parsed entry. Before #856 every section gated
 *    its `RemoveButton` on the entry being user-added, which is the whole
 *    report: a phantom achievement could be blanked field by field but never
 *    dropped, and still shipped into the Download PDF.
 * 2. The key that crosses the component boundary is the PARSED index, not the
 *    render position. `applyOverrides` filters a deleted entry out of the array
 *    this section maps over, so from the first deletion on the two diverge —
 *    and `achievementOverrides`, `descriptionOverrides` and the tombstone set
 *    are all keyed by the parsed one. Writing a render position into any of them
 *    rebinds a survivor's edits to its neighbour's, silently and plausibly.
 *
 * Achievements is the section the report came from, and the one where all three
 * of those channels meet, so it is the one rendered. Spies rather than a live
 * hook: the claim is about which key crosses the boundary, which a spy states
 * directly and a re-graded pipeline only implies.
 *
 * jsdom + raw `createRoot`, matching `ExperienceSection.test.tsx`.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { AchievementsSection } from "./ReconstructedResume.tsx";
import { survivingParsedIndices } from "../../hooks/useEditableParse.ts";
import type { AddedEntry } from "../../hooks/useEditableParse.ts";
import { bulletId } from "../../lib/score/bullet-id.ts";
import type { BulletGroup } from "../../lib/score/group-bullets.ts";
import type { BulletObservation } from "../../lib/score/score.ts";
import type { HeuristicAchievement } from "../../lib/score/types.ts";

function bullet(index: number, text: string): BulletObservation {
  return {
    text,
    id: bulletId(text, 0),
    index,
    hasMetric: true,
    startsWithActionVerb: true,
    wellFormedLength: true,
    wordCount: 9,
  };
}

const PARSED: readonly HeuristicAchievement[] = [
  { type: "Patent", title: "Phantom method", year: "2019" },
  { type: "Award", title: "Best Paper", year: "2020" },
  { type: "Talk", title: "Scaling parsers", year: "2021" },
];

const CITED = "Cited by 40 downstream filings.";

/** Index-aligned groups, as `buildEntryGroups` hands them over. Only the middle
 *  entry carries bullets, so the cascade has something to be wrong about. */
function groupsFor(achievements: readonly HeuristicAchievement[]): BulletGroup[] {
  return achievements.map((a, i) => ({
    experienceIndex: i,
    experience: { title: a.title },
    bullets: a.title === "Best Paper" ? [bullet(0, CITED)] : [],
  }));
}

let container: HTMLDivElement;
let root: Root;

interface Spies {
  onRemoveEntry: ReturnType<typeof vi.fn>;
  onRemoveBullet: ReturnType<typeof vi.fn>;
  onAchievementField: ReturnType<typeof vi.fn>;
}

/**
 * Render the section over `achievements` with `removedEntries` already applied
 * — i.e. exactly the state the container is in on the render AFTER a deletion:
 * the array is filtered, and `parsedIndices` is the map back.
 */
function render(
  achievements: readonly HeuristicAchievement[],
  removedEntries: ReadonlySet<string> = new Set(),
  added: AddedEntry[] = [],
): Spies {
  const spies: Spies = {
    onRemoveEntry: vi.fn(),
    onRemoveBullet: vi.fn(() => true),
    onAchievementField: vi.fn(),
  };
  const originalCount = achievements.length - added.length;
  act(() =>
    root.render(
      createElement(AchievementsSection, {
        achievements: [...achievements],
        groups: groupsFor(achievements),
        addedAchievements: added,
        originalCount,
        parsedIndices: survivingParsedIndices(
          "achievements",
          removedEntries,
          originalCount,
        ),
        onAddEntry: () => {},
        onEntryField: () => {},
        onAddBullet: () => {},
        onPruneEmpty: () => {},
        ...spies,
      }),
    ),
  );
  return spies;
}

function removeButtons(): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>('[aria-label="Remove achievement"]'),
  ];
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the parsed-entry remove affordance (#856)", () => {
  it("renders one on EVERY entry, parsed and added alike", () => {
    render(PARSED);
    expect(removeButtons()).toHaveLength(3);
  });

  it("deletes by the entry's parsedEntryKey, and takes its bullets", () => {
    const spies = render(PARSED);
    act(() => removeButtons()[1].click());

    expect(spies.onRemoveEntry).toHaveBeenCalledExactlyOnceWith(
      "achievements:1",
    );
    // Bullets go through `removeBullet` — dropping the entry cannot take them
    // out of `sections`, which is the pool the anonymous scorer grades.
    expect(spies.onRemoveBullet).toHaveBeenCalledExactlyOnceWith(
      bulletId(CITED, 0),
      { entryKey: "achievements:1", text: CITED },
    );
  });

  it("deletes a bullet-less entry with no bullet writes at all", () => {
    const spies = render(PARSED);
    act(() => removeButtons()[0].click());
    expect(spies.onRemoveEntry).toHaveBeenCalledExactlyOnceWith(
      "achievements:0",
    );
    expect(spies.onRemoveBullet).not.toHaveBeenCalled();
  });

  it("still removes a user-ADDED entry by its own id", () => {
    const added: AddedEntry = {
      id: "added:7",
      section: "achievements",
      title: "Hand-typed award",
    };
    const spies = render(
      [...PARSED, { title: added.title }],
      new Set(),
      [added],
    );
    act(() => removeButtons()[3].click());
    expect(spies.onRemoveEntry).toHaveBeenCalledExactlyOnceWith("added:7");
  });
});

describe("index resolution after a deletion (#856)", () => {
  // The render AFTER deleting parsed index 0: the array the section maps over
  // has been filtered, so render position 0 is now parsed index 1.
  const AFTER = PARSED.slice(1);
  const REMOVED = new Set(["achievements:0"]);

  it("deletes the NEXT entry by its parsed index, not its render position", () => {
    const spies = render(AFTER, REMOVED);
    expect(removeButtons()).toHaveLength(2);

    act(() => removeButtons()[0].click());
    // Render position 0 — "achievements:0" here would be a no-op re-delete of
    // the entry that is already gone, leaving this one un-deletable forever.
    expect(spies.onRemoveEntry).toHaveBeenCalledExactlyOnceWith(
      "achievements:1",
    );
    expect(spies.onRemoveBullet).toHaveBeenCalledExactlyOnceWith(
      bulletId(CITED, 0),
      { entryKey: "achievements:1", text: CITED },
    );
  });

  it("files a surviving entry's field edit under its parsed index", () => {
    const spies = render(AFTER, REMOVED);
    // The year cell of the SECOND surviving entry — parsed index 2. Read mode
    // names the control "Edit <label>" (`EditableField`, WCAG 2.5.3).
    const years = [
      ...container.querySelectorAll<HTMLElement>('[aria-label="Edit Year"]'),
    ];
    expect(years).toHaveLength(2);

    act(() => years[1].click());
    const input = container.querySelector<HTMLInputElement>("input");
    expect(input).not.toBeNull();
    act(() => {
      // Through the prototype setter, so React's own value tracker sees the
      // change and does not swallow the synthetic `input` event.
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input!, "2023");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() =>
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );

    // Render position 1 — `(1, …)` here would overwrite the OTHER survivor.
    expect(spies.onAchievementField).toHaveBeenCalledExactlyOnceWith(
      2,
      "year",
      "2023",
    );
  });
});

/**
 * #884 — the same component, instantiated for the CERTIFICATIONS bucket.
 *
 * Certifications render through `AchievementsSection` rather than a second
 * copy of it (the reuse gate), which makes the `section` prop the only thing
 * standing between a certification's edits and the achievements bucket's index
 * space. It is exactly the #856 failure mode one level up: a key that names the
 * wrong SECTION rebinds an edit to a different list entirely, silently and
 * plausibly. So the key is asserted here, at the boundary, for the same reason
 * the parsed index is above.
 */
describe("the same section rendered for certifications (#884)", () => {
  const CERTS: readonly HeuristicAchievement[] = [
    { type: "AWS", title: "Solutions Architect", year: "2022" },
    { title: "CKA", year: "2023" },
  ];

  function renderCerts(): ReturnType<typeof vi.fn> {
    const onRemoveEntry = vi.fn();
    act(() =>
      root.render(
        createElement(AchievementsSection, {
          section: "certifications",
          fallbackHeading: "Certifications",
          entryNoun: "certification",
          achievements: [...CERTS],
          groups: [],
          addedAchievements: [],
          originalCount: CERTS.length,
          parsedIndices: survivingParsedIndices(
            "certifications",
            new Set(),
            CERTS.length,
          ),
          onAddEntry: () => {},
          onEntryField: () => {},
          onAddBullet: () => {},
          onPruneEmpty: () => {},
          onRemoveEntry,
          onRemoveBullet: vi.fn(() => true),
          onAchievementField: vi.fn(),
        }),
      ),
    );
    return onRemoveEntry;
  }

  it("deletes by a certifications-scoped key, never an achievements one", () => {
    const onRemoveEntry = renderCerts();
    const buttons = [
      ...container.querySelectorAll<HTMLElement>(
        '[aria-label="Remove certification"]',
      ),
    ];
    expect(buttons).toHaveLength(2);
    act(() => buttons[1].click());
    expect(onRemoveEntry).toHaveBeenCalledExactlyOnceWith("certifications:1");
  });

  it("renders its own heading and add affordance", () => {
    renderCerts();
    expect(container.textContent).toContain("Certifications");
    expect(container.textContent).not.toContain("Achievements");
    expect(container.textContent).toContain("Add certification");
  });
});
