// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `consent.ts` — the recorded-acceptance fact `loadEngine` and sector
 * classification gate on (#1015). The load-bearing properties: consent is
 * keyed to a model id, the retired per-license-type keys never count, and an
 * acceptance survives a storage that refuses writes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetModelConsentForTesting,
  hasModelConsent,
  modelConsentKey,
  recordModelConsent,
} from "./consent.ts";
import { SHIPPED_MODEL } from "./models.ts";

beforeEach(() => {
  _resetModelConsentForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("model consent", () => {
  it("starts with no consent", () => {
    expect(hasModelConsent(SHIPPED_MODEL.id)).toBe(false);
  });

  it("records consent under a key named for the model id", () => {
    recordModelConsent(SHIPPED_MODEL.id);
    expect(hasModelConsent(SHIPPED_MODEL.id)).toBe(true);
    expect(localStorage.getItem(modelConsentKey(SHIPPED_MODEL.id))).toBe("accepted");
    expect(modelConsentKey(SHIPPED_MODEL.id)).toContain(SHIPPED_MODEL.id);
  });

  it("reads a consent recorded in an earlier page load", () => {
    localStorage.setItem(modelConsentKey(SHIPPED_MODEL.id), "accepted");
    expect(hasModelConsent(SHIPPED_MODEL.id)).toBe(true);
  });

  it("ignores the retired per-license-type keys", () => {
    localStorage.setItem("offlinecv:webllm:consent:Restricted-Community", "accepted");
    localStorage.setItem("offlinecv:webllm:consent:Apache-2.0", "accepted");
    expect(hasModelConsent(SHIPPED_MODEL.id)).toBe(false);
  });

  it("does not carry one model's consent over to another", () => {
    recordModelConsent("Llama-3.2-3B-Instruct-q4f16_1-MLC");
    expect(hasModelConsent(SHIPPED_MODEL.id)).toBe(false);
  });

  it("keeps an acceptance for the page when storage refuses the write", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    recordModelConsent(SHIPPED_MODEL.id);
    expect(hasModelConsent(SHIPPED_MODEL.id)).toBe(true);
  });
});
