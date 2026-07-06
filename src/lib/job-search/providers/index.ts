// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Provider registry for the in-app job search.
 *
 * Only keyless, CORS-open feeds verified reachable from a browser origin ship
 * here (Remotive, Arbeitnow, Jobicy — all return
 * `access-control-allow-origin: *`). A candidate that fails CORS is dropped
 * rather than added, so the fan-out never hangs on an unreachable feed.
 *
 * This module is dynamic-imported by `search.ts` (same chunk-splitting pattern
 * as the cascade tiers) so the provider adapters + their HTML-strip dependency
 * stay out of the entry chunk until the user actually searches.
 *
 * #320 (BYOK) will append its keyed adapter to the returned list ONLY when a
 * key is present — `getProviders()` is the single seam that decides who
 * participates in the fan-out.
 */

import type { JobProvider } from "../types.ts";
import { remotiveProvider } from "./remotive.ts";
import { arbeitnowProvider } from "./arbeitnow.ts";
import { jobicyProvider } from "./jobicy.ts";

/** The always-on keyless providers, in display order. */
export const KEYLESS_PROVIDERS: readonly JobProvider[] = [
  remotiveProvider,
  arbeitnowProvider,
  jobicyProvider,
];

/**
 * Resolve the providers that participate in the next fan-out. Today this is
 * just the keyless set; #320 folds in a keyed provider here when a stored key
 * is present.
 */
export function getProviders(): readonly JobProvider[] {
  return KEYLESS_PROVIDERS;
}
