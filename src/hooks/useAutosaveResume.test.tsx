// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * useAutosaveResume (#824) — the ways autosaving a résumé loses or duplicates
 * the user's work.
 *
 * The library is stubbed rather than driven through `fake-indexeddb`: every
 * behaviour here is about WHEN a write happens and WHAT id it carries, and a
 * `vi.fn()` records both exactly. The write itself is `resume-library.ts`'s
 * concern and is covered there.
 *
 * Six failures, all pinned below:
 *  - it writes for a visitor who only looked, putting a résumé on the disk of
 *    someone who never asked for one;
 *  - it writes once per keystroke instead of once per quiet period;
 *  - a second résumé inherits the first one's record id and overwrites it;
 *  - a restored record is shadowed by a new one on the first edit, so the
 *    library grows by one entry per visit;
 *  - the header's state claims "Saved" while a write is still owed;
 *  - a store that rejects every write is retried every debounce window for the
 *    rest of the session instead of once per edit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useAutosaveResume,
  AUTOSAVE_DEBOUNCE_MS,
  type AutosaveResume,
  type AutosavableResume,
  type ResumeSaveState,
} from "./useAutosaveResume.ts";
import { trackResumeSaved } from "../lib/analytics.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import type { EditSnapshot } from "./useEditableParse.ts";

// `track()` short-circuits without VITE_POSTHOG_KEY, which is every test run, so
// the real tracker is unobservable. Stubbed to assert the one thing the event
// exists for: WHICH path produced the record.
vi.mock("../lib/analytics.ts", () => ({ trackResumeSaved: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.mocked(trackResumeSaved).mockClear();
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A parse. Opaque to this hook — only its object identity matters, which is
 *  the whole point: a fresh one stands for "the user edited", and the pristine
 *  one doubles as the `parseKey` the record id is bound to. */
const parse = (marker: string) => ({ marker }) as unknown as CascadeResult;
const score = (overall: number) => ({ overall }) as AnonymousAtsScore;

const resumeFor = (result: CascadeResult): AutosavableResume => ({
  filename: "cv.pdf",
  bytes: new ArrayBuffer(8),
  sourceKind: "pdf",
  result,
  score: score(70),
});

interface Harness {
  save: ReturnType<typeof vi.fn>;
  /** Re-render with a new set of inputs, as `App` re-renders on every edit. */
  update: (next: Partial<Props>) => void;
  /** Advance past one debounce window and let the write settle. */
  flush: () => Promise<void>;
  state: () => ResumeSaveState;
  api: () => AutosaveResume;
}

interface Props {
  parseKey: unknown;
  hasEdits: boolean;
  resume: AutosavableResume | null;
}

function mount(initial: Props): Harness {
  const save = vi.fn(async () => "record-1");
  let current: AutosaveResume | undefined;
  let props = initial;

  function Probe(p: Props) {
    current = useAutosaveResume({ library: { save }, ...p });
    return null;
  }

  const render = () => {
    act(() => root.render(createElement(Probe, props)));
  };
  render();

  return {
    save,
    update: (next) => {
      props = { ...props, ...next };
      render();
    },
    flush: async () => {
      await act(async () => {
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
      });
    },
    state: () => {
      if (!current) throw new Error("hook not mounted");
      return current.state;
    },
    api: () => {
      if (!current) throw new Error("hook not mounted");
      return current;
    },
  };
}

/**
 * Make every write fail, and hand back the trigger that delivers the rejection.
 *
 * The two halves matter. The stub must not settle on its own, so the rejection
 * arrives from OUTSIDE the render that started the write — which is what the
 * real `library.save` does, its first statement being
 * `await requestStoragePersistence()`. A stub that rejects synchronously
 * collapses `saving: true → false` into a single commit, the debounce effect's
 * deps never change, and the retry loop this covers cannot happen at all: the
 * test would pass against the defect rather than catch it.
 */
function rejectEveryWrite(h: Harness): () => Promise<void> {
  const pending: Array<(err: unknown) => void> = [];
  h.save.mockImplementation(
    () => new Promise<string>((_, reject) => pending.push(reject)),
  );
  return async () => {
    const rejects = pending.splice(0);
    await act(async () => {
      for (const reject of rejects) reject(new Error("quota exceeded"));
    });
  };
}

describe("useAutosaveResume: what triggers a write", () => {
  it("writes nothing for a parse the user never edited", async () => {
    const a = parse("a");
    const h = mount({ parseKey: a, hasEdits: false, resume: resumeFor(a) });
    await h.flush();
    // The privacy answer AND the storage answer: a visitor who drops a PDF,
    // reads the score and leaves creates no record at all.
    expect(h.save).not.toHaveBeenCalled();
    expect(h.state()).toBe("none");
  });

  it("creates exactly one record on the first edit, after the debounce", async () => {
    const a = parse("a");
    const h = mount({ parseKey: a, hasEdits: false, resume: resumeFor(a) });

    h.update({ hasEdits: true, resume: resumeFor(parse("a-edited")) });
    expect(h.save).not.toHaveBeenCalled();
    expect(h.state()).toBe("none");

    await h.flush();
    expect(h.save).toHaveBeenCalledTimes(1);
    // No id — this mints the record rather than updating one.
    expect(h.save.mock.calls[0][0]).toMatchObject({ id: undefined });
    expect(h.state()).toBe("saved");
  });

  it("collapses a burst of edits into one write per quiet period", async () => {
    const a = parse("a");
    const h = mount({ parseKey: a, hasEdits: false, resume: resumeFor(a) });

    for (const step of ["e1", "e2", "e3"]) {
      h.update({ hasEdits: true, resume: resumeFor(parse(step)) });
      act(() => {
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 50);
      });
    }
    expect(h.save).not.toHaveBeenCalled();

    await h.flush();
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it("updates the SAME record on every later edit", async () => {
    const a = parse("a");
    const h = mount({ parseKey: a, hasEdits: true, resume: resumeFor(parse("e1")) });
    await h.flush();
    h.update({ resume: resumeFor(parse("e2")) });
    await h.flush();

    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.save.mock.calls[1][0]).toMatchObject({
      id: "record-1",
      // The bytes behind an existing id cannot have changed — see
      // `saveResumeToLibrary`'s `bytesUnchanged`. Asserted here because this is
      // the only call site that sets it.
      bytesUnchanged: true,
    });
  });

  it("writes the result and score it was handed, recovered or not", async () => {
    // Constraint 3: `App` feeds this `activeResult` / `activeScore`, so a
    // recovery pass that landed BEFORE the edit is what reaches the record.
    const recovered = parse("llm-recovered");
    const h = mount({
      parseKey: parse("heuristic"),
      hasEdits: true,
      resume: { ...resumeFor(recovered), score: score(88) },
    });
    await h.flush();
    expect(h.save.mock.calls[0][0]).toMatchObject({
      result: recovered,
      score: { overall: 88 },
    });
  });
});

describe("useAutosaveResume: pristine base + delta pass-through (#768)", () => {
  const EMPTY_SNAPSHOT = {
    contactOverrides: {},
    experienceOverrides: {},
    bulletOverrides: {},
    removedBullets: [],
    educationOverrides: {},
    skillsOverride: { removed: [], added: [] },
    addedEntries: [],
    addedBullets: {},
  } as unknown as EditSnapshot;

  it("carries baseResult and edit through to the library write when present", async () => {
    const a = parse("a");
    const base = parse("base-a");
    const edit = { ...EMPTY_SNAPSHOT, contactOverrides: { full_name: "Edited" } };
    const h = mount({
      parseKey: a,
      hasEdits: true,
      resume: { ...resumeFor(parse("e1")), baseResult: base, edit },
    });
    await h.flush();
    expect(h.save.mock.calls[0][0]).toMatchObject({
      baseResult: base,
      edit,
    });
  });

  it("omits baseResult and edit when the caller passes neither (the LLM-recovered branch)", async () => {
    const a = parse("a");
    const h = mount({ parseKey: a, hasEdits: true, resume: resumeFor(parse("e1")) });
    await h.flush();
    expect(h.save.mock.calls[0][0].baseResult).toBeUndefined();
    expect(h.save.mock.calls[0][0].edit).toBeUndefined();
  });

  it("writes the latest delta on the next edit's write, same as result", async () => {
    const a = parse("a");
    const base = parse("base-a");
    const h = mount({
      parseKey: a,
      hasEdits: true,
      resume: { ...resumeFor(parse("e1")), baseResult: base, edit: EMPTY_SNAPSHOT },
    });
    await h.flush();
    expect(h.save).toHaveBeenCalledTimes(1);

    const nextEdit = { ...EMPTY_SNAPSHOT, contactOverrides: { full_name: "X" } };
    h.update({
      resume: { ...resumeFor(parse("e2")), baseResult: base, edit: nextEdit },
    });
    await h.flush();
    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.save.mock.calls[1][0]).toMatchObject({ edit: nextEdit });
  });

  it("adopting WITH a delta writes nothing until a genuine edit follows it", async () => {
    // The restore sequence `hydrateFromLibrary` runs for a delta-carrying
    // record: `adopt` is handed the delta it is about to replay, and the
    // caller's very next render already has `hasEdits: true` — the replay,
    // not a user action. Without the fix this reads as dirty on that render
    // and schedules a spurious write + `trackResumeSaved`.
    const restoredEdit = { ...EMPTY_SNAPSHOT, contactOverrides: { full_name: "Riley" } };
    const base = parse("base-restored");
    const h = mount({ parseKey: null, hasEdits: false, resume: null });
    act(() => h.api().adopt(base, "record-from-library", restoredEdit));

    // The render `useAnalyzedResume`'s reset-and-replay effect fires in
    // (#768's docblock): `parseKey` has already flipped to the restored base,
    // `hasEdits` is already true, but the live snapshot has not caught up to
    // `restoredEdit` yet (the effect that will replay it runs AFTER this
    // commit, in the SAME flush as this hook's own catch-up effect).
    h.update({
      parseKey: base,
      hasEdits: true,
      resume: { ...resumeFor(parse("mid-replay")), baseResult: base, edit: EMPTY_SNAPSHOT },
    });
    expect(h.state()).toBe("saved");

    // The replay lands: the live snapshot now matches what was restored.
    h.update({
      resume: { ...resumeFor(parse("post-replay")), baseResult: base, edit: restoredEdit },
    });
    expect(h.state()).toBe("saved");
    await h.flush();
    expect(h.save).not.toHaveBeenCalled();

    // A genuine edit on top of the restored delta is the only thing that
    // should ever write.
    const editedSnapshot = { ...restoredEdit, contactOverrides: { full_name: "Riley Edited" } };
    h.update({
      resume: { ...resumeFor(parse("edited")), baseResult: base, edit: editedSnapshot },
    });
    await h.flush();
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save.mock.calls[0][0]).toMatchObject({
      id: "record-from-library",
      edit: editedSnapshot,
    });
  });

  it("adopting a delta with an added entry does not fire a spurious write on replay", async () => {
    // Regression (#768 review): `replay()` mints a FRESH id for every added
    // entry and profile extra (`useEditableParse.ts`'s `addEntry`/
    // `addProfile`) rather than reusing the id the snapshot was written with.
    // A comparison that expected the post-replay snapshot to be byte-for-byte
    // the one that was adopted would never match, fall through to the one-tick
    // escape hatch, and fire a write + `trackResumeSaved` on every restore of a
    // record with an added entry — exactly the write this adopt exists to
    // prevent.
    const restoredEdit = {
      ...EMPTY_SNAPSHOT,
      addedEntries: [{ id: "added:0", section: "experience", title: "Role" }],
    } as unknown as EditSnapshot;
    const base = parse("base-restored");
    const h = mount({ parseKey: null, hasEdits: false, resume: null });
    act(() => h.api().adopt(base, "record-from-library", restoredEdit));

    h.update({
      parseKey: base,
      hasEdits: true,
      resume: { ...resumeFor(parse("mid-replay")), baseResult: base, edit: EMPTY_SNAPSHOT },
    });
    expect(h.state()).toBe("saved");

    // The replay lands with the SAME content, under a re-minted id — this is
    // what a real `replay()` call over `restoredEdit` actually produces.
    const replayedEdit = {
      ...EMPTY_SNAPSHOT,
      addedEntries: [{ id: "added:7", section: "experience", title: "Role" }],
    } as unknown as EditSnapshot;
    h.update({
      resume: { ...resumeFor(parse("post-replay")), baseResult: base, edit: replayedEdit },
    });
    expect(h.state()).toBe("saved");
    // Two windows, as in "gives up waiting…" below: one for the bounded
    // escape hatch's own 0ms timer, one for the real debounce it would arm if
    // this comparison failed to recognise the replay as complete.
    await h.flush();
    await h.flush();
    expect(h.save).not.toHaveBeenCalled();
    expect(trackResumeSaved).not.toHaveBeenCalled();
  });

  it("gives up waiting for the replay and still writes, if `resume.edit` never matches", async () => {
    // Nothing guarantees the live snapshot ever reaches the exact shape it
    // was adopted with — e.g. the LLM-recovered branch drops `edit` from
    // `resume` entirely (`App.tsx`'s `useAutosaveResume` call). Waiting on a
    // match forever would silently suppress every future write for this
    // parse, which is worse than the one spurious write the content-match
    // guard exists to avoid — so it bails out after one tick.
    const restoredEdit = { ...EMPTY_SNAPSHOT, contactOverrides: { full_name: "Riley" } };
    const base = parse("base-restored");
    const h = mount({ parseKey: null, hasEdits: false, resume: null });
    act(() => h.api().adopt(base, "record-from-library", restoredEdit));

    // `resume.edit` is never supplied again — the caller's snapshot never
    // catches up to what was adopted with.
    h.update({ parseKey: base, hasEdits: true, resume: resumeFor(parse("recovered")) });
    expect(h.state()).toBe("saved");

    // Two windows: one for the fallback's own 0ms timer to give up and arm
    // the real debounce, one for that debounce itself to elapse.
    await h.flush();
    await h.flush();
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save.mock.calls[0][0]).toMatchObject({ id: "record-from-library" });
  });
});

describe("useAutosaveResume: record identity", () => {
  it("does not carry a record id onto the NEXT résumé", async () => {
    const a = parse("a");
    const h = mount({ parseKey: a, hasEdits: true, resume: resumeFor(parse("a1")) });
    await h.flush();
    expect(h.save.mock.calls[0][0]).toMatchObject({ id: undefined });

    // A genuinely new résumé: a fresh `parseKey`, which is exactly what
    // `useAnalyzedResume` mints on a drop, a replace or a library load.
    const b = parse("b");
    h.update({ parseKey: b, hasEdits: false, resume: resumeFor(b) });
    expect(h.state()).toBe("none");

    h.update({ hasEdits: true, resume: resumeFor(parse("b1")) });
    await h.flush();
    // A NEW record. Had the id leaked, the second résumé would have silently
    // overwritten the record holding the first.
    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.save.mock.calls[1][0]).toMatchObject({ id: undefined });
  });

  it("updates an adopted record instead of minting a second one", async () => {
    // The restore sequence exactly as `App` runs it: `adopt` fires in the same
    // event as the hydration, keyed by the parse that is about to BE `parseKey`.
    const restored = parse("restored");
    const h = mount({ parseKey: null, hasEdits: false, resume: null });
    act(() => h.api().adopt(restored, "record-from-library"));
    h.update({ parseKey: restored, hasEdits: false, resume: resumeFor(restored) });

    // Nothing owed: the record on disk IS what was just loaded from it.
    expect(h.state()).toBe("saved");
    await h.flush();
    expect(h.save).not.toHaveBeenCalled();

    h.update({ hasEdits: true, resume: resumeFor(parse("restored-edited")) });
    await h.flush();
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save.mock.calls[0][0]).toMatchObject({ id: "record-from-library" });
  });

  it("drops an adopted id when a different résumé arrives", async () => {
    const restored = parse("restored");
    const h = mount({ parseKey: null, hasEdits: false, resume: null });
    act(() => h.api().adopt(restored, "record-from-library"));

    const dropped = parse("dropped");
    h.update({ parseKey: dropped, hasEdits: true, resume: resumeFor(parse("d1")) });
    await h.flush();
    expect(h.save.mock.calls[0][0]).toMatchObject({ id: undefined });
  });
});

describe("useAutosaveResume: what the header states", () => {
  it("says Unsaved changes for the whole window a write is owed", async () => {
    const a = parse("a");
    const h = mount({ parseKey: a, hasEdits: true, resume: resumeFor(parse("e1")) });
    await h.flush();
    expect(h.state()).toBe("saved");

    // Typed again: a record exists AND a write is owed. Claiming "Saved" here
    // would be a statement about the user's disk that is not yet true.
    h.update({ resume: resumeFor(parse("e2")) });
    expect(h.state()).toBe("unsaved");
    await h.flush();
    expect(h.state()).toBe("saved");
  });

  it("saves on the explicit header action with no edit at all", async () => {
    const a = parse("a");
    const h = mount({ parseKey: a, hasEdits: false, resume: resumeFor(a) });
    await act(async () => h.api().save());
    expect(h.save).toHaveBeenCalledTimes(1);
    // The action is gone once a record exists — the badge carries it from here.
    expect(h.state()).toBe("saved");
  });

  it("reports which path produced the record", async () => {
    // The whole content of `resume_saved` (#824): autosave changes the SHAPE of
    // the answer to "does anyone keep a résumé", since most records are now
    // created by editing rather than by clicking, and `source` is what
    // separates the two.
    const a = parse("a");
    const h = mount({ parseKey: a, hasEdits: false, resume: resumeFor(a) });
    await act(async () => h.api().save());
    expect(trackResumeSaved).toHaveBeenLastCalledWith({ source: "header" });

    h.update({ hasEdits: true, resume: resumeFor(parse("a1")) });
    await h.flush();
    expect(trackResumeSaved).toHaveBeenLastCalledWith({ source: "autosave" });
  });

  it("keeps claiming the work is unsaved when the write rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = parse("a");
    const h = mount({ parseKey: a, hasEdits: false, resume: resumeFor(a) });
    h.save.mockRejectedValueOnce(new Error("quota exceeded"));

    await act(async () => h.api().save());
    // A swallowed failure that still said "Saved" is the one outcome worth
    // ruling out: the user would close the tab on a promise nothing kept.
    expect(h.state()).toBe("none");
  });

  it("attempts a rejected autosave once, not once per debounce window", async () => {
    // A store that rejects everything — Safari Private Browsing, or an origin
    // at quota. The failure moves none of the dirty inputs (by design: the
    // header must keep saying "unsaved"), so without the failure record the
    // effect re-arms off its own `saving: true → false` transition and retries
    // twice a second for the rest of the session, each round trip asking for
    // storage persistence and flickering the badge.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = parse("a");
    const h = mount({ parseKey: a, hasEdits: true, resume: resumeFor(parse("e1")) });
    const settle = rejectEveryWrite(h);

    await h.flush();
    expect(h.save).toHaveBeenCalledTimes(1);
    await settle();
    // Still truthful about the disk, and the explicit action is still offered.
    expect(h.state()).toBe("none");

    // Several more windows with no input from the user.
    for (let i = 0; i < 5; i++) {
      await h.flush();
      await settle();
    }
    expect(h.save).toHaveBeenCalledTimes(1);

    // An edit is the only thing that can change the answer, and it re-arms the
    // retry for free — a fresh `result` no longer matches the one that failed.
    h.update({ resume: resumeFor(parse("e2")) });
    await h.flush();
    expect(h.save).toHaveBeenCalledTimes(2);
    await settle();
    for (let i = 0; i < 5; i++) {
      await h.flush();
      await settle();
    }
    expect(h.save).toHaveBeenCalledTimes(2);
  });

  it("goes back to Saved once a write after a failure succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = parse("a");
    const h = mount({ parseKey: a, hasEdits: true, resume: resumeFor(parse("e1")) });
    const settle = rejectEveryWrite(h);

    await h.flush();
    await settle();
    expect(h.state()).toBe("none");

    // The store recovers (the user closed a tab, the quota freed up) and the
    // next edit's write lands: the failure record must not outlive it.
    h.save.mockImplementation(async () => "record-1");
    h.update({ resume: resumeFor(parse("e2")) });
    await h.flush();
    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.state()).toBe("saved");
  });
});
