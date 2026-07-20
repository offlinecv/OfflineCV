// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Tests for the pure I/O surface of `useModelSelection`. The React hook
 * itself is a thin wrapper around these functions (matches the pattern in
 * `useSectionRewriteLock.test.ts`); the Node test env doesn't run React
 * effects, so we drive localStorage directly.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  _resetPersistedModelSelectionForTesting,
  hasPersistedConsent,
  readPersistedModelId,
  writePersistedConsent,
  writePersistedModelId,
} from "./useModelSelection.ts";
import { DEFAULT_MODEL_ID, MODEL_REGISTRY } from "../lib/webllm/models.ts";

// The in-memory localStorage shim is installed globally (src/test-setup.ts), so
// the hook's safeGet/safeSet have something real to drive; just reset the hook's
// persisted state per test.
beforeEach(() => {
  _resetPersistedModelSelectionForTesting();
});

describe("readPersistedModelId", () => {
  it("returns DEFAULT_MODEL_ID when no value is stored", () => {
    expect(readPersistedModelId()).toBe(DEFAULT_MODEL_ID);
  });

  it("returns a stored id that's still in the registry", () => {
    const restricted = MODEL_REGISTRY.find(
      (m) => m.licenseType === "Restricted-Community",
    )!;
    writePersistedModelId(restricted.id);
    expect(readPersistedModelId()).toBe(restricted.id);
  });

  it("falls back to DEFAULT_MODEL_ID when the stored id is no longer in the registry", () => {
    // Simulate a registry entry that existed in a previous version and was
    // removed since (e.g. a model deprecated by MLC).
    globalThis.localStorage.setItem(
      "offlinecv:webllm:modelId",
      "deprecated-old-model-id",
    );
    expect(readPersistedModelId()).toBe(DEFAULT_MODEL_ID);
  });

  it("falls back to DEFAULT_MODEL_ID when localStorage is unavailable", () => {
    // Remove the shim entirely — safeGet must swallow the access throw.
    (globalThis as { localStorage?: Storage }).localStorage =
      undefined as unknown as Storage;
    expect(readPersistedModelId()).toBe(DEFAULT_MODEL_ID);
  });
});

describe("writePersistedModelId", () => {
  it("round-trips through readPersistedModelId", () => {
    const restricted = MODEL_REGISTRY.find(
      (m) => m.licenseType === "Restricted-Community",
    )!;
    writePersistedModelId(restricted.id);
    expect(readPersistedModelId()).toBe(restricted.id);
  });
});

describe("hasPersistedConsent / writePersistedConsent", () => {
  it("returns false by default", () => {
    expect(hasPersistedConsent("Restricted-Community")).toBe(false);
  });

  it("returns true after recording consent for that license type", () => {
    writePersistedConsent("Restricted-Community");
    expect(hasPersistedConsent("Restricted-Community")).toBe(true);
  });

  it("consent is scoped per license type — Apache-2.0 consent doesn't satisfy Restricted-Community", () => {
    // This guards against a future refactor that might collapse the
    // license dimension by accident (the consent gate would then leak).
    writePersistedConsent("Apache-2.0");
    expect(hasPersistedConsent("Apache-2.0")).toBe(true);
    expect(hasPersistedConsent("Restricted-Community")).toBe(false);
  });

  it("is idempotent — writing twice is a no-op", () => {
    writePersistedConsent("Restricted-Community");
    writePersistedConsent("Restricted-Community");
    expect(hasPersistedConsent("Restricted-Community")).toBe(true);
  });
});

describe("_resetPersistedModelSelectionForTesting", () => {
  it("wipes both modelId and all consent entries", () => {
    writePersistedModelId(MODEL_REGISTRY[1]!.id);
    writePersistedConsent("Restricted-Community");
    _resetPersistedModelSelectionForTesting();
    expect(readPersistedModelId()).toBe(DEFAULT_MODEL_ID);
    expect(hasPersistedConsent("Restricted-Community")).toBe(false);
  });
});
