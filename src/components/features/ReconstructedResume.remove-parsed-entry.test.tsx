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

/**
 * #899 — the certification-only bugs on top of the shared `AchievementsSection`
 * component #884 introduced: the achievements-only `AchievementTypePicker`
 * leaking onto credential rows, a dangling `·` in front of an empty year, and
 * multiple credentials each taking a full vertical row instead of compressing
 * onto one wrapped, middot-separated line.
 *
 * The compact line is where a row loses its own vertical space, so what it may
 * and may not take with it is the rest of this block: the year form has to be
 * the one the PDF draws (`compactCredentialHeader`), the `·` may mean only one
 * thing at a time, and no row may be routed onto the line if the affordance it
 * owns lives off it — which is what stranded an added credential with no way to
 * ever get a bullet.
 */
describe("compact certifications layout (#899)", () => {
  function renderCertsWith(
    certs: readonly HeuristicAchievement[],
    added: readonly AddedEntry[] = [],
  ): void {
    const all: HeuristicAchievement[] = [
      ...certs,
      ...added.map((a) => ({ title: a.title })),
    ];
    act(() =>
      root.render(
        createElement(AchievementsSection, {
          section: "certifications",
          fallbackHeading: "Certifications",
          entryNoun: "certification",
          achievements: all,
          groups: all.map((c, i) => ({
            experienceIndex: i,
            experience: { title: c.title },
            bullets: [],
          })),
          addedAchievements: [...added],
          originalCount: certs.length,
          parsedIndices: survivingParsedIndices(
            "certifications",
            new Set(),
            certs.length,
          ),
          onAddEntry: () => {},
          onEntryField: () => {},
          onAddBullet: () => {},
          onPruneEmpty: () => {},
          onRemoveEntry: () => {},
          onRemoveBullet: vi.fn(() => true),
          onAchievementField: vi.fn(),
        }),
      ),
    );
  }

  /** Every rendered `·` glyph — the achievement type↔title separator, the
   *  title↔year separator, and the between-item compact-row separator all
   *  draw through the same `aria-hidden` span shape. */
  function middotSpans(): HTMLElement[] {
    return [
      ...container.querySelectorAll<HTMLElement>('span[aria-hidden="true"]'),
    ].filter((el) => el.textContent === "·");
  }

  it("never renders the achievement type picker for a certification row", () => {
    renderCertsWith([
      { title: "AWS Certified Solutions Architect", year: "2022" },
    ]);
    expect(container.querySelector('[aria-haspopup="menu"]')).toBeNull();
  });

  it("omits the dangling separator when a certification has no year", () => {
    renderCertsWith([{ title: "Patent Bar Registration" }]);
    // A single, dateless certification: no type-picker separator (gated off),
    // no title↔year separator (no year to set off), no between-item separator
    // (only one item) — zero middots anywhere in the row.
    expect(middotSpans()).toHaveLength(0);
  });

  it("joins two or more certifications with exactly one between-item middot", () => {
    renderCertsWith([
      { title: "AWS Certified Solutions Architect" },
      { title: "CKA" },
    ]);
    // Neither carries a year, so the only middot either could draw is the
    // compact row's between-item separator — one, joining the pair, none
    // trailing the last item.
    expect(middotSpans()).toHaveLength(1);
  });

  it("parenthesises the year, so one glyph never means two things", () => {
    renderCertsWith([
      { title: "AWS Certified Solutions Architect", year: "2022" },
      { title: "CKA" },
    ]);
    // The compact line reuses `·` as its item boundary, so a year set off by
    // the same glyph would be unreadable ("Solutions Architect·2022·CKA"). The
    // exporter already parenthesises for exactly that reason
    // (`compactCredentialHeader`); the view has to draw the same line the PDF
    // will. One middot survives — the boundary between the two credentials.
    expect(container.textContent).toContain("(2022)");
    expect(middotSpans()).toHaveLength(1);
  });

  it("leaves a LONE credential's year on its ordinary separator", () => {
    // Nothing to be ambiguous with: a single credential draws no boundary
    // middot, and the exporter does not compact one either (its guard starts at
    // two), so parenthesising here would invent a divergence from the PDF
    // rather than remove one. The "+ year" affordance survives for the same
    // reason — the line it would clutter does not exist.
    renderCertsWith([{ title: "CKA", year: "2021" }]);
    expect(container.textContent).not.toContain("(2021)");
    expect(middotSpans()).toHaveLength(1);

    renderCertsWith([{ title: "CKA" }]);
    expect(container.querySelector('[aria-label^="Add Year"]')).not.toBeNull();
  });

  it("re-emits a NON-middot source separator verbatim, as the PDF does", () => {
    // The parenthesised form replaces only the ambiguous glyph. A résumé that
    // wrote its own comma keeps it, matching `compactCredentialHeader`'s same
    // carve-out, so #380's punctuation fidelity is not traded away wholesale.
    renderCertsWith([
      { title: "CKA", year: "2021", year_separator: "," },
      { title: "Terraform Associate" },
    ]);
    expect(container.textContent).not.toContain("(2021)");
    expect(container.textContent).toContain(",");
  });

  it("hides the '+ year' affordance on a dateless compact credential AT REST, not from the DOM", () => {
    // One "+ year" permanently on the shared line is the clutter the compact
    // form exists to remove and it competes with the boundary glyph — so it's
    // `opacity-0` until the row is hovered/focused, not omitted outright. A
    // parsed dateless credential still stays dateable from this line (#899
    // AC 5) — see AchievementYearSlot's docblock.
    renderCertsWith([{ title: "CKA" }, { title: "Terraform Associate" }]);
    const addYear = container.querySelector('[aria-label^="Add Year"]');
    expect(addYear).not.toBeNull();
    // opacity-at-rest lives on the parenthesised wrapper span, not the field
    // itself — the parens hide alongside the field.
    const wrapper = addYear?.parentElement;
    expect(wrapper?.className).toContain("opacity-0");
    expect(wrapper?.className).toContain("group-hover:opacity-100");
    expect(wrapper?.className).toContain("group-focus-within:opacity-100");
  });

  it("keeps the add-bullet affordance on an ADDED certification", () => {
    // The bug: an added credential starts with no bullets, so routing rows by
    // bullets alone put it on the compact line — which carries no
    // `InlineBulletAdd` — and it could never get one. It takes the full-width
    // branch instead, where the affordance lives.
    renderCertsWith([{ title: "CKA" }, { title: "Terraform Associate" }]);
    expect(container.textContent).not.toContain("Add bullet");
    renderCertsWith([{ title: "CKA" }], [
      { id: "added-1", section: "certifications", title: "Terraform Associate" },
    ]);
    expect(container.textContent).toContain("Add bullet");
    // …and the parsed credential before it draws no trailing separator into
    // the line break that full-width row forces.
    expect(middotSpans()).toHaveLength(0);
  });

  it("stays individually editable and removable inside the compact row", () => {
    renderCertsWith([
      { title: "AWS Certified Solutions Architect", year: "2022" },
      { title: "CKA" },
    ]);
    // Title + year fields for both entries, and one remove control each. The
    // dateless CKA row still renders its year field (hidden at rest, revealed
    // on hover/focus — see AchievementYearSlot) rather than omitting it, so a
    // parsed-but-undated credential stays dateable from the compact line.
    expect(
      container.querySelectorAll('[aria-label^="Edit Certification title"], [aria-label^="Add Certification title"]')
        .length,
    ).toBe(2);
    expect(
      container.querySelectorAll('[aria-label^="Edit Year"], [aria-label^="Add Year"]')
        .length,
    ).toBe(2);
    expect(
      container.querySelectorAll('[aria-label="Remove certification"]').length,
    ).toBe(2);
  });
});
