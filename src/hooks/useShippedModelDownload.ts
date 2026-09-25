// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `useShippedModelDownload` — the state behind `OnDeviceModelStatus`: is the
 * shipped model on this device, is it loading, did this line's download fail,
 * and the Download / Remove actions (#1015).
 *
 *   - **It follows the engine, not just its own clicks.** The engine state
 *     comes from `engine-status.ts` (`useShippedEngineStatus`), so a model any
 *     feature made resident reads Ready. A load is `"loading"` with its
 *     progress while no feature is drawing a bar for it, and `"busy"` (no
 *     progress) while one is — a second bar here read as two downloads. That
 *     holds whichever side asked first, and survives a remount or the
 *     feature's bar unmounting mid-load. The error is local: it belongs to
 *     this line's own Download.
 *   - **The cache probe runs on mount.** `hasModelWeightsCached` is a local
 *     Cache API read (`model-cache.ts`) — no web-llm chunk, no network — so
 *     a returning user sees Ready without first touching the line. (Imported
 *     directly, not through `web-llm.ts`, which many suites that mount this
 *     line mock.) While it is pending
 *     `cached` is `null`, and the line offers no action rather than a
 *     Download it may have to take back.
 *   - **Re-probes wait for the load to finish.** A probe while web-llm is
 *     writing weights into the same store can read a half-written state, so
 *     the probe re-runs only when the engine becomes (or stops being)
 *     resident, or after a removal settles.
 *   - **Download asks first.** `download` goes through `requestModelConsent`
 *     like every other on-device action; a decline changes nothing.
 *
 * Preloading needs no `acquireInference` bracket: no inference runs on the
 * engine this returns (see `loadEngine`'s docblock).
 */

import { useCallback, useEffect, useState } from "react";
import { detectWebGpu } from "../lib/webllm/capability.ts";
import { hasModelWeightsCached } from "../lib/webllm/model-cache.ts";
import { SHIPPED_MODEL } from "../lib/webllm/models.ts";
import { clearModel, loadEngine } from "../lib/webllm/web-llm.ts";
import type { ProgressUpdate, WebGpuCapability } from "../lib/webllm/types.ts";
import { requestModelConsent } from "./useModelConsent.ts";
import {
  useFeatureLoadBarCount,
  useShippedEngineStatus,
} from "./useShippedEngineStatus.ts";

export type ShippedModelLoadState =
  | { kind: "idle" }
  /** The model is loading and no feature is drawing its progress. */
  | { kind: "loading"; progress: ProgressUpdate }
  /** The model is loading and a feature's bar shows the progress. */
  | { kind: "busy" }
  | { kind: "error"; detail?: string };

export interface ShippedModelDownload {
  capability: WebGpuCapability | null;
  /** On this device (cached or resident); `null` while the first probe runs. */
  cached: boolean | null;
  loadState: ShippedModelLoadState;
  download: () => Promise<void>;
  remove: () => Promise<void>;
}

const IDLE: ShippedModelLoadState = { kind: "idle" };
const BUSY: ShippedModelLoadState = { kind: "busy" };

export function useShippedModelDownload(): ShippedModelDownload {
  const [capability, setCapability] = useState<WebGpuCapability | null>(null);
  const [probed, setProbed] = useState<boolean | null>(null);
  const [error, setError] = useState<{ detail?: string } | null>(null);
  const [removedAt, setRemovedAt] = useState(0);
  const engine = useShippedEngineStatus();
  const featureBars = useFeatureLoadBarCount();
  const resident = engine.kind === "loaded";

  useEffect(() => {
    let cancelled = false;
    void detectWebGpu().then((c) => {
      if (!cancelled) setCapability(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (capability !== "available") return;
    let cancelled = false;
    void hasModelWeightsCached(SHIPPED_MODEL.id).then((isCached) => {
      if (!cancelled) setProbed(isCached);
    });
    return () => {
      cancelled = true;
    };
  }, [capability, resident, removedAt]);

  const download = useCallback(async () => {
    setError(null);
    if (!(await requestModelConsent())) return;
    try {
      // Progress reaches the line through the engine-status store, which
      // also covers a load another feature already started.
      await loadEngine(SHIPPED_MODEL.id, () => {});
    } catch (err) {
      // Friendly summary in the UI; the raw web-llm message (often a
      // multi-line engine-internal string) stays under "Technical details".
      setError({
        detail: err instanceof Error && err.message ? err.message : undefined,
      });
    }
  }, []);

  const remove = useCallback(async () => {
    // A failed removal leaves the cache as it was; the re-probe reports the
    // true state either way, so log instead of surfacing an error.
    try {
      await clearModel(SHIPPED_MODEL.id);
    } catch (err) {
      console.warn("[webllm] clear failed:", err);
    }
    setRemovedAt(Date.now());
  }, []);

  const loadState: ShippedModelLoadState =
    engine.kind === "loading"
      ? featureBars === 0
        ? { kind: "loading", progress: engine.progress }
        : BUSY
      : error && engine.kind === "idle"
        ? { kind: "error", ...error }
        : IDLE;
  const cached = resident ? true : probed;

  return { capability, cached, loadState, download, remove };
}
