// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Smoke tests for SectionRewrite's presentational branches.
 *
 * The top-level component is hard to drive from a node test: it returns
 * `null` until `detectWebGpu()` resolves, and the non-idle states
 * (loading/rewriting/proposed/error) are all reached via async work the
 * suite can't execute without a real WebGPU adapter. So the tests target
 * the helpers that own the branching — `labelFor`, `formatTokens`,
 * `NumberPreservationWarning`, `ProposedSection` — covering the cheap
 * conditional paths that drive `fallow`'s CRAP advisories.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatTokens,
  labelFor,
  NumberPreservationWarning,
  ProposedSection,
  type Status,
} from "./SectionRewrite.tsx";
import type { SectionRewriteResult } from "../../lib/webllm/rewrite-section.ts";

// ── labelFor ────────────────────────────────────────────────────────────────

describe("labelFor", () => {
  const idle: Status = { kind: "idle" };
  const loading: Status = {
    kind: "loading",
    progress: { progress: 0, text: "" },
  };
  const rewriting: Status = { kind: "rewriting" };
  const result: SectionRewriteResult = {
    bullets: ["x"],
    numbersPreserved: true,
    reverted: false,
    droppedNumbers: [],
    addedNumbers: [],
  };
  const proposed: Status = { kind: "proposed", result, snapshot: ["x"] };
  const error: Status = { kind: "error", message: "OOM" };

  it("returns the locked-by-other label regardless of status when the lock is held elsewhere", () => {
    // This branch is the actual concurrency-UI signal — covered explicitly.
    expect(labelFor(idle, true)).toBe("Another rewrite running…");
    expect(labelFor(proposed, true)).toBe("Another rewrite running…");
    expect(labelFor(error, true)).toBe("Another rewrite running…");
  });

  it("maps each non-locked status to its label", () => {
    expect(labelFor(idle, false)).toBe("Rewrite section");
    expect(labelFor(loading, false)).toBe("Loading model…");
    expect(labelFor(rewriting, false)).toBe("Rewriting…");
    expect(labelFor(proposed, false)).toBe("Rewrite again");
    expect(labelFor(error, false)).toBe("Try again");
  });
});

// ── formatTokens ────────────────────────────────────────────────────────────

describe("formatTokens", () => {
  it("returns the single token unchanged for length 1", () => {
    expect(formatTokens(["$5K"])).toBe("$5K");
  });

  it("joins two tokens with `and`", () => {
    expect(formatTokens(["$5K", "10%"])).toBe("$5K and 10%");
  });

  it("uses an Oxford-style comma list for three or more tokens", () => {
    expect(formatTokens(["$5K", "10%", "12 months"])).toBe(
      "$5K, 10%, and 12 months",
    );
  });
});

// ── NumberPreservationWarning ───────────────────────────────────────────────

describe("NumberPreservationWarning", () => {
  it("renders the specific dropped token (not a generic 'metric changed' string)", () => {
    const html = renderToStaticMarkup(
      createElement(NumberPreservationWarning, {
        dropped: ["$5K"],
        added: [],
      }),
    );
    expect(html).toContain("removed $5K");
    // The whole point of the warning is naming the token — guard against a
    // regression that drops the token in favour of a generic message.
    expect(html).not.toContain("a metric was altered");
  });

  it("names both dropped and added tokens when the model both removed and invented numbers", () => {
    const html = renderToStaticMarkup(
      createElement(NumberPreservationWarning, {
        dropped: ["15%"],
        added: ["-15%"],
      }),
    );
    expect(html).toContain("removed 15%");
    expect(html).toContain("invented -15%");
    expect(html).toContain(" and ");
  });

  it("uses role=alert so screen readers announce the warning", () => {
    const html = renderToStaticMarkup(
      createElement(NumberPreservationWarning, {
        dropped: ["$5K"],
        added: [],
      }),
    );
    expect(html).toContain('role="alert"');
  });
});

// ── ProposedSection ─────────────────────────────────────────────────────────

describe("NumberPreservationWarning — reverted copy (#778)", () => {
  function render(props: {
    dropped: string[];
    added: string[];
    reverted?: boolean;
  }): string {
    return renderToStaticMarkup(
      createElement(NumberPreservationWarning, props),
    );
  }

  it("tells the user nothing was applied and names what would have been lost", () => {
    const html = render({ dropped: ["$4.2M"], added: [], reverted: true });
    expect(html).toContain("Kept your original");
    expect(html).toContain("$4.2M");
    // Never the "review before saving" copy — there is nothing new to review.
    expect(html).not.toContain("Review before saving");
  });

  it("names the INVENTED token when the gate reverted on invention alone", () => {
    // The widened gate reverts on pure invention, where `dropped` is empty —
    // copy that quoted only the dropped list rendered an empty token list.
    const html = render({ dropped: [], added: ["30%"], reverted: true });
    expect(html).toContain("Kept your original");
    expect(html).toContain("invented 30%");
    expect(html).not.toContain("removed");
    expect(html).not.toContain("Review before saving");
  });

  it("keeps the drift copy when the rewrite was applied", () => {
    const html = render({ dropped: [], added: ["99.9%"], reverted: false });
    expect(html).toContain("invented 99.9%");
    expect(html).toContain("Review before saving");
    expect(html).not.toContain("Kept your original");
  });

  it("defaults to the drift copy when `reverted` is omitted", () => {
    const html = render({ dropped: ["40%"], added: [] });
    expect(html).toContain("removed 40%");
  });
});

describe("ProposedSection", () => {
  function render(result: SectionRewriteResult): string {
    return renderToStaticMarkup(
      createElement(ProposedSection, {
        original: ["Original bullet 1.", "Original bullet 2."],
        result,
        onReject: () => {},
      }),
    );
  }

  it("uses success chrome when every input number survived", () => {
    const html = render({
      bullets: ["Reduced p99 latency by 40%.", "Drove $1.2M ARR."],
      numbersPreserved: true,
      reverted: false,
      droppedNumbers: [],
      addedNumbers: [],
    });
    expect(html).toContain("border-feedback-success-border");
    expect(html).toContain("bg-feedback-success-bg");
    // No warning surface when nothing changed.
    expect(html).not.toContain('role="alert"');
  });

  it("uses warning chrome AND surfaces the named token when a number was dropped", () => {
    const html = render({
      bullets: ["Reduced p99 latency."],
      numbersPreserved: false,
      reverted: false,
      droppedNumbers: ["40%"],
      addedNumbers: [],
    });
    expect(html).toContain("border-feedback-warning-border");
    expect(html).toContain("bg-feedback-warning-bg");
    expect(html).toContain("removed 40%");
    expect(html).toContain('role="alert"');
  });

  it("renders the original and proposed bullet text in the inline diff", () => {
    // The inline diff replaces the two-column "Original (N) | Proposed (N)"
    // view — both original and proposed text appear as diff spans, not column
    // headings. Verify the diff output contains the bullet text and the
    // correct diff chrome classes.
    const html = render({
      bullets: ["one", "two", "three"],
      numbersPreserved: true,
      reverted: false,
      droppedNumbers: [],
      addedNumbers: [],
    });
    // Original bullets came from ["Original bullet 1.", "Original bullet 2."].
    // At least removed-text spans (original) and added-text spans (proposed) must exist.
    expect(html).toContain("bg-feedback-error-bg");
    expect(html).toContain("bg-feedback-success-bg");
    // "two" and "three" appear as proposed (added) segments in the diff output.
    expect(html).toContain("two");
  });

  it("says the rewrite was rejected instead of showing a bare no-op diff (#778)", () => {
    // The gate returns the ORIGINAL bullets, so the diff is all-equal. Without
    // the notice the panel would read as "the model looked at your bullets and
    // changed nothing", which is a different — and false — story.
    const html = render({
      bullets: ["Original bullet 1.", "Original bullet 2."],
      numbersPreserved: true,
      reverted: true,
      droppedNumbers: ["$4.2M", "14%"],
      addedNumbers: [],
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Kept your original");
    expect(html).toContain("$4.2M and 14%");
    // The diff itself carries the caption, so the surface is never silent even
    // if the alert is scrolled past.
    expect(html).toContain("No changes applied");
    // Warning chrome, not success — the user asked for a rewrite and did not
    // get one, even though every number survived.
    expect(html).toContain("border-feedback-warning-border");
    // And no "Use this" CTA offering the user their own bullets back.
    expect(html).not.toContain("Use this — copy all bullets");
  });

  // The label swap after a successful copy moved into the shared `CopyButton`
  // with #609 — it is covered against a real stubbed clipboard in
  // `design-system/primitives/CopyButton.test.tsx`, which this static-markup
  // suite cannot do (no click, no promise). What stays this file's job is that
  // the panel still OFFERS the copy in its idle state.
  it("offers the copy-all affordance in its idle state", () => {
    const html = render({
      bullets: ["one"],
      numbersPreserved: true,
      reverted: false,
      droppedNumbers: [],
      addedNumbers: [],
    });
    expect(html).toContain("Use this — copy all bullets");
    expect(html).not.toContain("Copied");
  });
});
