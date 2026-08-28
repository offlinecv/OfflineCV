// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * useFeedbackDialog (#900) — the controller behind `FeedbackDialog`'s two
 * trigger paths and the localStorage capping between them.
 *
 * Pinned here:
 *  - the ambient trigger opens the dialog and increments
 *    `ocv_feedback_dialog_seen` exactly once per open;
 *  - the export milestone opens NOTHING until the export dialog closes — two
 *    native modals must never be open at once (`ExportDialog` stays open after
 *    a download by design, #421);
 *  - the automatic trigger fires the first time, then never again in the same
 *    session — the #900 "opens once" contract;
 *  - a returning browser carrying the retired panel's `ocv_feedback_seen`
 *    still gets the automatic trigger: this hook does not read that key, and
 *    every existing tester already has a non-zero value under it;
 *  - once the ambient button has shown the dialog, a LATER export no longer
 *    auto-opens it (snoozed, not re-nagged);
 *  - `ocv_feedback_submitted` permanently suppresses the automatic trigger,
 *    while the ambient trigger keeps working.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FeedbackDialogController } from "./useFeedbackDialog.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

interface Harness {
  api: () => FeedbackDialogController;
}

async function mount(): Promise<Harness> {
  vi.resetModules();
  const { useFeedbackDialog } = await import("./useFeedbackDialog.ts");

  let current: FeedbackDialogController | undefined;
  function Probe() {
    current = useFeedbackDialog();
    return null;
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Probe));
  });

  return { api: () => current! };
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.resetModules();
});

describe("useFeedbackDialog", () => {
  it("starts closed", async () => {
    const h = await mount();
    expect(h.api().open).toBe(false);
  });

  it("the ambient trigger opens the dialog and increments the seen counter", async () => {
    const h = await mount();
    await act(async () => h.api().openDialog());
    expect(h.api().open).toBe(true);
    expect(window.localStorage.getItem("ocv_feedback_dialog_seen")).toBe("1");
  });

  it("an export alone opens nothing — the dialog waits for the export dialog to close", async () => {
    const h = await mount();
    await act(async () => h.api().notifyResumeExported());
    // `ExportDialog` is still open here, showing the row that produced the
    // file (#421/#621). A second native modal on top of it would bury that.
    expect(h.api().open).toBe(false);

    await act(async () => h.api().notifyExportClosed());
    expect(h.api().open).toBe(true);
  });

  it("closing the export dialog without exporting opens nothing", async () => {
    const h = await mount();
    await act(async () => h.api().notifyExportClosed());
    expect(h.api().open).toBe(false);
  });

  it("still auto-triggers for a browser carrying the retired panel's ocv_feedback_seen", async () => {
    // A returning tester: the retired `FeedbackPanel` bumped `ocv_feedback_seen`
    // on every mount of the results page, so a value >= 2 is exactly what the
    // people #900 is for already have. Reusing that key would leave the
    // milestone trigger permanently dead for them.
    window.localStorage.setItem("ocv_feedback_seen", "2");
    const h = await mount();

    await act(async () => h.api().notifyResumeExported());
    await act(async () => h.api().notifyExportClosed());
    expect(h.api().open).toBe(true);
    // And the untouched legacy key is neither read nor migrated.
    expect(window.localStorage.getItem("ocv_feedback_seen")).toBe("2");
    expect(window.localStorage.getItem("ocv_feedback_dialog_seen")).toBe("1");
  });

  it("does not auto-reopen after the dialog has already been shown once", async () => {
    const h = await mount();
    await act(async () => h.api().openDialog());
    await act(async () => h.api().close());
    expect(h.api().open).toBe(false);

    await act(async () => h.api().notifyResumeExported());
    await act(async () => h.api().notifyExportClosed());
    // Snoozed: the automatic trigger never got its own "first open".
    expect(h.api().open).toBe(false);
  });

  it("never auto-opens once feedback has been submitted", async () => {
    const h = await mount();
    await act(async () => h.api().markSubmitted());
    await act(async () => h.api().notifyResumeExported());
    await act(async () => h.api().notifyExportClosed());
    expect(h.api().open).toBe(false);
    // The ambient trigger still works for a submitted user who reopens it.
    await act(async () => h.api().openDialog());
    expect(h.api().open).toBe(true);
  });
});
