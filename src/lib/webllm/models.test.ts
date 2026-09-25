// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";

import { downloadSizeLabel, SHIPPED_MODEL } from "./models.ts";
import { RETIRED_MODEL_IDS } from "./retired-models.ts";

describe("SHIPPED_MODEL", () => {
  it("is Gemma 2 (2B), the one model every on-device feature loads (#1015)", () => {
    expect(SHIPPED_MODEL.id).toBe("gemma-2-2b-it-q4f16_1-MLC");
    expect(SHIPPED_MODEL.name).toBe("Gemma 2 (2B)");
  });

  it("links the Gemma terms the consent dialog shows before any download", () => {
    expect(SHIPPED_MODEL.licenseUrl).toBe("https://ai.google.dev/gemma/terms");
  });

  it("is never one of the retired ids the one-time cleanup deletes", () => {
    expect(RETIRED_MODEL_IDS).not.toContain(SHIPPED_MODEL.id);
  });
});

describe("downloadSizeLabel", () => {
  it("states the shipped model's download in GB, one decimal", () => {
    expect(downloadSizeLabel(SHIPPED_MODEL)).toBe("~1.9 GB");
  });
});
