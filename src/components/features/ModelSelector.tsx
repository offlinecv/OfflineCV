// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ModelSelector — picker UI for the curated WebLLM model registry.
 *
 * Renders inline near `SectionRewrite` (per #64 step 6, updated spec). One
 * picker per page; all rewrite paths consume the persisted selection via
 * `useModelSelection`. Returns `null` when WebGPU is unavailable so the
 * surface stays out of the way for browsers that can't load any model — the
 * "WebGPU unavailable" explainer lives on the "Resume Quality" tab instead
 * (#276), the canonical on-device-AI surface.
 *
 * Flow on a user pick (model X ≠ current):
 *   1. If X is `Restricted-Community` AND no consent stored for that
 *      license type → open `ConsentDialog`. On accept, record consent +
 *      proceed. On decline, abort (selection stays).
 *   2. Preload X via `loadEngine(X, …)`. Show per-model download progress
 *      inline via the shared `ModelLoadProgress`. (Cross-model
 *      serialization in `web-llm.ts` keeps this safe from racing with an
 *      in-flight section rewrite.)
 *   3. On success → commit the selection via `setSelectedModelId(X)`. The
 *      persisted value drives subsequent `SectionRewrite` / `RewriteButton`
 *      loads.
 *   4. On failure → surface a per-model error inline and leave the
 *      previously selected model in place (spec: "return the user to the
 *      picker on load failure").
 *
 * Cache awareness: `hasModelInCache` from `@mlc-ai/web-llm` labels each row
 * as "already downloaded" vs "will download (~N GB, one-time)". The probe is
 * deferred to the first picker interaction (pointer enter / focus / click) so
 * the multi-MB WebLLM chunk does NOT download for users who never engage with
 * the picker — webllm was previously fetched only on rewrite click, and an
 * eager probe would defeat that lazy-load design. Until first interaction
 * every row reads "Will download" (degrades gracefully for returning users).
 * After interaction the probe also re-runs on every successful load via
 * `lastCompletedAt`, so newly-cached rows flip to "Downloaded · runs offline".
 * The spec's "download-size warning fires only on a fresh download" is
 * satisfied by showing the size + "will download" status only on uncached
 * rows.
 *
 * Reuse analysis (CLAUDE.md 3-tier rule):
 *   - Primitive: `Button` for every interactive control (model rows are
 *     buttons, "Try again" is a button); `Dialog` (via `ConsentDialog`);
 *     no raw `<button>` / `<dialog>` / `<select>` anywhere here.
 *   - Shared: `ModelLoadProgress` for the inline download panel — same
 *     primitive `RewriteButton` and `SectionRewrite` use, so PR B does
 *     not add a third copy of that chrome (closes #130).
 *   - No `Card` wrapper — the picker is a nested control strip inside
 *     `ReconstructedResume`, not a top-level surface.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, ModelLoadProgress } from "@design-system";
import {
  DEFAULT_MODEL_ID,
  MODEL_REGISTRY,
  type ModelMetadata,
} from "../../lib/webllm/models.ts";
import { detectWebGpu } from "../../lib/webllm/capability.ts";
import { clearModel, loadEngine } from "../../lib/webllm/web-llm.ts";
import type {
  ProgressUpdate,
  WebGpuCapability,
} from "../../lib/webllm/types.ts";
import { useModelSelection } from "../../hooks/useModelSelection.ts";
import { ConsentDialog } from "./ConsentDialog.tsx";

type LoadState =
  | { kind: "idle" }
  | { kind: "loading"; modelId: string; progress: ProgressUpdate }
  | {
      kind: "error";
      modelId: string;
      /** Human-readable summary, written for the user. */
      message: string;
      /** Raw error string (for the optional Technical details disclosure). */
      detail?: string;
    };

export function ModelSelector() {
  const [capability, setCapability] = useState<WebGpuCapability | null>(null);
  const {
    selectedModelId,
    setSelectedModelId,
    hasConsent,
    recordConsent,
  } = useModelSelection();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "idle" });
  // Split the consent dialog's open-ness from the model data so we can drive
  // the Dialog primitive's `open` prop to false BEFORE the React tree
  // unmounts the dialog node. The Dialog effect's `dialog.close()` is what
  // restores focus to the previously-focused element; an unmount-while-open
  // path skips that and strands the focus ring. `consentModel` stays set
  // for one extra frame after `consentOpen` flips to false (see the rAF
  // effect below) so the dialog has its model data through the close
  // lifecycle.
  const [consentModel, setConsentModel] = useState<ModelMetadata | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [cachedIds, setCachedIds] = useState<ReadonlySet<string>>(new Set());
  // Progressive disclosure: the picker collapses to a one-line summary by
  // default so the rewrite-model config does not eat permanent vertical space
  // above the first role when the user is happy with the default. The full
  // row list reveals on "Change". (See #64 follow-up — picker placement.)
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void detectWebGpu().then((c) => {
      if (!cancelled) setCapability(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // After the consent dialog closes, defer the `consentModel` null-out one
  // frame so the Dialog primitive's effect has time to call
  // `dialog.close()` (which restores focus) before React unmounts the
  // <dialog> node.
  useEffect(() => {
    if (consentOpen || consentModel === null) return;
    const handle = requestAnimationFrame(() => {
      setConsentModel(null);
    });
    return () => cancelAnimationFrame(handle);
  }, [consentOpen, consentModel]);

  // Probe IndexedDB on first picker interaction (lazy: importing
  // `@mlc-ai/web-llm` pulls the multi-MB chunk, so an eager mount-time probe
  // would defeat the lazy-load design for users who never rewrite). Re-probes
  // are gated on the transition BACK to `idle` so we don't read IndexedDB
  // while WebLLM is actively writing weights into it during a download — a
  // same-store concurrent read can briefly return inconsistent state and
  // would make a row flip to "Downloaded · runs offline" mid-download.
  // `lastCompletedAt` is bumped only after `loadEngine` resolves successfully
  // (see startLoad), and a successful load implies prior interaction so
  // `probed` is already true by then.
  const [probed, setProbed] = useState(false);
  const [lastCompletedAt, setLastCompletedAt] = useState(0);
  useEffect(() => {
    if (capability !== "available" || !probed) return;
    let cancelled = false;
    void probeCachedIds(MODEL_REGISTRY).then((ids) => {
      if (!cancelled) setCachedIds(ids);
    });
    return () => {
      cancelled = true;
    };
  }, [capability, probed, lastCompletedAt]);

  const probeOnce = useCallback(() => {
    setProbed(true);
  }, []);

  // Auto-expand when a non-default model is the active selection (e.g. a
  // returning user who previously switched) so their choice stays visible
  // rather than hidden behind the collapsed summary. Fires only on an actual
  // selection change, so a manual collapse afterward sticks.
  useEffect(() => {
    if (selectedModelId !== DEFAULT_MODEL_ID) setExpanded(true);
  }, [selectedModelId]);

  const startLoad = useCallback(
    async (model: ModelMetadata) => {
      setLoadState({
        kind: "loading",
        modelId: model.id,
        progress: { progress: 0, text: "Starting…" },
      });
      try {
        await loadEngine(model.id, (progress) => {
          setLoadState({ kind: "loading", modelId: model.id, progress });
        });
        setSelectedModelId(model.id);
        setLoadState({ kind: "idle" });
        // Bump the probe trigger AFTER the download finishes so the row
        // for `model.id` flips to "Downloaded" without racing the
        // in-flight IndexedDB writes.
        setLastCompletedAt(Date.now());
      } catch (err) {
        // Friendly-first: WebLLM's raw error messages are verbose and
        // engine-internal ("Cannot find adapter that matches the
        // request", multi-line stack-y strings). Show a user-readable
        // summary by default and keep the raw error available under
        // "Technical details" for the report-this-bug path.
        const summary =
          model.tier === "High"
            ? `${model.name} needs more GPU memory than your device can spare. Try a smaller model.`
            : `Couldn't load ${model.name}. Try again, or pick a different model.`;
        const detail =
          err instanceof Error && err.message ? err.message : undefined;
        setLoadState({
          kind: "error",
          modelId: model.id,
          message: summary,
          detail,
        });
      }
    },
    [setSelectedModelId],
  );

  const onPick = useCallback(
    (model: ModelMetadata) => {
      // Defense-in-depth: a touch tap or programmatic focus path may bypass
      // pointer-enter / focus on the container, but a click is an
      // unambiguous engagement signal.
      setProbed(true);
      if (model.id === selectedModelId && loadState.kind === "idle") return;
      // Restricted-Community models route through the consent gate the
      // first time. Type-level persistence: accepting once covers every
      // model under the same licenseType.
      if (
        model.licenseType === "Restricted-Community" &&
        !hasConsent(model.licenseType)
      ) {
        setConsentModel(model);
        setConsentOpen(true);
        return;
      }
      void startLoad(model);
    },
    [selectedModelId, loadState.kind, hasConsent, startLoad],
  );

  // Download-ahead: warm the cache for the already-selected model so the
  // first rewrite is instant. The model is already selected, so any consent
  // gate was cleared at selection time — go straight to `startLoad`, which
  // re-commits the same id (no-op) and flips the row to cached on success.
  const onDownloadAhead = useCallback(() => {
    setProbed(true);
    const model =
      MODEL_REGISTRY.find((m) => m.id === selectedModelId) ?? MODEL_REGISTRY[0];
    void startLoad(model);
  }, [selectedModelId, startLoad]);

  // Clear a downloaded model from disk + VRAM. After it resolves, bump the
  // probe trigger so the just-cleared row flips back to "Will download". A
  // failure leaves the cache intact; the re-probe re-confirms the true state
  // either way, so we swallow + log rather than surface a row error.
  const onClearModel = useCallback(async (modelId: string) => {
    try {
      await clearModel(modelId);
    } catch (err) {
      console.warn("[webllm] clear failed:", err);
    }
    setLastCompletedAt(Date.now());
  }, []);

  const onConsentAccept = useCallback(() => {
    if (!consentModel) return;
    recordConsent(consentModel.licenseType);
    const model = consentModel;
    // Close (focus restores), then the rAF effect nulls out consentModel.
    setConsentOpen(false);
    void startLoad(model);
  }, [consentModel, recordConsent, startLoad]);

  const onConsentDecline = useCallback(() => {
    // Spec: decline must NOT start the download and must leave the
    // previously-selected model in place. `selectedModelId` was never
    // touched, so closing the dialog is the entire revert.
    setConsentOpen(false);
  }, []);

  // Picker only shows when WebGPU can actually run a model. When it can't, the
  // shared explainer lives on the "Resume Quality" tab (the canonical on-device
  // AI surface, #276) — not inline here — so the notice isn't buried under
  // Experience or repeated per role. Renders nothing until detection resolves.
  if (capability !== "available") return null;

  // A load forces the rows open so the inline `ModelLoadProgress` stays
  // visible even if the user collapsed mid-download.
  const showRows = expanded || loadState.kind === "loading";
  const selectedModel =
    MODEL_REGISTRY.find((m) => m.id === selectedModelId) ?? MODEL_REGISTRY[0];

  return (
    <div
      className="flex flex-col gap-2"
      onPointerEnter={probeOnce}
      onFocus={probeOnce}
    >
      {showRows ? (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">
              Rewrite model
            </h3>
            <p className="text-[11px] text-content-tertiary">
              Picks here apply to every "Rewrite" button below.
            </p>
          </div>
          <Button
            variant="link"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            disabled={loadState.kind === "loading"}
            aria-expanded={true}
            className="text-xs"
          >
            Done
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xs text-content-tertiary">
            Rewrite model via{" "}
            <span className="font-semibold text-content-primary">
              {selectedModel.name}
            </span>
          </p>
          <div className="flex flex-wrap items-baseline gap-3">
            {loadState.kind === "error" &&
            loadState.modelId === selectedModel.id ? (
              <span className="flex items-baseline gap-2">
                <span className="text-[11px] text-feedback-error-text">
                  Couldn't download.
                </span>
                <Button
                  variant="link"
                  size="sm"
                  onClick={onDownloadAhead}
                  className="text-xs"
                >
                  Try again
                </Button>
              </span>
            ) : cachedIds.has(selectedModel.id) ? (
              <span className="text-[11px] text-feedback-success-text">
                ✓ Ready · runs offline
              </span>
            ) : (
              <Button
                variant="link"
                size="sm"
                onClick={onDownloadAhead}
                className="text-xs"
              >
                Download now · ~{(selectedModel.downloadSizeMb / 1024).toFixed(1)}{" "}
                GB
              </Button>
            )}
            <Button
              variant="link"
              size="sm"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={false}
              className="text-xs"
            >
              Edit
            </Button>
          </div>
        </div>
      )}

      {showRows && (
      <ul className="flex flex-col gap-1.5 list-none">
        {MODEL_REGISTRY.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            selected={model.id === selectedModelId}
            cached={cachedIds.has(model.id)}
            disabled={loadState.kind === "loading"}
            error={
              loadState.kind === "error" && loadState.modelId === model.id
                ? { message: loadState.message, detail: loadState.detail }
                : null
            }
            loadingProgress={
              loadState.kind === "loading" && loadState.modelId === model.id
                ? loadState.progress
                : null
            }
            onPick={() => onPick(model)}
            onClear={() => void onClearModel(model.id)}
          />
        ))}
      </ul>
      )}

      {consentModel && (
        <ConsentDialog
          model={consentModel}
          open={consentOpen}
          onAccept={onConsentAccept}
          onDecline={onConsentDecline}
        />
      )}
    </div>
  );
}

// Exported for unit tests — the top-level `ModelSelector` returns `null`
// until `detectWebGpu()` resolves, which `renderToStaticMarkup` can't drive,
// so the testable surface is `ModelRow` (which owns row state + display
// branching) plus the pure `licenseLabel` helper.
export function ModelRow({
  model,
  selected,
  cached,
  disabled,
  error,
  loadingProgress,
  onPick,
  onClear,
}: {
  model: ModelMetadata;
  selected: boolean;
  cached: boolean;
  disabled: boolean;
  error: { message: string; detail?: string } | null;
  loadingProgress: ProgressUpdate | null;
  onPick: () => void;
  onClear: () => void;
}) {
  // Two-step inline confirm for the destructive Clear: first click reveals
  // the "Remove? · Cancel" row, second commits. Kept inline (not a modal) so
  // a routine cache-cleanup doesn't yank a dialog over the picker. On success
  // the parent re-probe flips `cached` false and unmounts this whole block,
  // which resets `confirming` for free.
  const [confirming, setConfirming] = useState(false);
  const sizeGb = (model.downloadSizeMb / 1024).toFixed(1);
  const isDefault = model.id === DEFAULT_MODEL_ID;
  const downloadLabel = cached
    ? "Downloaded · runs offline"
    : `Will download ~${sizeGb} GB (one-time)`;

  return (
    <li>
      <Button
        variant="ghost"
        size="sm"
        onClick={onPick}
        disabled={disabled}
        aria-pressed={selected}
        className={`flex w-full flex-col items-stretch gap-1 rounded-md border px-3 py-2 text-left ${
          selected
            ? "border-accent-primary bg-feedback-success-bg"
            : "border-border-light bg-surface-card hover:border-border hover:bg-surface-hover"
        }`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-xs font-semibold text-content-primary">
            {model.name}
            {isDefault && (
              <span className="ml-1.5 text-[10px] font-normal text-content-tertiary">
                default
              </span>
            )}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-content-muted">
            {model.tier} tier · {licenseLabel(model)}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-content-tertiary">
          <span>{downloadLabel}</span>
          {selected && (
            <span className="text-[10px] uppercase tracking-wider text-feedback-success-text">
              ✓ Selected
            </span>
          )}
        </div>
      </Button>

      {loadingProgress && (
        <div className="mt-1">
          <ModelLoadProgress
            progress={loadingProgress.progress}
            text={loadingProgress.text}
            label={`Loading ${model.name} (one-time download)`}
          />
        </div>
      )}

      {error && (
        <div role="alert" className="mt-1 flex flex-col gap-0.5">
          <p className="text-[11px] text-feedback-error-text">{error.message}</p>
          {error.detail && (
            <details>
              <summary className="cursor-pointer text-[10px] text-content-tertiary hover:underline">
                Technical details
              </summary>
              <pre className="mt-1 max-w-prose overflow-x-auto whitespace-pre-wrap text-[10px] text-content-tertiary">
                {error.detail}
              </pre>
            </details>
          )}
        </div>
      )}

      {cached && !disabled && (
        confirming ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-content-tertiary">
              Remove {model.name}? Frees ~{sizeGb} GB · re-downloads next use.
            </span>
            <Button
              variant="link"
              size="sm"
              onClick={onClear}
              className="text-[11px] text-feedback-error-text"
            >
              Remove
            </Button>
            <Button
              variant="link"
              size="sm"
              onClick={() => setConfirming(false)}
              className="text-[11px] text-content-tertiary"
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="link"
            size="sm"
            onClick={() => setConfirming(true)}
            className="mt-1 text-[11px] text-content-tertiary"
          >
            Clear download
          </Button>
        )
      )}
    </li>
  );
}

export function licenseLabel(model: ModelMetadata): string {
  return model.licenseType === "Apache-2.0" ? "Apache-2.0" : "Vendor license";
}

/**
 * Probe `hasModelInCache` for every registry entry. Errors per-entry are
 * swallowed (treated as "not cached") so a flaky storage check doesn't
 * black out the picker.
 */
async function probeCachedIds(
  models: readonly ModelMetadata[],
): Promise<ReadonlySet<string>> {
  const { hasModelInCache } = await import("@mlc-ai/web-llm");
  const entries = await Promise.all(
    models.map(async (m) => {
      try {
        const cached = await hasModelInCache(m.id);
        return cached ? m.id : null;
      } catch {
        return null;
      }
    }),
  );
  return new Set(entries.filter((id): id is string => id !== null));
}
