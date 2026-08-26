// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * StandardLetterButton (#767) — the panel-level entry point to the standard
 * letter.
 *
 * One property carries this file: opening from here must write a letter with
 * NEITHER scope key. A `jobId` leaking in would file the user's standard
 * letter under whichever job happened to be nearby, and it would then vanish
 * from every other job's resolution chain — a silent loss of the letter the
 * whole tier exists for.
 *
 * `saveLetter` is mocked rather than driven through a fake IndexedDB, the same
 * call `LetterEditorDialog.test.tsx` makes: what is under test is the shape of
 * the write, not the store's ability to hold it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import {
  clickButtonIn,
  installDialogPolyfill,
  setupDomRoot,
  typeIntoTextArea,
} from "./__test-utils__/dialog-dom.ts";
import type { LetterRecord } from "../../lib/storage/index.ts";

const saveLetter = vi.hoisted(() => vi.fn());
vi.mock("../../lib/storage/index.ts", () => ({ saveLetter }));

const { StandardLetterButton } = await import("./StandardLetterButton.tsx");

installDialogPolyfill();
const dom = setupDomRoot();

beforeEach(() => {
  saveLetter.mockReset();
  saveLetter.mockResolvedValue(undefined);
});

const click = (text: string) => clickButtonIn(dom.container, text);
const typeBody = (text: string) => typeIntoTextArea(dom.container, text);

const existing: LetterRecord = {
  id: "standard-1",
  createdAt: 1,
  updatedAt: 2,
  body: "My standard letter.",
};

describe("StandardLetterButton (#767)", () => {
  it("names the state, so the user knows whether they have one", () => {
    dom.render(<StandardLetterButton />);
    expect(click("Write a standard letter")).toBeTruthy();

    dom.render(<StandardLetterButton letter={existing} />);
    expect(click("Edit standard letter")).toBeTruthy();
  });

  it("saves a letter with NEITHER scope key", async () => {
    dom.render(<StandardLetterButton />);
    click("Write a standard letter");
    typeBody("My story.");
    click("Save letter");
    await act(async () => {});

    const [input] = saveLetter.mock.calls[0]!;
    expect("jobId" in input).toBe(false);
    expect("companyKey" in input).toBe(false);
    expect(input.body).toBe("My story.");
  });

  it("edits the existing record in place rather than adding a second one", async () => {
    dom.render(<StandardLetterButton letter={existing} />);
    click("Edit standard letter");
    // Opened on the stored text, not blank.
    expect(dom.container.querySelector("textarea")!.value).toBe(
      "My standard letter.",
    );

    typeBody("Revised.");
    click("Save letter");
    await act(async () => {});

    const [input] = saveLetter.mock.calls[0]!;
    // The SAME id — `saveLetter` upserts, so this replaces the body. A new id
    // here would leave two standard letters and make which one applies a
    // matter of `updatedAt` luck.
    expect(input.id).toBe("standard-1");
    expect("jobId" in input).toBe(false);
  });

  it("re-reads the store after a write, so rows pick up the new letter", async () => {
    const onSaved = vi.fn();
    dom.render(<StandardLetterButton onSaved={onSaved} />);
    click("Write a standard letter");
    typeBody("My story.");
    click("Save letter");
    await act(async () => {});

    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
