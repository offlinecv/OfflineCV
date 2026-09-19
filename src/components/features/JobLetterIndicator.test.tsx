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

/** #767: inheritance reaches the user through the DIALOGS, never through the
 *  glyph. These are the two halves of that: what the row still says, and what
 *  the customize path hands the editor. */
describe("JobLetterIndicator inherited letters (#767)", () => {
  const standard: LetterRecord = {
    id: "standard-1",
    createdAt: 1,
    updatedAt: 9,
    body: "My standard letter.",
  };
  const inherited = { letter: standard, label: "your standard letter" };

  it("a standard letter does NOT flip the row's glyph to has-letter", () => {
    // The acceptance criterion with teeth: the row must keep offering to WRITE
    // one. Flipping it would claim a letter the user never wrote for this
    // employer, and the reveal would then show text they did not intend for it.
    dom.render(
      <JobLetterIndicator jobId="job-1" letters={[]} inherited={inherited} />,
    );
    expect(
      dom.container.querySelector('button[aria-label="Write a cover letter"]'),
    ).toBeTruthy();
    expect(
      dom.container.querySelector('button[aria-label="View cover letter"]'),
    ).toBeNull();
  });

  it("offers the inherited letter as a starting point in the editor", () => {
    dom.render(
      <JobLetterIndicator jobId="job-1" letters={[]} inherited={inherited} />,
    );
    clickButton("Write a cover letter");

    // Offered, capitalized for a standalone chip — and NOT seeded: the body is
    // still empty until the user picks it.
    const chip = [...dom.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Your standard letter",
    );
    expect(chip).toBeTruthy();
    expect(dom.container.querySelector("textarea")!.value).toBe("");
  });

  it("Customize seeds the editor from the inherited letter", () => {
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        letters={[ownLetter({ id: "own", label: "Mine", body: "Own body." })]}
        inherited={inherited}
      />,
    );
    clickButton("View cover letter");
    clickButton("Your standard letter");
    clickButton("Customize for this job");

    // Seeded with the SOURCE's text, in an editor composing a new draft — the
    // copy notice is what proves it is not revising the standard letter.
    expect(dom.container.querySelector("textarea")!.value).toBe(
      "My standard letter.",
    );
    expect(dom.container.textContent).toContain("Started from");
  });

  it("a plain write-one click never seeds, even with something to inherit", () => {
    dom.render(
      <JobLetterIndicator jobId="job-1" letters={[]} inherited={inherited} />,
    );
    clickButton("Write a cover letter");
    expect(dom.container.querySelector("textarea")!.value).toBe("");
    expect(dom.container.textContent).not.toContain("Started from");
  });
});

/** #767 review, blocking 1: the egress acknowledgement must gate everything
 *  this component can put on screen, not just the job's OWN letters. Adding the
 *  inherited entry added two routes to an outside-produced body — the reveal's
 *  chip and the editor's picker — and neither read its `producer`. */
describe("JobLetterIndicator egress gate over inherited letters (#767)", () => {
  const outsideStandard: LetterRecord = {
    id: "standard-1",
    createdAt: 1,
    updatedAt: 9,
    body: "My standard letter.",
    producer: { contract: 1, producer: "some-outside-producer" },
  };
  const inherited = { letter: outsideStandard, label: "your standard letter" };

  it("warns before revealing, when only the INHERITED letter came from outside", () => {
    // The job's own letter was hand-typed, so the pre-#767 test
    // (`hasOutsideProducer(letters)`) says don't warn — but one click on the
    // inherited chip would put outside-produced text on screen.
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        letters={[ownLetter({ id: "own", label: "Mine" })]}
        inherited={inherited}
      />,
    );
    clickButton("View cover letter");
    expect(dom.openDialogText()).toContain("Before you view this letter");
  });

  it("warns before the EDITOR too, when the job has no letters of its own", () => {
    // The worse path: no own letters means the glyph opens the editor directly,
    // and the picker chip is one click from the same outside-produced body.
    dom.render(
      <JobLetterIndicator jobId="job-1" letters={[]} inherited={inherited} />,
    );
    clickButton("Write a cover letter");
    expect(dom.openDialogText()).toContain("Before you view this letter");
  });

  it("lands on the right surface after acknowledging, per own-letter state", () => {
    // The ack path used to hard-code `reveal`, which was correct only while the
    // empty case could never warn. It can now.
    dom.render(
      <JobLetterIndicator jobId="job-1" letters={[]} inherited={inherited} />,
    );
    clickButton("Write a cover letter");
    clickButton("Got it");
    expect(dom.openDialogText()).toContain("Write a cover letter");
    expect(dom.container.querySelector("textarea")).toBeTruthy();
  });

  it("does not warn when nothing reachable came from outside", () => {
    // The other direction, still true: a hand-typed own letter and a hand-typed
    // inherited one must not be gated behind a warning that would be false.
    const { producer: _drop, ...cleanStandard } = outsideStandard;
    void _drop;
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        letters={[ownLetter({ id: "own", label: "Mine" })]}
        inherited={{ letter: cleanStandard, label: "your standard letter" }}
      />,
    );
    clickButton("View cover letter");
    expect(dom.openDialogText()).not.toContain("Before you view this letter");
  });
});

/** #767 review, blocking 2: the company tier had no write path at all, so
 *  `scope: "company"` could only ever fire for a record an outside producer
 *  wrote. "Customize for this company" is that path. */
describe("JobLetterIndicator company write path (#767)", () => {
  it("offers to lift a letter to company scope when the job has a company key", () => {
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        companyKey="northwind"
        letters={[ownLetter({ id: "own", label: "Mine", body: "Own body." })]}
      />,
    );
    clickButton("View cover letter");
    expect(
      [...dom.container.querySelectorAll("button")].some(
        (b) => b.textContent === "Customize for this company",
      ),
    ).toBe(true);
  });

  it("offers nothing of the sort when the job has no company to key on", () => {
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        letters={[ownLetter({ id: "own", label: "Mine" })]}
      />,
    );
    clickButton("View cover letter");
    expect(
      [...dom.container.querySelectorAll("button")].some(
        (b) => b.textContent === "Customize for this company",
      ),
    ).toBe(false);
  });

  it("opens the editor in COMPANY scope, seeded, with no jobId", () => {
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        companyKey="northwind"
        letters={[ownLetter({ id: "own", label: "Mine", body: "Own body." })]}
      />,
    );
    clickButton("View cover letter");
    clickButton("Customize for this company");

    // The title is what tells the user which letter they are about to write,
    // and it is derived from the scope keys the save will carry.
    expect(dom.openDialogText()).toContain("Write a company letter");
    expect(dom.container.querySelector("textarea")!.value).toBe("Own body.");
  });
});

/**
 * #767 review: the company offer used to ALWAYS insert. First that meant it
 * offered to fork the company's letter from itself when that letter was the
 * one on screen; the fix for that keyed the decision off the SELECTION, which
 * left the larger half open — with a company letter already at this key and
 * anything else selected, it still inserted a second record at the same key.
 *
 * Why a duplicate matters: the chain surfaces only the most-recently-updated
 * record per rung (`mostRecent`), so the older one stops resolving anywhere,
 * and it has no `jobId` for `deleteLettersForJob` to cascade to. #978 has
 * since made such a record visible and deletable through the reveal's
 * `extras`, so it is no longer lost forever — but creating one silently, under
 * a button that says "Customize", is still the wrong action.
 *
 * So the decision is keyed off whether the TIER IS OCCUPIED, which the
 * component can answer from `inherited` + `extras` without asking the store.
 */
describe("JobLetterIndicator company tier: edit, not fork (#767 review)", () => {
  const companyLetter = ownLetter({
    id: "company-1",
    jobId: undefined,
    companyKey: "northwind",
    label: "Northwind",
    body: "Company letter v1.",
  });

  const inheritedCompany = {
    letter: companyLetter,
    label: "your Northwind letter",
  };

  it("edits in place when the letter on screen IS this company's letter", () => {
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        companyKey="northwind"
        letters={[ownLetter({ id: "own", label: "Mine", body: "Own body." })]}
        inherited={inheritedCompany}
      />,
    );
    clickButton("View cover letter");
    clickButton("Your Northwind letter");

    // The offer renames itself, because it is now a different action.
    expect(
      [...dom.container.querySelectorAll("button")].some(
        (b) => b.textContent === "Customize for this company",
      ),
    ).toBe(false);
    clickButton("Edit this company letter");

    // REVISING: the editor titles it as an edit and carries the body through
    // with no copy notice — the notice is what marks an insert.
    expect(dom.openDialogText()).toContain("Edit company letter");
    expect(dom.openDialogText()).not.toContain("Started from");
    expect(dom.container.querySelector("textarea")!.value).toBe(
      "Company letter v1.",
    );
  });

  it("REPLACES the occupied tier instead of forking a second letter at the same key", () => {
    // The case the selection-keyed fix missed: a company letter exists, but the
    // job's own draft is what the reveal opened on (correctly — the glyph
    // promised this job's letters). Inserting here mints a second record at
    // `companyKey: "northwind"`, and only the newest of those ever resolves.
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        companyKey="northwind"
        letters={[ownLetter({ id: "own", label: "Mine", body: "Own body." })]}
        inherited={inheritedCompany}
      />,
    );
    clickButton("View cover letter");

    // The button tells the truth about what it is about to do. "Customize"
    // would describe an insert while performing an overwrite.
    expect(
      [...dom.container.querySelectorAll("button")].some(
        (b) => b.textContent === "Customize for this company",
      ),
    ).toBe(false);
    clickButton("Replace this company letter");

    // REVISING the occupant — the title is the edit form, so the save carries
    // `company-1`'s id rather than minting a new one…
    expect(dom.openDialogText()).toContain("Edit company letter");
    // …while the body is the text the user actually picked, which is the whole
    // point of the offer: promote this paragraph into the company letter.
    expect(dom.container.querySelector("textarea")!.value).toBe("Own body.");
    // And the notice says REPLACE, not copy. The copy wording ("editing it
    // later leaves X exactly as it is") would be a lie about the record being
    // overwritten.
    const text = dom.openDialogText() ?? "";
    expect(text).toContain("replaces");
    expect(text).not.toContain("This is a copy");
  });

  it("still INSERTS when the company tier is empty — the offer's original job", () => {
    // Nothing at `companyKey` yet: the inherited letter is the standard one, so
    // lifting an own draft to company scope is a genuine new record at a new
    // scope and must stay an insert.
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        companyKey="northwind"
        letters={[ownLetter({ id: "own", label: "Mine", body: "Own body." })]}
        inherited={{
          letter: ownLetter({
            id: "standard-1",
            jobId: undefined,
            body: "My standard letter.",
          }),
          label: "your standard letter",
        }}
      />,
    );
    clickButton("View cover letter");
    clickButton("Customize for this company");

    expect(dom.openDialogText()).toContain("Write a company letter");
    expect(dom.openDialogText()).toContain("Started from");
    expect(dom.container.querySelector("textarea")!.value).toBe("Own body.");
  });

  it("finds the occupant among the unreachable extras too, not just the inherited entry", () => {
    // `inherited` is the chain's head; #978's `extras` carry everything behind
    // it. A company record reachable only as an extra still OCCUPIES the tier,
    // so the offer must not insert past it either.
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        companyKey="northwind"
        letters={[ownLetter({ id: "own", label: "Mine", body: "Own body." })]}
        extras={[
          {
            letter: ownLetter({
              id: "company-old",
              jobId: undefined,
              companyKey: "northwind",
              body: "An older Northwind letter.",
            }),
            label: "an earlier Northwind letter",
          },
        ]}
      />,
    );
    clickButton("View cover letter");
    expect(
      [...dom.container.querySelectorAll("button")].some(
        (b) => b.textContent === "Replace this company letter",
      ),
    ).toBe(true);
  });

  it("calls a selected company DUPLICATE a replace, not an edit, because the head is what gets revised", () => {
    // `isCompanyLetter` matches any record at the key, duplicate included, but
    // the handler revises the tier's HEAD seeded from the duplicate. A button
    // reading "Edit this company letter" would promise an in-place edit of the
    // selected record while overwriting a different one.
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        companyKey="northwind"
        letters={[ownLetter({ id: "own", body: "Own body." })]}
        inherited={{
          letter: ownLetter({
            id: "c-new",
            jobId: undefined,
            companyKey: "northwind",
            updatedAt: 6,
            body: "CO-NEW.",
          }),
          label: "your Northwind letter",
        }}
        extras={[
          {
            letter: ownLetter({
              id: "c-old",
              jobId: undefined,
              companyKey: "northwind",
              updatedAt: 3,
              body: "CO-OLD.",
            }),
            label: "an earlier Northwind letter",
          },
        ]}
      />,
    );
    clickButton("View cover letter");
    clickButton("An earlier Northwind letter");
    const labels = [...dom.container.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(labels).not.toContain("Edit this company letter");
    clickButton("Replace this company letter");
    expect(openDialogText()).toContain("Edit company letter");
    expect(dom.container.querySelector("textarea")!.value).toBe("CO-OLD.");
    expect(openDialogText()).toContain("replaces");

    // The head itself still reads as an in-place edit.
    clickButton("Cancel");
    clickButton("View cover letter");
    clickButton("Your Northwind letter");
    expect(
      [...dom.container.querySelectorAll("button")].some(
        (b) => b.textContent === "Edit this company letter",
      ),
    ).toBe(true);
  });

  it("forks, not edits, when the selected letter is ANOTHER company's", () => {
    // Same key check the chain reads the rung with: a letter at a different key
    // is not this company's letter, whatever else it carries.
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        companyKey="northwind"
        letters={[ownLetter({ id: "own", label: "Mine", body: "Own body." })]}
        inherited={{
          letter: ownLetter({
            id: "other-company",
            jobId: undefined,
            companyKey: "contoso",
            body: "Contoso letter.",
          }),
          label: "your Contoso letter",
        }}
      />,
    );
    clickButton("View cover letter");
    clickButton("Your Contoso letter");
    expect(
      [...dom.container.querySelectorAll("button")].some(
        (b) => b.textContent === "Edit this company letter",
      ),
    ).toBe(false);
  });
});

/**
 * #978. `deleteLetter` had no caller in `src/` at all, so a letter was
 * removable only by deleting the job it named — and a letter naming no job was
 * not removable at all. This block covers the row's half: reaching the confirm,
 * and telling the user the truth about who else loses the letter, which differs
 * per scope and is the only thing that would make someone hesitate.
 *
 * The write itself is `LetterDeleteDialog.test.tsx`'s — these cases stop at the
 * confirm on purpose, so this suite still needs no store.
 */
describe("JobLetterIndicator: deleting a letter (#978)", () => {
  const standardExtra = ownLetter({
    id: "standard-old",
    jobId: undefined,
    body: "An older standard letter.",
  });
  const companyExtra = ownLetter({
    id: "company-old",
    jobId: undefined,
    companyKey: "northwind",
    body: "An older Northwind letter.",
  });

  it("reaches the confirm from the reveal and names the letter", () => {
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        letters={[ownLetter({ id: "own", label: "Mine" })]}
      />,
    );
    clickButton("View cover letter");
    clickButton("Delete");
    expect(openDialogText()).toContain("Delete this letter?");
    expect(openDialogText()).toContain("Mine");
  });

  it("says a job draft affects no other job", () => {
    dom.render(
      <JobLetterIndicator jobId="job-1" letters={[ownLetter({ id: "own" })]} />,
    );
    clickButton("View cover letter");
    clickButton("Delete");
    expect(openDialogText()).toContain("No other job is affected.");
  });

  it("says a standard letter is inherited by every job without one", () => {
    // The tier's HEAD — what the chain answers with — so deleting it really
    // does change what every job without a letter of its own inherits.
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        letters={[ownLetter({ id: "own" })]}
        inherited={{ letter: standardExtra, label: "your standard letter" }}
      />,
    );
    clickButton("View cover letter");
    clickButton("Your standard letter");
    clickButton("Delete");
    expect(openDialogText()).toContain(
      "Every job without a letter of its own stops inheriting it.",
    );
  });

  it("says a company letter is inherited by every job at that company", () => {
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        letters={[ownLetter({ id: "own" })]}
        inherited={{ letter: companyExtra, label: "your Northwind letter" }}
      />,
    );
    clickButton("View cover letter");
    clickButton("Your Northwind letter");
    clickButton("Delete");
    expect(openDialogText()).toContain(
      "Every job at this company stops inheriting it.",
    );
  });

  it("says no job is affected for an unreachable duplicate, at either tier", () => {
    // No job inherits a record behind its tier's head, so the scope-keyed
    // sentence would overstate the loss — and would describe the record
    // differently from `StandardLetterButton`'s older-letters door.
    for (const [extra, label] of [
      [standardExtra, "an earlier standard letter"],
      [companyExtra, "an earlier Northwind letter"],
    ] as const) {
      dom.render(
        <JobLetterIndicator
          jobId="job-1"
          letters={[ownLetter({ id: "own" })]}
          extras={[{ letter: extra, label }]}
        />,
      );
      clickButton("View cover letter");
      clickButton(label.charAt(0).toUpperCase() + label.slice(1));
      clickButton("Delete");
      const text = openDialogText() ?? "";
      expect(text).toContain("No job is affected — this copy is already unreachable.");
      expect(text).not.toContain("stops inheriting it");
      clickButton("Keep it");
    }
  });

  it("opens the reveal, not the editor, when a job with no drafts has something unreachable to show", () => {
    // The glyph still reports this job's own letters — that is what the row
    // promised — but the click has to be able to reach a record nothing else
    // in the app can see. The reveal's "New draft" is the same editor this
    // branch would otherwise have opened directly.
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        letters={[]}
        extras={[{ letter: standardExtra, label: "an earlier standard letter" }]}
      />,
    );
    clickButton("Write a cover letter");
    expect(openDialogText()).toContain("An older standard letter.");
    expect(dom.container.querySelector("dialog[open] textarea")).toBeNull();
  });

  it("still opens the editor from the empty state when there is nothing unreachable", () => {
    // The ordinary case must be untouched: `extras` is empty for every store
    // holding at most one record per tier.
    dom.render(<JobLetterIndicator jobId="job-1" letters={[]} extras={[]} />);
    clickButton("Write a cover letter");
    expect(openDialogText()).toContain("Write a cover letter");
  });

  it("gates an outside-produced duplicate behind the egress warning", () => {
    // The warning is about egress that already happened to the text being
    // SHOWN, whichever scope holds it — and a duplicate is exactly the record
    // shape a backup import lands.
    dom.render(
      <JobLetterIndicator
        jobId="job-1"
        letters={[ownLetter({ id: "own" })]}
        extras={[
          {
            letter: letter({ id: "imported-old", jobId: undefined, body: "SECRET-DUPE" }),
            label: "an earlier standard letter",
          },
        ]}
      />,
    );
    clickButton("View cover letter");
    expect(openDialogText()).toContain("Before you view this letter");
    expect(openDialogText()).not.toContain("SECRET-DUPE");
  });
});
