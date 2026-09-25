// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * formatTriageHeadline — the summary-row headline for `TargetingSection` (#953).
 *
 * Pulled out of a nested ternary so the pluralization matrix is testable
 * without rendering a disclosure. The irregular verb is the trap: "1 bullet
 * NEEDS attention" but "2 bullets NEED attention", while the combined shape is
 * always "need" regardless of either count. A naive `+ "s"` gets the third
 * case wrong and reads fine in code review.
 *
 * The second describe block below is an anchor-resolution regression test
 * (#958), in the spirit of `AtsScoreReadout.test.tsx`'s tile-anchor test: it
 * renders `TargetingTriageRow` and asserts every href it emits is a member of
 * the typed `SECTION_IDS` contract, so a renamed/removed target id fails here
 * instead of silently going dead — the exact failure mode that shipped the
 * `#reconstructed-resume` bullet link #956 had to remove.
 *
 * Membership proves only the anchor *side*. The third block renders the
 * target side — `DocumentBody`, the wrapper `ReconstructedResume` places
 * below the row — and asserts the id actually paints, mirroring
 * `AtsScoreReadout.test.tsx`'s "scroll-target render" block for `#contact`.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { formatTriageHeadline, TargetingTriageRow } from "./TargetingTriageRow.tsx";
import { DocumentBody } from "./DocumentBody.tsx";
import { SECTION_IDS } from "../../lib/anchors.ts";
import type { GuidanceIssue, GuidanceItem } from "../../lib/score/guidance.ts";
import type { ContactDisplayField } from "../../lib/contact.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("formatTriageHeadline", () => {
  it("returns null when nothing is flagged", () => {
    expect(formatTriageHeadline(0, 0)).toBeNull();
  });

  it("uses the singular verb for exactly one bullet", () => {
    expect(formatTriageHeadline(1, 0)).toBe("1 bullet needs attention");
  });

  it("uses the plural verb for several bullets", () => {
    expect(formatTriageHeadline(4, 0)).toBe("4 bullets need attention");
  });

  it("singularizes a lone missing contact field", () => {
    expect(formatTriageHeadline(0, 1)).toBe("1 contact field missing");
  });

  it("pluralizes several missing contact fields", () => {
    expect(formatTriageHeadline(0, 3)).toBe("3 contact fields missing");
  });

  it("keeps the plural verb in the combined shape even at one of each", () => {
    expect(formatTriageHeadline(1, 1)).toBe(
      "1 bullet & 1 contact field need attention",
    );
  });

  it("pluralizes both nouns independently in the combined shape", () => {
    expect(formatTriageHeadline(2, 3)).toBe(
      "2 bullets & 3 contact fields need attention",
    );
  });
});

const METRIC: GuidanceIssue = {
  dimension: "specificity",
  check: "metric",
  title: "Missing measurable metric",
  suggestion: "Add a number.",
};
const VERB: GuidanceIssue = {
  dimension: "structure",
  check: "verb",
  title: "Weak opening verb",
  suggestion: "Start with an action verb.",
};

/** One Fix It bullet step — what the row counts since #913. */
function makeStep(issues: GuidanceIssue[] = [VERB], n = 0): GuidanceItem {
  return {
    id: `bullet-${n}`,
    dimension: issues[0]!.dimension,
    dimensions: issues.map((i) => i.dimension),
    location: `Experience → bullet ${n + 1}`,
    targetAnchor: `bullet-anchor-${n}`,
    targetType: "bullet",
    bulletId: `${n}|did stuff`,
    issues,
    summary: issues[0]!.title,
  };
}

const MISSING_PHONE: ContactDisplayField = {
  key: "phone",
  label: "Phone",
  group: "contact",
  value: "",
  gated: true,
  reason: "absent",
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(props: {
  bulletSteps: readonly GuidanceItem[];
  totalBullets: number;
  contactMissing: ContactDisplayField[];
  hasBulletGap: boolean;
  hasContactGap: boolean;
}): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(TargetingTriageRow, props));
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

/** Every hash href the rendered row links to. */
function rowAnchors(el: HTMLDivElement): string[] {
  return Array.from(el.querySelectorAll("a[href^='#']")).map(
    (a) => a.getAttribute("href") ?? "",
  );
}

describe("TargetingTriageRow anchors (#958)", () => {
  const validTargets = new Set<string>(
    Object.values(SECTION_IDS).map((id) => `#${id}`),
  );

  it("points the bullet jump link at a known scroll target", () => {
    const el = render({
      bulletSteps: [makeStep()],
      totalBullets: 1,
      contactMissing: [],
      hasBulletGap: true,
      hasContactGap: false,
    });
    const anchors = rowAnchors(el);
    expect(anchors).toHaveLength(1);
    for (const href of anchors) {
      expect(validTargets.has(href)).toBe(true);
    }
    expect(anchors).toContain(`#${SECTION_IDS.documentBody}`);
  });

  it("renders both jump links, each resolving to a known target, when both gaps are present", () => {
    const el = render({
      bulletSteps: [makeStep()],
      totalBullets: 1,
      contactMissing: [MISSING_PHONE],
      hasBulletGap: true,
      hasContactGap: true,
    });
    const anchors = rowAnchors(el);
    expect(anchors).toHaveLength(2);
    for (const href of anchors) {
      expect(validTargets.has(href)).toBe(true);
    }
    expect(anchors).toContain(`#${SECTION_IDS.documentBody}`);
    expect(anchors).toContain(`#${SECTION_IDS.contact}`);
  });

  it("does not resurrect the dead #reconstructed-resume bullet link (#956)", () => {
    const el = render({
      bulletSteps: [makeStep()],
      totalBullets: 1,
      contactMissing: [],
      hasBulletGap: true,
      hasContactGap: false,
    });
    expect(rowAnchors(el)).not.toContain(`#${SECTION_IDS.reconstructed}`);
  });
});

describe("scroll-target render (end-to-end wiring, #958)", () => {
  // ReconstructedResume is too heavy to render here, so its `DocumentBody`
  // sibling stands in for the target side: delete or misspell the wrapper's
  // id and this fails, where the membership tests above stay green.
  it("DocumentBody renders a live #resume-document-body scroll target", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(DocumentBody, null, "body"));
    });
    const target = container.querySelector(`#${SECTION_IDS.documentBody}`);
    expect(target).not.toBeNull();
    expect(target?.textContent).toBe("body");
  });
});

describe("TargetingTriageRow counts Fix It's bullet steps (#913)", () => {
  it("counts steps against the total, and tallies each check from the steps' own issues", () => {
    // Two steps out of five graded bullets. The other three are flagged by
    // `needsAttention` elsewhere (a read-only project row, a metric past the
    // budget) but carry no step, so no marker — and the row must not count
    // them either.
    const el = render({
      bulletSteps: [makeStep([METRIC, VERB], 0), makeStep([VERB], 1)],
      totalBullets: 5,
      contactMissing: [],
      hasBulletGap: true,
      hasContactGap: false,
    });
    const text = el.textContent ?? "";
    expect(text).toContain("2 of 5 bullets need attention");
    expect(text).toContain("1 missing a metric");
    expect(text).toContain("2 weak verbs");
    expect(text).not.toContain("length");
  });
});
