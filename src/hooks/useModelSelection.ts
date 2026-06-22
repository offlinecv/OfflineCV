// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * `useModelSelection` — drives the user's persisted WebLLM model choice and
 * the per-license-type consent state that gates Restricted-Community models.
 *
 * Persisted to `localStorage` so the picker reflects the same selection
 * across page reloads. Both reads and writes are wrapped in try/catch so a
 * locked-down or full storage doesn't crash the picker — we fall back to
 * `DEFAULT_MODEL_ID` and "no consent given," which keeps the app working
 * with Qwen2.5 (Apache-2.0) regardless.
 *
 * Storage layout:
 *   - `resumelint:webllm:modelId` → exact `model_id` from MODEL_REGISTRY
 *   - `resumelint:webllm:consent:<LicenseType>` → "accepted" (presence
 *     only; absence means "no consent recorded")
 *
 * The pure I/O functions (`readPersistedModelId`, `writePersistedModelId`,
 * etc.) are exported separately so they can be unit-tested without a React
 * render harness — this matches the existing pattern from
 * `useSectionRewriteLock`.
 */

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_MODEL_ID,
  isRegisteredModelId,
  MODEL_REGISTRY,
  type LicenseType,
} from "../lib/webllm/models.ts";

/** Every distinct `licenseType` present in the registry. */
const LICENSE_TYPES: readonly LicenseType[] = Array.from(
  new Set(MODEL_REGISTRY.map((m) => m.licenseType)),
);

const MODEL_ID_KEY = "resumelint:webllm:modelId";
const CONSENT_KEY_PREFIX = "resumelint:webllm:consent:";
const CONSENT_VALUE = "accepted";

function safeGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // SecurityError in some sandboxed contexts, QuotaExceededError if
    // storage is full and we somehow read. Either way: no persisted value.
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Same as safeGet — silently fall back to in-memory state.
  }
}

/** Read the persisted model id, validated against the registry. */
export function readPersistedModelId(): string {
  const stored = safeGet(MODEL_ID_KEY);
  if (stored && isRegisteredModelId(stored)) return stored;
  return DEFAULT_MODEL_ID;
}

/** Persist a model id. The caller is responsible for ensuring it's in the registry. */
export function writePersistedModelId(id: string): void {
  safeSet(MODEL_ID_KEY, id);
}

export function hasPersistedConsent(licenseType: LicenseType): boolean {
  return safeGet(CONSENT_KEY_PREFIX + licenseType) === CONSENT_VALUE;
}

export function writePersistedConsent(licenseType: LicenseType): void {
  safeSet(CONSENT_KEY_PREFIX + licenseType, CONSENT_VALUE);
}

export interface ModelSelectionState {
  /** The currently chosen model id (always a valid registry entry). */
  selectedModelId: string;
  /** Change the selection. Caller must verify consent gate first if needed. */
  setSelectedModelId: (id: string) => void;
  /** Whether the user has already accepted the given license type. */
  hasConsent: (licenseType: LicenseType) => boolean;
  /** Record consent for the given license type (persists to localStorage). */
  recordConsent: (licenseType: LicenseType) => void;
}

function readAllConsent(): Record<LicenseType, boolean> {
  const map = {} as Record<LicenseType, boolean>;
  for (const t of LICENSE_TYPES) map[t] = hasPersistedConsent(t);
  return map;
}

export function useModelSelection(): ModelSelectionState {
  const [selectedModelId, setSelectedModelIdState] = useState<string>(
    readPersistedModelId,
  );
  // Mirror consent into React state so consumer re-reads of `hasConsent`
  // are driven by re-renders, not by incidental coupling with other state
  // changes. Without this mirror, a future refactor that calls
  // `recordConsent` without immediately changing some other state would
  // leave the consumer holding a stale view ("no consent yet") even though
  // localStorage said yes — and the consent gate would silently re-fire.
  const [consentMap, setConsentMap] = useState<Record<LicenseType, boolean>>(
    readAllConsent,
  );

  // Cross-tab sync: when another tab writes a new selection or consent,
  // mirror it into this tab's React state. Without the listener, Tab B
  // keeps showing Tab A's old selection / unaware that consent was given.
  useEffect(() => {
    function onStorage(event: StorageEvent): void {
      if (event.key === null) {
        // localStorage.clear() — refresh both.
        setSelectedModelIdState(readPersistedModelId());
        setConsentMap(readAllConsent());
        return;
      }
      if (event.key === "resumelint:webllm:modelId") {
        setSelectedModelIdState(readPersistedModelId());
      } else if (event.key.startsWith("resumelint:webllm:consent:")) {
        setConsentMap(readAllConsent());
      }
    }
    globalThis.addEventListener?.("storage", onStorage);
    return () => {
      globalThis.removeEventListener?.("storage", onStorage);
    };
  }, []);

  const hasConsent = useCallback(
    (licenseType: LicenseType) => consentMap[licenseType] === true,
    [consentMap],
  );

  const recordConsent = useCallback((licenseType: LicenseType) => {
    writePersistedConsent(licenseType);
    setConsentMap((prev) => ({ ...prev, [licenseType]: true }));
  }, []);

  const setSelectedModelId = useCallback((id: string) => {
    if (!isRegisteredModelId(id)) {
      // Defensive — caller should validate before calling, but a stale id
      // (e.g. from a deleted registry entry) silently falls back to default
      // rather than poisoning the picker.
      setSelectedModelIdState(DEFAULT_MODEL_ID);
      writePersistedModelId(DEFAULT_MODEL_ID);
      return;
    }
    setSelectedModelIdState(id);
    writePersistedModelId(id);
  }, []);

  return {
    selectedModelId,
    setSelectedModelId,
    hasConsent,
    recordConsent,
  };
}

/** Test-only: wipe persisted selection + consent so each test starts clean. */
export function _resetPersistedModelSelectionForTesting(): void {
  try {
    globalThis.localStorage?.removeItem(MODEL_ID_KEY);
    // Derive license types from the registry so adding a new licenseType
    // automatically gets covered here — no separate hardcoded list to
    // forget to update.
    for (const t of LICENSE_TYPES) {
      globalThis.localStorage?.removeItem(CONSENT_KEY_PREFIX + t);
    }
  } catch {
    // ignore
  }
}
