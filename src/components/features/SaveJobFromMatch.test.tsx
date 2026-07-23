// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * SaveJobFromMatch (#323 AC, "JD-match flow offers 'save as tracked job' and
 * carries the match result onto the job record"). Asserts the three things the
 * seam promises: the click reaches `saveFromMatch`, the JD text and match
 * result ride along with a title seeded from the JD, the button collapses to a
 * confirmation so a second click can't double-save the same posting, that
 * confirmation is keyed to its JD so a pasted-over posting is saveable, and a
 * failed write says so instead of looking like a success.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SaveJobFromMatch } from "./SaveJobFromMatch.tsx";
import type { JobTracker as Tracker } from "../../hooks/useJobTracker.ts";
import type { JdMatchResult } from "../../lib/jd-match";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const MATCH = {
  path: "keyword",
  coverage: { covered: [], missing: [] },
  terms: ["typescript"],
  nounsDropped: 0,
} as unknown as JdMatchResult;

const JD = "Staff Frontend Engineer\nAcme Inc\n\nWe are looking for...";

function makeTracker(): Tracker {
  return {
    jobs: [],
    ready: true,
    persisted: true,
    usageBytes: null,
    create: vi.fn(async () => "new-id"),
    update: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    link: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    saveFromMatch: vi.fn(async () => "new-id"),
    exportBackup: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  };
}

async function clickSave() {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Save as tracked job"),
  );
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return button;
}

describe("SaveJobFromMatch", () => {
  it("carries the JD text and match result onto the saved job", async () => {
    const tracker = makeTracker();
    await act(async () => {
      root.render(
        <SaveJobFromMatch tracker={tracker} jdText={JD} matchResult={MATCH} />,
      );
    });

    await clickSave();

    expect(tracker.saveFromMatch).toHaveBeenCalledWith({
      title: "Staff Frontend Engineer",
      jdText: JD,
      matchResult: MATCH,
    });
  });

  it("collapses to a confirmation so the same posting can't be double-saved", async () => {
    const tracker = makeTracker();
    await act(async () => {
      root.render(
        <SaveJobFromMatch tracker={tracker} jdText={JD} matchResult={MATCH} />,
      );
    });

    await clickSave();

    expect(container.textContent).toContain("Saved to your tracked jobs");
    expect(
      [...container.querySelectorAll("button")].some((b) =>
        b.textContent?.startsWith("Save as tracked job"),
      ),
    ).toBe(false);
    expect(tracker.saveFromMatch).toHaveBeenCalledTimes(1);
  });

  it("offers Save again when the user pastes a different JD (no unmount)", async () => {
    const tracker = makeTracker();
    await act(async () => {
      root.render(
        <SaveJobFromMatch tracker={tracker} jdText={JD} matchResult={MATCH} />,
      );
    });
    await clickSave();
    expect(container.textContent).toContain("Saved to your tracked jobs");

    // Select-all + paste takes jdText A -> B in one change event, so jdMatch
    // never passes through null and JdFitApp never unmounts this component.
    await act(async () => {
      root.render(
        <SaveJobFromMatch
          tracker={tracker}
          jdText={"Staff Backend Engineer\nGlobex\n\nDifferent posting..."}
          matchResult={MATCH}
        />,
      );
    });

    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Save as tracked job"),
    );
    expect(button).toBeDefined();
  });

  it("surfaces a failed save instead of silently re-enabling the button", async () => {
    const tracker = makeTracker();
    tracker.saveFromMatch = vi.fn(async () => {
      throw new Error("QuotaExceededError");
    });
    await act(async () => {
      root.render(
        <SaveJobFromMatch tracker={tracker} jdText={JD} matchResult={MATCH} />,
      );
    });

    await clickSave();

    expect(container.textContent).toContain("Couldn't save");
    expect(container.textContent).not.toContain("Saved to your tracked jobs");
    // Still offered, so the user can retry rather than being stuck.
    expect(
      [...container.querySelectorAll("button")].some((b) =>
        b.textContent?.startsWith("Save as tracked job"),
      ),
    ).toBe(true);
  });
});
