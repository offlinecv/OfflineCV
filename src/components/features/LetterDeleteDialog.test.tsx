// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * LetterDeleteDialog (#978) — the confirm in front of `deleteLetter`.
 *
 * Two properties carry this file, and both are about a write that cannot be
 * undone in the app:
 *
 *  - nothing is deleted until the user confirms, so mounting the dialog, or
 *    dismissing it, must leave the store untouched;
 *  - a failed delete must SAY so and keep the dialog open. Closing on a write
 *    that did not happen would tell the user their letter is gone while it is
 *    still there — the inverse of the silent loss this issue is about.
 *
 * `deleteLetter` is mocked rather than driven through a fake IndexedDB, the
 * same call `LetterEditorDialog.test.tsx` makes for `saveLetter`: what is under
 * test is when the store is asked, not its ability to answer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import {
  clickButtonIn,
  installDialogPolyfill,
  setupDomRoot,
} from "./__test-utils__/dialog-dom.ts";
import type { LetterRecord } from "../../lib/storage/index.ts";

const deleteLetter = vi.hoisted(() => vi.fn());
vi.mock("../../lib/storage/index.ts", () => ({ deleteLetter }));

const { LetterDeleteDialog } = await import("./LetterDeleteDialog.tsx");

installDialogPolyfill();
const dom = setupDomRoot();

beforeEach(() => {
  deleteLetter.mockReset();
  deleteLetter.mockResolvedValue(true);
});

const click = (text: string) => clickButtonIn(dom.container, text);

const letter: LetterRecord = {
  id: "letter-1",
  createdAt: 1,
  updatedAt: 2,
  body: "Dear hiring team,",
  label: "Second standard",
};

function render(
  props: Partial<Parameters<typeof LetterDeleteDialog>[0]> = {},
): { onDeleted: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
  const onDeleted = vi.fn();
  const onClose = vi.fn();
  dom.render(
    <LetterDeleteDialog
      open
      onClose={onClose}
      letter={letter}
      consequence="Every job without a letter of its own stops inheriting it."
      onDeleted={onDeleted}
      {...props}
    />,
  );
  return { onDeleted, onClose };
}

describe("LetterDeleteDialog (#978)", () => {
  it("names the letter and who else loses it, and deletes nothing on mount", () => {
    render();
    const text = dom.openDialogText() ?? "";
    expect(text).toContain("Second standard");
    expect(text).toContain("stops inheriting it");
    expect(deleteLetter).not.toHaveBeenCalled();
  });

  it("renders nothing without a letter, so a caller may mount it before a selection exists", () => {
    render({ letter: undefined });
    expect(dom.openDialogText()).toBeNull();
  });

  it("deletes, refreshes, then closes — in that order", async () => {
    const order: string[] = [];
    deleteLetter.mockImplementation(async () => {
      order.push("delete");
      return true;
    });
    const onDeleted = vi.fn(() => {
      order.push("refresh");
    });
    const onClose = vi.fn(() => {
      order.push("close");
    });
    dom.render(
      <LetterDeleteDialog
        open
        onClose={onClose}
        letter={letter}
        consequence="No other job is affected."
        onDeleted={onDeleted}
      />,
    );

    click("Delete letter");
    // The write, the refresh and the close all resolve out of band; one
    // `act` flush drains them, which is the recipe every sibling dialog suite
    // uses rather than polling.
    await act(async () => {});

    expect(onClose).toHaveBeenCalled();
    expect(deleteLetter).toHaveBeenCalledWith("letter-1");
    // The refresh must land before the close: the surface behind this dialog
    // repaints on close, and a close-first order repaints it still holding the
    // record that was just removed.
    expect(order).toEqual(["delete", "refresh", "close"]);
  });

  it("deletes nothing when the user keeps it", () => {
    const { onClose, onDeleted } = render();
    click("Keep it");
    expect(deleteLetter).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("says so and stays open when the store refuses the write", async () => {
    deleteLetter.mockRejectedValue(new Error("blocked"));
    const { onClose, onDeleted } = render();

    click("Delete letter");
    await act(async () => {});

    expect(dom.openDialogText() ?? "").toContain("Couldn’t delete it");
    expect(dom.openDialogText() ?? "").toContain("Nothing was removed.");
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes without claiming a failure when the delete lands but the refresh fails", async () => {
    // The record IS tombstoned; only the caller's re-read failed. "Nothing was
    // removed" would be false about the user's data.
    const onClose = vi.fn();
    render({ onClose, onDeleted: vi.fn().mockRejectedValue(new Error("read")) });

    click("Delete letter");
    await act(async () => {});

    expect(deleteLetter).toHaveBeenCalledTimes(1);
    expect(dom.openDialogText() ?? "").not.toContain("Nothing was removed.");
    expect(onClose).toHaveBeenCalled();
  });

  it("treats a second delete of an already-gone record as done, not as a failure", async () => {
    // `deleteLetter` answers false when there was no live record to tombstone.
    // The user's intent is satisfied either way, so this must close cleanly —
    // reporting a failure here would flag the one outcome indistinguishable
    // from success.
    deleteLetter.mockResolvedValue(false);
    const { onClose, onDeleted } = render();

    click("Delete letter");
    await act(async () => {});

    expect(onClose).toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalled();
    expect(dom.openDialogText() ?? "").not.toContain("Couldn’t delete it");
  });
});
