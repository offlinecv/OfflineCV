// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * WebGpuUnavailableNotice — the shared explainer that replaces the silent
 * `return null` when WebGPU isn't available (#276).
 *
 * Rendered as the body of the on-device-AI tab (the canonical on-device-AI
 * surface) when WebGPU can't run here — the tab used to vanish entirely. Instead
 * of a blank, the user gets: (1) a compact, capability-specific headline, (2)
 * reassurance that the core ATS score + parsed résumé are unaffected (on-device
 * AI is additive), and (3) a "How to turn this on →" Dialog with guidance
 * auto-selected to their detected browser + OS.
 *
 * All the UA-sniffing and the routing matrix live in `lib/webllm/platform.ts`;
 * this component only renders. Internal URLs (`chrome://…`, `about:config`)
 * come back as `copyPaths` and render as copy-to-clipboard text, never links —
 * browsers block web navigation to those schemes.
 *
 * Reuse (CLAUDE.md 3-tier rule): `InlineResult` (warning) for the compact strip
 * and `Dialog` for the how-to; `Button` for every control, and `CopyButton` for
 * the copy-path rows (#609). External help is a raw `<a>` (a link, not an
 * interactive-button primitive concern). No new banner/modal chrome is
 * introduced.
 */

import { useEffect, useMemo, useState } from "react";
import { Button, CopyButton, Dialog, InlineResult } from "@design-system";
import type { WebGpuCapability } from "../../lib/webllm/types.ts";
import {
  detectBrowserPlatform,
  enableGuidance,
  type CopyPath,
} from "../../lib/webllm/platform.ts";
import { trackWebllmNoticeShown } from "../../lib/analytics.ts";

const HEADLINE: Record<Exclude<WebGpuCapability, "available">, string> = {
  "no-webgpu": "On-device AI isn't available in this browser",
  "unsupported-os": "On-device AI couldn't reach your GPU",
};

interface Props {
  /** The non-`"available"` capability that triggered this notice. */
  capability: Exclude<WebGpuCapability, "available">;
}

export function WebGpuUnavailableNotice({ capability }: Props) {
  const [open, setOpen] = useState(false);
  const platform = useMemo(() => detectBrowserPlatform(), []);
  const guidance = useMemo(
    () => enableGuidance(capability, platform),
    [capability, platform],
  );

  // Fire once when the notice mounts (i.e. is actually shown). Sliced by
  // browser + os so we can size which populations hit the wall.
  useEffect(() => {
    trackWebllmNoticeShown({
      capability,
      browser: platform.browser,
      os: platform.os,
    });
  }, [capability, platform]);

  return (
    <InlineResult tone="warning" className="flex flex-col gap-1.5">
      <p className="text-sm font-semibold text-feedback-warning-text">
        {HEADLINE[capability]}
      </p>
      <p className="text-sm text-content-tertiary">
        Your ATS score and parsed résumé are unaffected — only the optional
        on-device AI analysis and rewrite need a GPU.
      </p>
      <div>
        <Button
          variant="link"
          size="sm"
          onClick={() => setOpen(true)}
          className="text-sm text-content-secondary"
        >
          How to turn this on →
        </Button>
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Enable on-device AI rewrite"
        className="max-w-md"
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <p className="text-2xs font-semibold uppercase tracking-wider text-content-muted">
              {guidance.platformLabel}
            </p>
            <ol className="flex list-decimal flex-col gap-1 pl-4 text-sm text-content-secondary">
              {guidance.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>

            {guidance.copyPaths.length > 0 && (
              <ul className="flex flex-col gap-1.5 list-none">
                {guidance.copyPaths.map((path) => (
                  <li key={path.value}>
                    <CopyablePath path={path} />
                  </li>
                ))}
              </ul>
            )}

            {guidance.links.length > 0 && (
              <ul className="flex flex-col gap-1 list-none">
                {guidance.links.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-accent-primary hover:underline underline-offset-2"
                    >
                      {link.label} ↗
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <details className="border-t border-border-light pt-2">
            <summary className="cursor-pointer text-sm text-content-tertiary hover:underline">
              Using a different browser?
            </summary>
            <ul className="mt-1.5 flex flex-col gap-1 pl-1 text-2xs text-content-tertiary list-none">
              <li>
                <span className="font-semibold text-content-secondary">
                  Chrome / Edge:
                </span>{" "}
                recent versions ship WebGPU by default; enable hardware
                acceleration if it's off.
              </li>
              <li>
                <span className="font-semibold text-content-secondary">
                  Firefox:
                </span>{" "}
                set <code>dom.webgpu.enabled</code> in <code>about:config</code>,
                or update to the latest.
              </li>
              <li>
                <span className="font-semibold text-content-secondary">
                  Safari:
                </span>{" "}
                update to a recent version (macOS Sequoia / iOS 18+).
              </li>
            </ul>
          </details>

          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Dialog>
    </InlineResult>
  );
}

/**
 * A copy-to-clipboard row for an internal URL the user must paste into their
 * own address bar (browsers block web navigation to `chrome://` / `about:`).
 *
 * Migrated onto the shared `CopyButton` (#609) — this file was one of the three
 * hand-rolled clipboard implementations that primitive replaced. One behaviour
 * change came with it, deliberately: a denied or unavailable clipboard now says
 * so instead of leaving the button reading "Copy". The path stays on screen and
 * selectable either way, which is why the failure label points back at it.
 */
function CopyablePath({ path }: { path: CopyPath }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xs text-content-tertiary">{path.label}</span>
      <div className="flex items-center gap-2 rounded border border-border-light bg-surface-subtle px-2 py-1">
        <code className="flex-1 overflow-x-auto text-2xs text-content-primary">
          {path.value}
        </code>
        <CopyButton
          value={path.value}
          variant="link"
          size="sm"
          aria-label={`Copy ${path.value}`}
          className="shrink-0 text-2xs text-accent-primary"
          copiedLabel="Copied ✓"
          failedLabel="Select it above"
          resetAfterMs={1500}
        >
          Copy
        </CopyButton>
      </div>
    </div>
  );
}
