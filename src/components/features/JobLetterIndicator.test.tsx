// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * JobLetterIndicator (#715). What matters: BOTH states are reachable — a job
 * with no letters offers to write one rather than rendering nothing, and a job
 * with letters opens the reveal — and the egress acknowledgement gates exactly
 * the letters it is about.
 *
 * That last one is the assertion with teeth. The warning says the résumé and
 * the job details were sent to a model's API; that is true of a letter an
 * outside producer wrote and false of one the user typed into
 * `LetterEditorDialog`, which carries no `producer` block
 * (`docs/cover-letter-contract.md` §6). A regression here does not throw or
 * render wrong — it tells the user something untrue about their own typing —
 * so both directions are covered explicitly.
 *
 * jsdom has no `HTMLDialogElement.showModal`/`close` — `Dialog`'s effect
 * calls both. The polyfill, the per-test root, and the "scope assertions to
 * the OPEN dialog" recipe all come from `__test-utils__/dialog-dom.ts`; see
 * that file for why each is easy to get wrong when rewritten by hand.
 */

import { describe, expect, it } from "vitest";
import { act } from "react";
import { JobLetterIndicator } from "./JobLetterIndicator.tsx";
import { recordLetterEgressAcknowledged } from "../../lib/letter-egress-ack.ts";
import { installDialogPolyfill, setupDomRoot } from "./__test-utils__/dialog-dom.ts";
import type { LetterRecord } from "../../lib/storage/index.ts";

installDialogPolyfill();
const dom = setupDomRoot();

/** A letter written by an OUTSIDE producer — the case the egress warning is
 *  about. `producer` is set unless a test overrides it away. */
function letter(over: Partial<LetterRecord>): LetterRecord {
  return {
    id: over.id ?? crypto.randomUUID(),
    jobId: "job-1",
    createdAt: 1,
    updatedAt: 1,
    body: "Dear hiring team,\n\nI am applying for the Staff Engineer role.",
    producer: { contract: 1, producer: "some-outside-producer" },
    ...over,
  };
}

/** A letter this app wrote — no `producer` block, so nothing egressed. */
function ownLetter(over: Partial<LetterRecord> = {}): LetterRecord {
  const { producer: _drop, ...rest } = letter(over);
  void _drop;
  return rest;
}

function clickButton(name: string | RegExp) {
  const button = [...dom.container.querySelectorAll("button")].find((b) =>
    typeof name === "string"
      ? (b.getAttribute("aria-label") ?? b.textContent) === name
      : name.test(b.getAttribute("aria-label") ?? b.textContent ?? ""),
  );
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  return button;
}

const openDialogText = () => dom.openDialogText();

describe("JobLetterIndicator", () => {
  it("offers to write one for a job with no letters", () => {
    dom.render(<JobLetterIndicator jobId="job-1" letters={[]} />);
    expect(
      dom.container.querySelector('button[aria-label="Write a cover letter"]'),
    ).not.toBeNull();
  });

  it("opens the editor — not the reveal — from the empty state", () => {
    dom.render(<JobLetterIndicator jobId="job-1" letters={[]} />);
    clickButton("Write a cover letter");
    expect(openDialogText()).toContain("Write a cover letter");
    // The empty state must never route through the egress warning: there is no
    // letter yet, so nothing has been sent anywhere to warn about.
    expect(openDialogText()).not.toContain("Before you view this letter");
  });

  it("names the count in the accessible label once there is more than one draft", () => {
    dom.render(
      <JobLetterIndicator jobId="job-1" letters={[letter({}), letter({ id: "l2" })]} />,
    );
    expect(dom.container.querySelector('button[aria-label*="(2)"]')).not.toBeNull();
  });

  it("shows the acknowledgement before the first reveal, not the letter body", () => {
    dom.render(<JobLetterIndicator jobId="job-1" letters={[letter({})]} />);
    clickButton("View cover letter");
    expect(openDialogText()).toContain("Before you view this letter");
    expect(openDialogText()).not.toContain("Staff Engineer");
  });

  it("does NOT warn about egress for a letter this app wrote", () => {
    // No `recordLetterEgressAcknowledged()` here: the acknowledgement has never
    // been given, so a gate keyed on it alone would fire. What must suppress it
    // is the absent `producer` block.
    dom.render(<JobLetterIndicator jobId="job-1" letters={[ownLetter()]} />);
    clickButton("View cover letter");
    expect(openDialogText()).toContain("Staff Engineer");
    expect(openDialogText()).not.toContain("Before you view this letter");
  });

  it("still warns when ONE of several drafts came from an outside producer", () => {
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        letters={[ownLetter({ id: "mine" }), letter({ id: "theirs" })]}
      />,
    );
    clickButton(/^View cover letters/);
    expect(openDialogText()).toContain("Before you view this letter");
  });

  it("reveals the letter after 'Got it', and persists the acknowledgement", () => {
    dom.render(<JobLetterIndicator jobId="job-1" letters={[letter({})]} />);
    clickButton("View cover letter");
    clickButton("Got it");
    expect(openDialogText()).toContain("Staff Engineer");
    expect(openDialogText()).not.toContain("Before you view this letter");
  });

  it("skips the acknowledgement on a fresh mount once it was already recorded", () => {
    recordLetterEgressAcknowledged();
    dom.render(<JobLetterIndicator jobId="job-1" letters={[letter({})]} />);
    clickButton("View cover letter");
    expect(openDialogText()).toContain("Staff Engineer");
    expect(openDialogText()).not.toContain("Before you view this letter");
  });

  it("does not re-show the acknowledgement for a DIFFERENT row once one row's dialog has accepted it", () => {
    // Two indicators mounted at once — the real shape of the Saved jobs
    // library, one per tracked job with a letter. Accepting on the first
    // must not leave the second's cached state stale (the bug
    // `letter-egress-ack.ts`'s docblock explains).
    dom.render(
      <>
        <JobLetterIndicator jobId="job-1" letters={[letter({ jobId: "job-1" })]} />
        <JobLetterIndicator
          jobId="job-2"
          letters={[letter({ jobId: "job-2", id: "l2" })]}
        />
      </>,
    );
    // Dialog always renders its children into the DOM (it toggles the native
    // `open` attribute imperatively rather than conditionally rendering), so
    // every dialog's buttons — "Got it", "Copy to clipboard" — are present
    // from the first render onward. Select the two TRIGGER icons specifically
    // rather than taking "the first two buttons in the DOM".
    const icons = [
      ...dom.container.querySelectorAll('button[aria-label="View cover letter"]'),
    ];
    expect(icons).toHaveLength(2);
    const [firstIcon, secondIcon] = icons;
    act(() => firstIcon?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    clickButton("Got it");

    act(() => secondIcon?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    // Both rows' reveal dialogs may now be open (row 1's never closed) — what
    // this asserts is that neither OPEN dialog is the acknowledgement one,
    // i.e. row 2's click went straight to "reveal" too.
    const openDialogs = [...dom.container.querySelectorAll("dialog[open]")];
    expect(openDialogs.length).toBeGreaterThan(0);
    for (const dialog of openDialogs) {
      expect(dialog.textContent).not.toContain("Before you view this letter");
    }
  });
});
