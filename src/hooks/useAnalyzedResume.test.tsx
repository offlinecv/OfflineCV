// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Behavioral tests for `useAnalyzedResume`'s from-scratch authoring flow
 * (#313), exercised through a probe component (the project has no
 * @testing-library/react — same pattern as the other hook tests, e.g.
 * `useReplaceResumeOnDrop.test.tsx`).
 *
 * Covers: `startBlank()` seeds an empty, fully editable `edited`/`displayResult`
 * with the score ring hidden; live edits (contact + an added experience entry
 * + bullet) flip the reveal predicate and re-grade the score; the "clear
 * edits" effect doesn't wipe a resumed draft; and the draft persists across a
 * simulated reload (a fresh hook mount) until the user resolves the prompt.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAnalyzedResume, type AnalyzedResume } from "./useAnalyzedResume.ts";
import { isScoreRevealed } from "../lib/contact.ts";
import { BLANK_DRAFT_STORAGE_KEY } from "./useResumeAnalysis.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;
let api: AnalyzedResume;

function Probe() {
  api = useAnalyzedResume();
  return null;
}

function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
}

function unmount(): void {
  act(() => root.unmount());
  container.remove();
}

beforeEach(() => {
  mount();
});

afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useAnalyzedResume — from-scratch authoring (#313)", () => {
  it("starts idle with no edited/displayResult", () => {
    expect(api.state.phase).toBe("idle");
    expect(api.edited).toBeNull();
    expect(api.displayResult).toBeNull();
  });

  it("startBlank() with no saved draft mounts an empty, revealed=false editor", () => {
    act(() => api.startBlank());

    expect(api.state.phase).toBe("authoring");
    expect(api.state.phase === "authoring" && api.state.pendingDraft).toBeNull();
    expect(api.edited).not.toBeNull();
    expect(api.edited?.parsed.experience).toEqual([]);
    expect(api.edited?.parsed.skills).toEqual([]);
    expect(api.displayResult).not.toBeNull();
    expect(
      isScoreRevealed(api.displayResult!, api.edit.contactOverrides),
    ).toBe(false);
  });

  it("adding contact + an experience entry + a bullet reveals and re-grades the score live", () => {
    act(() => api.startBlank());

    act(() => {
      api.edit.setContactField("full_name", "Jane Doe");
      api.edit.setContactField("email", "jane@example.com");
    });
    // Contact alone isn't enough — no experience yet.
    expect(
      isScoreRevealed(api.displayResult!, api.edit.contactOverrides),
    ).toBe(false);

    let entryId = "";
    act(() => {
      entryId = api.edit.addEntry("experience");
      api.edit.setEntryField(entryId, "title", "Software Engineer");
      api.edit.setEntryField(entryId, "subtitle", "Acme Corp");
      api.edit.addBullet(entryId, "Shipped a feature that grew revenue 20%");
    });

    expect(
      isScoreRevealed(api.displayResult!, api.edit.contactOverrides),
    ).toBe(true);
    expect(api.edited?.parsed.experience).toHaveLength(1);
    expect(api.edited?.parsed.experience[0].title).toBe("Software Engineer");
    expect(api.edited?.score.overall).toBeGreaterThan(0);
  });

  it("the same reveal predicate applies to a 'done' (upload) result", () => {
    // A sparse/failed parse — missing contact — should not reveal the ring
    // even though it came from an upload, not from-scratch authoring.
    const bareCascade = {
      parsed: { skills: [], experience: [], education: [] },
      fieldConfidence: {},
    };
    expect(isScoreRevealed(bareCascade, undefined)).toBe(false);
    expect(
      isScoreRevealed(bareCascade, {
        full_name: "Jane Doe",
        email: "jane@example.com",
      }),
    ).toBe(false); // still no experience
  });

  it("reset() returns to idle, clears edits, and clears the persisted draft", () => {
    act(() => api.startBlank());
    act(() => api.edit.setContactField("full_name", "Jane Doe"));
    expect(api.edit.hasEdits).toBe(true);

    act(() => api.reset());

    expect(api.state.phase).toBe("idle");
    expect(api.edited).toBeNull();
    expect(localStorage.getItem(BLANK_DRAFT_STORAGE_KEY)).toBeNull();
  });
});

describe("useAnalyzedResume — draft persistence across reload (#313)", () => {
  it("autosaves the draft (debounced) once there are edits, not before", () => {
    vi.useFakeTimers();
    act(() => api.startBlank());
    expect(localStorage.getItem(BLANK_DRAFT_STORAGE_KEY)).toBeNull();

    act(() => api.edit.setContactField("full_name", "Jane Doe"));
    // Not yet — still inside the debounce window.
    expect(localStorage.getItem(BLANK_DRAFT_STORAGE_KEY)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(600);
    });
    const saved = localStorage.getItem(BLANK_DRAFT_STORAGE_KEY);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).contactOverrides.full_name).toBe("Jane Doe");
  });

  it("a fresh mount (simulated reload) surfaces a resume-vs-start-over prompt instead of silently restoring", () => {
    vi.useFakeTimers();
    act(() => api.startBlank());
    let entryId = "";
    act(() => {
      api.edit.setContactField("full_name", "Jane Doe");
      api.edit.setContactField("email", "jane@example.com");
      entryId = api.edit.addEntry("experience");
      api.edit.setEntryField(entryId, "title", "Engineer");
      api.edit.addBullet(entryId, "Did a thing that mattered a lot honestly");
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(localStorage.getItem(BLANK_DRAFT_STORAGE_KEY)).not.toBeNull();

    // Simulate a reload: unmount and mount a brand-new hook instance —
    // nothing carries over except localStorage.
    unmount();
    vi.useRealTimers();
    mount();

    expect(api.state.phase).toBe("idle"); // nothing shown until re-entering authoring
    act(() => api.startBlank());

    expect(api.state.phase).toBe("authoring");
    expect(api.state.phase === "authoring" && api.state.pendingDraft).not.toBeNull();
    // The editor must not be mounted yet — no silent restore.
    expect(api.edited).toBeNull();
  });

  it("resumeDraft() replays the saved overrides and clears the prompt", () => {
    vi.useFakeTimers();
    act(() => api.startBlank());
    let entryId = "";
    act(() => {
      api.edit.setContactField("full_name", "Jane Doe");
      api.edit.setContactField("email", "jane@example.com");
      entryId = api.edit.addEntry("experience");
      api.edit.setEntryField(entryId, "title", "Engineer");
      api.edit.addBullet(entryId, "Did a thing that mattered a lot honestly");
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });

    unmount();
    vi.useRealTimers();
    mount();
    act(() => api.startBlank());
    expect(api.state.phase === "authoring" && api.state.pendingDraft).not.toBeNull();

    act(() => api.resumeDraft());

    expect(api.state.phase === "authoring" && api.state.pendingDraft).toBeNull();
    expect(api.edited?.parsed.experience).toHaveLength(1);
    expect(api.edited?.parsed.experience[0].title).toBe("Engineer");
    expect(
      isScoreRevealed(api.displayResult!, api.edit.contactOverrides),
    ).toBe(true);
  });

  it("startOverBlank() discards the saved draft and starts fresh (blank, empty)", () => {
    vi.useFakeTimers();
    act(() => api.startBlank());
    act(() => api.edit.setContactField("full_name", "Jane Doe"));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(localStorage.getItem(BLANK_DRAFT_STORAGE_KEY)).not.toBeNull();

    unmount();
    vi.useRealTimers();
    mount();
    act(() => api.startBlank());
    expect(api.state.phase === "authoring" && api.state.pendingDraft).not.toBeNull();

    act(() => api.startOverBlank());

    expect(api.state.phase === "authoring" && api.state.pendingDraft).toBeNull();
    expect(localStorage.getItem(BLANK_DRAFT_STORAGE_KEY)).toBeNull();
    expect(api.edited?.parsed.experience).toEqual([]);
    expect(api.edit.contactOverrides).toEqual({});
  });
});

describe("useAnalyzedResume — score memo scoped to scoring inputs (#428)", () => {
  function seedRevealedResume(): void {
    act(() => api.startBlank());
    act(() => {
      api.edit.setContactField("full_name", "Jane Doe");
      api.edit.setContactField("email", "jane@example.com");
      const entryId = api.edit.addEntry("experience");
      api.edit.setEntryField(entryId, "title", "Software Engineer");
      api.edit.setEntryField(entryId, "subtitle", "Acme Corp");
      api.edit.addBullet(entryId, "Shipped a feature that grew revenue 20%");
    });
  }

  it("adding a non-scoring profile (Behance) leaves the score object untouched", () => {
    seedRevealedResume();
    const scoreBefore = api.edited?.score;
    expect(scoreBefore).toBeDefined();

    act(() => {
      api.edit.addProfile("https://behance.net/janedoe");
    });

    // The extra shows up in edit state (ContactExtraLinks reads this
    // directly), but it never reaches the scorer — no legacy slot moved.
    expect(api.edit.profileOverrides).toHaveLength(1);
    expect(api.edited?.score).toBe(scoreBefore);
  });

  it("a scoring correction (GitHub) DOES move and re-run the score", () => {
    seedRevealedResume();
    const scoreBefore = api.edited?.score;
    expect(scoreBefore).toBeDefined();

    act(() => {
      api.edit.setLegacyLink("github_url", "https://github.com/janedoe");
    });

    expect(api.edited?.score).not.toBe(scoreBefore);
    expect(api.edited?.parsed.github_url).toBe("https://github.com/janedoe");
  });
});
