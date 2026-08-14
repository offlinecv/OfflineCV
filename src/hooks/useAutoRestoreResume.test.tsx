// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * useAutoRestoreResume (#812) — the cold-mount rehydration of `/`.
 *
 * The library is stubbed rather than driven through `fake-indexeddb`: every
 * behaviour worth pinning here is about WHEN the hook loads and whether it is
 * still allowed to apply the result when the read resolves, and a controllable
 * promise is the only way to hold a read open across a state change. The real
 * IndexedDB path is `resume-library.ts`'s own concern (covered there).
 *
 * The six ways this feature dies silently, all pinned below:
 *  - it never fires, so a returning user still faces an empty drop zone;
 *  - it fires again after `reset()`, so the results view cannot be dismissed;
 *  - it stays armed past the cold mount and ambushes an idle page when another
 *    tab saves a résumé;
 *  - it lands on top of a file the user dropped while the read was in flight;
 *  - it hydrates the wrong résumé over a pending tailor handoff, whose consumer
 *    then destroys the payload;
 *  - it throws on a rejecting `load` instead of leaving the app idle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode, createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAutoRestoreResume } from "./useAutoRestoreResume.ts";
import type { ResumeLibraryEntry, LoadedResume } from "../lib/resume-library.ts";
import { TAILOR_HANDOFF_KEY } from "../lib/tailor-handoff.ts";
import type { ParseState } from "./useResumeAnalysis.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const entry = (id: string, savedAt: number): ResumeLibraryEntry => ({
  id,
  filename: `${id}.pdf`,
  savedAt,
  scoreOverall: 71,
  sourceKind: "pdf",
  hasCachedParse: true,
});

/** A `LoadedResume` stub — only the identity fields are read by these tests;
 *  the parse/score payloads travel through untouched. */
const loaded = (id: string): LoadedResume =>
  ({
    id,
    filename: `${id}.pdf`,
    fileSize: 1234,
    sourceKind: "pdf",
    result: {},
    score: {},
  }) as unknown as LoadedResume;

interface Harness {
  onRestore: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  setPhase: (phase: ParseState["phase"]) => void;
  setReady: (ready: boolean) => void;
  setEntries: (entries: ResumeLibraryEntry[]) => void;
}

/**
 * Mount the hook under a probe whose `phase` / `library.ready` this test can
 * move. `render` is re-invoked (not remounted) so a phase change behaves the
 * way it does in `App` — a re-render of a still-mounted tree.
 */
function mount(
  options: {
    entries?: ResumeLibraryEntry[];
    ready?: boolean;
    phase?: ParseState["phase"];
    load?: ReturnType<typeof vi.fn>;
    strict?: boolean;
  } = {},
): Harness {
  const onRestore = vi.fn();
  const load =
    options.load ??
    vi.fn((id: string) => Promise.resolve<LoadedResume | undefined>(loaded(id)));
  let phase: ParseState["phase"] = options.phase ?? "idle";
  let ready = options.ready ?? true;
  let entries = options.entries ?? [entry("older", 1), entry("newest", 2)];

  function Probe() {
    useAutoRestoreResume({
      phase,
      library: { ready, entries, load },
      onRestore,
    });
    return null;
  }

  const paint = () => {
    const tree = createElement(Probe);
    act(() => root.render(options.strict ? createElement(StrictMode, null, tree) : tree));
  };
  paint();

  return {
    onRestore,
    load,
    setPhase: (next) => {
      phase = next;
      paint();
    },
    setReady: (next) => {
      ready = next;
      paint();
    },
    // A NEW array every time, the way `useResumeLibrary`'s `refresh()` mints
    // one — that fresh identity is what re-fires the restore effect.
    setEntries: (next) => {
      entries = next;
      paint();
    },
  };
}

/** Let the stubbed `load` promise settle. */
const settle = () => act(async () => {});

describe("useAutoRestoreResume", () => {
  it("restores the most recently saved résumé on a cold idle mount", async () => {
    const h = mount();
    await settle();
    expect(h.load).toHaveBeenCalledWith("newest");
    expect(h.onRestore).toHaveBeenCalledTimes(1);
    expect(h.onRestore.mock.calls[0][0].id).toBe("newest");
  });

  it("waits for the library before deciding there is nothing to restore", async () => {
    const h = mount({ ready: false });
    await settle();
    expect(h.load).not.toHaveBeenCalled();
    h.setReady(true);
    await settle();
    expect(h.onRestore).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the library is empty", async () => {
    const h = mount({ entries: [] });
    await settle();
    expect(h.load).not.toHaveBeenCalled();
    expect(h.onRestore).not.toHaveBeenCalled();
  });

  it("stays spent when a résumé is saved AFTER the empty library resolved", async () => {
    // The attempt is spent the moment the library first resolves, BEFORE the
    // empty-list check — move it below and this is the ambush that follows:
    // `useResumeLibrary` subscribes through `useLibraryChanges("resumes", …)`,
    // so a save in another tab mints a fresh `entries` array, re-fires this
    // effect, and hydrates a résumé over an idle page the user is standing on
    // long after arrival. This is a cold-mount restore, not a subscription.
    const h = mount({ entries: [] });
    await settle();
    expect(h.load).not.toHaveBeenCalled();

    h.setEntries([entry("saved-in-another-tab", 3)]);
    await settle();
    expect(h.load).not.toHaveBeenCalled();
    expect(h.onRestore).not.toHaveBeenCalled();
  });

  it("declines to restore while a tailor handoff is pending", async () => {
    // #812 S1. The payload names a SPECIFIC parse, and `consumeTailorHandoff`
    // clears the key even on a fingerprint mismatch — so a restored, unrelated
    // résumé's consumer would drain the steering rather than pass on it.
    // Pre-#812 a bfcache miss on the `/jobs/` → `/` return leg left `/` idle
    // with the payload intact and re-dropping the résumé still applied it;
    // restoring turns that recoverable state into an unrecoverable one.
    sessionStorage.setItem(
      TAILOR_HANDOFF_KEY,
      JSON.stringify({ jdContext: "Steer toward the JD", parseFingerprint: "deadbeef" }),
    );
    const h = mount();
    await settle();
    expect(h.load).not.toHaveBeenCalled();
    expect(h.onRestore).not.toHaveBeenCalled();
    // And the peek left it for its real consumer.
    expect(sessionStorage.getItem(TAILOR_HANDOFF_KEY)).not.toBeNull();
  });

  it("does not restore over a parse that is already on screen", async () => {
    // The bfcache return leg: the page comes back with its React state — and
    // its inline edits — intact. Restoring on top of that is data loss.
    const h = mount({ phase: "done" });
    await settle();
    expect(h.load).not.toHaveBeenCalled();
  });

  it("does NOT fire again after reset() returns the app to idle", async () => {
    // Without the spent-once guard the results view cannot be dismissed: every
    // "start over" re-hydrates the résumé the user just walked away from.
    const h = mount();
    await settle();
    expect(h.onRestore).toHaveBeenCalledTimes(1);

    h.setPhase("done");
    h.setPhase("idle");
    await settle();
    expect(h.onRestore).toHaveBeenCalledTimes(1);
    expect(h.load).toHaveBeenCalledTimes(1);
  });

  it("does not clobber a résumé dropped while the read was in flight", async () => {
    let release!: (value: LoadedResume | undefined) => void;
    const load = vi.fn(
      () => new Promise<LoadedResume | undefined>((res) => (release = res)),
    );
    const h = mount({ load });
    expect(load).toHaveBeenCalledTimes(1);

    // The user drops a file; the record lands a moment later.
    h.setPhase("parsing");
    h.setPhase("done");
    await act(async () => release(loaded("newest")));
    expect(h.onRestore).not.toHaveBeenCalled();
  });

  it("leaves the app idle when the load rejects, without throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi.fn(() => Promise.reject(new Error("IndexedDB is closed")));
    const h = mount({ load });
    await settle();
    expect(h.onRestore).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("treats an unreadable record as nothing to restore", async () => {
    const load = vi.fn(() => Promise.resolve(undefined));
    const h = mount({ load });
    await settle();
    expect(h.onRestore).not.toHaveBeenCalled();
  });

  it("restores exactly once under StrictMode's simulated remount", async () => {
    // The trap this guards: a per-effect `cancelled` flag tripped by the replay
    // cleanup, with the replayed setup declining to start a second load because
    // the attempt is already spent — dead under `npm run dev`, green in CI.
    const h = mount({ strict: true });
    await settle();
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.onRestore).toHaveBeenCalledTimes(1);
  });
});
