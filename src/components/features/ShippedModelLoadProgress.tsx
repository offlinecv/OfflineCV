// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ShippedModelLoadProgress — the progress bar every on-device feature shows
 * while the shipped model loads (#1015): rewrite, résumé critique, the parse
 * escape hatch, semantic analysis and the status line's own Download.
 *
 * Two things the six call sites used to get wrong on their own:
 *
 *   - **The label.** Each hard-coded "(one-time download)", so a reload from
 *     Cache Storage after a refresh or a `/` ↔ `/jobs/` navigation read as a
 *     fresh 1.9 GB download. The label now comes from `shippedModelLoadLabel`
 *     and the `source` `loadEngine` probed, and the "What's happening?"
 *     explainer, which describes a download, is left out for a load from
 *     this device.
 *   - **Joined loads.** A feature that asks for the model while another
 *     surface is already loading it shares that load (`loadEngine`'s fast
 *     path B) and never receives a progress callback, so its bar sat at
 *     "Starting…". While the engine store reports a load, its progress wins
 *     over the caller's.
 *   - **One bar per load.** It registers with the engine store while mounted,
 *     and the status line (`OnDeviceModelStatus`) draws its own bar only
 *     while none is registered — so the model downloading draws one bar
 *     whether the status line's Download or a feature asked first.
 *
 * Reuse analysis (CLAUDE.md 3-tier rule): a thin feature wrapper over the
 * shared `ModelLoadProgress`, which stays domain-agnostic; nothing here is a
 * new surface.
 */

import { useEffect } from "react";
import { ModelLoadProgress } from "@design-system";
import { registerFeatureLoadBar } from "../../lib/webllm/engine-status.ts";
import { useShippedEngineStatus } from "../../hooks/useShippedEngineStatus.ts";
import { shippedModelLoadLabel } from "../../lib/webllm/models.ts";
import type { ProgressUpdate } from "../../lib/webllm/types.ts";

export function ShippedModelLoadProgress({
  progress,
  showExplainer = false,
}: {
  /** The caller's own latest progress, used until the engine store has one. */
  progress: ProgressUpdate;
  showExplainer?: boolean;
}) {
  const engine = useShippedEngineStatus();
  useEffect(() => registerFeatureLoadBar(), []);
  const live = engine.kind === "loading" ? engine.progress : progress;
  return (
    <ModelLoadProgress
      progress={live.progress}
      text={live.text}
      label={shippedModelLoadLabel(live.source)}
      showExplainer={showExplainer && live.source !== "device"}
    />
  );
}
