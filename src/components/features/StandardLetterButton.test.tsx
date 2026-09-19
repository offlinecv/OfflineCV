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
 *
 * The second property arrived with the #767 review: this is a SECOND door onto
 * outside-produced letter text, and it must apply the same egress gate the row
 * indicator does. See the block at the bottom.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import {
  clickButtonIn,
  installDialogPolyfill,
  setupDomRoot,
  typeIntoTextArea,
} from "./__test-utils__/dialog-dom.ts";
import {
  hasAcknowledgedLetterEgress,
  recordLetterEgressAcknowledged,
} from "../../lib/letter-egress-ack.ts";
import type { LetterRecord } from "../../lib/storage/index.ts";

const saveLetter = vi.hoisted(() => vi.fn());
const deleteLetter = vi.hoisted(() => vi.fn());
vi.mock("../../lib/storage/index.ts", () => ({ saveLetter, deleteLetter }));

const { StandardLetterButton } = await import("./StandardLetterButton.tsx");

installDialogPolyfill();
const dom = setupDomRoot();

beforeEach(() => {
  saveLetter.mockReset();
  saveLetter.mockResolvedValue(undefined);
  deleteLetter.mockReset();
  deleteLetter.mockResolvedValue(true);
  // The acknowledgement is a single global flag, not per-letter — so a test
  // that records it would otherwise decide the outcome of every test after it.
  localStorage.clear();
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

/**
 * #767 review, blocking 2. Before #767 the editor was reachable only through
 * `JobLetterIndicator`, which gates any body carrying a `producer` block behind
 * the egress acknowledgement. This button is the second door, and an
 * outside-produced STANDARD letter is not hypothetical: `letter-contract.ts`
 * makes both scope keys optional and `producer` an allowed field, so it is
 * exactly the record shape a backup import lands.
 */
describe("StandardLetterButton egress gate (#767 review)", () => {
  // `Dialog` keeps every child mounted, so `container.textContent` sees the
  // CLOSED editor too — which is exactly the text these tests assert is not on
  // screen yet. Read the open dialog, and the textarea inside it.
  const openText = () => dom.openDialogText() ?? "";
  const openTextArea = () =>
    dom.container.querySelector("dialog[open] textarea") as
      | HTMLTextAreaElement
      | null;

  /** The shape a backup import lands: standard scope, outside producer. */
  const imported: LetterRecord = {
    id: "standard-imported",
    createdAt: 1,
    updatedAt: 2,
    body: "SECRET-BODY-FROM-A-MODEL",
    producer: { contract: 2, producer: "some-outside-producer" },
  };

  it("warns before showing an imported standard letter, and shows no body", () => {
    dom.render(<StandardLetterButton letter={imported} />);
    click("Edit standard letter");

    expect(openText()).toContain("Before you view this letter");
    expect(openText()).not.toContain("SECRET-BODY-FROM-A-MODEL");
    expect(openTextArea()).toBeNull();
    // Nothing recorded until the user actually acknowledges.
    expect(hasAcknowledgedLetterEgress()).toBe(false);
  });

  it("opens the editor on the letter once acknowledged, and records the flag", () => {
    dom.render(<StandardLetterButton letter={imported} />);
    click("Edit standard letter");
    // Asserted before the click, deliberately: `clickButtonIn` searches every
    // button in the container, and `Dialog` keeps CLOSED dialogs mounted — so
    // "Got it" is clickable even when no warning is on screen. Without this
    // line the test would pass against a build that has no gate at all.
    expect(openText()).toContain("Before you view this letter");
    click("Got it");

    expect(openTextArea()!.value).toBe("SECRET-BODY-FROM-A-MODEL");
    expect(hasAcknowledgedLetterEgress()).toBe(true);
  });

  it("shares the flag with the row indicator — acknowledged once, ever", () => {
    // The whole reason the gate is one shared module rather than a copy here:
    // a user who already accepted on a row must not be asked again by the
    // panel button.
    recordLetterEgressAcknowledged();
    dom.render(<StandardLetterButton letter={imported} />);
    click("Edit standard letter");

    expect(openText()).not.toContain("Before you view this letter");
    expect(openTextArea()!.value).toBe("SECRET-BODY-FROM-A-MODEL");
  });

  it("does not warn for a letter this app wrote", () => {
    // An absent `producer` block means offlinecv wrote it, so nothing egressed
    // and warning would tell the user something untrue about their own typing.
    dom.render(<StandardLetterButton letter={existing} />);
    click("Edit standard letter");
    expect(openText()).not.toContain("Before you view this letter");
    expect(openTextArea()!.value).toBe("My standard letter.");
  });

  it("does not warn when there is no letter at all", () => {
    // Composing from scratch sends nothing anywhere; there is no text to warn
    // about, and a warning before a blank editor is pure noise.
    dom.render(<StandardLetterButton />);
    click("Write a standard letter");
    expect(openText()).not.toContain("Before you view this letter");
    expect(openTextArea()).toBeTruthy();
  });
});

/**
 * #978. The standard tier is the one scope with a SINGLE window onto it — the
 * chain answers `mostRecent`, `JobTracker` passes `standard[0]`, and nothing
 * else in the app enumerates it — so a second unscoped record was invisible
 * everywhere and had no delete path. It is also the one tier that cannot be
 * reached through a job row, so this button is where the door has to be.
 */
describe("StandardLetterButton: unreachable duplicates (#978)", () => {
  const openText = () => dom.openDialogText() ?? "";

  const older: LetterRecord = {
    id: "standard-old",
    createdAt: 1,
    updatedAt: 1,
    body: "An older standard letter.",
  };

  it("shows no door when there is nothing unreachable", () => {
    // The ordinary store. A control that were always present and usually read
    // "(0)" would be permanent noise for a state that should never occur.
    dom.render(<StandardLetterButton letter={existing} />);
    expect(click("Older standard letters (0)")).toBeUndefined();
    expect(
      [...dom.container.querySelectorAll("button")].some((b) =>
        (b.textContent ?? "").startsWith("Older standard letters"),
      ),
    ).toBe(false);
  });

  it("counts the unreachable copies and lists them on click", () => {
    dom.render(
      <StandardLetterButton letter={existing} others={[older, { ...older, id: "s3" }]} />,
    );
    expect(click("Older standard letters (2)")).toBeTruthy();
    expect(openText()).toContain("An older standard letter.");
  });

  it("offers Copy and Delete but never Edit — editing one would silently promote it", () => {
    // An edit bumps `updatedAt`, and the chain answers `mostRecent`, so
    // "revise this old copy" would quietly make it the letter every job
    // inherits. Copy-then-paste is the same recovery, made explicit.
    dom.render(<StandardLetterButton letter={existing} others={[older]} />);
    click("Older standard letters (1)");
    expect(click("Edit")).toBeUndefined();
    expect(click("New draft")).toBeUndefined();
  });

  it("deletes the copy the user picked and re-reads the store", async () => {
    const onSaved = vi.fn();
    dom.render(
      <StandardLetterButton letter={existing} others={[older]} onSaved={onSaved} />,
    );
    click("Older standard letters (1)");
    click("Delete");

    // A confirm stands between the click and the write — nothing is deleted yet.
    expect(openText()).toContain("Delete this letter?");
    expect(deleteLetter).not.toHaveBeenCalled();
    // And it says the truth about this particular record: an unreachable copy
    // is already applying to nothing.
    expect(openText()).toContain("already unreachable");

    click("Delete letter");
    await act(async () => {});

    expect(deleteLetter).toHaveBeenCalledWith("standard-old");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("applies the egress gate to this door too, and returns to the right one", () => {
    // Two doors onto letter text now share one gate. The bug this pins is the
    // cheap one: acknowledging from the older-letters door must land on the
    // older-letters view, not on the editor the other door wanted.
    const imported: LetterRecord = {
      ...older,
      body: "SECRET-OLD-BODY",
      producer: { contract: 2, producer: "some-outside-producer" },
    };
    dom.render(<StandardLetterButton letter={existing} others={[imported]} />);
    click("Older standard letters (1)");

    expect(openText()).toContain("Before you view this letter");
    expect(openText()).not.toContain("SECRET-OLD-BODY");

    click("Got it");
    expect(openText()).toContain("SECRET-OLD-BODY");
    // The editor would have shown a <textarea>; the reveal shows a read-only
    // region. Asserting the destination, not just that something opened.
    expect(dom.container.querySelector("dialog[open] textarea")).toBeNull();
  });
});
