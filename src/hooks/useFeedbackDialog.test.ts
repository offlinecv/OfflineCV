// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * useFeedbackDialog (#900, #912) — the controller behind the feedback ask: how
 * it arrives, and how long it stays away afterwards.
 *
 * Pinned here, and the first two are the #912 behaviour changes worth stating
 * as tests rather than as prose:
 *
 *  - the export milestone raises the inline NUDGE, never the dialog. #900
 *    auto-opened a native modal, which takes keyboard focus off whatever the
 *    user was doing; only a user's own click opens the dialog now;
 *  - the ambient `[★ Feedback]` button does NOT start the cooldown. Under #900
 *    it shared one counter with the automatic trigger, so a user who opened the
 *    dialog out of curiosity permanently disabled the automatic ask;
 *  - the milestone raises nothing until the export dialog closes — a nudge
 *    shown behind a still-open `ExportDialog` (#421) is one the user never
 *    sees arrive;
 *  - the cooldown is elapsed time, not a lifetime cap: inside the window the
 *    ask is suppressed, past it the ask returns;
 *  - a returning browser carrying #900's `ocv_feedback_dialog_seen` — or the
 *    retired panel's `ocv_feedback_seen` — is asked again. Neither key is
 *    read, which is the deliberate one-time cost of loosening the cap;
 *  - `ocv_feedback_submitted` permanently suppresses the automatic ask, while
 *    the ambient trigger keeps working.
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

/** Drive a full export: the download, then the export dialog closing. */
async function exportResume(h: Harness): Promise<void> {
  await act(async () => h.api().notifyResumeExported());
  await act(async () => h.api().notifyExportClosed());
}

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.resetModules();
});

describe("useFeedbackDialog", () => {
  it("starts with nothing showing", async () => {
    const h = await mount();
    expect(h.api().open).toBe(false);
    expect(h.api().nudgeVisible).toBe(false);
  });

  it("the export milestone raises the NUDGE, not the dialog", async () => {
    // #912's central change. A native modal opening by itself takes keyboard
    // focus off whatever the user was doing; an invitation must not do that.
    const h = await mount();
    await exportResume(h);
    expect(h.api().nudgeVisible).toBe(true);
    expect(h.api().open).toBe(false);
  });

  it("an export alone raises nothing — it waits for the export dialog to close", async () => {
    const h = await mount();
    await act(async () => h.api().notifyResumeExported());
    // `ExportDialog` is still open here, showing the row that produced the
    // file (#421/#621). A nudge behind it is one the user never sees arrive.
    expect(h.api().nudgeVisible).toBe(false);

    await act(async () => h.api().notifyExportClosed());
    expect(h.api().nudgeVisible).toBe(true);
  });

  it("closing the export dialog without exporting raises nothing", async () => {
    const h = await mount();
    await act(async () => h.api().notifyExportClosed());
    expect(h.api().nudgeVisible).toBe(false);
    expect(h.api().open).toBe(false);
  });

  it("a star on the nudge opens the dialog on that rating and retires the nudge", async () => {
    const h = await mount();
    await exportResume(h);

    await act(async () => h.api().openDialog(2));
    expect(h.api().open).toBe(true);
    expect(h.api().initialRating).toBe(2);
    // Leaving it up behind the dialog would offer the same stars twice.
    expect(h.api().nudgeVisible).toBe(false);
  });

  it("dismissing the nudge opens nothing and leaves it dismissed", async () => {
    const h = await mount();
    await exportResume(h);
    await act(async () => h.api().dismissNudge());
    expect(h.api().nudgeVisible).toBe(false);
    expect(h.api().open).toBe(false);
  });

  it("the ambient trigger does NOT start the cooldown", async () => {
    // The #900 bug this replaces: `openDialog` shared one counter with the
    // automatic trigger, so looking at the dialog on purpose permanently
    // disabled being asked. Opening it yourself is not us asking you.
    const h = await mount();
    await act(async () => h.api().openDialog());
    expect(h.api().open).toBe(true);
    expect(window.localStorage.getItem("ocv_feedback_prompted_at")).toBeNull();

    await act(async () => h.api().close());
    await exportResume(h);
    expect(h.api().nudgeVisible).toBe(true);
  });

  it("records the ask when the nudge becomes visible, not when it is answered", async () => {
    // A nudge scrolled past is still an ask that was received; re-asking
    // tomorrow because it was ignored is the nagging this exists to prevent.
    const h = await mount();
    await exportResume(h);
    const at = window.localStorage.getItem("ocv_feedback_prompted_at");
    expect(at).not.toBeNull();
    expect(Number.parseInt(at!, 10)).toBeGreaterThan(0);
  });

  it("suppresses the ask inside the cooldown window", async () => {
    window.localStorage.setItem(
      "ocv_feedback_prompted_at",
      String(Date.now() - DAY_MS),
    );
    const h = await mount();
    await exportResume(h);
    expect(h.api().nudgeVisible).toBe(false);
  });

  it("asks again once the cooldown has elapsed", async () => {
    // The half that makes it a cooldown rather than a lifetime cap — without
    // this case the suppression above would pass against a permanent lock.
    window.localStorage.setItem(
      "ocv_feedback_prompted_at",
      String(Date.now() - 30 * DAY_MS),
    );
    const h = await mount();
    await exportResume(h);
    expect(h.api().nudgeVisible).toBe(true);
  });

  it("asks a browser carrying either retired key, and reads neither", async () => {
    // Every returning tester holds a value under both. Honouring them would
    // keep #900's lifetime cap alive for exactly the people #912 is for.
    window.localStorage.setItem("ocv_feedback_seen", "2");
    window.localStorage.setItem("ocv_feedback_dialog_seen", "1");
    const h = await mount();

    await exportResume(h);
    expect(h.api().nudgeVisible).toBe(true);
    expect(window.localStorage.getItem("ocv_feedback_seen")).toBe("2");
    expect(window.localStorage.getItem("ocv_feedback_dialog_seen")).toBe("1");
  });

  it("asks rather than staying silent when the stored timestamp is unreadable", async () => {
    // Fail open: a corrupt key that locked someone out of ever being asked is
    // the #912 bug arrived at by another route.
    window.localStorage.setItem("ocv_feedback_prompted_at", "not-a-number");
    const h = await mount();
    await exportResume(h);
    expect(h.api().nudgeVisible).toBe(true);
  });

  it("never asks once feedback has been submitted, but stays reachable", async () => {
    const h = await mount();
    await act(async () => h.api().markSubmitted());
    await exportResume(h);
    expect(h.api().nudgeVisible).toBe(false);

    await act(async () => h.api().openDialog());
    expect(h.api().open).toBe(true);
  });
});
