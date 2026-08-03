// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * RewritePromptDisclosure — "or take our prompt to a model you already use"
 * (#609).
 *
 * A collapsed secondary affordance inside the existing rewrite steering dialog.
 * The on-device pass stays the primary, one-click path and is unchanged: a user
 * who never opens this sees and does what they did before, unchanged. This is a
 * DISCLOSURE, not a fork in the road — which is why it is a link under the
 * dialog's own CTA row rather than a second button competing with "Run
 * rewrite".
 *
 * Why it exists: the on-device model is the only rewriter that keeps the résumé
 * text on the device, and it is also the weakest one most users can reach.
 * Someone with a frontier model in the next tab could do better, and the only
 * thing standing between them and that is our prompt — which was locked inside
 * the bundle. Handing it over costs this project nothing in privacy posture: a
 * clipboard write is local, the copied text carries no résumé content
 * (`export-prompt.ts` property 1), and where the user takes it afterwards is
 * their own deliberate choice rather than our default. No reassurance copy
 * about that here — this surface states what it does and lets the user decide.
 *
 * A sibling file rather than more lines in `ResumeRewrite.tsx` (CLAUDE.md's
 * ~200 LOC rule; that file is already at 200+ and owns the dialog).
 *
 * Reuse (CLAUDE.md 3-tier rule): `Button`, `TextAreaField` and `CopyButton`
 * from `@design-system` — no raw `<button>`, `<textarea>`, or a fourth
 * hand-rolled clipboard write. The prompt itself is built by the pure
 * `buildExportableRewritePrompt`; this file only renders.
 */

import { useMemo, useState } from "react";
import { Button, CopyButton, TextAreaField } from "@design-system";
import type { ResumeRewriteController } from "../../hooks/useResumeRewrite.ts";
import { buildExportableRewritePrompt } from "../../lib/webllm/export-prompt.ts";

export function RewritePromptDisclosure({
  controller,
}: {
  controller: ResumeRewriteController;
}) {
  const [open, setOpen] = useState(false);
  const { rewriteableSections, steering } = controller;

  // Derived on every render from the controller's LIVE steering, so editing the
  // instructions box or switching a length chip with this open rewrites the
  // shown text. Building it once on mount is the obvious bug here and would
  // pass any "the prompt renders" test — `RewritePromptDisclosure.test.tsx`
  // asserts the update for both inputs.
  const prompt = useMemo(
    () => buildExportableRewritePrompt(rewriteableSections, steering),
    [rewriteableSections, steering],
  );

  return (
    <div className="flex flex-col gap-2 border-t border-border-light pt-3">
      <div>
        <Button
          variant="link"
          size="sm"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="text-2xs text-content-secondary"
        >
          {open ? "Hide the prompt" : "Prefer another model? Copy the prompt ↓"}
        </Button>
      </div>

      {open && (
        <div className="flex flex-col gap-2">
          <p className="text-2xs text-content-muted">
            The same rules the on-device rewrite runs on, with your settings
            above folded in. Take it to any model, bring your own résumé, and
            edit the result back in below. This text holds no résumé content.
          </p>
          {/* Read-only, not disabled: a disabled textarea's text cannot be
              selected with the mouse in Chromium, and manual selection is the
              whole fallback when the clipboard is unavailable (dev:http, a
              denied permission). `autoGrow={false}` keeps a long prompt from
              pushing the dialog's own controls off-screen. */}
          <TextAreaField
            label="Rewrite prompt to copy"
            value={prompt}
            onChange={() => {}}
            readOnly
            autoGrow={false}
            rows={8}
            className="max-h-56 font-mono text-2xs"
          />
          <div className="flex items-center justify-end">
            <CopyButton
              value={prompt}
              variant="ghost"
              size="sm"
              className="rounded-md border border-border-light bg-surface-card px-2.5 py-1 text-2xs text-content-primary hover:border-border hover:bg-surface-hover"
              copiedLabel="Copied the prompt"
              failedLabel="Couldn’t copy — select the text above"
              resetAfterMs={3000}
            >
              Copy prompt
            </CopyButton>
          </div>
        </div>
      )}
    </div>
  );
}
