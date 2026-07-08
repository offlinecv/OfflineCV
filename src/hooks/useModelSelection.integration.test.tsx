// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Integration test for `useModelSelection`'s cross-instance propagation
 * contract. The bug this guards against: per-instance `useState` would mean
 * a write in one consumer (the picker) isn't observed by other consumers
 * (already-mounted `SectionRewrite` / `ResumeRewrite` instances) in the
 * same tab — because the `storage` event fires only in OTHER same-origin
 * tabs, not the writing one. Two consumers mount in one root; writes from
 * one are asserted on the other.
 *
 * Runs in jsdom (not the project's default Node env, per the
 * `@vitest-environment jsdom` pragma) so React + `react-dom/client` have a
 * window/document to render into. The store-shape lives in
 * `useModelSelection.ts`; the Node-env tests in `useModelSelection.test.ts`
 * cover the pure I/O surface. This file covers the React surface.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

// React 19's `act` checks this flag to decide whether to suppress its
// "testing environment is not configured" warning. Setting it on the
// global is the documented opt-in for non-RTL test setups.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import {
  _resetPersistedModelSelectionForTesting,
  useModelSelection,
} from "./useModelSelection.ts";
import { MODEL_REGISTRY } from "../lib/webllm/models.ts";
import type { LicenseType } from "../lib/webllm/models.ts";
import { installMemoryLocalStorage } from "./__test-utils__/memory-storage.ts";

const restrictedModel = MODEL_REGISTRY.find(
  (m) => m.licenseType === "Restricted-Community",
)!;

interface CapturedState {
  selectedModelId: string;
  setSelectedModelId: (id: string) => void;
  consentRestricted: boolean;
  recordConsent: (lt: LicenseType) => void;
}

function Probe({
  onState,
}: {
  onState: (s: CapturedState) => void;
}): ReactNode {
  const { selectedModelId, setSelectedModelId, hasConsent, recordConsent } =
    useModelSelection();
  onState({
    selectedModelId,
    setSelectedModelId,
    consentRestricted: hasConsent("Restricted-Community"),
    recordConsent,
  });
  // Render the current value so a DOM assertion can confirm React actually
  // re-rendered (not just the captured callback closure).
  return createElement("div", { "data-testid": "selected" }, selectedModelId);
}

beforeEach(() => {
  // Node 22+ ships a built-in global `localStorage` that shadows jsdom's
  // `Storage` and exposes no working methods, so install a fresh in-memory
  // shim per test rather than depending on the runtime's global (#398).
  installMemoryLocalStorage();
  _resetPersistedModelSelectionForTesting();
});

describe("useModelSelection — cross-instance propagation (same tab)", () => {
  it("setSelectedModelId from consumer A is observed by consumer B mounted in the same tree", async () => {
    let stateA: CapturedState | undefined;
    let stateB: CapturedState | undefined;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(Probe, {
            key: "a",
            onState: (s) => {
              stateA = s;
            },
          }),
          createElement(Probe, {
            key: "b",
            onState: (s) => {
              stateB = s;
            },
          }),
        ),
      );
    });

    // Both consumers start on the default — same snapshot.
    expect(stateA?.selectedModelId).toBe(stateB?.selectedModelId);
    const initial = stateA!.selectedModelId;
    expect(initial).not.toBe(restrictedModel.id);

    // Consumer A writes (simulating the picker).
    await act(async () => {
      stateA!.setSelectedModelId(restrictedModel.id);
    });

    // Consumer B (e.g. a `SectionRewrite` mounted before the pick) MUST see
    // the new selection. This is the contract PR B's reviewer flagged as
    // broken under per-instance useState — fixed by the module-level store.
    expect(stateA?.selectedModelId).toBe(restrictedModel.id);
    expect(stateB?.selectedModelId).toBe(restrictedModel.id);

    // And the DOM reflects the new value too (re-render actually happened,
    // not just a captured-closure update).
    const rendered = Array.from(
      container.querySelectorAll('[data-testid="selected"]'),
    ).map((el) => el.textContent);
    expect(rendered).toEqual([restrictedModel.id, restrictedModel.id]);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("recordConsent from consumer A is observed by consumer B (same tab)", async () => {
    let stateA: CapturedState | undefined;
    let stateB: CapturedState | undefined;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(Probe, {
            key: "a",
            onState: (s) => {
              stateA = s;
            },
          }),
          createElement(Probe, {
            key: "b",
            onState: (s) => {
              stateB = s;
            },
          }),
        ),
      );
    });

    expect(stateA?.consentRestricted).toBe(false);
    expect(stateB?.consentRestricted).toBe(false);

    await act(async () => {
      stateA!.recordConsent("Restricted-Community");
    });

    expect(stateA?.consentRestricted).toBe(true);
    expect(stateB?.consentRestricted).toBe(true);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
