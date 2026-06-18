// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Per-bullet "Suggest a rewrite" CTA. Runs Qwen2.5-1.5B in the browser via
 * WebLLM (see ../../lib/webllm/).
 *
 * Non-negotiable rules from issue #3:
 *   - On browsers without WebGPU, this component returns null. Not a
 *     greyed-out button, not a "your browser isn't supported" banner. Just
 *     gone. Silent degradation is worse than absence — please don't "fix"
 *     this with a fallback message.
 *   - The model weights (~1.2GB) download on click only. Never on mount,
 *     never on hover, never on scroll-into-view. The cold-start UX is the
 *     conversion killer, not inference cost.
 *
 * Styling uses semantic tokens only (surface / content / border / feedback)
 * per CLAUDE.md. The token CSS auto-adapts via prefers-color-scheme, so no
 * `dark:` overrides are needed.
 */

import { useCallback, useEffect, useState } from "react";
import { detectWebGpu } from "../../lib/webllm/capability.ts";
import { loadEngine } from "../../lib/webllm/web-llm.ts";
import { rewriteBulletWithLlm } from "../../lib/webllm/rewrite-bullet.ts";
import type {
  ProgressUpdate,
  WebGpuCapability,
} from "../../lib/webllm/types.ts";
import { Button } from "@design-system";

interface RewriteButtonProps {
  bullet: string;
  /**
   * Compact mode: render an icon-only trigger that sits inline on the bullet
   * row (alongside the check badges) instead of a labelled button on its own
   * line. The expansion panels (loading / result / error) break to full width
   * below the bullet via `display: contents`. Used by `ResumeBulletRow`.
   */
  compact?: boolean;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading"; progress: ProgressUpdate }
  | { kind: "rewriting" }
  | { kind: "done"; rewritten: string }
  | { kind: "error"; message: string };

export function RewriteButton({ bullet, compact = false }: RewriteButtonProps) {
  const [capability, setCapability] = useState<WebGpuCapability | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void detectWebGpu().then((c) => {
      if (!cancelled) setCapability(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onClick = useCallback(async () => {
    setCopied(false);
    try {
      setStatus({
        kind: "loading",
        progress: { progress: 0, text: "Starting…" },
      });
      const engine = await loadEngine((progress) => {
        setStatus({ kind: "loading", progress });
      });
      setStatus({ kind: "rewriting" });
      const rewritten = await rewriteBulletWithLlm(bullet, engine);
      setStatus({ kind: "done", rewritten });
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Couldn't load the rewrite model",
      });
    }
  }, [bullet]);

  const onCopy = useCallback(async () => {
    if (status.kind !== "done") return;
    try {
      await navigator.clipboard.writeText(status.rewritten);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [status]);

  if (capability !== "available") return null;

  const busy = status.kind === "loading" || status.kind === "rewriting";
  const idle = status.kind === "idle";

  // One expansion surface (loading / rewriting / result / error). In compact
  // mode it breaks to full width on its own row below the bullet; in the
  // standalone (labelled) mode it stacks under the button, right-aligned.
  const expansion =
    status.kind === "loading" ? (
      <LoadingPanel progress={status.progress} />
    ) : status.kind === "rewriting" ? (
      <p className="text-[11px] text-content-muted">Rewriting…</p>
    ) : status.kind === "done" ? (
      <RewriteResult
        rewritten={status.rewritten}
        copied={copied}
        onCopy={onCopy}
      />
    ) : status.kind === "error" ? (
      <p role="alert" className="text-[11px] text-feedback-error-text">
        {status.message}
      </p>
    ) : null;

  const compactButtonCls =
    "group inline-flex min-h-[28px] min-w-[28px] shrink-0 items-center justify-center self-baseline rounded-md text-content-tertiary hover:text-brand-amber disabled:cursor-not-allowed disabled:opacity-60";

  return (
    // `contents` in compact mode so the trigger and the expansion participate
    // directly in the bullet row's flex layout: the icon sits inline with the
    // check badges, the full-width expansion wraps to the next row.
    <div className={compact ? "contents" : "flex flex-col items-end gap-1.5"}>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        disabled={busy}
        aria-label="Suggest a rewrite for this bullet"
        title="Rewrite this bullet"
        className={
          compact
            ? compactButtonCls
            : idle
              ? "group min-h-[28px] self-start py-1 text-[11px] font-medium text-content-tertiary hover:text-brand-amber hover:bg-transparent"
              : "min-h-[28px] self-start rounded-md border border-border-light bg-surface-card px-2 py-1 text-[11px] font-medium text-content-secondary hover:border-border hover:bg-surface-hover"
        }
      >
        <SparkleIcon className={compact ? "h-3.5 w-3.5 shrink-0" : undefined} />
        {!compact && labelFor(status)}
      </Button>

      {expansion && (
        <div className={compact ? "mt-1.5 w-full" : undefined}>{expansion}</div>
      )}
    </div>
  );
}

function labelFor(status: Status): string {
  switch (status.kind) {
    case "loading":
      return "Loading model…";
    case "rewriting":
      return "Rewriting…";
    case "done":
      return "Rewrite again";
    case "error":
      return "Try again";
    default:
      return "Rewrite";
  }
}

/** Inline sparkle glyph for the rewrite affordance (SVG, not emoji). */
function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className ?? "h-3 w-3 shrink-0"}
      fill="currentColor"
    >
      <path d="M12 2l1.9 5.6a4 4 0 0 0 2.5 2.5L22 12l-5.6 1.9a4 4 0 0 0-2.5 2.5L12 22l-1.9-5.6a4 4 0 0 0-2.5-2.5L2 12l5.6-1.9a4 4 0 0 0 2.5-2.5L12 2z" />
    </svg>
  );
}

function LoadingPanel({ progress }: { progress: ProgressUpdate }) {
  const pct = Math.max(0, Math.min(100, Math.round(progress.progress * 100)));
  return (
    <div className="flex flex-col gap-1 rounded border border-border-light bg-surface-subtle p-2">
      <div className="flex items-center justify-between text-[11px] text-content-secondary">
        <span>Loading the bullet-rewrite model (~1.2GB, one-time download)</span>
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
      <details className="mt-1">
        <summary className="cursor-pointer text-[10px] text-content-tertiary hover:underline">
          What's happening?
        </summary>
        <p className="mt-1 max-w-prose text-[10px] leading-relaxed text-content-tertiary">
          A small open-source language model (Qwen2.5-1.5B) is downloading to
          your browser. It runs entirely on your device — your bullet text
          never leaves this tab. The download takes about a minute on a
          typical connection and is cached for next time.
        </p>
      </details>
    </div>
  );
}

function RewriteResult({
  rewritten,
  copied,
  onCopy,
}: {
  rewritten: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex flex-col gap-1 rounded border border-feedback-success-border bg-feedback-success-bg p-2">
      <p className="text-xs leading-snug text-content-primary">{rewritten}</p>
      <Button
        variant="link"
        onClick={onCopy}
        className="text-[10px] font-medium text-feedback-success-text"
      >
        {copied ? "Copied" : "Use this — copy to clipboard"}
      </Button>
    </div>
  );
}
