// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * TargetingSection (#825) — the fold, and what survives it.
 *
 * The whole justification for collapsing `RolesPanel` + `SkillTermGuidance` is
 * that neither panel's MESSAGE is collapsed with it: the count of addable
 * skills and the "no role prints on your PDF" warning both ride the summary
 * row. So the assertions here are mostly about the closed state — a test that
 * only opened the section would pass against a plain `<details>` with no
 * summary metadata at all, which is the version that fails the user.
 *
 * Raw createRoot + act, matching `SkillTermGuidance.test.tsx` beside it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TargetingSection } from "./TargetingSection.tsx";
import { assessResumeSkills } from "./SkillTermGuidance.tsx";
import type { ResumeQueryInput } from "../../lib/job-search/query-builder.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import type { BulletObservation } from "../../lib/score/score.ts";
import type { ContactDisplayField } from "../../lib/contact.ts";

let container: HTMLDivElement;
let root: Root | null = null;

interface RenderOptions {
  titles?: string[];
  primary?: string;
  parsed?: ResumeQueryInput;
  bullets?: readonly BulletObservation[];
  contactMissing?: ContactDisplayField[];
}

/** The same role-resolvable résumé `SkillTermGuidance.test.tsx` uses, so the
 *  classifier's verdicts here are the ones already pinned there. */
function resolvableParsed(): ResumeQueryInput {
  return {
    skills: ["PostgreSQL", "C#"],
    experience: [{ title: "Backend Engineer", company: "Acme Corp" }],
  };
}

function render({
  titles = ["Backend Engineer"],
  primary,
  parsed = resolvableParsed(),
  bullets,
  contactMissing,
}: RenderOptions = {}): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(TargetingSection, {
        titles,
        primary,
        onPrimaryChange: () => {},
        parsed,
        onAddSkill: () => {},
        bullets,
        contactMissing,
      }),
    );
  });
  return container;
}

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  container?.remove();
});

describe("TargetingSection", () => {
  it("starts collapsed, with both panels still mounted", () => {
    const el = render();
    const details = el.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    // `Disclosure` is a native `<details>` precisely so its children stay in
    // the tree while shut. If a future edit gates them on an open flag, this
    // goes red — and `SkillTermGuidance`'s add-confirmation trail, which is
    // component state, would silently reset on every collapse.
    expect(el.textContent).toContain("Which role are you targeting?");
    expect(el.textContent).toContain("Skills this role usually asks for");
  });

  it("puts the addable-skill count on the summary row, and only the addable ones", () => {
    const parsed = resolvableParsed();
    const { recognized, missing } = assessResumeSkills(parsed);
    // The fixture has to actually exercise the distinction, or the assertion
    // below is vacuous.
    expect(missing.length).toBeGreaterThan(0);
    expect(recognized.length).toBeGreaterThan(0);

    const el = render({ parsed });
    const summary = el.querySelector("summary")!;
    expect(summary.textContent).toContain(String(missing.length));
    // Counting the recognized skills too would badge a résumé with nothing to
    // do — the same unearned claim #826 took off the journey rail's ✓.
    expect(summary.textContent).not.toContain(
      String(recognized.length + missing.length),
    );
  });

  it("warns on the summary row when no role is picked, and stops once one is", () => {
    const noPick = render();
    // The mark is never colour alone: the meaning is in the accessible name.
    expect(noPick.querySelector("summary")!.textContent).toContain(
      "no role picked",
    );
    act(() => root!.unmount());
    root = null;
    container.remove();

    const picked = render({ primary: "Backend Engineer" });
    expect(picked.querySelector("summary")!.textContent).not.toContain(
      "no role picked",
    );
  });

  it("warns for a headline that matches no chip — it still prints", () => {
    // `RolesPanel` treats an unmatched headline as a real state rather than a
    // bug (a user-typed "Chief Widget Officer" prints fine), so the warn mark
    // has to read the headline's PRESENCE, not whether it is one of the
    // titles. Reading `titles.indexOf(primary)` instead passes every other
    // test in this file and lies on exactly this résumé.
    const el = render({ primary: "Chief Widget Officer" });
    expect(el.querySelector("summary")!.textContent).not.toContain(
      "no role picked",
    );
  });

  it("renders nothing when neither panel has anything to say", () => {
    // Both children self-hide, so without the wrapper's own guard this is a
    // disclosure that opens onto an empty box.
    const el = render({ titles: [], parsed: { skills: [], experience: [] } });
    expect(el.querySelector("details")).toBeNull();
    expect(el.textContent).toBe("");
  });

  it("shows an all-clear confirmation naming the count when bullets are present but all of them pass", () => {
    // #957: a résumé with bullets that all pass — nothing flagged, no
    // titles, no skill guidance — rendered nothing on `main`, because
    // `hasTriage` stays false when nothing is flagged. The all-clear the old
    // `AttentionStrip` used to print — naming the bullet count — never
    // reached the user. It has its own branch now.
    const allPassing: BulletObservation[] = [
      {
        text: "Cut checkout latency 45% by adding a read-through cache",
        id: "b1",
        index: 0,
        hasMetric: true,
        startsWithActionVerb: true,
        wellFormedLength: true,
        wordCount: 9,
      },
    ];
    const el = render({
      titles: [],
      parsed: { skills: [], experience: [] },
      bullets: allPassing,
    });
    // No `<details>`: with no titles, no skill guidance and nothing flagged,
    // every body child self-hides, so a disclosure here would open onto ~24px
    // of blank card — #956's defect, which the first pass at #957 reopened for
    // exactly this input. The confirmation renders as a standalone
    // `InlineResult` strip instead.
    expect(el.querySelector("details")).toBeNull();
    expect(el.textContent).toContain("All 1 bullet passes every check");
    expect(el.textContent).not.toContain("Targeting & improvements");
  });

  it("renders the all-clear inside the disclosure summary when there IS a body", () => {
    // Same all-passing bullets, but a title exists — so `RolesPanel` renders
    // and the disclosure has something to open onto. The all-clear belongs on
    // the summary row here, not as a standalone line.
    const allPassing: BulletObservation[] = [
      {
        text: "Cut checkout latency 45% by adding a read-through cache",
        id: "b1",
        index: 0,
        hasMetric: true,
        startsWithActionVerb: true,
        wellFormedLength: true,
        wordCount: 9,
      },
      {
        text: "Led a 4-engineer migration to a typed schema registry",
        id: "b2",
        index: 1,
        hasMetric: true,
        startsWithActionVerb: true,
        wellFormedLength: true,
        wordCount: 9,
      },
    ];
    const el = render({
      titles: ["Staff Engineer"],
      parsed: { skills: [], experience: [] },
      bullets: allPassing,
    });
    const summary = el.querySelector("summary")!;
    // Plural takes "pass", singular takes "passes" — see the copy note in
    // `TargetingSection.tsx`.
    expect(summary.textContent).toContain("All 2 bullets pass every check");
    // The assertion that would have caught the reopened #956 defect: whatever
    // the summary promises, the body must actually have content behind it.
    const body = el.querySelector("details > div");
    expect(body?.textContent?.trim()).not.toBe("");
  });

  it("stays silent about bullets when they all pass but contact has a gap", () => {
    // The deliberate narrowing (#957 scope call): the deleted `AttentionStrip`
    // fired its all-clear only when BOTH checks were clean. Two guards enforce
    // that, redundantly: `allBulletsClear`'s `!hasTriage` term, and
    // `summary`'s ternary testing `hasTriage` first (a contact gap also makes
    // `hasBody` true, so the standalone strip is unreachable). Either alone
    // keeps this input silent, so widening the term to `!hasBulletGap`, or
    // reordering the ternary, is behaviour-neutral by itself; the test fails
    // once both go, which is the point at which the user would see it.
    // Two bullets, not one, so the plural copy is the string under test —
    // the singular "passes" is pinned by the standalone-strip test above.
    const allPassing: BulletObservation[] = [
      {
        text: "Cut checkout latency 45% by adding a read-through cache",
        id: "b1",
        index: 0,
        hasMetric: true,
        startsWithActionVerb: true,
        wellFormedLength: true,
        wordCount: 9,
      },
      {
        text: "Led a 4-engineer migration to a typed schema registry",
        id: "b2",
        index: 1,
        hasMetric: true,
        startsWithActionVerb: true,
        wellFormedLength: true,
        wordCount: 9,
      },
    ];
    const el = render({
      bullets: allPassing,
      contactMissing: [
        { key: "linkedin_url", label: "Professional profile", value: "", group: "link", gated: true },
      ],
    });
    // Regex, not a substring: "pass every check" is not a substring of the
    // singular "passes every check", which is how this line once went vacuous.
    expect(el.textContent).not.toMatch(/pass(es)? every check/);
    const summary = el.querySelector("summary")!;
    expect(summary.textContent).toContain("1 contact field missing");
    // With a contact gap the summary is the triage headline, never the
    // all-clear label, whatever `allBulletsClear` says.
    expect(summary.textContent).not.toContain("expected skills");
  });

  it("summarizes bullet triage on the summary row and renders details inside", () => {
    const fakeBullets: BulletObservation[] = [
      {
        text: "Did stuff",
        id: "b1",
        index: 0,
        hasMetric: false,
        startsWithActionVerb: false,
        wellFormedLength: true,
        wordCount: 8,
      },
    ];
    const el = render({ bullets: fakeBullets });
    const summary = el.querySelector("summary")!;
    expect(summary.textContent).toContain("Targeting & improvements");
    expect(summary.textContent).toContain("1 bullet needs attention");

    // Inside the disclosure, the bullet breakdown renders.
    expect(el.textContent).toContain("missing a metric");
    expect(el.textContent).toContain("weak verb");
    // But NO bullet jump link (#956 review). It used to point at
    // `#reconstructed-resume`, which wraps this very row, so "Review bullets ↓"
    // scrolled UP past the contact card. There is no correct anchor to swap in
    // — flagged bullets can live in Projects or Achievements as well as
    // Experience — and the bullets are directly below this row anyway.
    expect(el.textContent).not.toContain("Review bullets");
    expect(
      [...el.querySelectorAll("a")].map((a) => a.getAttribute("href")),
    ).not.toContain("#reconstructed-resume");
  });

  it("summarizes missing contact fields on the summary row", () => {
    const missingContact: ContactDisplayField[] = [
      { key: "phone", label: "phone", value: "", group: "contact", gated: true },
    ];
    const el = render({ contactMissing: missingContact });
    const summary = el.querySelector("summary")!;
    expect(summary.textContent).toContain("Targeting & improvements");
    expect(summary.textContent).toContain("1 contact field missing");
    expect(el.textContent).toContain("Edit contact ↑");
  });

  it("summarizes combined bullet and contact triage on the summary row", () => {
    const fakeBullets: BulletObservation[] = [
      {
        text: "Did stuff",
        id: "b1",
        index: 0,
        hasMetric: false,
        startsWithActionVerb: false,
        wellFormedLength: true,
        wordCount: 8,
      },
    ];
    const missingContact: ContactDisplayField[] = [
      { key: "email", label: "email", value: "", group: "contact", gated: true },
    ];
    const el = render({ bullets: fakeBullets, contactMissing: missingContact });
    const summary = el.querySelector("summary")!;
    expect(summary.textContent).toContain(
      "1 bullet & 1 contact field need attention",
    );
  });
});
