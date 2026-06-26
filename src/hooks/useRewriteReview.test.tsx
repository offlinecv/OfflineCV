// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * useRewriteReview behaviour, exercised through a probe component rendered with
 * react-dom/client (the project has no @testing-library/react — same pattern as
 * useModelSelection.integration.test.tsx). The pure decision math lives in
 * apply-accepted.ts (covered there); this file covers the hook's state
 * transitions: single accept/reject, edit-implies-accept, section/all batches,
 * and reset.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { alignBullets } from "../lib/rewrite-review/align-bullets.ts";
import { applyAcceptedBullets } from "../lib/rewrite-review/apply-accepted.ts";
import { useRewriteReview, type RewriteReview } from "./useRewriteReview.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const original = ["Built feature A here", "Old filler bullet line", "Wrote the docs"];
const proposed = ["Built and shipped feature A here", "Wrote the docs", "New bullet"];
const pairs = alignBullets(original, proposed);

let container: HTMLDivElement;
let root: Root;
let api: RewriteReview;

function Probe() {
  api = useRewriteReview(pairs);
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useRewriteReview", () => {
  it("starts with no decisions and zero accepted", () => {
    expect(api.acceptedCount).toBe(0);
    expect(applyAcceptedBullets(pairs, api.decisions, api.edits)).toEqual(original);
  });

  it("accept then reject a single pair flips its decision", () => {
    const id = pairs[0]!.id;
    act(() => api.accept(id));
    expect(api.decisionOf(id)).toBe("accepted");
    expect(api.acceptedCount).toBe(1);
    act(() => api.reject(id));
    expect(api.decisionOf(id)).toBe("rejected");
    expect(api.acceptedCount).toBe(0);
  });

  it("toggle alternates a pair between accepted and rejected", () => {
    const id = pairs[0]!.id;
    act(() => api.toggle(id));
    expect(api.decisionOf(id)).toBe("accepted");
    act(() => api.toggle(id));
    expect(api.decisionOf(id)).toBe("rejected");
  });

  it("editing a bullet auto-accepts it and feeds Apply the edited text", () => {
    const matched = pairs.find((p) => p.kind === "matched")!;
    act(() => api.setEdit(matched.id, "Edited replacement text"));
    expect(api.decisionOf(matched.id)).toBe("accepted");
    const out = applyAcceptedBullets(pairs, api.decisions, api.edits);
    expect(out).toContain("Edited replacement text");
  });

  it("clearing an edit (empty string) drops it but leaves the pair accepted", () => {
    const matched = pairs.find((p) => p.kind === "matched")!;
    act(() => api.setEdit(matched.id, "temp"));
    act(() => api.setEdit(matched.id, ""));
    expect(api.edits.has(matched.id)).toBe(false);
    expect(api.decisionOf(matched.id)).toBe("accepted");
  });

  it("acceptAll then rejectAll move every pair together", () => {
    act(() => api.acceptAll());
    expect(api.acceptedCount).toBe(pairs.length);
    act(() => api.rejectAll());
    expect(api.acceptedCount).toBe(0);
  });

  it("acceptMany accepts only the listed ids", () => {
    const ids = [pairs[0]!.id, pairs[1]!.id];
    act(() => api.acceptMany(ids));
    expect(api.acceptedCount).toBe(2);
  });

  it("reset clears decisions and edits", () => {
    act(() => api.acceptAll());
    act(() => api.setEdit(pairs[0]!.id, "x"));
    act(() => api.reset());
    expect(api.acceptedCount).toBe(0);
    expect(api.edits.size).toBe(0);
  });
});
