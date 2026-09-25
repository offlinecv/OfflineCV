// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * OnDeviceModelStatus — one line naming the on-device model and whether it is
 * on this device, mounted at the top of Experience beside the whole-résumé
 * rewrite CTA (#1015). It replaces the model picker: there is one model now,
 * so the line offers what is left to decide — download it ahead of the first
 * rewrite, or remove it.
 *
 * States: "Download · ~1.9 GB" (the download goes through the shared consent
 * gate), a progress bar while the model loads, or a bare "Loading…" instead
 * while a feature is drawing that load's bar (two bars for one load read as
 * two downloads), "Ready · runs offline" with a two-step
 * "Remove from this device", and a load error (announced) with "Try again". Until the
 * mount-time cache probe answers, the line names the model and offers
 * nothing. Returns `null` without WebGPU, the same silent absence as every
 * other WebLLM surface — the explainer lives on the on-device-AI surface.
 *
 * Display only: the probe, the download and the removal are
 * `useShippedModelDownload`, and consent is `requestModelConsent`.
 *
 * Reuse analysis (CLAUDE.md 3-tier rule):
 *   - Primitive: `Button` for every control; no raw `<button>`.
 *   - Shared: `ModelLoadProgress` for the download panel, labelled by
 *     `shippedModelLoadLabel` like every feature's bar. Not
 *     `ShippedModelLoadProgress`: that one counts as a feature bar, which is
 *     exactly what this line yields to.
 *   - No `Card`: this is a control strip nested in `ReconstructedResume`.
 */

import { useState } from "react";
import { Button, ModelLoadProgress } from "@design-system";
import { useShippedModelDownload } from "../../hooks/useShippedModelDownload.ts";
import {
  downloadSizeLabel,
  SHIPPED_MODEL,
  shippedModelLoadLabel,
} from "../../lib/webllm/models.ts";

export function OnDeviceModelStatus() {
  const { capability, cached, loadState, download, remove } =
    useShippedModelDownload();

  if (capability !== "available") return null;

  const size = downloadSizeLabel(SHIPPED_MODEL);
  const loading = loadState.kind === "loading";

  // While loading, take a full row of the parent's wrapping flex row
  // (`ReconstructedResume`) so the progress bar is not squeezed beside the
  // rewrite trigger.
  return (
    <div className={`flex flex-col gap-2${loading ? " basis-full" : ""}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-sm text-content-tertiary">
          On-device model{" "}
          <span className="font-semibold text-content-primary">
            {SHIPPED_MODEL.name}
          </span>
        </p>
        {loadState.kind === "error" ? (
          <span className="flex items-baseline gap-2">
            <span role="alert" className="text-2xs text-feedback-error-text">
              Couldn&apos;t download.
            </span>
            <Button
              variant="link"
              size="sm"
              onClick={() => void download()}
              className="text-sm"
            >
              Try again
            </Button>
          </span>
        ) : loadState.kind === "busy" ? (
          <span role="status" className="text-2xs text-content-tertiary">
            Loading…
          </span>
        ) : loading || cached === null ? null : cached ? (
          <ReadyActions size={size} onRemove={remove} />
        ) : (
          <Button
            variant="link"
            size="sm"
            onClick={() => void download()}
            className="text-sm"
          >
            Download · {size}
          </Button>
        )}
      </div>

      {loadState.kind === "loading" && (
        <ModelLoadProgress
          progress={loadState.progress.progress}
          text={loadState.progress.text}
          label={shippedModelLoadLabel(loadState.progress.source)}
        />
      )}

      {loadState.kind === "error" && loadState.detail && (
        <details>
          <summary className="cursor-pointer text-3xs text-content-tertiary hover:underline">
            Technical details
          </summary>
          <pre className="mt-1 max-w-prose overflow-x-auto whitespace-pre-wrap text-3xs text-content-tertiary">
            {loadState.detail}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * "Ready" and its two-step inline Remove — kept inline rather than a modal so
 * a routine cleanup doesn't pull a dialog over the résumé.
 */
function ReadyActions({
  size,
  onRemove,
}: {
  size: string;
  onRemove: () => Promise<void>;
}) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  return (
    <span className="flex flex-wrap items-baseline gap-2">
      <span className="text-2xs text-feedback-success-text">
        ✓ Ready · runs offline
      </span>
      {confirmingRemove ? (
        <>
          <span className="text-2xs text-content-tertiary">
            Frees {size} · downloads again on next use.
          </span>
          <Button
            variant="link"
            size="sm"
            onClick={() => {
              setConfirmingRemove(false);
              void onRemove();
            }}
            className="text-2xs text-feedback-error-text"
          >
            Remove
          </Button>
          <Button
            variant="link"
            size="sm"
            onClick={() => setConfirmingRemove(false)}
            className="text-2xs text-content-tertiary"
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button
          variant="link"
          size="sm"
          onClick={() => setConfirmingRemove(true)}
          className="text-2xs text-content-tertiary"
        >
          Remove from this device
        </Button>
      )}
    </span>
  );
}
