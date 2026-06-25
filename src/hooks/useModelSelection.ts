// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * `useModelSelection` — drives the user's persisted WebLLM model choice and
 * the per-license-type consent state that gates Restricted-Community models.
 *
 * State is held in a MODULE-LEVEL store (not per-hook-instance `useState`) and
 * consumed via `useSyncExternalStore`. Three independent consumers call this
 * hook on the same page — `ModelSelector`, `SectionRewrite` (one per role),
 * and `ResumeRewrite`. With per-instance `useState`, a write in
 * the picker would NOT propagate to the rewrite surfaces in the same tab: the
 * `storage` event only fires in OTHER same-origin tabs, never in the writing
 * tab. The module-level store fixes that — every write calls `notify()`
 * synchronously so all subscribers re-render with the new snapshot. The
 * cross-tab `storage` listener folds into the same notify path.
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

import { useCallback, useSyncExternalStore } from "react";
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

function readAllConsent(): Record<LicenseType, boolean> {
  const map = {} as Record<LicenseType, boolean>;
  for (const t of LICENSE_TYPES) map[t] = hasPersistedConsent(t);
  return map;
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

// ─── Module-level shared store ─────────────────────────────────────────────
// State lives at the module level so a write in any consumer notifies every
// other consumer in the same tab. Snapshot functions return the same object
// reference between writes, satisfying useSyncExternalStore's stability
// contract; mutations replace the reference wholesale.

let currentModelId: string = readPersistedModelId();
let currentConsentMap: Record<LicenseType, boolean> = readAllConsent();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  ensureStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getModelIdSnapshot(): string {
  return currentModelId;
}

function getConsentMapSnapshot(): Record<LicenseType, boolean> {
  return currentConsentMap;
}

// SSR safety: `useSyncExternalStore` demands a server snapshot. We don't
// SSR, but the fallback shape still has to satisfy referential stability
// across calls — so use frozen module-level constants.
const SERVER_CONSENT_MAP: Record<LicenseType, boolean> = (() => {
  const map = {} as Record<LicenseType, boolean>;
  for (const t of LICENSE_TYPES) map[t] = false;
  return map;
})();
function getServerModelIdSnapshot(): string {
  return DEFAULT_MODEL_ID;
}
function getServerConsentMapSnapshot(): Record<LicenseType, boolean> {
  return SERVER_CONSENT_MAP;
}

// Cross-tab sync: when another tab writes a new selection or consent, mirror
// it into THIS tab's store. Registered lazily once per page so every
// subscribe doesn't pile on listeners.
let storageListenerWired = false;
function ensureStorageListener(): void {
  if (storageListenerWired) return;
  if (typeof globalThis.addEventListener !== "function") return;
  storageListenerWired = true;
  globalThis.addEventListener("storage", (event: StorageEvent) => {
    if (event.key === null) {
      // localStorage.clear() — refresh both.
      currentModelId = readPersistedModelId();
      currentConsentMap = readAllConsent();
      notify();
      return;
    }
    if (event.key === MODEL_ID_KEY) {
      currentModelId = readPersistedModelId();
      notify();
    } else if (event.key.startsWith(CONSENT_KEY_PREFIX)) {
      currentConsentMap = readAllConsent();
      notify();
    }
  });
}

function setSelectedModelIdInternal(id: string): void {
  // Defensive — a stale id (e.g. from a deleted registry entry) silently
  // falls back to default rather than poisoning the picker.
  const validated = isRegisteredModelId(id) ? id : DEFAULT_MODEL_ID;
  if (validated === currentModelId) {
    // Idempotent — still persist in case the localStorage value drifted from
    // the in-memory store (it shouldn't, but the cost is a single write).
    writePersistedModelId(validated);
    return;
  }
  currentModelId = validated;
  writePersistedModelId(validated);
  notify();
}

function recordConsentInternal(licenseType: LicenseType): void {
  if (currentConsentMap[licenseType] === true) {
    // Idempotent — already accepted; nothing to notify.
    writePersistedConsent(licenseType);
    return;
  }
  currentConsentMap = { ...currentConsentMap, [licenseType]: true };
  writePersistedConsent(licenseType);
  notify();
}

export function useModelSelection(): ModelSelectionState {
  const selectedModelId = useSyncExternalStore(
    subscribe,
    getModelIdSnapshot,
    getServerModelIdSnapshot,
  );
  const consentMap = useSyncExternalStore(
    subscribe,
    getConsentMapSnapshot,
    getServerConsentMapSnapshot,
  );

  const hasConsent = useCallback(
    (licenseType: LicenseType) => consentMap[licenseType] === true,
    [consentMap],
  );

  const recordConsent = useCallback((licenseType: LicenseType) => {
    recordConsentInternal(licenseType);
  }, []);

  const setSelectedModelId = useCallback((id: string) => {
    setSelectedModelIdInternal(id);
  }, []);

  return {
    selectedModelId,
    setSelectedModelId,
    hasConsent,
    recordConsent,
  };
}

/**
 * Test-only: wipe persisted selection + consent AND reset the module-level
 * store so subsequent tests start clean. Notifies subscribers so any
 * still-mounted consumer from a prior test gets a fresh snapshot.
 */
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
  currentModelId = readPersistedModelId();
  currentConsentMap = readAllConsent();
  notify();
}
