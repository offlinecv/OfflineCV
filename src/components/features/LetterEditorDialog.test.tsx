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
import {
  clickButtonIn,
  installDialogPolyfill,
  setupDomRoot,
  typeIntoTextArea,
} from "./__test-utils__/dialog-dom.ts";
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

const click = (text: string) => clickButtonIn(dom.container, text);
const typeBody = (text: string) => typeIntoTextArea(dom.container, text);

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

/** #767: the same editor now authors all three scopes, and start-from is a
 *  COPY. The assertions that matter are what reaches `saveLetter` — an `id`
 *  carried over from a starting point would OVERWRITE the source, and a scope
 *  key sent alongside another would be refused by the contract. */
describe("LetterEditorDialog scopes and start-from (#767)", () => {
  const standard = (): LetterRecord => ({
    id: "standard-1",
    createdAt: 1,
    updatedAt: 2,
    body: "My standard letter.",
  });

  const offer = () => [{ letter: standard(), label: "Your standard letter" }];

  it("saves a standard letter with NEITHER scope key when given neither prop", async () => {
    dom.render(<LetterEditorDialog open onClose={() => {}} onSaved={() => {}} />);
    typeBody("My story.");
    click("Save letter");
    await act(async () => {});

    const [input] = saveLetter.mock.calls[0]!;
    expect("jobId" in input).toBe(false);
    expect("companyKey" in input).toBe(false);
    expect(input.body).toBe("My story.");
  });

  it("saves a company letter with companyKey and no jobId", async () => {
    dom.render(
      <LetterEditorDialog
        open
        onClose={() => {}}
        companyKey="northwind"
        onSaved={() => {}}
      />,
    );
    typeBody("Why Northwind.");
    click("Save letter");
    await act(async () => {});

    const [input] = saveLetter.mock.calls[0]!;
    expect(input.companyKey).toBe("northwind");
    expect("jobId" in input).toBe(false);
  });

  it("never seeds without an explicit pick, however many offers it holds", () => {
    dom.render(
      <LetterEditorDialog
        open
        onClose={() => {}}
        jobId="job-1"
        startFrom={offer()}
        onSaved={() => {}}
      />,
    );
    // Offered, but the body is empty and Save is disabled — pre-filling would
    // put words the user never chose into a letter to an employer.
    expect(findButton("Your standard letter")).toBeTruthy();
    expect(dom.container.querySelector("textarea")!.value).toBe("");
    expect(findButton("Save letter")!.disabled).toBe(true);
  });

  it("picking a starting point copies the body and writes a NEW record", async () => {
    dom.render(
      <LetterEditorDialog
        open
        onClose={() => {}}
        jobId="job-1"
        startFrom={offer()}
        onSaved={() => {}}
      />,
    );
    click("Your standard letter");
    expect(dom.container.querySelector("textarea")!.value).toBe("My standard letter.");

    click("Save letter");
    await act(async () => {});
    const [input] = saveLetter.mock.calls[0]!;
    // The property the whole copy model rests on: no `id`, so `saveLetter`
    // inserts instead of upserting over `standard-1`.
    expect("id" in input).toBe(false);
    expect(input.jobId).toBe("job-1");
    expect(input.body).toBe("My standard letter.");
  });

  it("says the copy is a copy, naming the source, once picked", () => {
    dom.render(
      <LetterEditorDialog
        open
        onClose={() => {}}
        jobId="job-1"
        startFrom={offer()}
        onSaved={() => {}}
      />,
    );
    expect(dom.container.textContent).not.toContain("Started from");
    click("Your standard letter");
    const notice = dom.container.textContent ?? "";
    expect(notice).toContain("Started from Your standard letter");
    expect(notice).toContain("copy");
  });

  it("a caller-chosen seed fills the body on open, still with no id", async () => {
    // "Customize for this job" is the pick, made one dialog earlier.
    dom.render(
      <LetterEditorDialog
        open
        onClose={() => {}}
        jobId="job-1"
        seed={{ letter: standard(), label: "Your standard letter" }}
        onSaved={() => {}}
      />,
    );
    expect(dom.container.querySelector("textarea")!.value).toBe("My standard letter.");
    expect(dom.container.textContent).toContain("Started from");

    click("Save letter");
    await act(async () => {});
    const [input] = saveLetter.mock.calls[0]!;
    expect("id" in input).toBe(false);
    expect(input.jobId).toBe("job-1");
  });

  it("offers nothing to start from while REVISING, and keeps the record's own body", async () => {
    dom.render(
      <LetterEditorDialog
        open
        onClose={() => {}}
        jobId="job-1"
        letter={existing()}
        startFrom={offer()}
        seed={{ letter: standard(), label: "Your standard letter" }}
        onSaved={() => {}}
      />,
    );
    expect(findButton("Your standard letter")).toBeUndefined();
    // Revising wins over seeding — an existing letter's body is never replaced.
    expect(dom.container.querySelector("textarea")!.value).toBe("Original body.");

    click("Save letter");
    await act(async () => {});
    expect(saveLetter.mock.calls[0]![0].id).toBe("letter-1");
  });

  it("retires the picker once a starting point is taken, so a mis-click cannot wipe the draft", () => {
    // #767 review: `startFromLetter` replaces the whole body unconditionally,
    // and a controlled <textarea> has no undo across a re-render. A chip left on
    // screen after the pick is one mis-click from discarding everything typed
    // since.
    dom.render(
      <LetterEditorDialog
        open
        onClose={() => {}}
        jobId="job-1"
        startFrom={offer()}
        onSaved={() => {}}
      />,
    );
    click("Your standard letter");
    typeBody("Five hundred words of my own.");

    expect(findButton("Your standard letter")).toBeUndefined();
    expect(dom.container.querySelector("textarea")!.value).toBe(
      "Five hundred words of my own.",
    );
  });

  it("shows no picker in the seeded Customize flow either", () => {
    // Same hazard by the other route: `seed` sets `seededFrom` on open, so the
    // chip would otherwise render over an already-seeded body.
    dom.render(
      <LetterEditorDialog
        open
        onClose={() => {}}
        jobId="job-1"
        startFrom={offer()}
        seed={{ letter: standard(), label: "Your standard letter" }}
        onSaved={() => {}}
      />,
    );
    expect(findButton("Your standard letter")).toBeUndefined();
    expect(dom.container.textContent).toContain("Started from");
  });

  it("titles itself by scope, so the user knows which letter they are writing", () => {
    dom.render(<LetterEditorDialog open onClose={() => {}} onSaved={() => {}} />);
    expect(dom.container.textContent).toContain("Write your standard letter");

    dom.render(
      <LetterEditorDialog open onClose={() => {}} jobId="job-1" onSaved={() => {}} />,
    );
    expect(dom.container.textContent).toContain("Write a cover letter");
  });
});
