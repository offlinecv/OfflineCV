// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Smoke tests for ResumeRewrite's presentational helpers.
 *
 * Mirrors the SectionRewrite.test.ts approach: the top-level hook is hard to
 * drive without a WebGPU adapter, so we target the pure helpers that own
 * the branching — `StepIndicator`, `aggregateDrift`, `ResumeRewritePanel`'s
 * branch selection, and the label fn.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResumeRewritePanel, StepIndicator } from "./ResumeRewrite.tsx";
import { aggregateDrift } from "./ResumeRewriteProposed.tsx";
import { labelForResumeRewrite, sectionsEqual, type ResumeRewriteStatus } from "../../hooks/useResumeRewrite.ts";
import type { ResumeRewriteResult, SectionInput } from "../../lib/webllm/rewrite-resume.ts";

const idle: ResumeRewriteStatus = { kind: "idle" };
const loading: ResumeRewriteStatus = {
  kind: "loading",
  progress: { progress: 0.5, text: "weights.bin" },
};
const running: ResumeRewriteStatus = {
  kind: "running",
  progress: {
    currentIndex: 1,
    totalSections: 3,
    currentLabel: "Engineer — Acme",
    completed: [],
  },
};
const errored: ResumeRewriteStatus = {
  kind: "error",
  message: "Engine failed to load",
};

const okResult: ResumeRewriteResult = {
  sections: [
    {
      kind: "summary",
      input: { kind: "summary", id: "summary", label: "Summary", text: "Engineer with 10 years." },
      data: {
        text: "Senior engineer.",
        numbersPreserved: true,
        droppedNumbers: [],
        addedNumbers: [],
      },
    },
    {
      kind: "experience",
      input: { kind: "experience", id: "experience:0", label: "Engineer — Acme", bullets: ["a"] },
      data: {
        bullets: ["Shipped Foo to 10M users."],
        numbersPreserved: true,
        droppedNumbers: [],
        addedNumbers: [],
      },
    },
  ],
  allNumbersPreserved: true,
};

const driftResult: ResumeRewriteResult = {
  sections: [
    {
      kind: "experience",
      input: { kind: "experience", id: "experience:0", label: "Engineer", bullets: ["a"] },
      data: {
        bullets: ["Saved money."],
        numbersPreserved: false,
        droppedNumbers: ["$5K"],
        addedNumbers: [],
      },
    },
    {
      kind: "summary",
      input: { kind: "summary", id: "summary", label: "Summary", text: "Engineer." },
      data: {
        text: "Senior engineer with 99.9% availability.",
        numbersPreserved: false,
        droppedNumbers: [],
        addedNumbers: ["99.9%"],
      },
    },
  ],
  allNumbersPreserved: false,
};

describe("labelForResumeRewrite", () => {
  it("returns the locked-by-other label regardless of status when the lock is held elsewhere", () => {
    expect(labelForResumeRewrite(idle, true)).toBe("Another rewrite running…");
    expect(labelForResumeRewrite(running, true)).toBe("Another rewrite running…");
  });

  it("maps each status to its display label", () => {
    expect(labelForResumeRewrite(idle, false)).toBe("Rewrite full résumé");
    expect(labelForResumeRewrite(loading, false)).toBe("Loading model…");
    expect(labelForResumeRewrite(running, false)).toBe("Rewriting 2 of 3…");
    expect(labelForResumeRewrite(errored, false)).toBe("Try again");
    expect(
      labelForResumeRewrite(
        { kind: "proposed", result: okResult, snapshot: [] },
        false,
      ),
    ).toBe("Rewrite again");
  });

  it("caps the running label at the total count when the final progress event fires", () => {
    const done: ResumeRewriteStatus = {
      kind: "running",
      progress: {
        currentIndex: 3,
        totalSections: 3,
        currentLabel: null,
        completed: [],
      },
    };
    expect(labelForResumeRewrite(done, false)).toBe("Rewriting 3 of 3…");
  });
});

describe("sectionsEqual", () => {
  const summary: SectionInput = {
    kind: "summary",
    id: "summary",
    label: "Summary",
    text: "Engineer.",
  };
  const role: SectionInput = {
    kind: "experience",
    id: "experience:0",
    label: "Engineer",
    bullets: ["a", "b"],
  };

  it("is true for the same list and for an identical-content copy", () => {
    expect(sectionsEqual([summary, role], [summary, role])).toBe(true);
    expect(sectionsEqual([summary, role], [{ ...summary }, { ...role, bullets: ["a", "b"] }])).toBe(true);
  });

  it("is false when the lengths differ", () => {
    expect(sectionsEqual([summary], [summary, role])).toBe(false);
  });

  it("is false when a section's kind or id changes", () => {
    expect(sectionsEqual([role], [{ ...role, id: "experience:1" }])).toBe(false);
    expect(
      sectionsEqual([summary], [{ ...role, id: "summary" } as SectionInput]),
    ).toBe(false);
  });

  it("is false when summary text changes", () => {
    expect(sectionsEqual([summary], [{ ...summary, text: "Edited." }])).toBe(false);
  });

  it("is false when an experience bullet's text or count changes", () => {
    expect(sectionsEqual([role], [{ ...role, bullets: ["a", "c"] }])).toBe(false);
    expect(sectionsEqual([role], [{ ...role, bullets: ["a"] }])).toBe(false);
  });
});

describe("aggregateDrift", () => {
  it("returns empty arrays for an all-clean result", () => {
    expect(aggregateDrift(okResult)).toEqual({ dropped: [], added: [] });
  });

  it("collects dropped and added tokens across every section regardless of kind", () => {
    expect(aggregateDrift(driftResult)).toEqual({
      dropped: ["$5K"],
      added: ["99.9%"],
    });
  });
});

describe("StepIndicator", () => {
  it("renders the position label and progress percentage", () => {
    const html = renderToStaticMarkup(
      createElement(StepIndicator, {
        currentIndex: 1,
        totalSections: 4,
        label: "Section 2",
      }),
    );
    expect(html).toContain("Rewriting 2 of 4: Section 2");
    expect(html).toContain("25%");
    expect(html).toContain('role="progressbar"');
  });

  it("clamps the position label at the total when the final progress event fires", () => {
    const html = renderToStaticMarkup(
      createElement(StepIndicator, {
        currentIndex: 4,
        totalSections: 4,
        label: "Finishing…",
      }),
    );
    expect(html).toContain("Rewriting 4 of 4: Finishing…");
    expect(html).toContain("100%");
  });
});

describe("ResumeRewritePanel", () => {
  it("renders nothing for the idle status", () => {
    const html = renderToStaticMarkup(
      createElement(ResumeRewritePanel, {
        status: idle,
        onDismiss: () => {},
        onApplied: () => {},
        onUndo: () => {},
      }),
    );
    expect(html).toBe("");
  });

  it("renders the model-load progress bar in the loading status", () => {
    const html = renderToStaticMarkup(
      createElement(ResumeRewritePanel, {
        status: loading,
        onDismiss: () => {},
        onApplied: () => {},
        onUndo: () => {},
      }),
    );
    expect(html).toContain("Loading the rewrite model");
    expect(html).toContain('role="progressbar"');
  });

  it("renders the error message in the error status", () => {
    const html = renderToStaticMarkup(
      createElement(ResumeRewritePanel, {
        status: errored,
        onDismiss: () => {},
        onApplied: () => {},
        onUndo: () => {},
      }),
    );
    expect(html).toContain("Engine failed to load");
    expect(html).toContain('role="alert"');
  });

  it("renders the step indicator in the running status with the in-flight section label", () => {
    const html = renderToStaticMarkup(
      createElement(ResumeRewritePanel, {
        status: running,
        onDismiss: () => {},
        onApplied: () => {},
        onUndo: () => {},
      }),
    );
    expect(html).toContain("Rewriting 2 of 3");
    // The currentLabel (Engineer — Acme) must reach the indicator — the
    // whole point of widening ResumeRewriteProgress with the label was so
    // the step text names the in-flight section instead of "Section 2".
    expect(html).toContain("Engineer — Acme");
  });

  it("falls back to a generic finishing label when currentLabel is null", () => {
    const finishing: ResumeRewriteStatus = {
      kind: "running",
      progress: {
        currentIndex: 3,
        totalSections: 3,
        currentLabel: null,
        completed: [],
      },
    };
    const html = renderToStaticMarkup(
      createElement(ResumeRewritePanel, {
        status: finishing,
        onDismiss: () => {},
        onApplied: () => {},
        onUndo: () => {},
      }),
    );
    expect(html).toContain("Finishing…");
  });

  it("renders every section's before/after in the proposed status", () => {
    // The proposed view now renders an inline diff (red struck-through removed
    // text + green added text) instead of a two-column "Original | Proposed"
    // grid. The section labels and the diff chrome classes must be present;
    // original/proposed text may be split across multiple diff spans so we
    // check for the stable substrings that appear as full segments in these
    // fixtures and the action button.
    const status: ResumeRewriteStatus = {
      kind: "proposed",
      result: okResult,
      snapshot: [],
    };
    const html = renderToStaticMarkup(
      createElement(ResumeRewritePanel, {
        status,
        onDismiss: () => {},
        onApplied: () => {},
        onUndo: () => {},
      }),
    );
    // Section labels (h4 headings) are unaffected by the diff swap.
    expect(html).toContain("Summary");
    expect(html).toContain("Engineer — Acme");
    // Diff chrome classes must exist for the summary and bullet diffs.
    expect(html).toContain("bg-feedback-error-bg");
    expect(html).toContain("bg-feedback-success-bg");
    // "Shipped Foo to 10M users." replaces a single "a" bullet — the full
    // proposed string appears as one added segment (no shared prefix/suffix).
    expect(html).toContain("Shipped Foo to 10M users.");
    // Action button.
    expect(html).toContain("Discard");
  });

  it("surfaces the aggregated metric-drift warning when any section flagged drift", () => {
    const status: ResumeRewriteStatus = {
      kind: "proposed",
      result: driftResult,
      snapshot: [],
    };
    const html = renderToStaticMarkup(
      createElement(ResumeRewritePanel, {
        status,
        onDismiss: () => {},
        onApplied: () => {},
        onUndo: () => {},
      }),
    );
    expect(html).toContain("AI altered a metric");
    expect(html).toContain("$5K");
    expect(html).toContain("99.9%");
  });
});
