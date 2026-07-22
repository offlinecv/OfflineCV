// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
 *
 * #533 makes that seam PARAMETERIZED: company ATS-board providers, derived
 * from the candidate's sector via the registry, are passed in and appended to
 * the always-on keyless set. `makeCompanyProvider` is the raw registry-entry →
 * adapter dispatch; the bounded pipeline that wraps it (cache → light fetch →
 * role filter → per-company cap → lazy hydrate) lives in `../company-boards.ts`,
 * so this module stays a plain registry.
 */

import type { JobProvider } from "../types.ts";
import type { CompanyEntry } from "../company-registry.ts";
import { remotiveProvider } from "./remotive.ts";
import { arbeitnowProvider } from "./arbeitnow.ts";
import { jobicyProvider } from "./jobicy.ts";
import { makeGreenhouseProvider } from "./greenhouse.ts";
import { makeLeverProvider } from "./lever.ts";
import { makeAshbyProvider } from "./ashby.ts";

/** The always-on keyless providers, in display order. */
export const KEYLESS_PROVIDERS: readonly JobProvider[] = [
  remotiveProvider,
  arbeitnowProvider,
  jobicyProvider,
];

/**
 * Build the raw board provider for one registry entry. `entry.name` is threaded
 * through as the provider label so a result card reads "Stripe", not
 * "Greenhouse · stripe" — the company is the thing the candidate recognizes,
 * and the ATS vendor is an implementation detail.
 *
 * The returned provider fetches the WHOLE light index, unfiltered and uncapped.
 * Callers wanting the bounded pipeline want `makeBoardProvider` in
 * `../company-boards.ts` instead.
 */
export function makeCompanyProvider(entry: CompanyEntry): JobProvider {
  switch (entry.ats) {
    case "greenhouse":
      return makeGreenhouseProvider(entry.slug, entry.name);
    case "lever":
      return makeLeverProvider(entry.slug, entry.name);
    case "ashby":
      return makeAshbyProvider(entry.slug, entry.name);
  }
}

/**
 * Resolve the providers that participate in the next fan-out: the always-on
 * keyless feeds, plus any company-board providers the caller selected. No
 * companies selected (the default) yields exactly the pre-#533 keyless set, so
 * the parser-audit lane's behaviour is unchanged for a user who never touches
 * the company selector. #320 folds a keyed provider in here too.
 */
export function getProviders(
  companyProviders: readonly JobProvider[] = [],
): readonly JobProvider[] {
  return [...KEYLESS_PROVIDERS, ...companyProviders];
}
