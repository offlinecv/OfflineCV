// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * TargetingSection × located score guidance (#810).
 *
 * A sibling file rather than more cases in `TargetingSection.test.tsx`, the
 * same split `ExperienceSection.other-bullets.test.tsx` and
 * `ExperienceSection.prune-hold.test.tsx` already use: that file is about the
 * fold and what survives it, this is about one child's wiring.
 *
 * The case that matters is the FOURTH `hasBody` term. `TargetingSection`'s
 * guard is a disjunction with one term per child, and its docblock says a new
 * child must be added to it by hand — a stale guard returns `null` and the
 * whole disclosure disappears while a child had something to say. Guidance is
 * not implied by the triage terms: those count flagged bullets and missing
 * CONTACT fields, while guidance also speaks to the non-contact completeness
 * checks. So a résumé with every bullet passing and complete contact details,
 * but no Summary section, has no triage and still has advice — and that is
 * exactly the combination a hand-maintained guard drops.
 *
 * Raw createRoot + act, matching the file beside it. `Disclosure` is a native
 * `<details>` that never unmounts its children, so the body is assertable
 * without opening the section — the same property the sibling file's
 * "starts collapsed, with both panels still mounted" case relies on.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TargetingSection } from "./TargetingSection.tsx";
import type { ResumeQueryInput } from "../../lib/job-search/query-builder.ts";
import type { ScoreGuidanceItem } from "../../lib/score/guidance.ts";
import type { BulletObservation } from "../../lib/score/score.ts";
import type { ContactDisplayField } from "../../lib/contact.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root | null = null;

/** A résumé the term classifier resolves nothing from, so `SkillTermGuidance`
 *  contributes no body of its own and each case isolates the term under test. */
function barrenParsed(): ResumeQueryInput {
  return { skills: [], experience: [] };
}

function guidanceItem(
  overrides: Partial<ScoreGuidanceItem> = {},
): ScoreGuidanceItem {
  return {
    dimension: "specificity",
    where: "Experience → Staff Engineer — Acme → bullet 3",
    action: "add a number — an amount, a percentage, or a count",
    ...overrides,
  };
}

function flaggedBullet(): BulletObservation {
  return {
    text: "Was responsible for the billing system",
    id: "0|was responsible for the billing system",
    index: 0,
    hasMetric: false,
    startsWithActionVerb: false,
    wellFormedLength: true,
    wordCount: 12,
  };
}

function render(options: {
  titles?: string[];
  parsed?: ResumeQueryInput;
  bullets?: readonly BulletObservation[];
  contactMissing?: ContactDisplayField[];
  guidance?: readonly ScoreGuidanceItem[];
}): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(TargetingSection, {
        titles: options.titles ?? [],
        onPrimaryChange: () => {},
        parsed: options.parsed ?? barrenParsed(),
        onAddSkill: () => {},
        bullets: options.bullets,
        contactMissing: options.contactMissing,
        guidance: options.guidance,
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

describe("TargetingSection — the guidance term in hasBody (#810)", () => {
  it("opens the disclosure for guidance alone, with no triage and no titles", () => {
    const el = render({ guidance: [guidanceItem()] });

    // Without the fourth term this whole component returns null.
    expect(el.querySelector("details")).not.toBeNull();
    expect(el.textContent).toContain("What to change");
    expect(el.textContent).toContain(
      "Experience → Staff Engineer — Acme → bullet 3",
    );
  });

  it("renders nothing at all when there is no guidance and nothing else to say", () => {
    const el = render({});
    expect(el.querySelector("details")).toBeNull();
    expect(el.textContent).toBe("");
  });

  it("renders no guidance chrome when the list is empty but the section has a body", () => {
    const el = render({ titles: ["Backend Engineer"], guidance: [] });
    expect(el.querySelector("details")).not.toBeNull();
    expect(el.textContent).not.toContain("What to change");
  });
});

describe("TargetingSection — guidance beside the triage row", () => {
  it("renders the counts first and the located detail after them", () => {
    const el = render({
      bullets: [flaggedBullet()],
      guidance: [guidanceItem()],
    });

    const text = el.textContent ?? "";
    // The triage row's aggregate…
    expect(text).toContain("bullet");
    expect(text).toContain("need attention");
    // …then the per-location detail, below it.
    const countsAt = text.indexOf("need attention");
    const detailAt = text.indexOf("What to change");
    expect(countsAt).toBeGreaterThanOrEqual(0);
    expect(detailAt).toBeGreaterThan(countsAt);
  });

  it("carries the action text, not just the location", () => {
    const el = render({ guidance: [guidanceItem()] });
    expect(el.textContent).toContain("add a number");
  });

  it("labels each row with its dimension", () => {
    const el = render({
      guidance: [
        guidanceItem({ dimension: "specificity" }),
        guidanceItem({ dimension: "structure", action: "open with an action verb" }),
        guidanceItem({ dimension: "completeness", where: "Contact → Phone" }),
      ],
    });
    const text = el.textContent ?? "";
    expect(text).toContain("Specificity");
    expect(text).toContain("Structure");
    expect(text).toContain("Completeness");
    expect(text).toContain("Contact → Phone");
  });
});
