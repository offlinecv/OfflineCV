// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useExtensionPresence — "is a browser extension listening on this page?"
 *
 * The share control it gates (`ShareWithExtensionBar`) is useful to the small
 * minority of visitors who run the capture extension and is noise to everyone
 * else, so it renders only once something has answered a probe. The probe is a
 * bare `ping` on the résumé-profile channel: it carries no résumé data, which
 * is what makes it the one message in this lane allowed to fire without a
 * click. See `lib/extension-profile.ts`.
 *
 * **A `false` is not proof of absence, and nothing here may say otherwise.** No
 * extension sends a negative acknowledgement, so silence covers "not
 * installed", "disabled", "installed after this tab opened" (Chrome does not
 * inject a declared content script into an already-open tab) and "answered a
 * millisecond after we stopped caring", and this hook cannot tell them apart.
 * It therefore only ever HIDES an affordance — it must never be used to state
 * that the user has no extension, and it latches on: once true, always true for
 * the life of the mount, because the answer cannot become false without a
 * message nobody sends.
 *
 * Two probes rather than one. A declared content script runs at `document_idle`,
 * which Chrome may schedule before `window.onload` or after it, so a probe sent
 * by a component that mounted early can precede the listener that would answer
 * it — a race that is invisible when it happens, because the symptom is a
 * control that simply never appears. The retry costs one empty message.
 */

import { useEffect, useState } from "react";
import { onExtensionPong, postExtensionPing } from "../lib/extension-profile.ts";

/** Delay before the second probe — see the docblock for the race it covers. */
const PROBE_RETRY_MS = 1_000;

export function useExtensionPresence(): boolean {
  const [present, setPresent] = useState(false);

  useEffect(() => {
    // Listener first: a `pong` that arrives before we subscribe is a `pong`
    // nobody hears, and there is no second one to fall back on.
    const unsubscribe = onExtensionPong(() => setPresent(true));
    postExtensionPing();
    const retry = setTimeout(postExtensionPing, PROBE_RETRY_MS);
    return () => {
      clearTimeout(retry);
      unsubscribe();
    };
    // Deps hand-audited both ways (`exhaustive-deps` is NOT enforced here —
    // CLAUDE.md): the effect closes over nothing but `setPresent`, which React
    // guarantees stable, so `[]` is complete and any added dep would only
    // re-probe for no behaviour change.
  }, []);

  return present;
}
