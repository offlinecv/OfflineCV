// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Visual-hierarchy guard for the drop zone.
 *
 * In user testing (Jul 2026) first-time visitors could not find the primary
 * action on the pre-drop screen — "everything is the same color, it's kind of
 * hard to find what am I supposed to do here". The cause was measurable, not
 * subjective: the drop zone rendered on the default neutral surface with a
 * `border-border` dashed edge and a `text-sm` prompt, while the hero directly
 * above it owned the page's only tinted surface (`bg-surface-card-warm`) and a
 * `text-3xl` headline. The block you cannot act on out-ranked the one you must.
 *
 * These assertions pin the inversion, because it is exactly the kind of change
 * a later "tone this down" edit reverts silently — nothing else in the suite
 * would go red. They deliberately assert the RELATIVE treatment (accent surface
 * present, prompt above body size), not specific token values, so a palette
 * change is still free.
 *
 * `renderToStaticMarkup` is enough here — no DOM, no interaction. Drag/drop and
 * file-accept behaviour are covered by `lib/file-accept.test.ts` and
 * `useReplaceResumeOnDrop.test.tsx`.
 */

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DropZone } from "./DropZone.tsx";

const html = () => renderToStaticMarkup(<DropZone onFile={() => {}} />);

describe("DropZone visual hierarchy", () => {
  it("renders on an accent surface, not the neutral page background", () => {
    const markup = html();
    expect(markup).toContain("bg-accent-forward-bg");
    expect(markup).toContain("border-accent-primary");
    // The pre-fix neutral edge is what made it recede — it must not come back.
    expect(markup).not.toContain("border-border ");
  });

  it("gives the prompt a size step above body copy", () => {
    const markup = html();
    // The prompt outranks the supporting lines, which stay at text-sm.
    expect(markup).toContain("text-lg font-semibold");
    expect(markup).toContain("Drop your resume here");
  });

  it("keeps the file-custody line attached to the action", () => {
    // The privacy claim qualifies THIS control; it is not decoration that can
    // be relocated to a footer without losing its referent.
    expect(html()).toContain("Your file stays in this browser tab.");
  });

  it("still states the accepted formats and the click affordance", () => {
    const markup = html();
    expect(markup).toContain("PDF or DOCX");
    expect(markup).toContain("click to pick a file");
  });

  it("marks drag state with a border style change, not colour alone", () => {
    // At rest the border is already accent-coloured, so a colour-only drag
    // state would be invisible in greyscale. Dashed → solid carries it.
    expect(html()).toContain("border-dashed");
  });
});
