// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Integration coverage for the Fix It step-through mode in Result (#810).
 *
 * Proves that:
 * 1. Guidance items are derived deterministically on the parsed result.
 * 2. AtsScoreReadout offers the "Fix It →" entry point when items exist.
 * 3. Clicking "Fix It →" opens the FixItToolbar dock and activates the first item's anchor.
 * 4. Navigating Next steps through items and moves the active highlight ring.
 * 5. Clicking Done exits Fix It mode.
 * 6. An edit that resolves the current item shrinks the list live, in place.
 * 7. Leaving the mode hands focus back to the control that entered it.
 * 8. The Experience-level steps focus a control in Experience — the role-dates
 *    step the first missing start date — never the first control in the résumé.
 * 9. The step follows its item, not its position: an edit elsewhere leaves it
 *    put, and the item that slides into a resolved step is scrolled into view.
 * 10. Section steps focus the section's add control, never a remove button.
 * 11. Done never returns focus to <body>, and past the last step no target
 *     keeps the highlight.
 * 12. A flagged bullet's tinted marker (#913) enters the mode at THAT bullet's
 *     step, landing focus on the bullet text rather than the marker; nothing
 *     enters the mode, moves focus or scrolls on render alone.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement, useMemo } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Result } from "./Result.tsx";
import { useEditableParse, type EditableParse } from "../hooks/useEditableParse.ts";
import { useLlmRecovery } from "../hooks/useLlmRecovery.ts";
import {
  useAutosaveResume,
  type SavableResumeLibrary,
} from "../hooks/useAutosaveResume.ts";
import { computeAnonymousAtsScore } from "../lib/score/score.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const SAVE_STUB: SavableResumeLibrary = { save: async () => "record-1" };

vi.mock("../lib/webllm/capability.ts", () => ({
  detectWebGpu: () => Promise.resolve("unsupported"),
}));

function mockResultWithIssues(): CascadeResult {
  return {
    canonical: {
      fields: {
        full_name: "", // Missing name
        email: "test@example.com",
        phone: "(312) 555-0123",
        skills: ["TypeScript"], // Fewer than 3 skills
        experience: [
          {
            title: "Engineer",
            company: "Acme",
            start_date: "2020",
            end_date: "2022",
            description: "Developed features.", // Weak verb / no metric
          },
        ],
        education: [],
      },
      sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
      fieldConfidence: {},
    },
    confidence: 0.8,
    triggers: [],
    suggestedEscalation: "none",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "Engineer at Acme. Developed features.",
    markdown: "",
    linkAnnotations: [],
    diagnostics: { rawCharCount: 100, extractedCharCount: 80, pages: 1, elapsedMs: 10 },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  } as unknown as CascadeResult;
}

let container: HTMLDivElement;
let root: Root;

function Host({ result }: { result: CascadeResult }) {
  const edit = useEditableParse();
  const score = computeAnonymousAtsScore({
    parsed: result.canonical.fields,
    fieldConfidence: result.canonical.fieldConfidence,
    triggers: result.triggers,
    rawText: result.rawText,
    sections: { accomplishmentSections: [], byName: new Map(), source: "regex" },
  });
  const recovery = useLlmRecovery(result, score, result);
  const autosave = useAutosaveResume({
    library: SAVE_STUB,
    parseKey: result,
    hasEdits: edit.hasEdits,
    resume:
      recovery === null
        ? null
        : {
            filename: "cv.pdf",
            sourceKind: "pdf",
            result: recovery.activeResult,
            score: recovery.activeScore,
          },
  });
  if (recovery === null) throw new Error("recovery is non-null for a real parse");
  return createElement(Result, {
    result,
    parseKey: result,
    sourceKind: "pdf",
    onReset: () => {},
    edit,
    recovery,
    autosave,
  });
}

afterEach(() => {
  if (root) {
    act(() => root.unmount());
  }
  container?.remove();
});

describe("Result — Fix It guided step-through mode (#810)", () => {
  it("renders Fix It button and enters step-through mode on click", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const result = mockResultWithIssues();
    await act(async () => {
      root.render(createElement(Host, { result }));
    });

    // Fix It button must be visible in AtsScoreReadout hero
    const fixItBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Fix It →"),
    );
    expect(fixItBtn).toBeDefined();

    // FixItToolbar is initially not mounted
    expect(container.querySelector('[aria-label="Fix It guidance"]')).toBeNull();

    // Click Fix It button
    await act(async () => {
      fixItBtn?.click();
    });

    // FixItToolbar is now mounted
    const toolbar = container.querySelector('[aria-label="Fix It guidance"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.textContent).toContain("Step 1 of");

    // The name field anchor must have the active highlight ring class
    const nameAnchor = container.querySelector("#contact-field-full_name");
    expect(nameAnchor).not.toBeNull();
    expect(nameAnchor?.className).toContain("ring-accent-primary");

    // Next button advances to next step
    const nextBtn = Array.from(toolbar?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent?.includes("Next →"),
    );
    expect(nextBtn).toBeDefined();

    await act(async () => {
      nextBtn?.click();
    });

    expect(toolbar?.textContent).toContain("Step 2 of");

    // Clicking Done exits Fix It mode
    const doneBtn = Array.from(toolbar?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent?.trim() === "Done",
    );
    expect(doneBtn).toBeDefined();

    await act(async () => {
      doneBtn?.click();
    });

    // Toolbar is unmounted
    expect(container.querySelector('[aria-label="Fix It guidance"]')).toBeNull();
    // Highlight ring is removed from name anchor
    expect(nameAnchor?.className).not.toContain("ring-accent-primary");
  });

  /**
   * A host that folds the name override back into the parse and re-grades it,
   * the way `useAnalyzedResume` does — including the confidence a user-affirmed
   * field earns (`applyOverrides`) — so an edit moves the score, and the
   * guidance derived from it, exactly as it does on the page.
   */
  async function renderEditing(
    parse: CascadeResult,
    sink: { current: EditableParse | null },
  ): Promise<HTMLElement> {
    function EditHost() {
      const edit = useEditableParse();
      sink.current = edit;
      const name = edit.contactOverrides.full_name;
      const displayResult = useMemo(
        () => ({
          ...parse,
          canonical: {
            ...parse.canonical,
            fields: {
              ...parse.canonical.fields,
              full_name: name ?? parse.canonical.fields.full_name,
            },
            fieldConfidence: {
              ...parse.canonical.fieldConfidence,
              ...(name ? { full_name: 1 } : {}),
            },
          },
        }),
        [name],
      ) as CascadeResult;
      const score = computeAnonymousAtsScore({
        parsed: displayResult.canonical.fields,
        fieldConfidence: displayResult.canonical.fieldConfidence,
        triggers: displayResult.triggers,
        rawText: displayResult.rawText,
        sections: { accomplishmentSections: [], byName: new Map(), source: "regex" },
      });
      const recovery = useLlmRecovery(displayResult, score, parse);
      const autosave = useAutosaveResume({
        library: SAVE_STUB,
        parseKey: parse,
        hasEdits: edit.hasEdits,
        resume: null,
      });
      if (recovery === null) throw new Error("recovery is non-null for a real parse");
      return createElement(Result, {
        result: displayResult,
        parseKey: parse,
        sourceKind: "pdf",
        onReset: () => {},
        edit,
        recovery,
        autosave,
      });
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(EditHost));
    });
    return container;
  }

  const fixItButton = (el: HTMLElement) =>
    Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Fix It →"),
    );
  const stepLine = (el: HTMLElement) =>
    el.querySelector('[aria-label="Fix It guidance"]')?.textContent?.match(
      /Step (\d+) of (\d+)/,
    );

  it("shrinks the list live when an edit resolves the current item", async () => {
    const sink: { current: EditableParse | null } = { current: null };
    const el = await renderEditing(mockResultWithIssues(), sink);

    await act(async () => {
      fixItButton(el)?.click();
    });
    const before = stepLine(el);
    expect(before?.[1]).toBe("1");
    const total = Number(before?.[2]);
    // Step 1 is the missing name.
    expect(el.querySelector("#contact-field-full_name")?.className).toContain(
      "ring-accent-primary",
    );

    await act(async () => {
      sink.current?.setContactField("full_name", "Dana Fixture");
    });

    // Same position, one fewer item: the step the user was on is now the next
    // gap, and the mode is still on — nobody had to press Next.
    expect(stepLine(el)?.slice(1)).toEqual(["1", String(total - 1)]);
    expect(el.querySelector("#contact-field-full_name")?.className).not.toContain(
      "ring-accent-primary",
    );
  });

  it("brings the item that slides into a resolved step into view", async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      const sink: { current: EditableParse | null } = { current: null };
      const el = await renderEditing(mockResultWithIssues(), sink);
      await act(async () => {
        fixItButton(el)?.click();
      });
      scrolled.length = 0;

      await act(async () => {
        sink.current?.setContactField("full_name", "Dana Fixture");
      });

      const now = el.querySelector(".ring-accent-primary");
      expect(now).not.toBeNull();
      expect(scrolled).toContain(now);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("stays on its item when an edit resolves a different one", async () => {
    const sink: { current: EditableParse | null } = { current: null };
    const el = await renderEditing(mockResultWithIssues(), sink);
    await act(async () => {
      fixItButton(el)?.click();
    });
    const total = Number(stepLine(el)?.[2]);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[aria-label="Next guidance item"]')!.click();
    });
    const lit = el.querySelector(".ring-accent-primary");

    // Resolve step 1 (the name) while on step 2.
    await act(async () => {
      sink.current?.setContactField("full_name", "Dana Fixture");
    });

    expect(stepLine(el)?.slice(1)).toEqual(["1", String(total - 1)]);
    expect(el.querySelector(".ring-accent-primary")).toBe(lit);
  });

  it("lands the Skills step on the add-skill control, not a remove button", async () => {
    const el = await renderEditing(mockResultWithIssues(), { current: null });
    await act(async () => {
      fixItButton(el)?.click();
    });
    await stepTo(el, "Skills");

    expect(document.activeElement?.getAttribute("aria-label")).toBe("Add skill");
    expect(el.querySelector("#resume-skills")?.contains(document.activeElement)).toBe(
      true,
    );
  });

  it("hands focus back to the Fix It button on Done", async () => {
    const sink: { current: EditableParse | null } = { current: null };
    const el = await renderEditing(mockResultWithIssues(), sink);
    const entry = fixItButton(el)!;

    entry.focus();
    await act(async () => {
      entry.click();
    });
    expect(document.activeElement).not.toBe(entry); // focus moved into the résumé

    const done = Array.from(
      el.querySelectorAll<HTMLButtonElement>('[aria-label="Fix It guidance"] button'),
    ).find((b) => b.textContent?.trim() === "Done")!;
    await act(async () => {
      done.click();
    });

    expect(el.querySelector('[aria-label="Fix It guidance"]')).toBeNull();
    expect(document.activeElement).toBe(entry);
  });

  it("still hands focus back to the Fix It button after a marker moved the step mid-mode (#913)", async () => {
    const el = await renderEditing(mockResultWithIssues(), { current: null });
    const entry = fixItButton(el)!;

    entry.focus();
    await act(async () => {
      entry.click();
    });
    // The marker takes focus the way a click does in Chrome, then moves the
    // step while the mode is already on.
    const marker = el.querySelector<HTMLButtonElement>("button[data-fixit-marker]")!;
    marker.focus();
    await act(async () => {
      marker.click();
    });

    const done = Array.from(
      el.querySelectorAll<HTMLButtonElement>('[aria-label="Fix It guidance"] button'),
    ).find((b) => b.textContent?.trim() === "Done")!;
    await act(async () => {
      done.click();
    });

    expect(document.activeElement).toBe(entry);
  });

  it("sends Done to the last step when entry left focus on <body> (#1003)", async () => {
    // Safari and macOS Firefox do not focus a button on click, so the entry
    // click leaves <body> active. Returning focus there strands the user.
    const sink: { current: EditableParse | null } = { current: null };
    const el = await renderEditing(mockResultWithIssues(), sink);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      fixItButton(el)!.click();
    });
    const done = Array.from(
      el.querySelectorAll<HTMLButtonElement>('[aria-label="Fix It guidance"] button'),
    ).find((b) => b.textContent?.trim() === "Done")!;
    // Done itself holds focus (tabbed to), so its unmount drops focus to <body>.
    done.focus();
    await act(async () => {
      done.click();
    });

    // Step 1 is the missing name: Done lands on its control.
    expect(document.activeElement).not.toBe(document.body);
    expect(
      el.querySelector("#contact-field-full_name")?.contains(document.activeElement),
    ).toBe(true);
  });

  it("drops the highlight once the user steps past the last item", async () => {
    const sink: { current: EditableParse | null } = { current: null };
    const el = await renderEditing(mockResultWithIssues(), sink);
    await act(async () => {
      fixItButton(el)!.click();
    });
    for (let i = 0; i < 20; i++) {
      const finish = el.querySelector<HTMLButtonElement>(
        '[aria-label="Finish stepping through guidance"]',
      );
      const next =
        finish ??
        el.querySelector<HTMLButtonElement>('[aria-label="Next guidance item"]');
      await act(async () => {
        next!.click();
      });
      if (finish) break;
    }
    expect(el.querySelector('[aria-label="Fix It guidance complete"]')).not.toBeNull();
    expect(el.querySelector(".ring-accent-primary")).toBeNull();

    await act(async () => {
      el.querySelector<HTMLButtonElement>(
        '[aria-label="Back to the last guidance item"]',
      )!.click();
    });
    expect(el.querySelector('[aria-label="Fix It guidance"]')).not.toBeNull();
    expect(el.querySelector(".ring-accent-primary")).not.toBeNull();
  });

  /** Press Next until the dock shows `location`; the step order is not the test. */
  async function stepTo(el: HTMLElement, location: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const dock = el.querySelector('[aria-label="Fix It guidance"]');
      if (dock?.textContent?.includes(location)) return;
      const next = dock?.querySelector<HTMLButtonElement>(
        '[aria-label="Next guidance item"]',
      );
      if (!next) break;
      await act(async () => {
        next.click();
      });
    }
    throw new Error(`no Fix It step at ${location}`);
  }

  it("lands the role-dates step on the first role with no start date", async () => {
    const parse = mockResultWithIssues();
    parse.canonical.fields.experience = [
      { title: "Engineer", company: "Acme", start_date: "2020", description: "" },
      { title: "Analyst", company: "Beta", description: "" },
      { title: "Intern", company: "Gamma", description: "" },
    ];
    const el = await renderEditing(parse, { current: null });
    await act(async () => {
      fixItButton(el)?.click();
    });
    await stepTo(el, "Experience → Dates");

    const target = el.querySelector("#resume-experience-dates");
    expect(target?.className).toContain("ring-accent-primary");
    // Beta's start date: the first undated role, not Acme's and not the name.
    expect(target?.closest("div")?.textContent).toContain("Beta");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Add Start date");
    expect(target?.contains(document.activeElement)).toBe(true);
  });

  it("keeps a role's start date mounted when the dates anchor moves off it", async () => {
    const parse = mockResultWithIssues();
    parse.canonical.fields.experience = [
      { title: "Engineer", company: "Acme", description: "" },
      { title: "Analyst", company: "Beta", description: "" },
      { title: "Intern", company: "Gamma", description: "" },
    ];
    const sink: { current: EditableParse | null } = { current: null };
    const el = await renderEditing(parse, sink);
    const acmeStart = el.querySelector("#resume-experience-dates")?.firstElementChild;
    expect(acmeStart?.closest("div")?.textContent ?? "").toContain("Acme");

    // Dating Acme moves the anchor to Beta; Acme's field must not remount, or
    // the focus a keyboard user committed from is dropped to <body>.
    await act(async () => {
      sink.current?.setExperienceField(0, "start_date", "2019");
    });
    expect(el.querySelector("#resume-experience-dates")?.closest("div")?.textContent).toContain(
      "Beta",
    );
    expect(acmeStart?.isConnected).toBe(true);
  });

  it("lands the missing-experience step inside the Experience section", async () => {
    const parse = mockResultWithIssues();
    parse.canonical.fields.experience = [];
    const el = await renderEditing(parse, { current: null });
    await act(async () => {
      fixItButton(el)?.click();
    });
    await stepTo(el, "Experience");

    const section = el.querySelector("#resume-experience");
    expect(section?.className).toContain("ring-accent-primary");
    expect(section?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Add experience");
    expect(el.querySelector("#contact")?.contains(document.activeElement)).toBe(false);
  });

  it("enters Fix It at a bullet's own step when its tinted marker is clicked (#913)", async () => {
    const el = await renderEditing(mockResultWithIssues(), { current: null });
    const markers = el.querySelectorAll<HTMLButtonElement>("button[data-fixit-marker]");
    // "Developed features." is the one stepped bullet in this parse.
    expect(markers).toHaveLength(1);
    const row = markers[0]!.closest("li")!;

    await act(async () => {
      markers[0]!.click();
    });

    const dock = el.querySelector('[aria-label="Fix It guidance"]');
    expect(dock).not.toBeNull();
    // Not step 1 — the leading contact steps come first — but the bullet's.
    expect(dock?.textContent).toContain("bullet 1");
    expect(dock?.textContent).not.toContain("Step 1 of");
    expect(row.className).toContain("ring-accent-primary");
    // Focus lands on the thing the step edits, never back on the marker.
    expect(row.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(markers[0]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Edit Bullet text");
  });

  it("moves no focus, scrolls nothing and opens no dock on render alone (#913)", async () => {
    const original = Element.prototype.scrollIntoView;
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      (document.activeElement as HTMLElement | null)?.blur();
      const el = await renderEditing(mockResultWithIssues(), { current: null });
      expect(el.querySelector('[aria-label="Fix It guidance"]')).toBeNull();
      expect(document.activeElement).toBe(document.body);
      expect(scrolled).not.toHaveBeenCalled();
      expect(el.querySelector(".ring-accent-primary")).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("rules every section heading, never the header block (#913)", async () => {
    const el = await renderEditing(mockResultWithIssues(), { current: null });
    const headings = el.querySelectorAll("#resume-experience h2, #resume-skills h2");
    expect(headings.length).toBeGreaterThan(0);
    for (const h of headings) expect(h.className).toContain("border-b");
    expect(el.querySelector("#contact [class*='border-b']")).toBeNull();
  });
});
