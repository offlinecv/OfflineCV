// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ConsentDialog — the modal shown before the on-device model downloads for
 * the first time. Built on the shared `Dialog` primitive from `@design-system`.
 *
 *   - Fires before `loadEngine` is ever called, on the first user-initiated
 *     on-device action (#1015). The request comes from
 *     `requestModelConsent` in `src/hooks/useModelConsent.ts`, and the one
 *     instance on the page is mounted by `ModelConsentHost`.
 *   - Consent is recorded per model id, not per license family, so a later
 *     model change asks again.
 *   - Displays the model's `licenseUrl` so the user can read the vendor's
 *     terms before accepting.
 *   - Decline starts no download and changes nothing.
 *
 * The dialog owns no persistence — it is a controlled component; the host
 * records consent on accept.
 *
 * Reuse analysis (CLAUDE.md 3-tier rule):
 *   - Primitive: `Dialog` from `@design-system` owns the modal chrome,
 *     focus trap, Esc handling, and ARIA wiring. No raw `<dialog>` here.
 *   - Primitive: `Button` for both Accept and Decline.
 *   - No `Card`: the dialog itself is the surface; nesting Card would
 *     double the border + padding.
 */

import { Button, Dialog } from "@design-system";
import {
  downloadSizeLabel,
  type ModelMetadata,
} from "../../lib/webllm/models.ts";

interface ConsentDialogProps {
  /** The model about to download. */
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
        <p className="text-sm leading-relaxed text-content-secondary">
          The on-device AI features use{" "}
          <strong className="text-content-primary">{model.name}</strong>, which
          is released under{" "}
          <a
            href={model.licenseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-primary underline underline-offset-2 hover:text-accent-primary-hover"
          >
            the vendor's terms of use
          </a>
          . Downloading the model ({downloadSizeLabel(model)}, one time) means
          accepting those terms; the weights then stay on your device.
        </p>
        <p className="text-2xs leading-relaxed text-content-tertiary">
          You only need to accept once in this browser.
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
