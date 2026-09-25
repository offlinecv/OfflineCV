// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * What the engine layer is doing with each model — idle, loading (with the
 * latest progress), or loaded — as a tiny external store (#1015).
 *
 * `loadEngine` hands progress only to the caller that started a load, so a
 * surface that merely reports on the model (the status line) could not see a
 * load another feature started, or tell that the model had since become
 * resident. `web-llm.ts` publishes every transition here and
 * `useShippedModelDownload` subscribes with `useSyncExternalStore`, so the
 * status line follows the one engine whichever feature drives it.
 *
 * It lives apart from `web-llm.ts` on purpose: many suites mock that module,
 * and a subscriber reading from the mock would break every one of them. Each
 * status object is stored and replaced whole, so `getEngineStatus` returns a
 * stable reference between changes, as `useSyncExternalStore` requires.
 *
 * It also counts the feature progress bars on screen
 * (`ShippedModelLoadProgress` registers while mounted). One load must draw one
 * bar: the status line draws its own only while no feature is drawing one,
 * whichever of them started or joined the load.
 */

import type { ProgressUpdate } from "./types.ts";

export type EngineStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly progress: ProgressUpdate }
  | { readonly kind: "loaded" };

const IDLE: EngineStatus = Object.freeze({ kind: "idle" });

const statusById = new Map<string, EngineStatus>();
const listeners = new Set<() => void>();
let featureLoadBars = 0;

export function getEngineStatus(modelId: string): EngineStatus {
  return statusById.get(modelId) ?? IDLE;
}

export function subscribeEngineStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

function publish(modelId: string, status: EngineStatus): void {
  statusById.set(modelId, status);
  notify();
}

/** How many feature progress bars are mounted right now. */
export function getFeatureLoadBarCount(): number {
  return featureLoadBars;
}

/** Count a mounted feature progress bar; the returned function uncounts it, once. */
export function registerFeatureLoadBar(): () => void {
  featureLoadBars++;
  notify();
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    featureLoadBars--;
    notify();
  };
}

export function markEngineLoading(modelId: string, progress: ProgressUpdate): void {
  publish(modelId, Object.freeze({ kind: "loading", progress }));
}

export function markEngineLoaded(modelId: string): void {
  publish(modelId, Object.freeze({ kind: "loaded" }));
}

/** No engine resident and none loading: a load failed, or it was evicted or cleared. */
export function markEngineIdle(modelId: string): void {
  if (getEngineStatus(modelId) === IDLE) return;
  publish(modelId, IDLE);
}

/** Test-only: forget every status. Subscribers stay attached. */
export function _resetEngineStatusForTesting(): void {
  statusById.clear();
  featureLoadBars = 0;
}
