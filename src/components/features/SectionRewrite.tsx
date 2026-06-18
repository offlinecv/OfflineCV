// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
 *     `RewriteButton`. Not a greyed CTA, not a banner.
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
 *   - Shared: the inline before/after panel follows the same inline-result
 *     pattern as `RewriteButton`'s `RewriteResult` (rounded border + feedback
 *     bg). Top-level `Card` would be the wrong chrome — Cards own panel
 *     framing on the page; this is a result strip *inside* the role list.
 *
 * Concurrency: see `useSectionRewriteLock` for the synchronous atomic lock
 * that gates concurrent `engine.chat.completions.create()` calls.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { detectWebGpu } from "../../lib/webllm/capability.ts";
import { loadEngine } from "../../lib/webllm/web-llm.ts";
import { rewriteSectionWithLlm } from "../../lib/webllm/rewrite-section.ts";
import type {
  ProgressUpdate,
  WebGpuCapability,
} from "../../lib/webllm/types.ts";
import type { SectionRewriteResult } from "../../lib/webllm/rewrite-section.ts";
import { useSectionRewriteLock } from "../../hooks/useSectionRewriteLock.ts";
import { Button } from "@design-system";

interface SectionRewriteProps {
  /** The role's bullets, as currently displayed (after #82 overrides). */
  bullets: readonly string[];
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

export function SectionRewrite({ bullets }: SectionRewriteProps) {
  const [capability, setCapability] = useState<WebGpuCapability | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const { isLocked, acquire } = useSectionRewriteLock();

  // Trim blank bullets here once — passed to both the model (so it doesn't
  // see empties) and the before/after panel (so the original column matches
  // what the model actually saw).
  const trimmedBullets = useMemo(
    () => bullets.filter((b) => b.trim().length > 0),
    [bullets],
  );

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
    try {
      setStatus({
        kind: "loading",
        progress: { progress: 0, text: "Starting…" },
      });
      const engine = await loadEngine((progress) => {
        setStatus({ kind: "loading", progress });
      });
      setStatus({ kind: "rewriting" });
      const result = await rewriteSectionWithLlm(trimmedBullets, engine);
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
      release();
    }
  }, [trimmedBullets, acquire]);

  const onReject = useCallback(() => {
    setStatus({ kind: "idle" });
    setCopied(false);
  }, []);

  const onCopyAll = useCallback(async () => {
    if (status.kind !== "proposed") return;
    try {
      await navigator.clipboard.writeText(status.result.bullets.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [status]);

  if (capability !== "available") return null;
  if (trimmedBullets.length === 0) return null;

  const myBusy = status.kind === "loading" || status.kind === "rewriting";
  const lockedByOther = isLocked && !myBusy;

  return (
    <div className="mt-1 flex flex-col gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        disabled={isLocked}
        aria-label="Rewrite all bullets in this role"
        className="self-start rounded-md border border-border-light bg-surface-card px-2.5 py-1 text-[11px] text-content-secondary hover:border-border hover:bg-surface-hover"
      >
        {labelFor(status, lockedByOther)}
      </Button>

      {status.kind === "loading" && (
        <LoadingPanel progress={status.progress} />
      )}

      {status.kind === "rewriting" && (
        <p className="text-[11px] text-content-muted">
          Rewriting the section…
        </p>
      )}

      {status.kind === "proposed" && (
        <ProposedSection
          original={trimmedBullets}
          result={status.result}
          copied={copied}
          onCopyAll={onCopyAll}
          onReject={onReject}
        />
      )}

      {status.kind === "error" && (
        <p role="alert" className="text-[11px] text-feedback-error-text">
          {status.message}
        </p>
      )}
    </div>
  );
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

function LoadingPanel({ progress }: { progress: ProgressUpdate }) {
  const pct = Math.max(0, Math.min(100, Math.round(progress.progress * 100)));
  return (
    <div className="flex flex-col gap-1 rounded border border-border-light bg-surface-subtle p-2">
      <div className="flex items-center justify-between text-[11px] text-content-secondary">
        <span>Loading the rewrite model (~1.2GB, one-time download)</span>
        <span className="font-mono">{pct}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Model download progress"
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-base"
      >
        <div
          className="h-full bg-feedback-success-icon transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress.text && (
        <p className="font-mono text-[10px] text-content-muted">
          {progress.text}
        </p>
      )}
    </div>
  );
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
  const borderClass = result.numbersPreserved
    ? "border-feedback-success-border"
    : "border-feedback-warning-border";
  const bgClass = result.numbersPreserved
    ? "bg-feedback-success-bg"
    : "bg-feedback-warning-bg";

  return (
    <div
      className={`flex flex-col gap-3 rounded border p-3 ${borderClass} ${bgClass}`}
    >
      {!result.numbersPreserved && (
        <NumberPreservationWarning
          dropped={result.droppedNumbers}
          added={result.addedNumbers}
        />
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <BulletColumn
          label={`Original (${original.length})`}
          bullets={original}
          textClass="text-content-secondary"
        />
        <BulletColumn
          label={`Proposed (${result.bullets.length})`}
          bullets={result.bullets}
          textClass="text-content-primary"
        />
      </div>

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
    </div>
  );
}

function BulletColumn({
  label,
  bullets,
  textClass,
}: {
  label: string;
  bullets: readonly string[];
  textClass: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-content-muted">
        {label}
      </h4>
      <ul className={`flex flex-col gap-1.5 text-xs leading-snug list-none ${textClass}`}>
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="font-mono text-content-muted" aria-hidden="true">
              •
            </span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </div>
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
