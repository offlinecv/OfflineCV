// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * LetterRevealDialog (#715). What matters: the body renders as PLAIN TEXT —
 * no markdown interpretation, paragraph breaks preserved via CSS rather than
 * parsing — several drafts are reachable and distinguishable by `label`, most
 * recent first, and Copy to clipboard copies the SELECTED draft's full body.
 *
 * A copy that FAILS must say so: `navigator.clipboard` is absent on an
 * insecure origin (`npm run dev:http`) and `writeText` rejects when the
 * permission is denied, and both used to leave the button reading "Copy to
 * clipboard" with nothing copied.
 *
 * jsdom has no `HTMLDialogElement.showModal`/`close` — polyfill and per-test
 * root both come from `__test-utils__/dialog-dom.ts`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { LetterRevealDialog } from "./LetterRevealDialog.tsx";
import { installDialogPolyfill, setupDomRoot } from "./__test-utils__/dialog-dom.ts";
import type { LetterRecord } from "../../lib/storage/index.ts";

installDialogPolyfill();
const dom = setupDomRoot();

/** jsdom ships no `navigator.clipboard`, so every case here installs the one
 *  it wants. Restored after each test so a clipboard stubbed as MISSING can't
 *  leak into the next case's assertions. */
function stubClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  stubClipboard(undefined);
});

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

function clickButton(text: string) {
  const button = [...dom.container.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  return button;
}

/** Render the dialog open, with the two authoring callbacks stubbed. Every
 *  test here is about DISPLAY — the plain-text body, the draft picker, the
 *  copy result — so `onEdit`/`onCompose` are noise at each call site, and
 *  spelling them out inline made two tests identical enough to register as a
 *  clone. `JobLetterIndicator.test.tsx` owns what those callbacks actually
 *  do. */
function renderDialog(letters: readonly LetterRecord[]) {
  dom.render(
    <LetterRevealDialog
      open
      onClose={() => {}}
      onEdit={() => {}}
      onCompose={() => {}}
      letters={letters}
    />,
  );
}

describe("LetterRevealDialog", () => {
  it("renders the body as plain text — literal markdown syntax survives unrendered", () => {
    // A producer's prose could contain characters that LOOK like markdown by
    // accident; this asserts they are never interpreted into HTML.
    const withAsterisks = letter({
      body: "Dear hiring team,\n\nI led the **checkout** rewrite.",
    });
    renderDialog([withAsterisks]);
    expect(dom.container.textContent).toContain("I led the **checkout** rewrite.");
    expect(dom.container.querySelector("strong, b, em, i")).toBeNull();
  });

  it("preserves the paragraph break between the salutation and the body", () => {
    const body = "Dear hiring team,\n\nI am applying for the Staff Engineer role.";
    renderDialog([letter({ body })]);
    // `whitespace-pre-wrap` is what preserves this — assert the literal `\n\n`
    // survives into the rendered text node rather than collapsing to a space.
    const box = dom.container.querySelector(".whitespace-pre-wrap");
    expect(box?.textContent).toBe(body);
  });

  it("shows only one draft picker entry — none — when there is a single letter", () => {
    renderDialog([letter({})]);
    expect(dom.container.querySelector('[role="group"]')).toBeNull();
  });

  it("lists several drafts by label, most-recent first, and switches the shown body", () => {
    const warm = letter({
      id: "l1",
      label: "Warm open",
      updatedAt: 1,
      body: "Warm draft body.",
    });
    const short = letter({
      id: "l2",
      label: "Short version",
      updatedAt: 2,
      body: "Short draft body.",
    });
    // Caller (`useJobLetters`) hands these in most-recently-updated-first
    // order already — this component trusts that order for its default pick.
    renderDialog([short, warm]);
    expect(dom.container.querySelector(".whitespace-pre-wrap")?.textContent).toBe(
      "Short draft body.",
    );

    clickButton("Warm open");
    expect(dom.container.querySelector(".whitespace-pre-wrap")?.textContent).toBe(
      "Warm draft body.",
    );
  });

  it("copies the SELECTED draft's full body, not the first one, once switched", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard({ writeText });

    const warm = letter({ id: "l1", label: "Warm open", updatedAt: 1, body: "Warm body" });
    const short = letter({ id: "l2", label: "Short version", updatedAt: 2, body: "Short body" });
    renderDialog([short, warm]);

    clickButton("Warm open");
    await act(async () => {
      clickButton("Copy to clipboard");
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("Warm body");
    expect(dom.container.textContent).toContain("Copied");
  });

  it("says the copy FAILED when there is no Clipboard API at all", async () => {
    // The `npm run dev:http` case: an insecure origin exposes no
    // `navigator.clipboard`, and optional-chaining the call would have awaited
    // `undefined` and reported a copy that never happened.
    stubClipboard(undefined);
    renderDialog([letter({})]);

    await act(async () => {
      clickButton("Copy to clipboard");
      await Promise.resolve();
    });

    expect(dom.container.textContent).toContain("Couldn’t copy");
    expect(dom.container.textContent).not.toContain("Copied");
    // The body stays on screen and selectable, so the instruction is real.
    expect(dom.container.querySelector(".whitespace-pre-wrap")?.textContent).toContain(
      "Staff Engineer",
    );
  });

  it("says the copy FAILED when writeText rejects", async () => {
    stubClipboard({ writeText: vi.fn(() => Promise.reject(new Error("denied"))) });
    renderDialog([letter({})]);

    await act(async () => {
      clickButton("Copy to clipboard");
      await Promise.resolve();
    });

    expect(dom.container.textContent).toContain("Couldn’t copy");
    expect(dom.container.textContent).not.toContain("Copied");
  });

  it("clears a previous failure when a different draft is picked", async () => {
    stubClipboard(undefined);
    const warm = letter({ id: "l1", label: "Warm open", updatedAt: 1 });
    const short = letter({ id: "l2", label: "Short version", updatedAt: 2 });
    renderDialog([short, warm]);

    await act(async () => {
      clickButton("Copy to clipboard");
      await Promise.resolve();
    });
    expect(dom.container.textContent).toContain("Couldn’t copy");

    clickButton("Warm open");
    expect(dom.container.textContent).not.toContain("Couldn’t copy");
  });

  it("makes the scrolling letter body reachable by keyboard", () => {
    // `max-h-96` scrolls on any letter of normal length, and the only other
    // focusables in this modal are the draft chips and Copy — so the region
    // has to take focus itself or a keyboard user cannot scroll it.
    renderDialog([letter({})]);
    const body = dom.container.querySelector(".overflow-y-auto");
    expect(body?.getAttribute("tabindex")).toBe("0");
    expect(body?.getAttribute("role")).toBe("region");
    expect(body?.getAttribute("aria-label")).toBeTruthy();
  });

  it("names the producer when the letter carries one", () => {
    renderDialog([
      letter({ producer: { contract: 1, producer: "claude-code-letter-skill" } }),
    ]);
    expect(dom.container.textContent).toContain("claude-code-letter-skill");
  });
});
