// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Storage durability (#321). By default IndexedDB is "best-effort" — the browser
 * may evict it under disk pressure, and Safari clears script-writable storage
 * after 7 days without a visit. `navigator.storage.persist()` asks the browser
 * to exempt this origin from automatic eviction; the grant is not guaranteed and
 * varies by engagement/heuristics, so callers surface the result honestly (see
 * `EVICTION_NOTICE`) rather than promising permanence.
 *
 * All calls guard on the API's presence so they no-op safely where
 * `navigator.storage` is absent (older browsers, the Node test env).
 */

/** User-facing transparency copy for wherever saved data is shown. The UI issues
 *  place it; the signal ({@link isStoragePersisted}) and the words live here. */
export const EVICTION_NOTICE =
  "Saved locally in this browser only. Browsers can clear site data under low " +
  "disk space, and Safari clears it after 7 days without a visit — export a " +
  "backup to keep anything important.";

/** Ask the browser to persist this origin's storage. Returns the grant state
 *  (`false` when the API is unavailable). Safe to call on every first write. */
export async function requestStoragePersistence(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) {
    return false;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Whether storage is currently persistent (vs. best-effort). Query for UI. */
export async function isStoragePersisted(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persisted) {
    return false;
  }
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}
