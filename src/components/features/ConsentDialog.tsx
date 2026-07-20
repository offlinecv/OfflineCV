// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ConsentDialog — modal shown before any Restricted-Community model begins
 * downloading. Built on the shared `Dialog` primitive from `@design-system`.
 *
 * Per the #64 spec:
 *   - Fires before `loadEngine` is called for a Restricted-Community model
 *     when consent has not already been recorded.
 *   - Persistence is per-`licenseType` (handled by `useModelSelection`),
 *     not per-model — accepting Gemma's terms also covers Llama if both
 *     are tagged Restricted-Community.
 *   - The modal DISPLAYS the per-model `licenseUrl` so the user reads the
 *     specific vendor's terms before accepting. Type-level consent +
 *     model-level link disclosure.
 *   - Decline must revert to the previously cached model (or
 *     `DEFAULT_MODEL_ID` if none) and not start any download.
 *
 * The dialog owns no persistence — it's a controlled component. The caller
 * (ModelSelector) handles `recordConsent` on accept and "revert selection"
 * on decline.
 *
 * Reuse analysis (CLAUDE.md 3-tier rule):
 *   - Primitive: `Dialog` from `@design-system` owns the modal chrome,
 *     focus trap, Esc handling, and ARIA wiring. No raw `<dialog>` here.
 *   - Primitive: `Button` for both Accept and Decline.
 *   - No `Card`: the dialog itself is the surface; nesting Card would
 *     double the border + padding.
 */

import { Button, Dialog } from "@design-system";
import type { ModelMetadata } from "../../lib/webllm/models.ts";

interface ConsentDialogProps {
  /** The model the user is trying to load. Must be Restricted-Community. */
  model: ModelMetadata;
  open: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

export function ConsentDialog({
  model,
  open,
  onAccept,
  onDecline,
}: ConsentDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onDecline}
      title={`Review the ${model.name} license before downloading`}
      className="max-w-md"
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-content-secondary">
          <strong className="text-content-primary">{model.name}</strong> is
          released under the{" "}
          {model.licenseUrl ? (
            <a
              href={model.licenseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-amber underline underline-offset-2 hover:text-brand-amber-light"
            >
              vendor's terms of use
            </a>
          ) : (
            "vendor's terms of use"
          )}
          , which differ from the Apache-2.0 default. The model weights stay
          on your device, but downloading the model means accepting those
          terms.
        </p>
        <p className="text-[11px] leading-relaxed text-content-tertiary">
          You only need to accept once per license type — switching to
          another model under the same license won't re-prompt you.
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="link"
            size="sm"
            onClick={onDecline}
            className="text-content-tertiary"
          >
            Decline
          </Button>
          {/* Initial focus deliberately defaults to Decline (first
              focusable child in DOM order). Consent UX convention: the
              safe option gets keyboard focus so a roll-through Enter
              doesn't accidentally accept terms the user hasn't read. */}
          <Button variant="primary" size="sm" onClick={onAccept}>
            Accept &amp; download
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
