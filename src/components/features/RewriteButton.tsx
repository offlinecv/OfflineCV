// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Per-bullet "Suggest a rewrite" CTA. Runs Qwen2-1.5B in the browser via
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

interface RewriteButtonProps {
  bullet: string;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading"; progress: ProgressUpdate }
  | { kind: "rewriting" }
  | { kind: "done"; rewritten: string }
  | { kind: "error"; message: string };

export function RewriteButton({ bullet }: RewriteButtonProps) {
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

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-label={`Suggest a rewrite for this bullet`}
        className={
          idle
            ? "group inline-flex min-h-[28px] items-center gap-1 self-start py-1 text-[11px] font-medium text-content-tertiary hover:text-brand-amber disabled:cursor-not-allowed disabled:opacity-60"
            : "inline-flex min-h-[28px] items-center gap-1 self-start rounded-md border border-border-light bg-surface-card px-2 py-1 text-[11px] font-medium text-content-secondary hover:border-border hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
        }
      >
        <SparkleIcon />
        {labelFor(status)}
      </button>

      {status.kind === "loading" && (
        <LoadingPanel progress={status.progress} />
      )}

      {status.kind === "rewriting" && (
        <p className="text-[11px] text-content-muted">Rewriting…</p>
      )}

      {status.kind === "done" && (
        <RewriteResult
          rewritten={status.rewritten}
          copied={copied}
          onCopy={onCopy}
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
function SparkleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-3 w-3 shrink-0"
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
          A small open-source language model (Qwen2-1.5B) is downloading to
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
      <button
        type="button"
        onClick={onCopy}
        className="self-start text-[10px] font-medium text-feedback-success-text hover:underline"
      >
        {copied ? "Copied" : "Use this — copy to clipboard"}
      </button>
    </div>
  );
}
