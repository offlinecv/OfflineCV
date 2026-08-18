// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * SemanticMatch (#204) — the on-device verdict view.
 *
 * jsdom rather than `renderToStaticMarkup` because the two things most worth
 * pinning are structural, not textual: the ORDER the three status groups
 * appear in, and whether the evidence disclosure is a real, focusable,
 * keyboard-operable control. Both are DOM queries.
 */

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SemanticMatch } from "./SemanticMatch.tsx";
import type { SemanticJdMatchResult } from "../../lib/jd-match";
import type { RequirementVerdict } from "../../lib/jd-match/llm/judge-evidence.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function verdict(
  id: string,
  text: string,
  status: RequirementVerdict["status"],
  reason: string,
  evidence?: string,
): RequirementVerdict {
  const base: RequirementVerdict = {
    requirement: { id, kind: "skill", text },
    status,
    reason,
  };
  return evidence === undefined ? base : { ...base, evidence };
}

/** Wrap verdicts in the semantic arm, tallying the summary the way
 *  `runLlmMatch` does so the header's numbers are the real ones. */
function semantic(verdicts: readonly RequirementVerdict[]): SemanticJdMatchResult {
  let met = 0;
  let partial = 0;
  let missing = 0;
  for (const v of verdicts) {
    if (v.status === "met") met += 1;
    else if (v.status === "partial") partial += 1;
    else missing += 1;
  }
  return {
    path: "semantic",
    verdicts,
    summary: { met, partial, missing, total: verdicts.length },
  };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(result: SemanticJdMatchResult): HTMLDivElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  container = el;
  root = createRoot(el);
  act(() => {
    root?.render(<SemanticMatch result={result} />);
  });
  return el;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

/** Group headings, in DOM order. */
function headings(el: HTMLElement): string[] {
  return [...el.querySelectorAll("h3")].map((h) => h.textContent ?? "");
}

/** Row texts, in DOM order across every group. */
function rows(el: HTMLElement): string[] {
  return [...el.querySelectorAll("li")].map((li) => li.textContent ?? "");
}

const MIXED = semantic([
  // Deliberately NOT in met/partial/missing order — the view must regroup.
  verdict(
    "req-1",
    "Own an on-call rotation",
    "missing",
    "No on-call duty appears anywhere in the résumé.",
  ),
  verdict(
    "req-2",
    "Five years of Go",
    "partial",
    "Two years of Go at Acme, short of five.",
    "Backend services in Go, 2023–2025",
  ),
  verdict(
    "req-3",
    "Run Kubernetes in production",
    "met",
    "Ran production clusters at Acme.",
    "Operated a 40-node Kubernetes cluster",
  ),
  verdict(
    "req-4",
    "Terraform at scale",
    "met",
    "Managed the estate's Terraform modules.",
  ),
]);

describe("SemanticMatch grouping", () => {
  it("groups verdicts Met → Partial → Missing regardless of input order", () => {
    const el = render(MIXED);
    expect(headings(el)).toEqual(["Met (2)", "Partial (1)", "Missing (1)"]);
    // Row order follows the groups, and within a group the model's order.
    expect(
      rows(el).map((text) => text.replace(/^(Met|Partial|Missing)/, "$1|")),
    ).toEqual([
      expect.stringMatching(/^Met\|Run Kubernetes in production/),
      expect.stringMatching(/^Met\|Terraform at scale/),
      expect.stringMatching(/^Partial\|Five years of Go/),
      expect.stringMatching(/^Missing\|Own an on-call rotation/),
    ]);
  });

  it("omits a status group entirely when nothing has that status", () => {
    const el = render(
      semantic([
        verdict("req-1", "Ship React", "met", "Five years of React."),
        verdict("req-2", "Ship TypeScript", "met", "TypeScript throughout."),
      ]),
    );
    expect(headings(el)).toEqual(["Met (2)"]);
    expect(el.textContent).not.toContain("Partial (");
    expect(el.textContent).not.toContain("Missing (");
  });

  it("renders a partial-only result on its own", () => {
    const el = render(
      semantic([
        verdict("req-1", "Lead a team", "partial", "Mentored two juniors."),
      ]),
    );
    expect(headings(el)).toEqual(["Partial (1)"]);
  });

  it("renders a missing-only result on its own", () => {
    const el = render(
      semantic([verdict("req-1", "Hold a PhD", "missing", "No doctorate listed.")]),
    );
    expect(headings(el)).toEqual(["Missing (1)"]);
  });
});

describe("SemanticMatch row content", () => {
  it("renders the requirement text and the full reason for every row", () => {
    const text = render(MIXED).textContent ?? "";
    expect(text).toContain("Run Kubernetes in production");
    expect(text).toContain("Ran production clusters at Acme.");
    expect(text).toContain("Two years of Go at Acme, short of five.");
    expect(text).toContain("No on-call duty appears anywhere in the résumé.");
  });

  it("states each row's status in TEXT, not only in colour", () => {
    // A row read out of its heading's context — screen-reader row navigation,
    // a long group scrolled past its heading — is still self-describing.
    const rowTexts = rows(render(MIXED));
    expect(rowTexts[0].startsWith("Met")).toBe(true);
    expect(rowTexts[2].startsWith("Partial")).toBe(true);
    expect(rowTexts[3].startsWith("Missing")).toBe(true);
  });

  it("keeps every status badge visible against its own row (#866 review)", () => {
    // The defect this pins: `neutral` filled with `bg-surface-subtle`, which is
    // ALSO the `<li>`'s fill, so the "Missing" pill had no boundary and
    // rendered as bare text while "Met"/"Partial" rendered as pills. That
    // silently dropped the shape channel for the one status most worth
    // flagging, contradicting the component's "never by colour alone" claim.
    //
    // Asserted as the INVARIANT rather than as a literal class string: a badge
    // whose fill matches its row's fill must carry a border, whichever tone it
    // is and whatever the tokens are renamed to later.
    const el = render(MIXED);
    const rows = [...el.querySelectorAll("li")];
    expect(rows.length).toBeGreaterThan(0);

    const fill = (cls: string): string | undefined =>
      cls.split(/\s+/).find((c) => c.startsWith("bg-"));
    const hasBorder = (cls: string): boolean =>
      cls.split(/\s+/).some((c) => c === "border" || c.startsWith("border-"));

    for (const row of rows) {
      const badge = row.querySelector("span[class*='rounded-full']");
      expect(badge).toBeTruthy();
      const badgeCls = badge?.className ?? "";
      if (fill(badgeCls) === fill(row.className)) {
        expect(
          hasBorder(badgeCls),
          `badge "${badge?.textContent}" shares its row's ${fill(row.className)} fill, so it needs a border to stay visible`,
        ).toBe(true);
      }
    }
  });

  it("gives the Missing badge a boundary that does not read as a warning", () => {
    const el = render(MIXED);
    const missingRow = [...el.querySelectorAll("li")].find((li) =>
      li.textContent?.startsWith("Missing"),
    );
    const badge = missingRow?.querySelector("span[class*='rounded-full']");
    const cls = badge?.className ?? "";
    // Visible: it carries a border.
    expect(cls).toMatch(/\bborder\b/);
    // …and still neutral — no feedback/warning/error colouring, so an unmet
    // requirement is not framed as a fault.
    expect(cls).not.toMatch(/feedback-(warning|error)/);
    // The word survives regardless of any of the above.
    expect(badge?.textContent).toBe("Missing");
  });

  it("shows the headline tally from the pre-computed summary", () => {
    const text = render(MIXED).textContent ?? "";
    expect(text).toContain("2 met · 1 partial · 1 missing");
    expect(text).toContain("Across 4 requirements");
  });

  it("singularises the requirement count for a one-verdict result", () => {
    const el = render(
      semantic([verdict("req-1", "Ship React", "met", "Five years of React.")]),
    );
    expect(el.textContent).toContain("Across 1 requirement the");
  });
});

describe("SemanticMatch evidence disclosure", () => {
  it("renders a collapsed, keyboard-operable disclosure only where evidence exists", () => {
    const el = render(MIXED);
    const details = [...el.querySelectorAll("details")];
    // Two of the four verdicts carry evidence.
    expect(details).toHaveLength(2);
    for (const d of details) {
      // Collapsed by default — the snippet is opt-in detail, not row noise.
      expect(d.open).toBe(false);
      // `<summary>` is natively focusable and Enter/Space-activatable, which
      // is what makes this keyboard-reachable with no raw <button> and no JS
      // toggle state, and what keeps the open/closed state off hover.
      expect(d.querySelector("summary")).toBeTruthy();
    }
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });

  it("gives each disclosure an accessible name qualified by its requirement", () => {
    const names = [...render(MIXED).querySelectorAll("summary")].map(
      (s) => s.textContent ?? "",
    );
    expect(names).toEqual([
      "Evidence for: Run Kubernetes in production",
      "Evidence for: Five years of Go",
    ]);
    // Distinct, so a screen reader's control list doesn't read "Evidence"
    // N times with nothing to tell them apart.
    expect(new Set(names).size).toBe(names.length);
  });

  it("renders the evidence snippet verbatim inside the disclosure", () => {
    const quotes = [...render(MIXED).querySelectorAll("blockquote")].map(
      (b) => b.textContent ?? "",
    );
    expect(quotes).toEqual([
      "Operated a 40-node Kubernetes cluster",
      "Backend services in Go, 2023–2025",
    ]);
  });

  it("renders no disclosure at all for a verdict without evidence", () => {
    const el = render(
      semantic([
        verdict("req-1", "Terraform at scale", "met", "Managed the modules."),
      ]),
    );
    expect(el.querySelectorAll("details")).toHaveLength(0);
    expect(el.textContent).not.toContain("Evidence");
  });
});

describe("SemanticMatch headings and privacy copy", () => {
  it("keeps the shipped diagnostic + in-tab sentences and drops the keyword one", () => {
    const text = render(MIXED).textContent ?? "";
    expect(text).toContain("Diagnostic, not a verdict.");
    expect(text).toContain("Your JD text stays in this browser tab.");
    // The keyword matcher's self-description is false of this arm.
    expect(text).not.toContain("we don't read context");
  });

  it("nests the group headings under the panel heading", () => {
    const el = render(MIXED);
    expect(el.querySelector("h2")?.textContent).toBe("JD match");
    expect(el.querySelectorAll("h3")).toHaveLength(3);
  });
});
