// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * GitHubStarCta — quiet, policy-compliant GitHub star CTA.
 *
 * Two display variants (set via `variant` prop):
 *
 *   "inline"  → a compact anchor for app chrome (footer). Always visible, never
 *               pops. Renders as a ghost-style link with GitHub mark SVG + label
 *               + optional live star count.
 *
 *   "card"    → a warm, contextual CTA card (used inside FeedbackPanel's
 *               post-positive-feedback thank-you surface). Wraps the inline CTA
 *               in a Card so it has visual weight without being a modal.
 *
 * GitHub policy rules observed (load-bearing — do not relax):
 *   ✓ Plain "Star us" ask is allowed.
 *   ✗ Nothing offered in exchange for a star (no gifts, credits, gating).
 *   ✗ Score/result never blocked behind a star.
 *   ✗ No star modal on app load.
 *
 * Design rules (CLAUDE.md): Button + Card from @design-system; semantic tokens
 * only; no hardcoded hex / raw palette classes / manual dark: variants.
 */

import { Card } from "./Card.tsx";

const REPO_URL = "https://github.com/offlinecv/OfflineCV";

/**
 * Minimum star count before we surface the number as social proof. Below this,
 * a low count ("1", "3") is weaker than no number at all — so we keep the plain
 * "Star on GitHub" ask and hide the badge until the count is genuinely
 * persuasive. One-line knob; raise/lower as the repo grows.
 */
const STAR_COUNT_DISPLAY_THRESHOLD = 25;

/** Inline SVG GitHub mark (octocat silhouette path). Sized at 14×14 so it
 *  sits on the same baseline as text-xs / text-sm copy without vertical shift.
 *  Uses `currentColor` so it inherits the surrounding text token. */
function GitHubIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="shrink-0"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

interface GitHubStarCtaProps {
  variant: "inline" | "card";
  /** Live star count from `useGitHubStars()`. Omit (undefined) to hide the count. */
  count?: number;
}

/** Format a raw star count for display: 1234 → "1,234"; 1234567 → "1.2M". */
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  return n.toLocaleString();
}

function StarLink({ count }: { count?: number }) {
  // Only surface the number once it's persuasive; a tiny count reads as weak
  // social proof, so below the threshold we show the plain ask with no badge.
  const showCount = count !== undefined && count >= STAR_COUNT_DISPLAY_THRESHOLD;
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 text-xs text-content-secondary transition-colors hover:text-content-primary"
      aria-label={
        showCount
          ? `Star offlinecv on GitHub — ${formatCount(count)} stars`
          : "Star offlinecv on GitHub"
      }
    >
      <GitHubIcon />
      <span>Star on GitHub</span>
      {showCount && (
        <span
          aria-hidden="true"
          className="rounded bg-surface-subtle px-1 py-0.5 text-[10px] font-semibold tabular-nums text-content-tertiary"
        >
          {formatCount(count)}
        </span>
      )}
    </a>
  );
}

export function GitHubStarCta({ variant, count }: GitHubStarCtaProps) {
  if (variant === "card") {
    return (
      <Card className="flex flex-col gap-2 border-l-4 border-l-brand-amber bg-accent-forward-bg shadow-sm">
        <p className="text-sm font-semibold text-content-primary">
          Glad it's working! ⭐
        </p>
        <p className="text-sm text-content-secondary">
          Star us on GitHub so others can find OfflineCV.
        </p>
        <StarLink count={count} />
      </Card>
    );
  }

  // variant === "inline"
  return <StarLink count={count} />;
}
