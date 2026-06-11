// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { LayoutTrigger } from "./heuristics/types";

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
