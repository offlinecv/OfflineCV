// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The one consent gate every user-initiated WebLLM action goes through
 * (#1015).
 *
 * A feature that is about to load the shipped model calls
 * `requestModelConsent()` first and stops if it resolves `false`:
 *
 *     if (!(await requestModelConsent())) return;   // declined: nothing changed
 *
 * With consent already recorded it resolves `true` at once. Without it, the
 * single `ModelConsentHost` mounted by `PageShell` opens `ConsentDialog`;
 * Accept records consent (keyed to the model id, `lib/webllm/consent.ts`) and
 * resolves `true`, Decline resolves `false`. The features never render the
 * dialog themselves, so the gate is written once rather than per feature —
 * the rewrite, critique, escape-hatch and JD-match callers only differ in
 * where they put that one line. Background work (sector classification)
 * never calls this; it reads `hasModelConsent` and falls back silently.
 *
 * Two properties the callers rely on:
 *   - **Concurrent requests share one dialog.** A second rewrite click while
 *     the dialog is open gets the same pending promise, not a second modal.
 *   - **No host, no consent.** If nothing is mounted to show the dialog, the
 *     request resolves `false` rather than waiting forever — failing closed
 *     is the only safe direction for a download gate.
 *
 * `loadEngine` independently refuses to download without consent, so a
 * caller that skipped this line gets an error, not a silent download.
 */

import { useCallback, useSyncExternalStore } from "react";
import { hasModelConsent, recordModelConsent } from "../lib/webllm/consent.ts";
import { SHIPPED_MODEL } from "../lib/webllm/models.ts";

interface PendingRequest {
  promise: Promise<boolean>;
  settle: (accepted: boolean) => void;
}

let pending: PendingRequest | null = null;
let hostCount = 0;
const requestListeners = new Set<() => void>();

function notifyRequestListeners(): void {
  for (const listener of requestListeners) listener();
}

/**
 * Ask for consent to download the shipped model. Resolves `true` when it is
 * (or already was) accepted, `false` when declined or when no host can ask.
 */
export function requestModelConsent(): Promise<boolean> {
  if (hasModelConsent(SHIPPED_MODEL.id)) return Promise.resolve(true);
  if (pending) return pending.promise;
  if (hostCount === 0) {
    console.warn("[webllm] no ModelConsentHost mounted; treating as declined");
    return Promise.resolve(false);
  }
  let settle!: (accepted: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  pending = { promise, settle };
  notifyRequestListeners();
  return promise;
}

function settlePending(accepted: boolean): void {
  const request = pending;
  if (!request) return;
  if (accepted) recordModelConsent(SHIPPED_MODEL.id);
  pending = null;
  notifyRequestListeners();
  request.settle(accepted);
}

function subscribeRequests(listener: () => void): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

function isRequestPending(): boolean {
  return pending !== null;
}

/**
 * The host side of the gate: whether a request is waiting, and how to answer
 * it. `register` must be called from an effect for as long as the host can
 * show the dialog — it is what `requestModelConsent` counts to decide whether
 * anyone can ask.
 */
export function useModelConsentRequest(): {
  open: boolean;
  accept: () => void;
  decline: () => void;
  register: () => () => void;
} {
  const open = useSyncExternalStore(
    subscribeRequests,
    isRequestPending,
    () => false,
  );
  const accept = useCallback(() => settlePending(true), []);
  const decline = useCallback(() => settlePending(false), []);
  const register = useCallback(() => {
    hostCount += 1;
    return () => {
      hostCount -= 1;
      // The last host leaving cannot answer a request it was showing.
      if (hostCount === 0) settlePending(false);
    };
  }, []);
  return { open, accept, decline, register };
}

/** Test-only: drop any pending request and registered hosts. */
export function _resetModelConsentRequestForTesting(): void {
  pending?.settle(false);
  pending = null;
  hostCount = 0;
  notifyRequestListeners();
}
