// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_ID,
  getModelById,
  isRegisteredModelId,
  MODEL_REGISTRY,
} from "./models.ts";

describe("MODEL_REGISTRY", () => {
  it("has at least one entry", () => {
    expect(MODEL_REGISTRY.length).toBeGreaterThan(0);
  });

  it("has unique model ids", () => {
    const ids = MODEL_REGISTRY.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("requires `licenseUrl` for every Restricted-Community entry", () => {
    const restricted = MODEL_REGISTRY.filter(
      (m) => m.licenseType === "Restricted-Community",
    );
    expect(restricted.length).toBeGreaterThan(0);
    for (const m of restricted) {
      expect(m.licenseUrl, `${m.id} missing licenseUrl`).toBeTruthy();
      expect(m.licenseUrl).toMatch(/^https?:\/\//);
    }
  });

  it("has a positive `downloadSizeMb` on every entry", () => {
    for (const m of MODEL_REGISTRY) {
      expect(m.downloadSizeMb).toBeGreaterThan(0);
    }
  });

  it("includes Qwen2.5-1.5B as an Apache-2.0 entry (the default)", () => {
    const qwen = MODEL_REGISTRY.find(
      (m) => m.id === "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    );
    expect(qwen).toBeDefined();
    expect(qwen!.licenseType).toBe("Apache-2.0");
  });
});

describe("DEFAULT_MODEL_ID", () => {
  it("points to a model that exists in the registry", () => {
    expect(isRegisteredModelId(DEFAULT_MODEL_ID)).toBe(true);
  });

  it("is Apache-2.0 — every install must boot without the consent gate firing", () => {
    const m = getModelById(DEFAULT_MODEL_ID);
    expect(m).toBeDefined();
    expect(m!.licenseType).toBe("Apache-2.0");
  });
});

describe("getModelById", () => {
  it("returns the entry for a registered id", () => {
    expect(getModelById(DEFAULT_MODEL_ID)?.id).toBe(DEFAULT_MODEL_ID);
  });

  it("returns undefined for an unknown id", () => {
    expect(getModelById("not-a-real-model-id")).toBeUndefined();
  });
});

describe("isRegisteredModelId", () => {
  it("is true for every entry in the registry", () => {
    for (const m of MODEL_REGISTRY) {
      expect(isRegisteredModelId(m.id)).toBe(true);
    }
  });

  it("is false for an unknown id", () => {
    expect(isRegisteredModelId("Mystery-Model-XYZ")).toBe(false);
  });
});
