// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * JobLetterIndicator (#715). What matters: no affordance for a job with no
 * letters, the one-time egress acknowledgement gates the FIRST reveal and
 * never the second (persisted via `letter-egress-ack.ts`, not per-component
 * state — see that module's docblock for why), and the acknowledgement is
 * global across rows rather than per-job.
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

function letter(over: Partial<LetterRecord>): LetterRecord {
  return {
    id: over.id ?? crypto.randomUUID(),
    jobId: "job-1",
    createdAt: 1,
    updatedAt: 1,
    body: "Dear hiring team,\n\nI am applying for the Staff Engineer role.",
    ...over,
  };
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
  it("renders nothing for a job with no letters", () => {
    dom.render(<JobLetterIndicator letters={[]} />);
    expect(dom.container.querySelector("button")).toBeNull();
  });

  it("names the count in the accessible label once there is more than one draft", () => {
    dom.render(<JobLetterIndicator letters={[letter({}), letter({ id: "l2" })]} />);
    expect(dom.container.querySelector('button[aria-label*="(2)"]')).not.toBeNull();
  });

  it("shows the acknowledgement before the first reveal, not the letter body", () => {
    dom.render(<JobLetterIndicator letters={[letter({})]} />);
    clickButton("View cover letter");
    expect(openDialogText()).toContain("Before you view this letter");
    expect(openDialogText()).not.toContain("Staff Engineer");
  });

  it("reveals the letter after 'Got it', and persists the acknowledgement", () => {
    dom.render(<JobLetterIndicator letters={[letter({})]} />);
    clickButton("View cover letter");
    clickButton("Got it");
    expect(openDialogText()).toContain("Staff Engineer");
    expect(openDialogText()).not.toContain("Before you view this letter");
  });

  it("skips the acknowledgement on a fresh mount once it was already recorded", () => {
    recordLetterEgressAcknowledged();
    dom.render(<JobLetterIndicator letters={[letter({})]} />);
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
        <JobLetterIndicator letters={[letter({ jobId: "job-1" })]} />
        <JobLetterIndicator letters={[letter({ jobId: "job-2", id: "l2" })]} />
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
