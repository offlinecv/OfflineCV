// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * #929 end-to-end: revising a producer-written letter through
 * `LetterEditorDialog` must not turn off the egress acknowledgement gate for
 * it. Unlike `LetterEditorDialog.test.tsx`, storage is NOT mocked here — the
 * point is to drive the real `save()` → `updateLetter` → `letters` store path
 * and then ask the real gate (`letterEgressNeedsAck`, `JobLetterIndicator`'s
 * own predicate) whether the record that came back still needs one, rather
 * than asserting `producer !== undefined` on the record by hand. A test that
 * only inspected the record's shape would not have caught the #929 bug either:
 * the mechanism it reproduces is a caller (this dialog) sending a partial
 * write, and the store silently completing it — the record shape after a BAD
 * fix (e.g. a stopgap `...letter` spread that also happens to drop the flag
 * some other field depends on) could still look right to a hand check.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { LetterEditorDialog } from "./LetterEditorDialog.tsx";
import { letterEgressNeedsAck } from "./LetterEgressAckDialog.tsx";
import { DB_NAME, closeDB } from "../../lib/storage/db.ts";
import { saveLetter, getLetter, getAllLetters } from "../../lib/storage/index.ts";
import {
  clickButtonIn,
  installDialogPolyfill,
  setupDomRoot,
  typeIntoTextArea,
} from "./__test-utils__/dialog-dom.ts";

installDialogPolyfill();
const dom = setupDomRoot();

/** Flush the real IndexedDB write `save()` kicks off, plus the state updates
 *  it makes once it resolves — several `setTimeout` rounds, not the single
 *  microtask turn an already-resolved mocked promise would need, and enough
 *  rounds to hold under load. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
});

describe("LetterEditorDialog x real storage: the egress gate survives an edit (#929)", () => {
  it("still needs acknowledgement after a revise, because producer rode through the merge", async () => {
    const original = await saveLetter({
      jobId: "job-1",
      body: "Outside-drafted text.",
      producer: { contract: 1, producer: "some-outside-producer" },
    });
    expect(letterEgressNeedsAck([original])).toBe(true);

    dom.render(
      <LetterEditorDialog
        open
        onClose={() => {}}
        jobId="job-1"
        letter={original}
        onSaved={() => {}}
      />,
    );
    typeIntoTextArea(dom.container, "The user's own revision.");
    clickButtonIn(dom.container, "Save letter");
    await flush();

    const revised = await getLetter(original.id);
    expect(revised?.body).toBe("The user's own revision.");
    // The real gate, asked about the real post-edit record — not a field
    // check the test wrote itself.
    expect(letterEgressNeedsAck([revised])).toBe(true);
  });

  it("a letter this app composes from scratch still needs no acknowledgement", async () => {
    dom.render(
      <LetterEditorDialog open onClose={() => {}} jobId="job-2" onSaved={() => {}} />,
    );
    typeIntoTextArea(dom.container, "Dear hiring team,");
    clickButtonIn(dom.container, "Save letter");
    await flush();

    const [saved] = await getAllLetters();
    expect(letterEgressNeedsAck([saved])).toBe(false);
  });
});
