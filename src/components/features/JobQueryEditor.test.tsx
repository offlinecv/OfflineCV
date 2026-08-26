// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Coverage for the #581 primary-title marker + click-to-promote, extended to
 * skills in #597: the property under test is that promoting a chip is a plain
 * reorder of the relevant list flowing through the existing `onChange`, and
 * that `titleNoise` — a derived, non-user-facing field on the same `JobQuery` —
 * survives the promotion untouched. The old "Searching feeds for …" line is
 * gone: `SearchPlanCard` states the outbound terms now (#597), and it is
 * `FindJobsPanel` that renders it, so the assertion moved with the surface.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Stepper } from "@design-system";
import { JobQueryEditor } from "./JobQueryEditor.tsx";
import type { JobQuery } from "../../lib/job-search/query-builder.ts";
import { describeQuerySteps } from "../../lib/job-search/query-steps.ts";
import { assessQueryTerms } from "../../lib/job-search/term-quality.ts";
import { missingTermLabel, TermQualityAdvisory } from "./TermQualityAdvisory.tsx";
import type { CoherenceFinding } from "../../lib/job-search/term-quality.ts";
import type { CompanyTargets } from "../../hooks/useCompanyTargets.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

/** A company picker that never resolved its registry — `CompanyTargets`
 *  renders nothing until `ready`, so the Filters step reduces to the fields
 *  these tests are actually about. `FindJobsPanel` owns the real hook. */
const NO_COMPANIES: CompanyTargets = {
  ready: false,
  sector: null,
  runnerUp: null,
  suggested: [],
  selected: [],
  isSelected: () => false,
  toggle: () => {},
  switchToRunnerUp: () => {},
  isWatched: () => false,
  toggleWatched: () => {},
};

/**
 * `JobQueryEditor` emits `StepPanel`s (#602), which read their position from
 * `Stepper`'s context, so every render goes through the same host the panel
 * uses. Inactive panels stay MOUNTED (only `hidden`), which is what keeps these
 * tests able to assert across all four steps from one render — the same
 * property that lets a half-typed chip draft survive stepping away.
 */
function element(
  query: JobQuery,
  onChange: (next: (q: JobQuery) => JobQuery) => void,
  isDegenerate: boolean,
) {
  return createElement(Stepper, {
    id: "test",
    value: "role",
    onValueChange: () => {},
    steps: describeQuerySteps(query, 0),
    children: createElement(JobQueryEditor, {
      query,
      onChange,
      isDegenerate,
      links: [],
      companySearchLinks: [],
      companyTargets: NO_COMPANIES,
    }),
  });
}

function render(
  query: JobQuery,
  onChange: (next: (q: JobQuery) => JobQuery) => void,
  isDegenerate = false,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(element(query, onChange, isDegenerate));
  });
  return container;
}

/** Re-renders the same root with a new query/isDegenerate, mirroring how the
 *  parent workbench flows a fresh `JobQuery` back down after `onChange`. */
function rerender(
  query: JobQuery,
  onChange: (next: (q: JobQuery) => JobQuery) => void,
  isDegenerate = false,
) {
  act(() => {
    root.render(element(query, onChange, isDegenerate));
  });
  return container;
}

/** Deep-freezes an object and every plain-object/array value it holds, so an
 *  in-place mutation (`push`, `arr[i] = x`, `obj.field = x`) throws a
 *  TypeError in strict mode instead of silently succeeding. Only reaches
 *  plain objects/arrays — it would not, for example, protect a Map or a
 *  class instance nested inside, but `JobQuery` is a plain record of
 *  strings/numbers/string-arrays, which this covers completely. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function findButton(el: HTMLElement, matchLabel: string): HTMLButtonElement {
  const btn = [...el.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === matchLabel,
  );
  if (!btn) throw new Error(`no button labelled "${matchLabel}"`);
  return btn as HTMLButtonElement;
}

/** Sets an input's value the way a user would, as far as React can tell.
 *  Assigning `input.value` directly is swallowed by React's value tracker —
 *  it compares against its own cached value and concludes nothing changed, so
 *  no `onChange` fires. Going through the prototype's native setter updates the
 *  DOM without touching the tracker, and the bubbled `input` event then reads
 *  as a genuine edit. */
function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Types `value` into the chip input named `ariaLabel` and clicks that row's
 * Add button.
 *
 * `addIndex` selects among the identically-labelled "Add" buttons in DOM order
 * and is passed to `Array.at`, so a negative index counts from the end: the
 * editor renders Titles (0), Skills (1), … and Exclude last (-1). Indexing is
 * what the tests already did inline; naming it here is the only reason the
 * convention is legible, so keep the comment with it.
 */
function typeAndAdd(el: HTMLElement, ariaLabel: string, value: string, addIndex: number) {
  const input = el.querySelector(`input[aria-label="${ariaLabel}"]`) as HTMLInputElement;
  if (!input) throw new Error(`no input labelled "${ariaLabel}"`);
  setNativeValue(input, value);
  const addBtns = [...el.querySelectorAll("button")].filter((b) => b.textContent === "Add");
  const btn = addBtns.at(addIndex);
  if (!btn) throw new Error(`no Add button at index ${addIndex} (found ${addBtns.length})`);
  act(() => btn.click());
}

/** Clicks the read-mode `EditableField` span identified by its accessible
 *  name, types `text` into the input it reveals, then commits by pressing
 *  Enter (single-line `EditableField` also commits on blur, but Enter is
 *  the deterministic path in jsdom). */
function editField(el: HTMLElement, openLabel: string, fieldLabel: string, text: string) {
  const opener = [...el.querySelectorAll('[role="button"]')].find(
    (b) => b.getAttribute("aria-label") === openLabel,
  ) as HTMLElement;
  if (!opener) throw new Error(`no editable field opener labelled "${openLabel}"`);
  act(() => opener.click());
  const input = el.querySelector(`input[aria-label="${fieldLabel}"]`) as HTMLInputElement;
  if (!input) throw new Error(`no input labelled "${fieldLabel}" after opening editor`);
  setNativeValue(input, text);
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("JobQueryEditor — primary title promotion", () => {
  it("moves a clicked chip to the front and follows with the searched-for line", () => {
    let query: JobQuery = {
      titles: ["Berlin Site Lead", "VP Engineering", "Engineering Manager"],
      skills: [],
      titleNoise: ["berlin"],
    };
    const el = render(query, (next) => {
      query = next(query);
    });

    // Superseded by `SearchPlanCard` (#597) — the editor no longer states what
    // egresses, so a duplicate here would be a second place to keep in sync.
    expect(el.textContent).not.toContain("Searching feeds for");

    const promote = [...el.querySelectorAll("button")].find((b) =>
      b.getAttribute("aria-label")?.includes("Make VP Engineering the primary title"),
    );
    if (!promote) throw new Error("no promote control for VP Engineering");
    act(() => promote.click());

    // Reordered — VP Engineering is now titles[0].
    expect(query.titles).toEqual([
      "VP Engineering",
      "Berlin Site Lead",
      "Engineering Manager",
    ]);
    // Untouched derived field on the same query object.
    expect(query.titleNoise).toEqual(["berlin"]);

    act(() => {
      root.render(
        element(
          query,
          (next) => {
            query = next(query);
          },
          false,
        ),
      );
    });
    // The star follows the reorder, which is what the plan card reads.
    expect(el.querySelector('[aria-current="true"]')?.textContent).toContain(
      "VP Engineering",
    );
  });

  it("promotes a skill through the same whole-query replacement, recomputing canonicalSkills", () => {
    let query: JobQuery = {
      titles: [],
      skills: ["Team Building & Mentorship", "TypeScript"],
      canonicalSkills: ["TypeScript"],
    };
    const el = render(query, (next) => {
      query = next(query);
    });

    const promote = findButton(el, "Make TypeScript the primary skill");
    act(() => promote.click());

    expect(query.skills).toEqual(["TypeScript", "Team Building & Mentorship"]);
    expect(query.canonicalSkills).toEqual(["TypeScript"]);
  });

  it("marks the primary chip with a star and aria-current", () => {
    const query: JobQuery = { titles: ["Staff Engineer", "Tech Lead"], skills: [] };
    const el = render(query, () => query);

    const current = el.querySelector('[aria-current="true"]');
    expect(current?.textContent).toContain("Staff Engineer");
  });
});

/**
 * #597's information-architecture claims, each of which is a placement the user
 * can see: a term that reaches nothing is named in words rather than only as a
 * chip mark, and a suggestion sits under the list it writes into instead of in
 * a trailing section at the foot of the form.
 */
describe("JobQueryEditor — dropped terms and in-column suggestions (issue 597)", () => {
  it("names a term that narrows nothing, with the lib's own reason verbatim", () => {
    const query: JobQuery = {
      titles: ["Berlin", "Engineering Manager"],
      skills: [],
      titleNoise: ["berlin"],
    };
    const verdict = assessQueryTerms(query).verdicts.find((v) => v.term === "Berlin");
    expect(verdict?.quality).toBe("noise");

    const el = render(query, () => query);
    expect(el.textContent).toContain("aren't narrowing your search");
    // Verbatim from `term-quality.ts`, not a second sentence written here.
    expect(el.textContent).toContain(verdict!.reason);
  });

  it("says nothing about the terms it is entitled to judge but not to call dropped", () => {
    // A clean query has no noise verdict, so the block must not appear at all —
    // no empty state, no all-clear.
    const query: JobQuery = { titles: ["Engineering Manager"], skills: [] };
    const el = render(query, () => query);
    expect(el.textContent).not.toContain("aren't narrowing your search");
  });

  it("renders the title suggestions inside the Role step, not in a trailing block", () => {
    const query: JobQuery = { titles: ["Engineering Manager"], skills: [] };
    const missing = assessQueryTerms(query).missing.filter((t) => t.kind === "title");
    expect(missing.length).toBeGreaterThan(0);

    const el = render(query, () => query);
    // Scoped to the panel, not merely "appears somewhere on the page" — with
    // every step mounted (see `element`), a page-wide text search would pass
    // even if the suggestions had drifted back into a trailing section.
    const rolePanel = el.querySelector("#test-steppanel-role");
    const skillsPanel = el.querySelector("#test-steppanel-skills");
    expect(rolePanel?.textContent).toContain("Add to your titles");
    expect(skillsPanel?.textContent).not.toContain("Add to your titles");
  });

  it("renders the skill suggestions inside the Skills step, and no pill in Review (#595)", () => {
    // The other half of the adjacency claim, and the one #595 was filed about:
    // every pill has to be visible with the field it writes into. Asserted per
    // panel, because the failure mode is a pill drifting back into the trailing
    // Review block — which is page-wide text a whole-page search would still find.
    const query: JobQuery = { titles: ["Engineering Manager"], skills: [] };
    const missing = assessQueryTerms(query).missing.filter((t) => t.kind === "skill");
    expect(missing.length).toBeGreaterThan(0);

    const el = render(query, () => query);
    const skillsPanel = el.querySelector("#test-steppanel-skills");
    const rolePanel = el.querySelector("#test-steppanel-role");
    const reviewPanel = el.querySelector("#test-steppanel-review");
    // Asserted, not assumed: a renamed panel id would turn every `not.toContain`
    // below into a check against `undefined`.
    expect(reviewPanel).not.toBeNull();
    expect(skillsPanel?.textContent).toContain("Add to your skills");
    expect(rolePanel?.textContent).not.toContain("Add to your skills");
    // Review carries whole-query findings only — the coherence note and the
    // dropped terms — so neither suggestion heading may appear there.
    expect(reviewPanel?.textContent).not.toContain("Add to your skills");
    expect(reviewPanel?.textContent).not.toContain("Add to your titles");
  });
});

/**
 * Coverage for #589: `JobQueryEditor` is the single write path into
 * `JobQuery`, and every mutation is supposed to be a whole-query
 * replacement — never an in-place edit, never a dropped sibling field. This
 * block asserts that per handler: the object passed to `onChange` is a NEW
 * object, it carries only the intended change, and it is not just the
 * component's own internal state (props-in / callback-out, no mocks).
 */
describe("JobQueryEditor — query mutation contract (issue 589)", () => {
  const fullQuery: JobQuery = {
    titles: ["Staff Engineer"],
    skills: ["TypeScript"],
    location: "Austin, TX",
    excludeTerms: ["Manager"],
    compFloor: 150_000,
    families: ["fullstack"],
    seniority: "Staff",
  };

  const noOptionalFieldsQuery: JobQuery = {
    titles: ["Staff Engineer"],
    skills: ["TypeScript"],
    // location / excludeTerms / compFloor / families / seniority all absent.
  };

  it("adds a title via the Titles chip input, producing a new object with every other field untouched", () => {
    let captured: JobQuery | undefined;
    const el = render(fullQuery, (next) => {
      captured = next(fullQuery);
    });
    typeAndAdd(el, "Add title", "Principal Engineer", 0);

    expect(captured).not.toBe(fullQuery);
    expect(captured?.titles).toEqual(["Staff Engineer", "Principal Engineer"]);
    expect(captured?.skills).toBe(fullQuery.skills);
    expect(captured?.location).toBe(fullQuery.location);
    expect(captured?.excludeTerms).toBe(fullQuery.excludeTerms);
    expect(captured?.compFloor).toBe(fullQuery.compFloor);
    expect(captured?.families).toBe(fullQuery.families);
    expect(captured?.seniority).toBe(fullQuery.seniority);
  });

  it("removes a title via its chip's Remove control", () => {
    const twoTitles: JobQuery = { ...fullQuery, titles: ["Staff Engineer", "Tech Lead"] };
    let captured: JobQuery | undefined;
    const el = render(twoTitles, (next) => {
      captured = next(twoTitles);
    });
    act(() => findButton(el, "Remove Tech Lead").click());

    expect(captured).not.toBe(twoTitles);
    expect(captured?.titles).toEqual(["Staff Engineer"]);
  });

  it("adds and removes a skill", () => {
    let captured: JobQuery | undefined;
    const el = render(fullQuery, (next) => {
      captured = next(fullQuery);
    });
    typeAndAdd(el, "Add skill", "Rust", 1); // Titles' Add is index 0
    expect(captured).not.toBe(fullQuery);
    expect(captured?.skills).toEqual(["TypeScript", "Rust"]);
    expect(captured?.titles).toBe(fullQuery.titles);

    const afterAdd = rerender(captured!, (next) => {
      captured = next(captured!);
    });
    act(() => findButton(afterAdd, "Remove TypeScript").click());
    expect(captured?.skills).toEqual(["Rust"]);
  });

  it("adds and removes an exclude term", () => {
    let captured: JobQuery | undefined;
    const el = render(fullQuery, (next) => {
      captured = next(fullQuery);
    });
    typeAndAdd(el, "Add exclude term", "Recruiter", -1); // Exclude row is the last chip list
    expect(captured).not.toBe(fullQuery);
    expect(captured?.excludeTerms).toEqual(["Manager", "Recruiter"]);
    expect(captured?.titles).toBe(fullQuery.titles);
    expect(captured?.skills).toBe(fullQuery.skills);

    const afterAdd = rerender(captured!, (next) => {
      captured = next(captured!);
    });
    act(() => findButton(afterAdd, "Remove Manager").click());
    expect(captured?.excludeTerms).toEqual(["Recruiter"]);
  });

  it("adding an exclude term when excludeTerms is undefined produces [term], not a crash on the ?? [] path", () => {
    let captured: JobQuery | undefined;
    const el = render(noOptionalFieldsQuery, (next) => {
      captured = next(noOptionalFieldsQuery);
    });
    typeAndAdd(el, "Add exclude term", "Recruiter", -1);

    expect(captured).not.toBe(noOptionalFieldsQuery);
    expect(captured?.excludeTerms).toEqual(["Recruiter"]);
    expect(captured?.titles).toBe(noOptionalFieldsQuery.titles);
    expect(captured?.skills).toBe(noOptionalFieldsQuery.skills);
  });

  it("removing a role family narrows to an EMPTY ARRAY, not undefined — readers resolve [] to the permissive 'all' filter", () => {
    let captured: JobQuery | undefined;
    const el = render(fullQuery, (next) => {
      captured = next(fullQuery);
    });
    act(() => findButton(el, "Remove fullstack").click());

    expect(captured).not.toBe(fullQuery);
    expect(captured?.families).toEqual([]);
    expect(Array.isArray(captured?.families)).toBe(true);
    expect(captured?.families).not.toBeUndefined();
    // Every other field survives untouched.
    expect(captured?.titles).toBe(fullQuery.titles);
    expect(captured?.skills).toBe(fullQuery.skills);
    expect(captured?.location).toBe(fullQuery.location);
    expect(captured?.excludeTerms).toBe(fullQuery.excludeTerms);
    expect(captured?.compFloor).toBe(fullQuery.compFloor);
    expect(captured?.seniority).toBe(fullQuery.seniority);
  });

  it("renders 'no role narrowing' with families undefined, exercising the (families ?? []) read path without crashing", () => {
    // NOTE (drift from the issue checklist): `removeRoleFamily`'s own
    // `(q.families ?? []).filter(...)` write-side branch has no reachable UI
    // path when `families` is undefined — `RoleFamilyChips` renders its
    // remove buttons from the same `query.families ?? []` list the row
    // displays, so an undefined `families` renders zero chips and there is
    // nothing to click. The write-side `?? []` is defensive-only under the
    // current render logic. What IS reachable and asserted here is the
    // READ-side `?? []` (the row renders the empty-state copy instead of
    // throwing on `undefined.map`), plus the narrow-to-`[]` write path
    // above, which is exercised from a non-empty `families` fixture.
    const el = render(noOptionalFieldsQuery, () => noOptionalFieldsQuery);
    expect(el.textContent).toContain("No role narrowing");
  });

  it("commits an edited location", () => {
    let captured: JobQuery | undefined;
    const el = render(fullQuery, (next) => {
      captured = next(fullQuery);
    });
    editField(el, "Edit Location", "Location", "Denver, CO");

    expect(captured).not.toBe(fullQuery);
    expect(captured?.location).toBe("Denver, CO");
    expect(captured?.titles).toBe(fullQuery.titles);
    expect(captured?.skills).toBe(fullQuery.skills);
  });

  it("committing an empty location produces undefined, not an empty string", () => {
    let captured: JobQuery | undefined;
    const el = render(fullQuery, (next) => {
      captured = next(fullQuery);
    });
    editField(el, "Edit Location", "Location", "");

    expect(captured?.location).toBeUndefined();
    expect(captured?.location).not.toBe("");
  });

  it("commits a comp floor value", () => {
    let captured: JobQuery | undefined;
    const el = render(fullQuery, (next) => {
      captured = next(fullQuery);
    });
    editField(el, "Edit Minimum annual pay", "Minimum annual pay", "180000");

    expect(captured).not.toBe(fullQuery);
    expect(captured?.compFloor).toBe(180_000);
    expect(captured?.titles).toBe(fullQuery.titles);
  });

  it("shows LevelSelect when query.seniority is set, and the '+ Target level' pill when it is not", () => {
    const withLevel = render(fullQuery, () => fullQuery);
    expect(withLevel.querySelectorAll('[role="radio"]').length).toBeGreaterThan(0);
    expect(
      [...withLevel.querySelectorAll("button")].some(
        (b) => b.getAttribute("aria-label") === "Target level",
      ),
    ).toBe(false);

    const withoutLevel = render(noOptionalFieldsQuery, () => noOptionalFieldsQuery);
    expect(withoutLevel.querySelectorAll('[role="radio"]').length).toBe(0);
    expect(
      [...withoutLevel.querySelectorAll("button")].some(
        (b) => b.getAttribute("aria-label") === "Target level",
      ),
    ).toBe(true);
  });

  it("clicking the '+ Target level' pill reveals LevelSelect", () => {
    const el = render(noOptionalFieldsQuery, () => noOptionalFieldsQuery);
    act(() => findButton(el, "Target level").click());
    expect(el.querySelectorAll('[role="radio"]').length).toBeGreaterThan(0);
  });

  it("renders the degenerate-query hint only when isDegenerate is true", () => {
    const hintText = "We couldn't derive a search from this resume";
    const withHint = render(noOptionalFieldsQuery, () => noOptionalFieldsQuery, true);
    expect(withHint.textContent).toContain(hintText);

    const withoutHint = render(noOptionalFieldsQuery, () => noOptionalFieldsQuery, false);
    expect(withoutHint.textContent).not.toContain(hintText);
  });

  it("never mutates the input query object in place — a frozen fixture throws on any in-place write", () => {
    const frozen = deepFreeze({
      titles: ["Staff Engineer"],
      skills: ["TypeScript"],
      location: "Austin, TX",
      excludeTerms: ["Manager"],
      compFloor: 150_000,
      families: ["fullstack"],
      seniority: "Staff",
    }) as JobQuery;
    const snapshotJSON = JSON.stringify(frozen);

    let latest: JobQuery = frozen;
    const el = render(frozen, (next) => {
      // A handler that mutated `latest` in place (e.g. `latest.titles.push`)
      // would throw a TypeError here, synchronously, since `latest` starts
      // out frozen — the assertion IS that none of the interactions below
      // throw.
      latest = next(latest);
    });

    // Exercise several handlers in sequence; each replaces `latest` with a
    // freshly spread (unfrozen) object, so later handlers operate on a
    // non-frozen query — this only proves the FIRST handler touching each
    // frozen array/object doesn't write through it in place.
    const titleInput = el.querySelector('input[aria-label="Add title"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    expect(() => {
      act(() => {
        setter.call(titleInput, "Principal Engineer");
        titleInput.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const addBtn = [...el.querySelectorAll("button")].find((b) => b.textContent === "Add")!;
      act(() => addBtn.click());
    }).not.toThrow();
    expect(latest.titles).toEqual(["Staff Engineer", "Principal Engineer"]);

    expect(() => {
      act(() => findButton(el, "Remove fullstack").click());
    }).not.toThrow();

    // The original fixture is byte-identical to before any interaction —
    // freezing already guarantees this structurally, but the JSON diff
    // makes the intent explicit for a reader.
    expect(JSON.stringify(frozen)).toBe(snapshotJSON);
  });
});

/**
 * Coverage for #585: `JobQueryEditor` renders `assessQueryTerms`'s judgement
 * on the query it already owns — a chip's quality mark, and an add-able row
 * for what the resolved role is missing. `assessQueryTerms` itself is
 * `term-quality.test.ts`'s job; these tests only check the RENDERING
 * contract (mark + accessible label present/absent, click adds the exact
 * term via `onChange`), computing expected verdicts from the same classifier
 * rather than hardcoding its output, so they don't drift if #584's rules
 * change.
 */
describe("JobQueryEditor — term quality (issue 585)", () => {
  it("marks a strong title with a text glyph and a screen-reader-legible reason, verbatim from the lib", () => {
    const query: JobQuery = { titles: ["Engineering Manager"], skills: [] };
    const { verdicts } = assessQueryTerms(query);
    const verdict = verdicts.find((v) => v.term === "Engineering Manager");
    expect(verdict?.quality).toBe("strong");

    const el = render(query, () => query);
    // The glyph is decorative (aria-hidden); the accessible label is the
    // separate sr-only span carrying `reason` unchanged.
    // Scoped by `title`: only a CHIP's quality mark carries the reason as a
    // tooltip, so this can't be satisfied by the glyph legend (#597), which
    // reuses the same tokens with no per-term reason behind them.
    expect(
      el.querySelector('[aria-hidden="true"][title].text-feedback-success-text'),
    ).not.toBeNull();
    expect(el.textContent).toContain(verdict!.reason);
  });

  it("renders a term with no verdict as a plain, unmarked chip", () => {
    // No role resolves for this title (rule 1 in term-quality.ts): NOTHING is
    // judged without a basis, so this term gets no verdict at all.
    const query: JobQuery = { titles: ["Zzyzx Wobble Frobnicator"], skills: [] };
    const { verdicts } = assessQueryTerms(query);
    expect(verdicts).toHaveLength(0);

    const el = render(query, () => query);
    // Same `title` scoping as above — the glyph legend is not a chip mark.
    const marks = [...el.querySelectorAll('[aria-hidden="true"][title]')].filter(
      (node) =>
        node.classList.contains("text-feedback-success-text") ||
        node.classList.contains("text-feedback-warning-text") ||
        node.classList.contains("text-content-tertiary"),
    );
    expect(marks).toHaveLength(0);
  });

  it("renders nothing for missing terms when the query is empty (no role resolved)", () => {
    const query: JobQuery = { titles: [], skills: [] };
    expect(assessQueryTerms(query).missing).toEqual([]);

    const el = render(query, () => query);
    expect(el.textContent).not.toContain("Add to your titles");
    expect(el.textContent).not.toContain("Add to your skills");
  });

  it("clicking a missing-term suggestion adds it to the query via onChange, with every sibling field untouched and no mutation of the input", () => {
    const query: JobQuery = deepFreeze({
      titles: ["Engineering Manager"],
      skills: [],
      location: "Remote",
    }) as JobQuery;
    const { missing } = assessQueryTerms(query);
    expect(missing.length).toBeGreaterThan(0);
    const target = missing[0]!;

    let captured: JobQuery | undefined;
    const el = render(query, (next) => {
      captured = next(query);
    });

    // `TermQualityAdvisory` renders each pill's label through the same
    // `missingTermLabel` — a skill's canonical id (e.g. `ci-cd`) maps to its
    // human label there, never the raw id.
    const pillLabel = missingTermLabel(target);
    const pill = findButton(el, pillLabel);
    expect(() => act(() => pill.click())).not.toThrow();

    expect(captured).not.toBe(query);
    if (target.kind === "title") {
      expect(captured?.titles).toEqual([...query.titles, pillLabel]);
      expect(captured?.skills).toBe(query.skills);
    } else {
      expect(captured?.skills).toEqual([...query.skills, pillLabel]);
      expect(captured?.titles).toBe(query.titles);
    }
    expect(captured?.location).toBe(query.location);
  });
});

/**
 * Coverage for the title/skill coherence advisory (issue 587). The DETECTION is
 * `term-quality.test.ts`'s job; these check only that the finding reaches the
 * user — inside the existing advisory, never as a fourth panel — and that its
 * two render conditions are independent, since a mismatched résumé can easily
 * have nothing missing.
 */
describe("JobQueryEditor — title/skill coherence (issue 587)", () => {
  /** Renders the advisory alone, the one way to drive `missing` and
   *  `coherence` independently — `assessQueryTerms` never produces a firing
   *  finding with an empty `missing`, but the component must not depend on
   *  that coincidence. */
  function renderAdvisory(
    missing: Parameters<typeof TermQualityAdvisory>[0]["missing"],
    coherence?: CoherenceFinding,
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(TermQualityAdvisory, { missing, coherence, onAdd: () => {} }),
      );
    });
    return container;
  }

  const mismatched: JobQuery = {
    titles: ["Engineering Manager"],
    skills: ["Java", "Python", "Kubernetes", "Docker", "Terraform"],
  };

  it("renders the lib's sentence verbatim, under an accessible name, with a text-presentation mark", () => {
    const { coherence } = assessQueryTerms(mismatched);
    expect(coherence).toBeDefined();

    const el = render(mismatched, () => mismatched);
    expect(el.textContent).toContain(coherence!.note);
    // Named for a screen reader by the sr-only prefix, not by the glyph — the
    // mark is decorative and colour is never the only carrier.
    expect(el.textContent).toContain("Check these terms:");
    const mark = [...el.querySelectorAll('[aria-hidden="true"]')].find(
      (node) => node.textContent === "⚠︎",
    );
    expect(mark).toBeDefined();
  });

  it("renders no note for a coherent query", () => {
    const coherent: JobQuery = {
      titles: ["Engineering Manager"],
      skills: ["People Management", "Coaching Mentorship", "Team Building", "Project Delivery"],
    };
    expect(assessQueryTerms(coherent).coherence).toBeUndefined();

    const el = render(coherent, () => coherent);
    expect(el.textContent).not.toContain("Check these terms:");
  });

  it("renders the note even when there is nothing missing to add", () => {
    const coherence = assessQueryTerms(mismatched).coherence!;
    const el = renderAdvisory([], coherence);
    expect(el.textContent).toContain(coherence.note);
    expect(el.textContent).not.toContain("Add to your titles");
    expect(el.textContent).not.toContain("Add to your skills");
  });

  it("renders nothing at all when there is no finding and nothing missing", () => {
    expect(renderAdvisory([], undefined).innerHTML).toBe("");
  });

  /**
   * A suggestion pill writes into `query.titles` or into `query.skills`
   * depending on its kind, and in one flat row the two were visually identical —
   * nothing on screen said what a click would do. The grouping is the fix, so
   * these assert the pill is INSIDE its own labelled group, not merely that the
   * heading text appears somewhere on the page.
   */
  describe("grouped suggestions", () => {
    /** The group element whose heading starts with `heading`, or undefined.
     *
     *  Takes the INNERMOST match, not the first: any ancestor whose leading child
     *  is this group satisfies the same predicate, and picking it would sweep the
     *  other group's pills in too — making the `not.toContain` assertions below
     *  vacuous. `querySelectorAll` is document order, so the ancestor comes
     *  first and the group itself comes last. */
    function group(el: HTMLElement, heading: string): Element | undefined {
      const matches = [...el.querySelectorAll("div")].filter(
        (node) => node.firstElementChild?.textContent?.startsWith(heading) === true,
      );
      return matches[matches.length - 1];
    }

    it("puts each suggestion under a heading that names the field it writes to", () => {
      const el = renderAdvisory([
        { term: "engineering team lead", kind: "title" },
        { term: "people-management", kind: "skill" },
      ]);
      const titles = group(el, "Add to your titles");
      const skills = group(el, "Add to your skills");
      expect(titles?.textContent).toContain("engineering team lead");
      expect(titles?.textContent).not.toContain("People Management");
      expect(skills?.textContent).toContain(
        missingTermLabel({ term: "people-management", kind: "skill" }),
      );
      expect(skills?.textContent).not.toContain("engineering team lead");
    });

    it("renders only the group it has terms for", () => {
      const el = renderAdvisory([{ term: "people-management", kind: "skill" }]);
      expect(el.textContent).toContain("Add to your skills");
      expect(el.textContent).not.toContain("Add to your titles");
    });
  });
});

/**
 * Coverage for the `canonicalSkills` annotation the classifier reads. The
 * classifier's own use of it is `term-quality.test.ts`'s job; this pins the
 * editor's half of the contract — a chip the USER adds is annotated exactly like
 * one `buildJobQuery` derived, so the annotation never goes stale against the
 * list it describes.
 */
describe("JobQueryEditor — skill edits keep the canonicality annotation in step", () => {
  function addSkillValue(el: HTMLElement, value: string) {
    const input = el.querySelector('input[aria-label="Add skill"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const addBtn = [...el.querySelectorAll("button")].filter(
      (b) => b.textContent === "Add",
    )[1]!;
    act(() => addBtn.click());
  }

  it("annotates a canonical skill the user types, and leaves a free-text one unannotated", () => {
    const query: JobQuery = { titles: ["Engineering Manager"], skills: [] };
    let captured: JobQuery | undefined;
    const el = render(query, (next) => {
      captured = next(query);
    });

    addSkillValue(el, "Kubernetes");
    expect(captured?.skills).toEqual(["Kubernetes"]);
    expect(captured?.canonicalSkills).toEqual(["Kubernetes"]);

    addSkillValue(el, "Team Building & Mentorship");
    expect(captured?.skills).toEqual(["Team Building & Mentorship"]);
    expect(captured?.canonicalSkills).toEqual([]);
  });

  it("drops a removed skill from the annotation too", () => {
    const query: JobQuery = {
      titles: ["Engineering Manager"],
      skills: ["Kubernetes", "Team Building & Mentorship"],
      canonicalSkills: ["Kubernetes"],
    };
    let captured: JobQuery | undefined;
    const el = render(query, (next) => {
      captured = next(query);
    });
    act(() => findButton(el, "Remove Kubernetes").click());
    expect(captured?.skills).toEqual(["Team Building & Mentorship"]);
    expect(captured?.canonicalSkills).toEqual([]);
  });
});
