// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * PageShell — the chrome both root surfaces share (issue #226).
 *
 * `/` (parser audit, App.tsx) and `/jd-fit` (JdFitApp.tsx) are two products
 * under one brand, so the header (logo + GitHub-star CTA + update banner) and
 * the footer (privacy line + links) are identical between them. This shell owns
 * that chrome once; each surface passes its own `subtitle`, `badge`, optional
 * `chips`, and an optional `headerExtra` slot (e.g. the cross-link CTA), then
 * renders its body as `children`.
 *
 * Reuse: consumes only `@design-system` primitives/shared components + the
 * useGitHubStars / useUpdateChecker hooks. No raw <button> / hardcoded palette.
 */

import { useState, type ReactNode } from "react";
import { UpdateBanner, GitHubStarCta } from "@design-system";
import { useGitHubStars } from "../../hooks/useGitHubStars.ts";
import { useUpdateChecker } from "../../hooks/useUpdateChecker.ts";

export interface PageShellProps {
  /** Subtitle shown beside the GitHub-star CTA on wide viewports. */
  subtitle: string;
  /** Small uppercase badge after the wordmark (e.g. "alpha", "JD Fit"). */
  badge: string;
  /** Optional chip row under the header. */
  chips?: ReactNode;
  /** Optional header-right slot rendered before the GitHub CTA. */
  headerExtra?: ReactNode;
  children: ReactNode;
}

export function PageShell({
  subtitle,
  badge,
  chips,
  headerExtra,
  children,
}: PageShellProps) {
  const { count: starCount } = useGitHubStars();

  // Proactive stale-deploy notice (see useUpdateChecker). Dismissable so a user
  // mid-analysis can defer; the vite:preloadError backstop still catches a hard
  // chunk failure if they ignore it.
  const { updateAvailable, reload } = useUpdateChecker();
  const [updateDismissed, setUpdateDismissed] = useState(false);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-10">
      {updateAvailable && !updateDismissed && (
        <UpdateBanner
          onReload={reload}
          onDismiss={() => setUpdateDismissed(true)}
        />
      )}

      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <a
              href={import.meta.env.BASE_URL}
              className="inline-grid h-8 w-8 place-items-center rounded-md bg-brand-amber text-base font-bold text-content-inverse"
              aria-label="resumelint home"
            >
              R
            </a>
            <h1 className="text-2xl font-semibold tracking-tight">resumelint</h1>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-content-muted">
              {badge}
            </span>
          </div>
          <div className="flex items-center gap-4">
            {headerExtra}
            <p className="hidden text-xs text-content-muted sm:block">
              {subtitle}
            </p>
            <GitHubStarCta variant="inline" count={starCount} />
          </div>
        </div>
        {chips && <div className="flex flex-wrap gap-2">{chips}</div>}
      </header>

      {children}

      <footer className="mt-auto flex flex-col gap-2 border-t border-border-light pt-6 text-xs text-content-tertiary">
        <p>Your PDF stays in this browser tab by default and is never used to train AI. AI analysis is optional.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <a
            href="https://github.com/resumelint-org/resumelint/blob/main/LICENSE"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:underline"
          >
            License
          </a>
          <a
            href="https://www.hbs.edu/managing-the-future-of-work/research/Pages/hidden-workers-untapped-talent.aspx"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:underline"
          >
            Further reading: HBS Hidden Workers
          </a>
          <a
            href="https://github.com/resumelint-org/resumelint/blob/main/README.md#telemetry"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:underline"
          >
            Privacy &amp; data
          </a>
        </div>
      </footer>
    </main>
  );
}
