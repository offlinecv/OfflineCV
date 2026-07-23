// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Feature flags — two-layer gate.
 *
 * 1. **Build-time env default** (this file's `FLAG_DEFAULTS`). The real
 *    kill-switch: synchronous, works in every build (including the keyless OSS
 *    build), no async flicker, and dead-code-eliminates a gated surface when
 *    off. Set the env var at build time to flip the default.
 * 2. **PostHog override** (optional rollout dial). When PostHog is loaded, its
 *    `isFeatureEnabled` verdict — if defined — overrides the env default,
 *    enabling % rollout / targeting without a rebuild. When PostHog is absent
 *    (no `VITE_POSTHOG_KEY`), the env default wins and no posthog-js is pulled
 *    in (see analytics.ts).
 *
 * Flags resolve to the env default first, so visible UI never pops in/out while
 * PostHog's flags load over the network.
 */

import { useEffect, useState } from "react";
import { getFeatureFlag, subscribeFeatureFlags } from "./analytics";

const envOn = (v: unknown): boolean => v === "true" || v === "1";

/**
 * Build-time defaults, keyed by PostHog flag name (kebab-case to match the
 * PostHog flag key). Default OFF unless its env var is explicitly set.
 *
 * - `jd-fit-banner` (`VITE_ENABLE_JD_FIT`) — the "Check fit against a job"
 *   cross-sell to the `/jd-fit/` surface. Off by default: `/jd-fit/` is alpha
 *   and not ready to promote from the parser result.
 *
 * - `job-tracker` (`VITE_ENABLE_JOB_TRACKER`) — the local job tracker (#323)
 *   on `/` and its "save this job" affordance on `/jd-fit/`. Off by default:
 *   #323 is P4 (Post-Public), so the surface ships dark and is promoted from
 *   PostHog rather than by a rebuild. The data layer is inert while off — the
 *   hook only runs where the flag renders it.
 *
 * - `llm` (`VITE_ENABLE_LLM`) — two-layer gate for all WebLLM-backed
 *   features: the disagreement detector (#242), escape hatch (#243), and
 *   gap-report (#245).
 *
 *   Layer 1 (this entry, build-time kill-switch): off by default. Set
 *   `VITE_ENABLE_LLM=true` at build time to enable for a deployment.
 *
 *   Layer 2 (optional PostHog `llm` flag): when PostHog is loaded, its
 *   `isFeatureEnabled("llm")` verdict overrides this default — enables %
 *   rollout / device targeting without a rebuild.
 *
 *   Each child feature (#242–#245) also gates independently on WebGPU
 *   capability (via `detectWebGpu` from `src/lib/webllm/capability.ts`) so
 *   devices without WebGPU never see the LLM path even when this flag is on.
 *   The foundation (#241) owns this shared gating rule; UI wiring is out of
 *   scope here.
 */
// Module-private: consumed only by `useFlag` and the `FlagName` type below.
// Not exported — no other module reads the defaults map directly, and
// `keyof typeof` works on a private const, so keeping it unexported avoids a
// dead public export (fallow dead-code gate).
const FLAG_DEFAULTS = {
  "jd-fit-banner": envOn(import.meta.env.VITE_ENABLE_JD_FIT),
  "job-tracker": envOn(import.meta.env.VITE_ENABLE_JOB_TRACKER),
  "llm": envOn(import.meta.env.VITE_ENABLE_LLM),
} as const;

export type FlagName = keyof typeof FLAG_DEFAULTS;

/**
 * Resolve a feature flag: PostHog override if present, else the build-time env
 * default. Re-renders when PostHog's flags refresh.
 */
export function useFlag(name: FlagName): boolean {
  const [on, setOn] = useState<boolean>(FLAG_DEFAULTS[name]);
  useEffect(() => {
    const resolve = () => setOn(getFeatureFlag(name) ?? FLAG_DEFAULTS[name]);
    resolve();
    return subscribeFeatureFlags(resolve);
  }, [name]);
  return on;
}
