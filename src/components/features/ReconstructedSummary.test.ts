// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Display contract for the Summary section (#625).
 *
 * Read mode is static (no client-only effects run before `editing` is true), so
 * these render through `renderToStaticMarkup` in the repo's default Node env —
 * matching `EditableField.test.tsx`. What is asserted here is what the user can
 * SEE and reach: the section is present at all (it wasn't before #625), it
 * carries the résumé's own heading, and an absent summary offers an
 * add-affordance rather than an empty block.
 *
 * The write side (`summaryRewriteApply`, and the one-slot invariant it shares
 * with the inline field) is exercised against the real hook in
 * `useEditableParse.test.tsx`; the export side in
 * `pdf/render-roundtrip-summary-edit.repro.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SummarySection } from "./ReconstructedSummary.tsx";

function render(props: Parameters<typeof SummarySection>[0]): string {
  return renderToStaticMarkup(createElement(SummarySection, props));
}

describe("SummarySection (issue 625)", () => {
  it("renders the parsed summary text under a default heading", () => {
    const html = render({
      summary: "Platform engineer with a decade of experience.",
      onSummaryChange: () => {},
    });
    expect(html).toContain("Platform engineer with a decade of experience.");
    expect(html).toContain(">Summary<");
    // The value itself is the edit affordance (no pencil, no separate control).
    expect(html).toContain('aria-label="Edit Summary"');
  });

  // #285: the exporter draws the résumé's own heading, so the preview must too
  // — otherwise the preview is not the artifact.
  it("honours the verbatim source heading when the résumé has one", () => {
    const html = render({
      heading: "Professional Profile",
      summary: "Platform engineer with a decade of experience.",
      onSummaryChange: () => {},
    });
    expect(html).toContain(">Professional Profile<");
    expect(html).not.toContain(">Summary<");
  });

  // AC5: a résumé the parser found no summary for shows an add-affordance, not
  // an empty block — the same "+ <noun>" treatment every other empty field gets.
  it("offers an add-affordance when there is no parsed summary", () => {
    const html = render({ summary: undefined, onSummaryChange: () => {} });
    expect(html).toContain('<span aria-hidden="true">+ </span>summary');
    expect(html).toContain('aria-label="Add Summary"');
    // The heading still renders: this is the EDITOR, where the point is that
    // the empty slot is reachable. Dropping the heading is an EXPORT rule.
    expect(html).toContain(">Summary<");
  });

  it("shows the add-affordance again once the summary is cleared", () => {
    const html = render({ summary: "", onSummaryChange: () => {} });
    expect(html).toContain('aria-label="Add Summary"');
  });
});
