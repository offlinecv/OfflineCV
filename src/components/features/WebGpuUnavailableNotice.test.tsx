// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The notice's opener and dialog title per capability (#1019). The two
 * browser-side states offer a way to turn on-device AI on; a GPU without
 * `shader-f16` has no setting we know of, so its opener and title must not
 * promise one — the guidance inside says as much.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/analytics.ts", () => ({
  trackWebllmNoticeShown: vi.fn(),
}));

import { WebGpuUnavailableNotice } from "./WebGpuUnavailableNotice.tsx";
import {
  clickButtonIn,
  installDialogPolyfill,
  setupDomRoot,
} from "./__test-utils__/dialog-dom.ts";

installDialogPolyfill();
const dom = setupDomRoot();

/** Click the opener named `cta`, then read the open dialog's heading. */
function openDialogTitle(cta: string): string | null {
  expect(clickButtonIn(dom.container, cta)).toBeDefined();
  const dialog = dom.container.querySelector("dialog[open]");
  return dialog?.querySelector("h1, h2, h3")?.textContent ?? null;
}

describe("WebGpuUnavailableNotice — opener and title per capability (#1019)", () => {
  it("offers to turn it on when the browser is the blocker", () => {
    dom.render(<WebGpuUnavailableNotice capability="no-webgpu" />);
    expect(openDialogTitle("How to turn this on →")).toBe(
      "Enable on-device AI rewrite",
    );
    expect(dom.openDialogText()).toContain("Using a different browser?");
  });

  it("promises no setting when the GPU lacks shader-f16", () => {
    dom.render(<WebGpuUnavailableNotice capability="no-shader-f16" />);
    expect(openDialogTitle("What this means →")).toBe(
      "Why on-device AI is off",
    );
    // A browser switch cannot supply a GPU feature.
    expect(dom.openDialogText()).not.toContain("Using a different browser?");
  });
});
