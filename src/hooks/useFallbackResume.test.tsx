// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `useFallbackResume` (#724): picks the most recently saved library résumé to
 * rate the Saved jobs tracker against when a direct visit to `/jobs/` never
 * received the `/` handoff. What matters here is the wiring — `active` gating
 * the handoff/fallback race, "most recent" selection, cancellation on unmount,
 * and NOT re-triggering a reload for an entries refresh that leaves the newest
 * id unchanged — not the library or parse internals, which are covered
 * elsewhere.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFallbackResume, type FallbackResumeLibrary } from "./useFallbackResume.ts";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";
import type { ResumeLibraryEntry, LoadedResume } from "../lib/resume-library.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function parsedFor(name: string): HeuristicParsedResume {
  return { skills: [name], experience: [], education: [] };
}

function entry(id: string, savedAt: number): ResumeLibraryEntry {
  return { id, filename: `${id}.pdf`, savedAt, scoreOverall: 80, sourceKind: "pdf" };
}

/** Just enough of `CascadeResult`/`LoadedResume` for the hook's one read
 *  (`loaded.result.canonical.fields`). */
function loadedFor(id: string): LoadedResume {
  const result = {
    canonical: { fields: parsedFor(id) },
  } as unknown as CascadeResult;
  return {
    id,
    filename: `${id}.pdf`,
    fileSize: 0,
    sourceKind: "pdf",
    result,
    score: { overall: 80 } as LoadedResume["score"],
  };
}

function makeLibrary(
  entries: ResumeLibraryEntry[],
  opts: { ready?: boolean; loadDelayMs?: number } = {},
): FallbackResumeLibrary & { load: ReturnType<typeof vi.fn> } {
  const load = vi.fn(async (id: string) => {
    if (opts.loadDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.loadDelayMs));
    }
    return loadedFor(id);
  });
  return { ready: opts.ready ?? true, entries, load };
}

let container: HTMLElement;
let root: Root;
let latest: ReturnType<typeof useFallbackResume> = undefined;

function Probe({
  active,
  library,
}: {
  active: boolean;
  library: FallbackResumeLibrary;
}) {
  latest = useFallbackResume(active, library);
  return null;
}

async function renderProbe(active: boolean, library: FallbackResumeLibrary) {
  await act(async () => {
    root.render(<Probe active={active} library={library} />);
  });
  for (let turn = 0; turn < 20; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  latest = undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useFallbackResume", () => {
  it("resolves to undefined when inactive (a real handoff is present)", async () => {
    const library = makeLibrary([entry("r1", 100)]);
    await renderProbe(false, library);
    expect(latest).toBeUndefined();
    expect(library.load).not.toHaveBeenCalled();
  });

  it("resolves to undefined when the library has no saved résumés", async () => {
    const library = makeLibrary([]);
    await renderProbe(true, library);
    expect(latest).toBeUndefined();
    expect(library.load).not.toHaveBeenCalled();
  });

  it("waits for the library to become ready before loading", async () => {
    const library = makeLibrary([entry("r1", 100)], { ready: false });
    await renderProbe(true, library);
    expect(latest).toBeUndefined();
    expect(library.load).not.toHaveBeenCalled();
  });

  it("loads the MOST RECENTLY SAVED entry, not the first in the list", async () => {
    const library = makeLibrary([entry("older", 100), entry("newer", 200)]);
    await renderProbe(true, library);
    expect(library.load).toHaveBeenCalledWith("newer");
    expect(latest).toEqual({ resumeId: "newer", parsed: parsedFor("newer") });
  });

  it("does not set state after unmount (cancellable)", async () => {
    const library = makeLibrary([entry("r1", 100)], { loadDelayMs: 20 });
    await act(async () => {
      root.render(<Probe active library={library} />);
    });
    // Unmount before the delayed `load()` resolves.
    act(() => root.unmount());
    // If the effect's cleanup did not cancel, the resolved `.then()` would call
    // `setState` on an unmounted component tree — React would warn/throw in a
    // dev build. Draining past the delay proves it either way.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    // No assertion needed beyond "this didn't throw" — recreate the container
    // so afterEach's unmount has something valid to act on.
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("does not re-load when entries refresh but the newest id is unchanged", async () => {
    const library = makeLibrary([entry("r1", 100)]);
    await renderProbe(true, library);
    expect(library.load).toHaveBeenCalledTimes(1);

    // A fresh array (as `useResumeLibrary`'s `setEntries` would hand down after
    // an unrelated refresh), same newest id.
    await renderProbe(true, { ...library, entries: [entry("r1", 100)] });
    expect(library.load).toHaveBeenCalledTimes(1);
  });

  /**
   * `load` can reject for real — it is an IndexedDB read, it calls
   * `blob.arrayBuffer()`, and on a stale-shape record it re-runs the cascade.
   * Without a `.catch()` the rejection is unhandled AND silent: the tracker
   * shows no ratings and nothing anywhere says why. Both halves are asserted,
   * because either one alone would go green on a fix that only did the other.
   */
  it("logs a failed load and leaks no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("IndexedDB read failed");
    const library: FallbackResumeLibrary = {
      ready: true,
      entries: [entry("r1", 100)],
      load: vi.fn(() => Promise.reject(boom)),
    };

    try {
      await renderProbe(true, library);
      // Node surfaces an unhandled rejection only once the microtask queue has
      // drained, so give it a macrotask turn before asserting there was none.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(consoleError).toHaveBeenCalledWith(
        "[useFallbackResume] library load failed:",
        boom,
      );
      expect(unhandled).toEqual([]);
      // No fallback is the right end state: rating against nothing beats rating
      // against a half-read résumé.
      expect(latest).toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      consoleError.mockRestore();
    }
  });

  it("re-loads when a newer résumé is saved", async () => {
    const library = makeLibrary([entry("r1", 100)]);
    await renderProbe(true, library);
    expect(latest?.resumeId).toBe("r1");

    await renderProbe(true, { ...library, entries: [entry("r1", 100), entry("r2", 200)] });
    expect(library.load).toHaveBeenCalledWith("r2");
    expect(latest?.resumeId).toBe("r2");
  });
});
