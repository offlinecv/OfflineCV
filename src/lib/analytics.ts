// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { LayoutTrigger, ParseEvent } from "./heuristics/types";
import type { WebGpuCapability } from "./webllm/types";
import type { AtsPlatform } from "./jd-match/fetch-jd";

type PostHog = {
  capture: (event: string, props?: Record<string, unknown>) => void;
};

const KEY = import.meta.env.VITE_POSTHOG_KEY ?? "";
const HOST = import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com";

/** True when analytics are enabled (VITE_POSTHOG_KEY is set at build time). */
export const ANALYTICS_ENABLED = !!KEY;

let ph: PostHog | null = null;
const queue: Array<[string, Record<string, unknown>]> = [];

export async function initAnalytics(): Promise<void> {
  // OSS build with no env: KEY is the literal "" after Vite's build-time
  // replacement, so Rollup drops the dynamic import and the posthog-js
  // chunk never appears in dist/.
  if (!KEY) return;
  const mod = await import("posthog-js");
  mod.default.init(KEY, {
    api_host: HOST,
    persistence: "memory",
    disable_session_recording: true,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
  });
  ph = mod.default as unknown as PostHog;
  for (const [evt, props] of queue) ph.capture(evt, props);
  queue.length = 0;
}

function track(event: string, props: Record<string, unknown>): void {
  if (!KEY) return;
  if (!ph) {
    queue.push([event, props]);
    return;
  }
  ph.capture(event, props);
}

function sizeBucket(bytes: number): string {
  if (bytes < 100_000) return "<100KB";
  if (bytes < 1_000_000) return "100KB-1MB";
  return ">1MB";
}

export function trackFileAccepted(fileSize: number): void {
  track("file_accepted", {
    file_size_bytes: fileSize,
    file_size_bucket: sizeBucket(fileSize),
  });
}

export function trackParseCompleted(args: {
  pages: number;
  elapsedMs: number;
  scoreOverall: number;
  scoreSpecificity: number;
  scoreStructure: number;
  scoreCompleteness: number;
  triggers: readonly LayoutTrigger[];
  algoVersion: string;
  layoutMultiplier: number;
}): void {
  track("parse_completed", {
    pages: args.pages,
    elapsed_ms: args.elapsedMs,
    score_overall: args.scoreOverall,
    score_specificity: args.scoreSpecificity,
    score_structure: args.scoreStructure,
    score_completeness: args.scoreCompleteness,
    triggers: [...args.triggers],
    algo_version: args.algoVersion,
    layout_multiplier: args.layoutMultiplier,
  });
}

export function trackFeedback(args: {
  verdictBand: string;
  thumb: "up" | "down";
}): void {
  track("feedback_submitted", {
    verdict_band: args.verdictBand,
    thumb: args.thumb,
  });
}

export function trackParseFailed(args: {
  errorName: string;
  fileSize: number;
}): void {
  // Never pass the error message — pdfjs error strings can quote text
  // fragments from the file, which would violate the footer's
  // "Your PDF stays in this browser tab" claim.
  track("parse_failed", {
    error_name: args.errorName,
    file_size_bytes: args.fileSize,
  });
}

// Parse-funnel telemetry. Wired into runCascade via the `onEvent` callback so
// parse_started / tier_engaged / cascade_parse_completed land in the funnel.
// The manual `trackParseCompleted` (event: "parse_completed") is separate and
// carries score dimensions (specificity/structure/completeness) that cascade
// doesn't emit — keep both; they cover different analytical questions.
//
// Privacy-safe schema: counts, enums, and pre-bucketed sizes only.
// No field VALUES or PII ever cross this path — they stay in the cascade result.
export function trackCascadeEvent(event: ParseEvent): void {
  switch (event.type) {
    case "parse_started":
      track("parse_funnel_started", {
        cascade_version: event.cascade_version,
        user_type: event.user_type,
        file_size_kb_bucket: event.file_size_kb_bucket,
      });
      break;
    case "tier_engaged":
      track("tier_engaged", {
        cascade_version: event.cascade_version,
        user_type: event.user_type,
        tier: event.tier,
        reason: event.reason,
        elapsed_ms_since_start: event.elapsed_ms_since_start,
      });
      break;
    case "parse_completed":
      // Named "cascade_parse_completed" (not "parse_completed") to avoid
      // collision with the manual trackParseCompleted event that adds
      // score-dimension data unavailable inside the cascade.
      track("cascade_parse_completed", {
        cascade_version: event.cascade_version,
        user_type: event.user_type,
        final_source: event.final_source,
        total_duration_ms: event.total_duration_ms,
        confidence: event.confidence,
        triggers: [...event.triggers],
        tier_mask: event.tier_mask,
        llm_ran: event.llm_ran,
      });
      break;
  }
}

export function trackRenderError(args: { errorName: string }): void {
  // Never pass the error message — it can echo text fragments from the file
  // being parsed and would violate the footer's privacy claim.
  track("render_error", {
    error_name: args.errorName,
  });
}

// WebLLM funnel. The call-sites (capability.ts, web-llm.ts, rewrite-bullet.ts,
// rewrite-section.ts) gate the one-shot events so each fires at most once per
// (model id, page). Same env-gating semantics as the existing trackers: when
// VITE_POSTHOG_KEY is unset, `track()` is a no-op and these compile away.
//
// `model` dimension (#64): every download/loaded/rewrite event carries the
// model id so the funnel can be sliced by model. `webllm_capability_detected`
// has no model dimension — it's about the browser, fired before any model is
// picked.

export function trackWebllmCapabilityDetected(
  capability: WebGpuCapability,
): void {
  track("webllm_capability_detected", { capability });
}

export function trackWebllmDownloadStarted(args: { model: string }): void {
  track("webllm_download_started", { model: args.model });
}

export function trackWebllmLoaded(args: { model: string }): void {
  track("webllm_loaded", { model: args.model });
}

export function trackWebllmFirstRewrite(args: { model: string }): void {
  track("webllm_first_rewrite", { model: args.model });
}

// Section-rewrite funnel (issue #63). Kept distinct from the per-bullet
// keys above so each path's first-rewrite conversion stays measurable.
// `webllm_first_section_rewrite` mirrors `webllm_first_rewrite` for the
// section path; the original per-bullet key is preserved unchanged.

export function trackWebllmSectionRewriteStarted(args: {
  model: string;
  inputBulletCount: number;
}): void {
  track("webllm_section_rewrite_started", {
    model: args.model,
    input_bullet_count: args.inputBulletCount,
  });
}

export function trackWebllmSectionRewriteCompleted(args: {
  model: string;
  inputBulletCount: number;
  outputBulletCount: number;
  numbersPreserved: boolean;
}): void {
  track("webllm_section_rewrite_completed", {
    model: args.model,
    input_bullet_count: args.inputBulletCount,
    output_bullet_count: args.outputBulletCount,
    numbers_preserved: args.numbersPreserved,
  });
}

export function trackWebllmFirstSectionRewrite(args: { model: string }): void {
  track("webllm_first_section_rewrite", { model: args.model });
}

// JD URL ingestion funnel (#72 / #75). Fires on every user-initiated fetch
// from the JD URL input. The `outcome` enum lets us tell apart the four
// platform-relevant funnel states without ever recording the URL itself —
// privacy-safe by construction. No URL, no JD text, no host fragment.
//
//   ok                      — fetch succeeded; `platform` is the parsed ATS
//   unsupported_known       — host classified (linkedin/indeed/…); platform null
//   unsupported_unknown     — host not recognised at all; platform null
//   network_error           — supported ATS, but the API call failed
export type JdUrlOutcome =
  | "ok"
  | "unsupported_known"
  | "unsupported_unknown"
  | "network_error";

export function trackJdUrlFetch(args: {
  outcome: JdUrlOutcome;
  /** Set when `outcome === "ok"`; otherwise null. */
  platform: AtsPlatform | null;
}): void {
  track("jd_url_fetch", {
    outcome: args.outcome,
    platform: args.platform,
  });
}
