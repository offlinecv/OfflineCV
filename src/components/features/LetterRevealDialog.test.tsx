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

  it("says WHICH chip is selected, not just draws it", () => {
    // #767 review: the selected chip was signalled by `variant` alone — colour
    // and weight — so inside `role="group" aria-label="Choose a draft"` every
    // chip sounded identical to a screen reader (WCAG 1.4.1). `aria-pressed`
    // rather than `aria-current`: these toggle what the dialog displays.
    const warm = letter({ id: "l1", label: "Warm open", updatedAt: 1 });
    const short = letter({ id: "l2", label: "Short version", updatedAt: 2 });
    renderDialog([short, warm]);

    const pressed = () =>
      [...dom.container.querySelectorAll('[role="group"] button')].map((b) => [
        b.textContent,
        b.getAttribute("aria-pressed"),
      ]);
    expect(pressed()).toEqual([
      ["Short version", "true"],
      ["Warm open", "false"],
    ]);

    clickButton("Warm open");
    expect(pressed()).toEqual([
      ["Short version", "false"],
      ["Warm open", "true"],
    ]);
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

/** #767: an inherited letter is offered here as one more entry, and must be
 *  unmistakable as someone else's. The failure this guards is a user pasting
 *  their standard letter into an application believing it was tailored. */
describe("LetterRevealDialog inherited letters (#767)", () => {
  const inheritedLetter = letter({
    id: "standard-1",
    jobId: undefined,
    body: "My standard letter.",
  });
  const inherited = { letter: inheritedLetter, label: "your standard letter" };

  function renderWithInherited(
    letters: readonly LetterRecord[],
    onCustomize = () => {},
  ) {
    dom.render(
      <LetterRevealDialog
        open
        onClose={() => {}}
        letters={letters}
        inherited={inherited}
        onEdit={() => {}}
        onCompose={() => {}}
        onCustomize={onCustomize}
      />,
    );
  }

  it("opens on the job's OWN letter, never on the inherited one", () => {
    // The row's glyph promised this job's letter; opening on someone else's
    // would make the glyph a lie.
    renderWithInherited([letter({ id: "own", label: "Mine", body: "Own body." })]);
    expect(dom.container.textContent).toContain("Own body.");
    expect(dom.container.textContent).not.toContain("My standard letter.");
  });

  it("says nothing extra while the job's own letter is showing", () => {
    renderWithInherited([letter({ id: "own", label: "Mine" })]);
    expect(dom.container.textContent).not.toContain("not a letter for this job");
    // Edit, not Customize — this letter is the job's to edit in place.
    expect(clickButton("Customize for this job")).toBeUndefined();
  });

  it("names the scope once the inherited letter is selected", () => {
    renderWithInherited([letter({ id: "own", label: "Mine" })]);
    // The chip STANDS ALONE, so it capitalizes the phrase; the notice below
    // embeds the same phrase mid-sentence and must not (#767 review). Both
    // asserted here, because getting one right and the other wrong is exactly
    // what shipped.
    expect(clickButton("Your standard letter")).toBeTruthy();
    expect(dom.container.textContent).toContain(
      "This is your standard letter, not a letter for this job",
    );
    expect(dom.container.textContent).toContain("not a letter for this job");
    expect(dom.container.textContent).toContain("My standard letter.");
  });

  it("names the company offer for what it will actually do", () => {
    // Three actions wear this one button, and the label is the only thing
    // telling them apart (#767 review). Getting it wrong is not cosmetic: a
    // button reading "Customize" that overwrites the company letter describes
    // an insert while performing a replace.
    const own = letter({ id: "own", label: "Mine" });
    const company = letter({
      id: "company-1",
      jobId: undefined,
      companyKey: "northwind",
      label: "Northwind",
    });
    const offer = (occupied: boolean) => ({
      companyKey: "northwind",
      occupied,
      onCustomize: () => {},
    });
    const labelOf = () =>
      [...dom.container.querySelectorAll("button")]
        .map((b) => b.textContent)
        .find((t) => t?.includes("company letter") || t?.includes("this company"));

    // Tier empty: a genuine new record at a new scope.
    dom.render(
      <LetterRevealDialog
        open
        onClose={() => {}}
        letters={[own]}
        companyOffer={offer(false)}
      />,
    );
    expect(labelOf()).toBe("Customize for this company");

    // Tier occupied, something else selected: this replaces it.
    dom.render(
      <LetterRevealDialog
        open
        onClose={() => {}}
        letters={[own]}
        companyOffer={offer(true)}
      />,
    );
    expect(labelOf()).toBe("Replace this company letter");

    // The company letter itself is on screen: a plain edit in place, and the
    // predicate is the same one the chain reads the rung with.
    dom.render(
      <LetterRevealDialog
        open
        onClose={() => {}}
        letters={[company]}
        companyOffer={offer(true)}
      />,
    );
    expect(labelOf()).toBe("Edit this company letter");
  });

  it("offers Customize instead of Edit for the inherited letter", () => {
    const onCustomize = vi.fn();
    renderWithInherited([letter({ id: "own", label: "Mine" })], onCustomize);
    clickButton("Your standard letter");

    // Edit is GONE, not merely joined: editing in place would rewrite a letter
    // this job does not own.
    expect(
      [...dom.container.querySelectorAll("button")].some((b) => b.textContent === "Edit"),
    ).toBe(false);
    clickButton("Customize for this job");
    expect(onCustomize).toHaveBeenCalledTimes(1);
    expect(onCustomize.mock.calls[0]![0].id).toBe("standard-1");
  });

  it("ignores an inherited letter with no handler to act on it", () => {
    // `onCustomize` is what makes the entry actionable; without it the offer
    // would be a chip that does nothing.
    dom.render(
      <LetterRevealDialog
        open
        onClose={() => {}}
        letters={[letter({ id: "own", label: "Mine" })]}
        inherited={inherited}
        onEdit={() => {}}
        onCompose={() => {}}
      />,
    );
    expect(clickButton("your standard letter")).toBeUndefined();
  });
});

describe("LetterRevealDialog: unreachable duplicates and delete (#978)", () => {
  const standardExtra = letter({
    id: "standard-old",
    jobId: undefined,
    label: undefined,
    body: "An older standard letter.",
  });
  const extras = [{ letter: standardExtra, label: "an earlier standard letter" }];

  function renderWithExtras(
    over: Partial<Parameters<typeof LetterRevealDialog>[0]> = {},
  ) {
    dom.render(
      <LetterRevealDialog
        open
        onClose={() => {}}
        letters={[letter({ id: "own", label: "Mine", body: "Own body." })]}
        extras={extras}
        onEdit={() => {}}
        onCompose={() => {}}
        {...over}
      />,
    );
  }

  it("offers an unreachable duplicate as a chip, without opening on it", () => {
    renderWithExtras();
    // The row still promised this job's own draft, so that is what is showing.
    expect(dom.container.textContent).toContain("Own body.");
    expect(dom.container.textContent).not.toContain("An older standard letter.");
    // …and the duplicate is one click away, which is the whole point: before
    // this it was in IndexedDB with no surface able to show it at all.
    expect(clickButton("An earlier standard letter")).toBeTruthy();
    expect(dom.container.textContent).toContain("An older standard letter.");
  });

  it("names a duplicate's scope the same way it names an inherited letter", () => {
    renderWithExtras();
    clickButton("An earlier standard letter");
    // Chip capitalized (it stands alone), notice lowercase (it is embedded) —
    // the same split `scope-phrase.ts` enforces for the inherited entry.
    expect(dom.container.textContent).toContain(
      "This is an earlier standard letter, not a letter for this job",
    );
  });

  it("never offers Edit for a duplicate — it is not this job's to revise", () => {
    renderWithExtras();
    clickButton("An earlier standard letter");
    expect(
      [...dom.container.querySelectorAll("button")].some((b) => b.textContent === "Edit"),
    ).toBe(false);
  });

  it("hands Delete whatever is actually on screen", () => {
    const onDelete = vi.fn();
    renderWithExtras({ onDelete });

    clickButton("Delete");
    expect(onDelete).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "own" }),
    );

    clickButton("An earlier standard letter");
    clickButton("Delete");
    expect(onDelete).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "standard-old" }),
    );
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it("renders no Delete without a handler", () => {
    // Deleting is destructive and the confirm lives with the caller, so a
    // button that could only no-op must not appear.
    renderWithExtras();
    expect(clickButton("Delete")).toBeUndefined();
  });

  it("drops Edit and New draft for a caller that has no job to author for", () => {
    // `StandardLetterButton`'s older-letters view: letters belonging to no job,
    // where "revise this draft" and "start another draft for this job" are both
    // meaningless. Copy and Delete are what remain.
    dom.render(
      <LetterRevealDialog
        open
        onClose={() => {}}
        letters={[standardExtra]}
        onDelete={() => {}}
      />,
    );
    expect(clickButton("Edit")).toBeUndefined();
    expect(clickButton("New draft")).toBeUndefined();
    expect(clickButton("Delete")).toBeTruthy();
    expect(clickButton("Copy to clipboard")).toBeTruthy();
  });
});
