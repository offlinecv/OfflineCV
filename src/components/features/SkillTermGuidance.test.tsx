// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render coverage for SkillTermGuidance (#586). Raw createRoot + act,
 * matching the other feature render tests in this lane (no
 * @testing-library here — see RoleFamilyChips.test.tsx).
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SkillTermGuidance } from "./SkillTermGuidance.tsx";
import type { ResumeQueryInput } from "../../lib/job-search/query-builder.ts";
import type { SkillsReorderController } from "../../hooks/useSkillsReorder.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

function render(
  parsed: ResumeQueryInput,
  onAddSkill: (skill: string) => void,
  skillsOrder?: SkillsReorderController,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(SkillTermGuidance, { parsed, onAddSkill, skillsOrder }),
    );
  });
  return container;
}

/** A `useSkillsReorder` controller with something to say. Stubbed rather than
 *  driven through the real hook: the hook's own lifecycle is covered in
 *  `useSkillsReorder.test.tsx`, and what this file has to pin is that the row
 *  reaches the screen HERE — on a surface with no model, no WebGPU check and
 *  no `status.kind` (#544). */
function reorderController(
  overrides: Partial<SkillsReorderController> = {},
): SkillsReorderController {
  return {
    finding: {
      buried: ["Kubernetes"],
      suggestedOrder: ["Kubernetes", "PostgreSQL", "C#"],
    },
    canApply: true,
    applied: false,
    apply: () => {},
    undo: () => {},
    dismiss: () => {},
    ...overrides,
  };
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** A résumé whose title resolves the backend-engineer profile: PostgreSQL is
 *  canonical for that role (strong), C# is recognized but not what the role
 *  is usually hired on (weak), and "People Management" is a high-value skill
 *  the profile expects but the résumé never uses (missing). */
function resolvableParsed(): ResumeQueryInput {
  return {
    skills: ["PostgreSQL", "C#"],
    experience: [
      {
        title: "Backend Engineer",
        company: "Acme Corp",
      },
    ],
  };
}

describe("SkillTermGuidance", () => {
  it("renders recognized and not-recognized skills for a role-resolvable résumé", () => {
    const el = render(resolvableParsed(), () => {});
    expect(el.textContent).toContain("Skills this role usually asks for");
    // The subhead names the ROLE as the source, which is what makes the panel's
    // new position (directly under RolesPanel) legible — its content is derived
    // from `titles[0]`. Worded "first", not "starred": `titles[0]` drives this
    // list whether or not it carries a ★ (a résumé with no headline has no ★
    // at all, by design — see RolesPanel).
    expect(el.textContent).toContain("Based on the first role title above");
    // `query.skills` canonicalizes through the jd-match skill index
    // (`buildJobQuery` → `getSkillIndex`), so the rendered term is the
    // canonical id/label ("PostgreSQL", "C#"), not the résumé's raw
    // casing — same behaviour `/jobs/` renders.
    expect(el.textContent).toContain("Already in your résumé: PostgreSQL");
    expect(el.textContent).toContain(
      "We could not match these to a known skill: C#",
    );
    // The old wording blamed the user's term rather than our index; assert it
    // is gone, not merely that the new sentence is present.
    expect(el.textContent).not.toContain("Not recognized by matchers");
  });

  it("confirms in place where an added term landed", () => {
    const el = render(resolvableParsed(), () => {});
    const pill = el.querySelector("button[aria-label]") as HTMLButtonElement;
    const label = pill.getAttribute("aria-label")!;

    expect(el.textContent).not.toContain("to your Skills section");
    act(() => pill.click());

    // This panel now sits far above the Skills section it writes into, so the
    // add needs an acknowledgement the vanishing pill alone cannot give.
    expect(el.textContent).toContain(`to your Skills section: ${label}`);
    const live = el.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toContain(label);
  });

  it("renders the reason for an unrecognized skill verbatim from the classifier", () => {
    const el = render(resolvableParsed(), () => {});
    // REASONS.skillWeak in term-quality.ts.
    expect(el.textContent).toContain(
      "Not what this role is usually hired on, so it adds little.",
    );
  });

  it("calls onAddSkill through the existing inline-edit path when a missing term is clicked", () => {
    const added: string[] = [];
    const el = render(resolvableParsed(), (skill) => added.push(skill));
    const pill = el.querySelector("button[aria-label]") as HTMLButtonElement;
    expect(pill).not.toBeNull();
    const label = pill.getAttribute("aria-label");
    act(() => pill.click());
    expect(added).toEqual([label]);
  });

  it("never auto-edits: no onAddSkill call happens on render alone", () => {
    let called = false;
    render(resolvableParsed(), () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  it("renders nothing for a résumé whose role never resolves", () => {
    const el = render(
      {
        skills: [],
        experience: [
          { title: "Chief Happiness Officer", company: "Acme Corp" },
        ],
      },
      () => {},
    );
    expect(el.textContent).toBe("");
  });

  it("renders nothing for an entirely empty résumé", () => {
    const el = render({ skills: [], experience: [] }, () => {});
    expect(el.textContent).toBe("");
  });
});

// ── Skills ordering (#544) ────────────────────────────────────────────────────

/**
 * The regression these cover: the ordering row first shipped inside
 * `CritiqueResults`, which mounts only under `status.kind === "done"` — so a
 * finding computed on every parse was visible only after a visitor opted into
 * the on-device model download. Nothing in this file touches WebGPU, a model,
 * or an `AnalysisController`, which is the point: if the row renders here, it
 * renders for the majority path.
 */
describe("SkillTermGuidance — skills ordering (#544)", () => {
  it("renders the ordering call-out with no on-device model in play", () => {
    const el = render(resolvableParsed(), () => {}, reorderController());
    expect(el.textContent).toContain(
      '"Kubernetes" looks highly relevant to your target role',
    );
    const reorder = el.querySelector(
      'button[aria-label^="Move the highly relevant skills"]',
    );
    expect(reorder).not.toBeNull();
  });

  it("renders no ordering copy when the caller passes no controller", () => {
    const el = render(resolvableParsed(), () => {});
    expect(el.textContent).not.toContain("sits well down your Skills list");
  });

  it("renders no ordering copy when the controller has nothing to flag", () => {
    const el = render(
      resolvableParsed(),
      () => {},
      reorderController({ finding: undefined }),
    );
    expect(el.textContent).not.toContain("sits well down your Skills list");
  });

  it("Apply writes through the controller, never on render alone", () => {
    let applied = 0;
    const el = render(resolvableParsed(), () => {}, {
      ...reorderController(),
      apply: () => {
        applied += 1;
      },
    });
    expect(applied).toBe(0);
    const reorder = el.querySelector(
      'button[aria-label^="Move the highly relevant skills"]',
    ) as HTMLButtonElement;
    act(() => reorder.click());
    expect(applied).toBe(1);
  });

  it("still renders when the classifier resolved no role at all", () => {
    // All three term-quality buckets are empty here (`term-quality.ts` rule 1),
    // which is the panel's own self-hide condition. The ordering heuristic
    // needs only title TOKENS, not a resolved role profile, so the two can
    // disagree — and the panel must not take the finding down with it.
    const el = render(
      {
        skills: [],
        experience: [{ title: "Chief Happiness Officer", company: "Acme Corp" }],
      },
      () => {},
      reorderController(),
    );
    expect(el.textContent).toContain("sits well down your Skills list");
  });

  it("keeps the confirmation strip up while `applied` holds, finding gone", () => {
    // Post-Apply the finding recomputes to undefined (the skills are no longer
    // buried), but the undo affordance still has to be reachable.
    const el = render(
      resolvableParsed(),
      () => {},
      reorderController({ finding: undefined, applied: true }),
    );
    expect(el.querySelector("button[aria-label]")).not.toBeNull();
    expect(el.textContent).toContain("Skills");
  });
});
