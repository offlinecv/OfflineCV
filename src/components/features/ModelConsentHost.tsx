// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ModelConsentHost — the one place on a page that shows `ConsentDialog` for
 * the shipped on-device model (#1015).
 *
 * `PageShell` mounts it once, so `/` and `/jobs/` both have it and no feature
 * renders its own dialog: a rewrite, the critique, the escape hatch, the JD
 * match and the status line's Download all call `requestModelConsent()` and
 * this host answers. While it is mounted it registers itself, which is what
 * lets `requestModelConsent` tell "nobody can ask" (resolve `false`) from
 * "ask" — see `src/hooks/useModelConsent.ts`.
 *
 * Renders nothing until the first request, so a page where nobody touches an
 * on-device feature carries no dialog node. After that the dialog stays
 * mounted and only `open` toggles: the `Dialog` primitive restores focus in
 * its close path, which an unmount-while-open would skip.
 */

import { useEffect, useState } from "react";
import { useModelConsentRequest } from "../../hooks/useModelConsent.ts";
import { SHIPPED_MODEL } from "../../lib/webllm/models.ts";
import { ConsentDialog } from "./ConsentDialog.tsx";

export function ModelConsentHost() {
  const { open, accept, decline, register } = useModelConsentRequest();
  const [everOpened, setEverOpened] = useState(false);

  useEffect(() => register(), [register]);

  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  if (!open && !everOpened) return null;
  return (
    <ConsentDialog
      model={SHIPPED_MODEL}
      open={open}
      onAccept={accept}
      onDecline={decline}
    />
  );
}
