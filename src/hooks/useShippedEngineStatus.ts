// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `useShippedEngineStatus` — the shipped model's engine status
 * (`engine-status.ts`) as React state: idle, loading with the latest
 * progress, or loaded (#1015).
 *
 * The one subscription both the status line (`useShippedModelDownload`) and
 * every feature's progress bar (`ShippedModelLoadProgress`) read, so all of
 * them follow the same load whichever surface started it.
 * `useFeatureLoadBarCount` is the same store's count of mounted feature bars.
 */

import { useSyncExternalStore } from "react";
import {
  type EngineStatus,
  getEngineStatus,
  getFeatureLoadBarCount,
  subscribeEngineStatus,
} from "../lib/webllm/engine-status.ts";
import { SHIPPED_MODEL } from "../lib/webllm/models.ts";

function readShippedStatus(): EngineStatus {
  return getEngineStatus(SHIPPED_MODEL.id);
}

export function useShippedEngineStatus(): EngineStatus {
  // Same snapshot on the server: the static-markup renders in tests (and any
  // future prerender) read the store as it stands.
  return useSyncExternalStore(
    subscribeEngineStatus,
    readShippedStatus,
    readShippedStatus,
  );
}

export function useFeatureLoadBarCount(): number {
  return useSyncExternalStore(
    subscribeEngineStatus,
    getFeatureLoadBarCount,
    getFeatureLoadBarCount,
  );
}
