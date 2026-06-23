// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ModelLoadProgress — the shared WebLLM model-download progress panel.
 *
 * Replaces the two near-identical `LoadingPanel` functions previously
 * hand-rolled in `RewriteButton.tsx` and `SectionRewrite.tsx` (issue #130).
 * Owns the chrome (rounded border + subtle bg + padding) and the progress-
 * bar markup; consumers thread the progress fraction + label + optional
 * loader status line.
 *
 * Used today by per-bullet rewrite, section rewrite, and the model picker
 * (`ModelSelector` in PR B of #64). When PR B's picker drives a model
 * switch, the same panel renders for the new model's download — same
 * chrome, different `label`.
 *
 * Design rules (CLAUDE.md):
 *   – Semantic tokens only; no hardcoded hex or raw palette classes.
 *   – `role="progressbar"` + `aria-value{now,min,max}` for screen readers.
 *   – The "What's happening?" disclosure (showExplainer) is opt-in so
 *     callers that already render their own context don't double-up.
 */

interface ModelLoadProgressProps {
  /** 0..1 fraction reported by WebLLM's initProgressCallback. */
  progress: number;
  /**
   * Headline label shown to the user. Caller-supplied so the per-bullet
   * vs section vs picker contexts can name the operation explicitly
   * (e.g. "Loading the rewrite model (~1.2 GB, one-time download)").
   */
  label: string;
  /**
   * Optional status text from WebLLM (e.g. the weight file currently being
   * fetched). Rendered in monospace below the bar when present.
   */
  text?: string;
  /**
   * When true, render a `<details>` disclosure that explains the model is
   * downloading locally and the bullet text never leaves the tab. Defaults
   * to `false`; per-bullet `RewriteButton` opts in.
   */
  showExplainer?: boolean;
}

export function ModelLoadProgress({
  progress,
  label,
  text,
  showExplainer = false,
}: ModelLoadProgressProps) {
  const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
  return (
    <div className="flex flex-col gap-1 rounded border border-border-light bg-surface-subtle p-2">
      <div className="flex items-center justify-between text-[11px] text-content-secondary">
        <span>{label}</span>
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
      {text && (
        <p className="font-mono text-[10px] text-content-muted">{text}</p>
      )}
      {showExplainer && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[10px] text-content-tertiary hover:underline">
            What's happening?
          </summary>
          <p className="mt-1 max-w-prose text-[10px] leading-relaxed text-content-tertiary">
            A small open-source language model is downloading to your
            browser. It runs entirely on your device — your text never
            leaves this tab. The download is cached for next time.
          </p>
        </details>
      )}
    </div>
  );
}
