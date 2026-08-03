// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * End-to-end coverage for the copyable-prompt disclosure (#609), driven
 * through the REAL `useResumeRewrite` controller rather than a stubbed
 * `steering` object.
 *
 * That choice is the point of the file. The likely bug in this feature is a
 * prompt built once and never rebuilt — and it passes any test that stubs the
 * steering, because the stub only ever holds one value. Driving the real
 * controller's `setPageTarget` / `setUserInstructions` exercises the whole
 * chain the user does: state → assembled steering → prompt → the text in the
 * box → the bytes on the clipboard.
 *
 * Only the engine layer is mocked (capability probe + `web-llm`), matching
 * `hooks/webllm-controllers.test.tsx`; nothing about steering or prompt
 * assembly is.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../lib/webllm/capability.ts", () => ({
  detectWebGpu: () => Promise.resolve("available"),
}));

vi.mock("../../lib/webllm/web-llm.ts", () => ({
  loadEngine: () => Promise.resolve({ chat: {} }),
  acquireInference: vi.fn(),
  releaseInference: vi.fn(),
}));

import { RewritePromptDisclosure } from "./RewritePromptDisclosure.tsx";
import {
  useResumeRewrite,
  type ResumeRewriteController,
} from "../../hooks/useResumeRewrite.ts";
import {
  NO_FABRICATION_RULE,
  PRESERVE_NUMBERS_RULE,
} from "../../lib/webllm/rewrite-guardrails.ts";
import type { SectionInput } from "../../lib/webllm/rewrite-resume.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// Synthetic persona, per CLAUDE.md's fixture rule — a résumé-shaped literal in
// a test is the thing that gets lifted into a fixture later.
const SUMMARY = "Platform engineer with 9 years in payments at Northwind Logistics.";
const BULLET_A = "Cut checkout latency 42% by resharding the ledger service.";
const BULLET_B = "Led 5 engineers through a zero-downtime Oracle migration.";
const RESUME_VALUES = [
  SUMMARY,
  BULLET_A,
  BULLET_B,
  "Staff Engineer · Northwind Logistics",
  "Northwind",
  "Oracle",
  "42%",
];

const SECTIONS: SectionInput[] = [
  { kind: "summary", id: "s", label: "Summary", text: SUMMARY },
  {
    kind: "experience",
    id: "e1",
    label: "Staff Engineer · Northwind Logistics",
    bullets: [BULLET_A, BULLET_B],
  },
];

let container: HTMLElement;
let root: Root;
let controller: ResumeRewriteController;

function Probe() {
  const c = useResumeRewrite(SECTIONS);
  controller = c;
  return <RewritePromptDisclosure controller={c} />;
}

beforeEach(async () => {
  // `useResumeRewrite` persists steering to localStorage, so a target set in
  // one case would otherwise be the starting state of the next.
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Flush the mocked `detectWebGpu()` inside `act` — its resolution sets
  // capability state, and letting it land mid-test is what produces the
  // "update not wrapped in act" noise (and, worse, a re-render between an
  // assertion and the thing it is asserting about).
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  stubClipboard(undefined);
});

function stubClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    value,
    configurable: true,
    writable: true,
  });
}

function toggle() {
  const button = container.querySelector("button[aria-expanded]");
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function clickButton(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function shownPrompt(): string {
  return container.querySelector("textarea")?.value ?? "";
}

describe("RewritePromptDisclosure — disclosure", () => {
  it("hides the prompt until a deliberate action reveals it", () => {
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain(PRESERVE_NUMBERS_RULE);
    expect(container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("reveals a prompt carrying the shared guardrails", () => {
    toggle();
    expect(shownPrompt()).toContain(PRESERVE_NUMBERS_RULE);
    expect(shownPrompt()).toContain(NO_FABRICATION_RULE);
  });

  it("shows the prompt read-only, not disabled, so it stays selectable", () => {
    toggle();
    const textarea = container.querySelector("textarea")!;
    expect(textarea.readOnly).toBe(true);
    expect(textarea.disabled).toBe(false);
  });
});

describe("RewritePromptDisclosure — the prompt tracks live steering", () => {
  it("updates when the page target changes", () => {
    toggle();
    expect(shownPrompt()).not.toContain("Target a one-page résumé");

    act(() => controller.setPageTarget(1));
    expect(shownPrompt()).toContain("Target a one-page résumé");

    act(() => controller.setPageTarget(3));
    expect(shownPrompt()).toContain("Target a three-page résumé");
    expect(shownPrompt()).not.toContain("Target a one-page résumé");
  });

  it("updates when the freeform instructions change", () => {
    toggle();
    act(() => controller.setUserInstructions("drop the internships"));
    expect(shownPrompt()).toContain(
      "The user has these additional instructions: drop the internships",
    );
  });

  it("is complete with no steering set at all", () => {
    toggle();
    const prompt = shownPrompt();
    expect(prompt).toContain(PRESERVE_NUMBERS_RULE);
    expect(prompt).not.toContain("The user has these additional instructions:");
    expect(prompt).not.toMatch(/\n{3}/);
  });
});

describe("the controller absorbs parent render churn (#732 review)", () => {
  // `ReconstructedResume` calls `buildResumeSections(…)` in its render body —
  // a plain call, not a memo — so `sections` arrives as a NEW array on every
  // render. That churn used to reach `rewriteableSections` and `steering`,
  // which made the disclosure's prompt `useMemo` inert: deps that change every
  // render memoize nothing.
  //
  // Asserted on the controller rather than on the rendered prompt, because the
  // prompt is derived — it comes out identical either way, which is exactly why
  // the churn was invisible until someone looked at the dep list.
  const ROLE = "Staff Engineer · Northwind Logistics";

  function freshSections(label: string, second: string): SectionInput[] {
    return [
      { kind: "summary", id: "s", label: "Summary", text: SUMMARY },
      { kind: "experience", id: "e1", label, bullets: [BULLET_A, second] },
    ];
  }

  let churn: ResumeRewriteController;

  function ChurnProbe({ label, second }: { label: string; second: string }) {
    churn = useResumeRewrite(freshSections(label, second));
    return null;
  }

  async function render(label = ROLE, second = BULLET_B) {
    await act(async () => {
      root.render(<ChurnProbe label={label} second={second} />);
      await Promise.resolve();
    });
  }

  it("holds section and steering identity across a content-identical re-render", async () => {
    await render();
    // A page target makes `steering` a real object — with no steering at all it
    // is `undefined`, and `undefined === undefined` would pass vacuously.
    act(() => churn.setPageTarget(1));

    const sections = churn.rewriteableSections;
    const steering = churn.steering;
    expect(steering).toBeDefined();

    await render();

    expect(churn.rewriteableSections).toBe(sections);
    expect(churn.steering).toBe(steering);
  });

  it("still adopts a new array when a display LABEL changes", async () => {
    // The stabilizer is stricter than `sectionsEqual`, which ignores `label`.
    // These objects are what the progress line and the proposal panel's
    // headings read, so holding a stale one would show the old employer.
    await render();
    const sections = churn.rewriteableSections;

    await render("Staff Engineer · Contoso Freight");

    expect(churn.rewriteableSections).not.toBe(sections);
    expect(churn.rewriteableSections.map((s) => s.label)).toContain(
      "Staff Engineer · Contoso Freight",
    );
  });

  it("still adopts a new array when a BULLET changes", async () => {
    await render();
    const sections = churn.rewriteableSections;

    await render(ROLE, "Rebuilt the pricing service end to end.");

    expect(churn.rewriteableSections).not.toBe(sections);
    expect(JSON.stringify(churn.rewriteableSections)).toContain(
      "Rebuilt the pricing service end to end.",
    );
  });
});

describe("RewritePromptDisclosure — copying", () => {
  it("puts the shown prompt on the clipboard and confirms in place", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard({ writeText });
    toggle();
    act(() => controller.setPageTarget(2));

    await act(async () => {
      clickButton("Copy prompt");
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(shownPrompt());
    expect(container.textContent).toContain("Copied the prompt");
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Copied the prompt",
    );
  });

  it("copies no résumé content", async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    stubClipboard({ writeText });
    toggle();
    act(() => controller.setUserInstructions("emphasise the payments work"));

    await act(async () => {
      clickButton("Copy prompt");
      await Promise.resolve();
    });

    const copied = writeText.mock.calls[0]![0];
    for (const value of RESUME_VALUES) {
      expect(copied).not.toContain(value);
    }
  });

  it("degrades without throwing when there is no Clipboard API, leaving the text on screen", async () => {
    stubClipboard(undefined);
    toggle();

    await act(async () => {
      clickButton("Copy prompt");
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Couldn’t copy — select the text above");
    expect(shownPrompt()).toContain(PRESERVE_NUMBERS_RULE);
    expect(container.querySelector("textarea")?.disabled).toBe(false);
  });
});
