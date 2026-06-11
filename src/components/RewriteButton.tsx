// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Per-bullet "Suggest a rewrite" CTA. Runs Qwen2-1.5B in the browser via
 * WebLLM (see ../lib/webllm/).
 *
 * Non-negotiable rules from issue #3:
 *   - On browsers without WebGPU, this component returns null. Not a
 *     greyed-out button, not a "your browser isn't supported" banner. Just
 *     gone. Silent degradation is worse than absence — please don't "fix"
 *     this with a fallback message.
 *   - The model weights (~1.2GB) download on click only. Never on mount,
 *     never on hover, never on scroll-into-view. The cold-start UX is the
 *     conversion killer, not inference cost.
 */

import { useCallback, useEffect, useState } from "react";
import { detectWebGpu } from "../lib/webllm/capability.ts";
import { loadEngine } from "../lib/webllm/web-llm.ts";
import { rewriteBulletWithLlm } from "../lib/webllm/rewrite-bullet.ts";
import type {
  ProgressUpdate,
  WebGpuCapability,
} from "../lib/webllm/types.ts";

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

  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="self-start rounded-md border border-neutral-300 bg-white px-2 py-1 text-[11px] font-medium text-neutral-700 hover:border-neutral-400 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
      >
        {labelFor(status)}
      </button>

      {status.kind === "loading" && (
        <LoadingPanel progress={status.progress} />
      )}

      {status.kind === "rewriting" && (
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          Rewriting…
        </p>
      )}

      {status.kind === "done" && (
        <RewriteResult
          rewritten={status.rewritten}
          copied={copied}
          onCopy={onCopy}
        />
      )}

      {status.kind === "error" && (
        <p className="text-[11px] text-red-700 dark:text-red-300">
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
      return "Suggest another rewrite";
    case "error":
      return "Try again";
    default:
      return "Suggest a rewrite";
  }
}

function LoadingPanel({ progress }: { progress: ProgressUpdate }) {
  const pct = Math.max(0, Math.min(100, Math.round(progress.progress * 100)));
  return (
    <div className="flex flex-col gap-1 rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center justify-between text-[11px] text-neutral-700 dark:text-neutral-300">
        <span>Loading the bullet-rewrite model (~1.2GB, one-time download)</span>
        <span className="font-mono">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
        <div
          className="h-full bg-emerald-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress.text && (
        <p className="font-mono text-[10px] text-neutral-500 dark:text-neutral-500">
          {progress.text}
        </p>
      )}
      <details className="mt-1">
        <summary className="cursor-pointer text-[10px] text-neutral-600 hover:underline dark:text-neutral-400">
          What's happening?
        </summary>
        <p className="mt-1 max-w-prose text-[10px] leading-relaxed text-neutral-600 dark:text-neutral-400">
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
    <div className="flex flex-col gap-1 rounded border border-emerald-200 bg-emerald-50/60 p-2 dark:border-emerald-900/60 dark:bg-emerald-950/30">
      <p className="text-xs leading-snug text-neutral-900 dark:text-neutral-100">
        {rewritten}
      </p>
      <button
        type="button"
        onClick={onCopy}
        className="self-start text-[10px] font-medium text-emerald-800 hover:underline dark:text-emerald-200"
      >
        {copied ? "Copied" : "Use this — copy to clipboard"}
      </button>
    </div>
  );
}
