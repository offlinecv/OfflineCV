// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Per-role "Rewrite section" CTA. Runs Qwen2.5-1.5B in the browser via WebLLM
 * (see ../../lib/webllm/) over every bullet of a role at once. The model can
 * dedupe, merge weak bullets, drop pure filler, reorder, and balance verb
 * variety — none of which is reachable from the per-bullet path. The
 * proposed bullets render beside the originals as a single accept-all /
 * reject choice.
 *
 * Non-negotiable rules from issue #63:
 *   - On browsers without WebGPU, returns null. Silent absence — matches
 *     `InlineResult`. Not a greyed CTA, not a banner.
 *   - Model weights download on click only. The shared `loadEngine()` cache
 *     means clicking section-rewrite after per-bullet (or in a sibling role)
 *     reuses the same engine — no second multi-GB download.
 *   - Number-preservation guardrail runs deterministically on every output.
 *     When a numeric token is dropped or invented, an inline warning names
 *     the specific token (non-blocking) so the user can still accept the
 *     rewrite knowingly.
 *
 * Reuse analysis (CLAUDE.md 3-tier rule):
 *   - Primitive: `Button` from `@design-system` for every interactive
 *     control. No raw `<button>` in this file.
 *   - Shared: the inline before/after panel uses the `InlineResult` primitive
 *     from `@design-system` (rounded border + feedback bg + tone). Top-level
 *     `Card` would be the wrong chrome — Cards own panel framing on the page;
 *     this is a result strip *inside* the role list.
 *
 * Concurrency: see `useSectionRewriteLock` for the synchronous atomic lock
 * that gates concurrent `engine.chat.completions.create()` calls.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { detectWebGpu } from "../../lib/webllm/capability.ts";
import {
  acquireInference,
  loadEngine,
  releaseInference,
} from "../../lib/webllm/web-llm.ts";
import { rewriteSectionWithLlm } from "../../lib/webllm/rewrite-section.ts";
import type {
  ProgressUpdate,
  WebGpuCapability,
} from "../../lib/webllm/types.ts";
import type { SectionRewriteResult } from "../../lib/webllm/rewrite-section.ts";
import { useSectionRewriteLock } from "../../hooks/useSectionRewriteLock.ts";
import { useModelSelection } from "../../hooks/useModelSelection.ts";
import { Button, ModelLoadProgress, InlineResult, InlineDiff } from "@design-system";
import { computeTextDiff } from "../../lib/diff/text-diff.ts";
import {
  alignBullets,
  type AlignedPair,
} from "../../lib/rewrite-review/align-bullets.ts";
import { resolveBulletActions } from "../../lib/rewrite-review/apply-accepted.ts";
import { useRewriteReview } from "../../hooks/useRewriteReview.ts";
import { RewriteReviewList } from "./RewriteReviewList.tsx";

/**
 * Wiring a per-role rewrite to the reconstructed-résumé edit model so accepted
 * bullets can be written back (#211). `obsIndices` is parallel to the `bullets`
 * passed to `useSectionRewrite` (same order/length, BEFORE blank-trimming), so
 * an accepted change at trimmed position i resolves to its
 * BulletObservation.index. When omitted, the proposed panel keeps its legacy
 * copy-all/discard surface (used by callers without an edit model).
 */
export interface SectionRewriteApply {
  obsIndices: readonly number[];
  /** Replace a parsed bullet's text (→ setBulletField). */
  onReplace: (obsIndex: number, text: string) => void;
  /** Drop a parsed bullet (→ removeBullet). */
  onRemove: (obsIndex: number) => void;
  /** Append a new bullet to this role (→ addBullet on the role's entry key). */
  onAdd: (text: string) => void;
}

/** Stable empty alignment so the review hook doesn't reset on every idle render. */
const NO_PAIRS: AlignedPair[] = [];

/** Sparkle glyph for the (idle) rewrite trigger. Decorative — the button owns
 *  the label/title. */
function WandIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 1.5l1 2.7 2.7 1-2.7 1-1 2.7-1-2.7-2.7-1 2.7-1z" />
      <path d="M3.8 9.3l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
    </svg>
  );
}

/** Spinner shown on the trigger while the model loads / rewrites. */
function SpinnerIcon() {
  return (
    <svg
      aria-hidden="true"
      className="animate-spin"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="8" cy="8" r="6" className="opacity-25" />
      <path d="M8 2a6 6 0 016 6" strokeLinecap="round" className="opacity-90" />
    </svg>
  );
}

/** What `useSectionRewrite` hands back so the caller can place the trigger and
 *  the result panel in separate slots (trigger beside the role title, panel
 *  full-width below the bullets). Both are `null` when the feature is
 *  unavailable (no WebGPU) or there are no non-blank bullets — preserving the
 *  "silent absence" rule from issue #63. */
export interface SectionRewriteParts {
  /** The "Rewrite section" button. Render it next to the role heading. */
  trigger: ReactNode;
  /** The loading/proposed/error result surface, or null when idle. Render it
   *  full-width below the role's bullet list. */
  panel: ReactNode;
}

export type Status =
  | { kind: "idle" }
  | { kind: "loading"; progress: ProgressUpdate }
  | { kind: "rewriting" }
  | {
      kind: "proposed";
      result: SectionRewriteResult;
      /** Snapshot of the bullets the model actually saw. Used to detect
       *  when the underlying section has been edited since this proposal
       *  was generated — in which case the proposal is stale and gets
       *  auto-dismissed (see the useEffect below). Without this, the user
       *  could see e.g. "Original (2) | Proposed (3)" after deleting a
       *  bullet underneath a previous rewrite. */
      snapshot: readonly string[];
    }
  | { kind: "error"; message: string };

function bulletsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Section-rewrite controller. Owns all the WebLLM state and returns the trigger
 * button and the result panel as separate nodes so the caller can position them
 * independently — the trigger sits beside the role title, the panel spans full
 * width under the bullets. (Previously this was a single `SectionRewrite`
 * component that stacked button-over-panel at the bottom of the role.)
 */
export function useSectionRewrite(
  bullets: readonly string[],
  apply?: SectionRewriteApply,
): SectionRewriteParts {
  const [capability, setCapability] = useState<WebGpuCapability | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const { isLocked, acquire } = useSectionRewriteLock();
  const { selectedModelId } = useModelSelection();

  // Trim blank bullets here once — passed to both the model (so it doesn't
  // see empties) and the before/after panel (so the original column matches
  // what the model actually saw). When an edit model is wired (`apply`), the
  // surviving bullets' BulletObservation indices are kept parallel so an
  // accepted change at trimmed position i maps back to the right bullet.
  const { trimmedBullets, keptObsIndices } = useMemo(() => {
    const texts: string[] = [];
    const idxs: number[] = [];
    bullets.forEach((b, i) => {
      if (b.trim().length === 0) return;
      texts.push(b);
      if (apply) idxs.push(apply.obsIndices[i] ?? -1);
    });
    return { trimmedBullets: texts, keptObsIndices: idxs };
  }, [bullets, apply]);

  // Per-bullet review state (#211). Aligned against the snapshot the model
  // actually saw (stable per proposal) — not the live bullets — so the rows and
  // the decision map don't churn under unrelated re-renders.
  const pairs = useMemo<AlignedPair[]>(
    () =>
      status.kind === "proposed"
        ? alignBullets(status.snapshot, status.result.bullets)
        : NO_PAIRS,
    [status],
  );
  const review = useRewriteReview(pairs);
  const { reset: resetReview } = review;
  // A fresh proposal (new aligned pairs) starts with a clean decision slate.
  useEffect(() => {
    resetReview();
  }, [pairs, resetReview]);

  useEffect(() => {
    let cancelled = false;
    void detectWebGpu().then((c) => {
      if (!cancelled) setCapability(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-dismiss a stale proposal: if the user edits the underlying bullets
  // after a rewrite proposal is visible, the "Original vs Proposed" panel
  // would otherwise compare current bullets against the prior rewrite's
  // output — `Original (2) | Proposed (3)` is the confusing failure mode.
  // Compare content, not identity, because `trimmedBullets` is a fresh
  // array on every render even when the contents are unchanged.
  useEffect(() => {
    if (status.kind !== "proposed") return;
    if (!bulletsEqual(status.snapshot, trimmedBullets)) {
      setStatus({ kind: "idle" });
      setCopied(false);
    }
  }, [trimmedBullets, status]);

  const onClick = useCallback(async () => {
    setCopied(false);
    // Atomic acquire — null means another instance already holds the lock and
    // we must bail. This is the real "no concurrent generate()" guard; the
    // disabled flag on the button is only the UI surface of the same check
    // (and updates one render late, so it can't be relied on alone).
    const release = acquire();
    if (release === null) return;
    // Snapshot the model id so the same id is released that we acquired —
    // ModelSelector could in principle update `selectedModelId` mid-run.
    const modelId = selectedModelId;
    // Acquire the inference guard SYNCHRONOUSLY, before any await — closes
    // the load→use TOCTOU window from #148. A concurrent picker switch's
    // eviction will see the positive count and park `.unload()` until the
    // matching release runs in `finally`.
    acquireInference(modelId);
    try {
      setStatus({
        kind: "loading",
        progress: { progress: 0, text: "Starting…" },
      });
      const engine = await loadEngine(modelId, (progress) => {
        setStatus({ kind: "loading", progress });
      });
      setStatus({ kind: "rewriting" });
      const result = await rewriteSectionWithLlm(
        trimmedBullets,
        engine,
        modelId,
      );
      if (result.bullets.length === 0) {
        setStatus({
          kind: "error",
          message: "The model returned an empty rewrite. Try again.",
        });
        return;
      }
      setStatus({ kind: "proposed", result, snapshot: trimmedBullets });
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Couldn't load the rewrite model",
      });
    } finally {
      releaseInference(modelId);
      release();
    }
  }, [trimmedBullets, acquire, selectedModelId]);

  const onReject = useCallback(() => {
    setStatus({ kind: "idle" });
    setCopied(false);
  }, []);

  // Apply accepted decisions back into the reconstructed résumé via the edit
  // model, then dismiss the proposal. Each action's `originalIndex` is a
  // position in the trimmed snapshot, mapped to its BulletObservation.index
  // through `keptObsIndices`.
  const onApply = useCallback(() => {
    if (!apply) return;
    const actions = resolveBulletActions(pairs, review.decisions, review.edits);
    for (const action of actions) {
      if (action.kind === "add") {
        apply.onAdd(action.text);
        continue;
      }
      const obsIndex = keptObsIndices[action.originalIndex];
      if (obsIndex === undefined || obsIndex < 0) continue;
      if (action.kind === "replace") apply.onReplace(obsIndex, action.text);
      else apply.onRemove(obsIndex);
    }
    setStatus({ kind: "idle" });
    setCopied(false);
  }, [apply, pairs, review.decisions, review.edits, keptObsIndices]);

  const onCopyAll = useCallback(async () => {
    if (status.kind !== "proposed") return;
    try {
      await navigator.clipboard.writeText(status.result.bullets.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [status]);

  if (capability !== "available" || trimmedBullets.length === 0) {
    return { trigger: null, panel: null };
  }

  const myBusy = status.kind === "loading" || status.kind === "rewriting";
  const lockedByOther = isLocked && !myBusy;

  const triggerTitle = labelFor(status, lockedByOther);
  const trigger = (
    <Button
      variant="icon"
      onClick={onClick}
      disabled={isLocked}
      aria-label={`${triggerTitle} — rewrites every bullet in this role`}
      title={triggerTitle}
      className="h-7 w-7 shrink-0 rounded-md text-content-muted hover:text-brand-amber disabled:opacity-50"
    >
      {myBusy ? <SpinnerIcon /> : <WandIcon />}
    </Button>
  );

  const panel =
    status.kind === "idle" ? null : (
      <div className="mt-1 flex flex-col gap-2">
        {status.kind === "loading" && (
          <ModelLoadProgress
            progress={status.progress.progress}
            text={status.progress.text}
            label="Loading the rewrite model (one-time download)"
          />
        )}

        {status.kind === "rewriting" && (
          <p className="text-[11px] text-content-muted">
            Rewriting the section…
          </p>
        )}

        {status.kind === "proposed" &&
          (apply ? (
            <InlineResult
              tone={status.result.numbersPreserved ? "success" : "warning"}
              className="flex flex-col gap-3"
            >
              <RewriteReviewList
                pairs={pairs}
                review={review}
                onApply={onApply}
                onDiscard={onReject}
                warning={
                  status.result.numbersPreserved ? undefined : (
                    <NumberPreservationWarning
                      dropped={status.result.droppedNumbers}
                      added={status.result.addedNumbers}
                    />
                  )
                }
              />
            </InlineResult>
          ) : (
            <ProposedSection
              original={trimmedBullets}
              result={status.result}
              copied={copied}
              onCopyAll={onCopyAll}
              onReject={onReject}
            />
          ))}

        {status.kind === "error" && (
          <p role="alert" className="text-[11px] text-feedback-error-text">
            {status.message}
          </p>
        )}
      </div>
    );

  return { trigger, panel };
}

// Helpers exported for unit tests (see SectionRewrite.test.ts). The component
// itself is harder to render in non-idle states from a smoke test (status is
// internal + driven by async work), so the testable surface is the helpers
// that own the branching: `labelFor`, `formatTokens`, `ProposedSection`,
// `NumberPreservationWarning`.
export function labelFor(status: Status, lockedByOther: boolean): string {
  if (lockedByOther) return "Another rewrite running…";
  switch (status.kind) {
    case "loading":
      return "Loading model…";
    case "rewriting":
      return "Rewriting…";
    case "proposed":
      return "Rewrite again";
    case "error":
      return "Try again";
    default:
      return "Rewrite section";
  }
}

export function ProposedSection({
  original,
  result,
  copied,
  onCopyAll,
  onReject,
}: {
  original: readonly string[];
  result: SectionRewriteResult;
  copied: boolean;
  onCopyAll: () => void;
  onReject: () => void;
}) {
  return (
    <InlineResult
      tone={result.numbersPreserved ? "success" : "warning"}
      className="flex flex-col gap-3"
    >
      {!result.numbersPreserved && (
        <NumberPreservationWarning
          dropped={result.droppedNumbers}
          added={result.addedNumbers}
        />
      )}

      <InlineDiff
        segments={computeTextDiff(
          original.map((b) => `• ${b}`).join("\n"),
          result.bullets.map((b) => `• ${b}`).join("\n"),
        )}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCopyAll}
          className="rounded-md border border-border-light bg-surface-card px-2.5 py-1 text-[11px] text-content-primary hover:border-border hover:bg-surface-hover"
        >
          {copied ? "Copied" : "Use this — copy all bullets"}
        </Button>
        <Button
          variant="link"
          size="sm"
          onClick={onReject}
          className="text-[11px] font-medium text-content-tertiary"
        >
          Discard
        </Button>
      </div>
    </InlineResult>
  );
}

export function NumberPreservationWarning({
  dropped,
  added,
}: {
  dropped: readonly string[];
  added: readonly string[];
}) {
  const parts: string[] = [];
  if (dropped.length > 0) parts.push(`removed ${formatTokens(dropped)}`);
  if (added.length > 0) parts.push(`invented ${formatTokens(added)}`);
  const detail = parts.join(" and ");
  return (
    <p
      role="alert"
      className="text-[11px] leading-snug text-feedback-warning-text"
    >
      <span aria-hidden="true">⚠ </span>
      AI altered a metric — {detail}. Review before saving.
    </p>
  );
}

export function formatTokens(tokens: readonly string[]): string {
  if (tokens.length === 1) return tokens[0]!;
  if (tokens.length === 2) return `${tokens[0]} and ${tokens[1]}`;
  return `${tokens.slice(0, -1).join(", ")}, and ${tokens[tokens.length - 1]}`;
}
