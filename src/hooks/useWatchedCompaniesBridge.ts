// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Mounts the read-only watched-companies responder
 * (`lib/watched-companies-bridge.ts`) for the lifetime of the page (#864).
 *
 * Called once from `JobsApp.tsx` — the only surface `useCompanyTargets`/the
 * watched shortlist exists on. Not mounted on `/` since there is nothing
 * there for the extension to ask about.
 */

import { useEffect } from "react";
import { listenForWatchedCompaniesRequests } from "../lib/watched-companies-bridge.ts";

export function useWatchedCompaniesBridge(): void {
  useEffect(() => listenForWatchedCompaniesRequests(), []);
}
