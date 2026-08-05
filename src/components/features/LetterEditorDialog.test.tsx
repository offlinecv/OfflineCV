// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * LetterEditorDialog — the in-app author/revise surface for one cover letter.
 *
 * The assertions here are about what reaches `saveLetter`, because that is
 * where this component can do lasting damage to a record it did not create:
 *
 *  - It must NOT write a `producer` block. An absent block is how
 *    `docs/cover-letter-contract.md` §6 says "offlinecv wrote this", and it is
 *    what `JobLetterIndicator` reads to decide whether to warn about egress. A
 *    synthesized block would make the app claim a letter left the device.
 *  - Editing an existing letter must carry its `id` through, or every save
 *    would mint a new draft and the user's edit would read as a duplicate.
 *  - A blank body must not be writable at all: `saveLetter` accepts `""`, and
 *    a blank record renders as "Empty draft." — a row claiming a letter that
 *    shows nothing.
 *
 * `saveLetter` is mocked rather than driven through a fake IndexedDB: what is
 * under test is the ARGUMENT this component builds, and a real store would
 * assert the storage layer's behaviour instead.
 *
 * jsdom lacks `HTMLDialogElement.showModal`/`close`; the polyfill and per-test
 * root come from `__test-utils__/dialog-dom.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { installDialogPolyfill, setupDomRoot } from "./__test-utils__/dialog-dom.ts";
import type { LetterRecord } from "../../lib/storage/index.ts";

const saveLetter = vi.hoisted(() => vi.fn());
vi.mock("../../lib/storage/index.ts", () => ({ saveLetter }));

const { LetterEditorDialog } = await import("./LetterEditorDialog.tsx");

installDialogPolyfill();
const dom = setupDomRoot();

beforeEach(() => {
  saveLetter.mockReset();
  saveLetter.mockResolvedValue(undefined);
});

function findButton(text: string) {
  return [...dom.container.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
}

function click(text: string) {
  const button = findButton(text);
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  return button;
}

/** Type into the body textarea the way React's controlled input requires — a
 *  bare `.value =` assignment is swallowed by React's value tracker. */
function typeBody(text: string) {
  const area = dom.container.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function existing(over: Partial<LetterRecord> = {}): LetterRecord {
  return {
    id: "letter-1",
    jobId: "job-1",
    createdAt: 1,
    updatedAt: 2,
    body: "Original body.",
    producer: { contract: 1, producer: "some-outside-producer" },
    ...over,
  };
}

describe("LetterEditorDialog", () => {
  it("refuses to save a blank draft", () => {
    dom.render(
      <LetterEditorDialog open onClose={() => {}} jobId="job-1" onSaved={() => {}} />,
    );
    expect(findButton("Save letter")?.disabled).toBe(true);
    click("Save letter");
    expect(saveLetter).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only draft as blank", () => {
    dom.render(
      <LetterEditorDialog open onClose={() => {}} jobId="job-1" onSaved={() => {}} />,
    );
    typeBody("   \n  ");
    expect(findButton("Save letter")?.disabled).toBe(true);
  });

  it("writes a new letter with no producer block", async () => {
    dom.render(
      <LetterEditorDialog open onClose={() => {}} jobId="job-9" onSaved={() => {}} />,
    );
    typeBody("Dear hiring team,");
    click("Save letter");
    await act(async () => {});

    expect(saveLetter).toHaveBeenCalledTimes(1);
    const [input] = saveLetter.mock.calls[0]!;
    expect(input).toEqual({ jobId: "job-9", body: "Dear hiring team," });
    expect(input).not.toHaveProperty("producer");
    expect(input).not.toHaveProperty("id");
  });

  it("carries the id through when revising, and never names the producer", async () => {
    dom.render(
      <LetterEditorDialog
        open
        onClose={() => {}}
        jobId="job-1"
        letter={existing()}
        onSaved={() => {}}
      />,
    );
    typeBody("Revised body.");
    click("Save letter");
    await act(async () => {});

    const [input] = saveLetter.mock.calls[0]!;
    expect(input.id).toBe("letter-1");
    expect(input.body).toBe("Revised body.");
    // `saveLetter` spreads the input over the stored record, so an untouched
    // key survives. Naming `producer` here — even with the record's own value —
    // would make this component an author of provenance it did not create.
    expect(input).not.toHaveProperty("producer");
  });

  it("seeds from the record it was opened with", () => {
    dom.render(
      <LetterEditorDialog
        open
        onClose={() => {}}
        jobId="job-1"
        letter={existing()}
        onSaved={() => {}}
      />,
    );
    expect(dom.container.querySelector("textarea")?.value).toBe("Original body.");
  });

  it("keeps the text on screen when the write fails", async () => {
    saveLetter.mockRejectedValue(new Error("quota"));
    const onClose = vi.fn();
    dom.render(
      <LetterEditorDialog open onClose={onClose} jobId="job-1" onSaved={() => {}} />,
    );
    typeBody("Dear hiring team,");
    click("Save letter");
    await act(async () => {});

    expect(onClose).not.toHaveBeenCalled();
    expect(dom.container.querySelector("textarea")?.value).toBe("Dear hiring team,");
    expect(dom.openDialogText()).toContain("Couldn’t save");
  });

  it("refreshes the caller BEFORE closing, so the row never flashes the old state", async () => {
    const order: string[] = [];
    const onSaved = vi.fn(async () => {
      order.push("saved");
    });
    const onClose = vi.fn(() => {
      order.push("closed");
    });
    dom.render(
      <LetterEditorDialog open onClose={onClose} jobId="job-1" onSaved={onSaved} />,
    );
    typeBody("Dear hiring team,");
    click("Save letter");
    await act(async () => {});

    expect(order).toEqual(["saved", "closed"]);
  });
});
