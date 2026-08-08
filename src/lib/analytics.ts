// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { CASCADE_VERSION } from "./heuristics/types.ts";
import type { LayoutTrigger, ParseEvent } from "./heuristics/types.ts";
import type { WebGpuCapability } from "./webllm/types.ts";
import type { Browser, Os } from "./webllm/platform.ts";
import type { AtsPlatform } from "./jd-match/fetch-jd.ts";

type PostHog = {
  capture: (event: string, props?: Record<string, unknown>) => void;
  isFeatureEnabled?: (key: string) => boolean | undefined;
  onFeatureFlags?: (cb: () => void) => void;
  register: (props: Record<string, unknown>) => void;
};

const KEY = import.meta.env.VITE_POSTHOG_KEY ?? "";
const HOST = import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com";

/**
 * Which build produced this event: `development` under `npm run dev`,
 * `staging` from the GitHub Pages deploy (dev.offlinecv.org), `production`
 * as the fallback for every other build. Registered as a PostHog
 * super-property (#739) so it lands on EVERY event — that's what makes it
 * usable as a clause in PostHog's "Filter out internal and test users"
 * project setting, which is configured in the PostHog project, not here. It
 * describes the build, not the person: no person property is ever set (see
 * the Telemetry section in README.md). `||`, not `??`: an unset CI variable
 * expands to `""`, not `undefined`, and `""` would land on every event and
 * silently match nothing in that filter.
 */
const ENVIRONMENT =
  import.meta.env.VITE_POSTHOG_ENV ||
  (import.meta.env.DEV ? "development" : "production");

const INTERNAL_KEY = "ocv_internal";

/**
 * The precedence rule both readers below obey: an explicit `?ocv_internal=1`
 * or `=0` overrides whatever is stored, and anything else — an unrecognised
 * value, or no param at all — defers to storage. Split out so the rule is
 * stated once rather than duplicated between the pure resolver and the
 * wrapper that performs the write.
 */
function internalFlagWrite(search: string): "set" | "clear" | null {
  const value = new URLSearchParams(search).get(INTERNAL_KEY);
  if (value === "1") return "set";
  if (value === "0") return "clear";
  return null;
}

/**
 * Pure resolution of the internal-traffic marker: query param wins when
 * present, otherwise falls back to what's already stored. Exported and
 * DOM-free (takes `search`/`stored` as plain strings) so every resolution
 * case is testable without a browser. See
 * `readInternalFlag` for the impure wrapper that supplies the real
 * `location.search` / `localStorage` values and performs the write.
 */
export function resolveInternalFlag(
  search: string,
  stored: string | null,
): boolean {
  const write = internalFlagWrite(search);
  if (write === "set") return true;
  if (write === "clear") return false;
  return stored === "1";
}

/**
 * A teammate visits `?ocv_internal=1` once per browser; every later event
 * from that browser carries `is_internal: true` so the project's test-account
 * filter can drop it. A boolean UX flag persisted via `localStorage` — no id,
 * no email, nothing identifying a person — matching the other first-party
 * `ocv_*` keys in README.md's "Browser storage" table. `localStorage` (not
 * PostHog's own `opt_out_capturing()`) is deliberate: PostHog's opt-out state
 * is written through the configured `persistence`, which is `"memory"` here
 * (see `initAnalytics`), so it would evaporate on tab close and each teammate
 * would have to re-opt-out constantly. Must never throw: private mode (where
 * `localStorage` access itself throws) and any environment without a
 * `location` global both fall through to `false`.
 */
export function readInternalFlag(): boolean {
  try {
    const search = location.search;
    const write = internalFlagWrite(search);
    if (write === "set") localStorage.setItem(INTERNAL_KEY, "1");
    else if (write === "clear") localStorage.removeItem(INTERNAL_KEY);
    return resolveInternalFlag(search, localStorage.getItem(INTERNAL_KEY));
  } catch {
    return false;
  }
}

/** True when analytics are enabled (VITE_POSTHOG_KEY is set at build time). */
export const ANALYTICS_ENABLED = !!KEY;

let ph: PostHog | null = null;
const queue: Array<[string, Record<string, unknown>]> = [];

/**
 * Which root surface emitted an event (#226 / #52). `/` (main.tsx) is the
 * parser audit; `/jobs` (jobs/main.tsx) is the job-search workbench (which
 * now also owns the paste-a-JD affordance a deprecated second surface used
 * to carry). Each entry calls `setAnalyticsSurface` once at boot; every
 * `track()` stamps the value so the surfaces are distinguishable in PostHog
 * without a whole event-category system. Defaults to "parser" so an
 * un-tagged caller (or a test) attributes to the original surface.
 * Dead-code-safe: when VITE_POSTHOG_KEY is unset, `track()` short-circuits
 * before reading this.
 */
export type AnalyticsSurface = "parser" | "jobs";
let surface: AnalyticsSurface = "parser";

/** Tag every subsequent event with the emitting surface. Call once at boot. */
export function setAnalyticsSurface(value: AnalyticsSurface): void {
  surface = value;
}

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
  // Register the environment/internal super-properties BEFORE flushing the
  // pre-init queue (#739), so events queued before `initAnalytics` resolved
  // also carry them — not just events emitted after this point.
  ph.register({ environment: ENVIRONMENT, is_internal: readInternalFlag() });
  for (const [evt, props] of queue) ph.capture(evt, props);
  queue.length = 0;
  // Fan PostHog's flag-refresh callback out to flag subscribers (see flags.ts).
  // Fires once flags first resolve, and again on any later refresh, so a gated
  // surface flips on/off without a reload. Also flush immediately in case flags
  // were already cached before the first subscriber registered.
  ph.onFeatureFlags?.(() => {
    for (const cb of flagSubs) cb();
  });
  for (const cb of flagSubs) cb();
}

// --- Feature flags (consumed by src/lib/flags.ts) -------------------------
// PostHog is the *rollout override* layer; the build-time env default in
// flags.ts is the real gate. When VITE_POSTHOG_KEY is unset, `ph` stays null,
// `getFeatureFlag` returns undefined, and the env default wins — so a keyless
// OSS build never depends on PostHog (and the posthog-js chunk stays
// tree-shaken).
const flagSubs = new Set<() => void>();

/** PostHog's verdict for a flag, or undefined when PostHog isn't loaded. */
export function getFeatureFlag(key: string): boolean | undefined {
  return ph?.isFeatureEnabled?.(key);
}

/** Subscribe to flag refreshes; returns an unsubscribe fn. */
export function subscribeFeatureFlags(cb: () => void): () => void {
  flagSubs.add(cb);
  return () => {
    flagSubs.delete(cb);
  };
}

function track(event: string, props: Record<string, unknown>): void {
  if (!KEY) return;
  // Stamp the emitting surface (#226) on every event so PostHog can split the
  // parser-audit (`/`) and job-search (`/jobs`) surfaces. Read at emit time,
  // after the entry has called setAnalyticsSurface.
  const stamped = { ...props, surface };
  if (!ph) {
    queue.push([event, stamped]);
    return;
  }
  ph.capture(event, stamped);
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

export interface FeedbackArgs {
  /** 1–5 star rating. Always present (submission is gated on it). */
  rating: number;
  /** Optional area pill: Parsing · Scoring · UI · Other. */
  category?: string;
  /** Optional free-text feedback. */
  feedbackText?: string;
  /** Optional contact email — PII. Only attached when the user typed one. */
  email?: string;
  /**
   * Explicit opt-in: the user ticked "follow up with me". Recorded so marketing
   * can segment consenting respondents even when no email channel was supplied.
   */
  wantsContact?: boolean;
}

/**
 * Shape the `feedback_submitted` event properties from raw form state.
 *
 * Pure and exported so the PII-load-bearing rule is unit-tested without a
 * PostHog stub: `email` (and the other optionals) are attached ONLY when the
 * user actually provided a non-empty value — never as an empty string. See the
 * README Telemetry section for the privacy contract this upholds.
 */
export function buildFeedbackProps(args: FeedbackArgs): Record<string, unknown> {
  const props: Record<string, unknown> = { rating: args.rating };
  if (args.category) props.category = args.category;
  if (args.feedbackText?.trim()) props.feedback_text = args.feedbackText.trim();
  if (args.wantsContact) props.wants_contact = true;
  if (args.email?.trim()) props.email = args.email.trim();
  return props;
}

export function trackFeedback(args: FeedbackArgs): void {
  track("feedback_submitted", buildFeedbackProps(args));
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
    case "parse_completed": {
      const { event: name, props } = buildCascadeParseCompletedEvent(event);
      track(name, props);
      break;
    }
  }
}

/** An event name paired with its payload, before `track()` stamps the surface. */
export type TrackedEvent = {
  event: string;
  props: Record<string, unknown>;
};

/**
 * Payload for `cascade_parse_completed` — one emit per finished cascade.
 *
 * Named "cascade_parse_completed" (not "parse_completed") to avoid collision
 * with the manual `trackParseCompleted` event that adds score-dimension data
 * unavailable inside the cascade.
 *
 * `total_duration_ms` is load-bearing beyond its own value: it is the only
 * property that separates this emit from the LLM events, which carry a model id
 * instead. The saved parse-volume insights filter on it being set, so dropping
 * it here silently zeroes those charts rather than failing loudly.
 *
 * Pure and exported so the name and shape are testable without a PostHog key —
 * `track()` short-circuits when `VITE_POSTHOG_KEY` is unset, which is every test
 * run. Same pattern as `buildFeedbackProps`.
 */
export function buildCascadeParseCompletedEvent(
  event: Extract<ParseEvent, { type: "parse_completed" }>,
): TrackedEvent {
  return {
    event: "cascade_parse_completed",
    props: {
      cascade_version: event.cascade_version,
      user_type: event.user_type,
      final_source: event.final_source,
      total_duration_ms: event.total_duration_ms,
      confidence: event.confidence,
      triggers: [...event.triggers],
      tier_mask: event.tier_mask,
      llm_ran: event.llm_ran,
    },
  };
}

/** Payload for `llm_parse_ran` (#242). See `trackLlmParseRan`. */
export function buildLlmParseRanEvent(args: { model: string }): TrackedEvent {
  return {
    event: "llm_parse_ran",
    props: {
      cascade_version: CASCADE_VERSION,
      llm_ran: true,
      model: args.model,
    },
  };
}

/** Payload for `llm_fallback_ran` (#243). See `trackLlmFallbackRan`. */
export function buildLlmFallbackRanEvent(args: { model: string }): TrackedEvent {
  return {
    event: "llm_fallback_ran",
    props: {
      cascade_version: CASCADE_VERSION,
      llm_ran: true,
      final_source: "llm_fallback",
      model: args.model,
    },
  };
}

/**
 * The opt-in WebLLM parse pass ran (#242). The LLM pass runs AFTER the cascade
 * returns, so by the time the user opts in, `cascade_parse_completed` has
 * already fired carrying `llm_ran: false`.
 *
 * This used to re-emit `cascade_parse_completed` to restate the flag. That made
 * the event name mean two different things — "a parse finished" and "the LLM
 * pass ran on a parse that already finished" — so every count of it read high:
 * parse success rate (completions / files accepted) sat above 100%, and the
 * `triggers` / `final_source` breakdowns gained a null bucket, because a
 * re-emit carries none of the cascade's measurements. The stated reason for
 * sharing the name was to let PostHog "correlate the two on the same
 * person/session", which a distinct name does not prevent — correlation is by
 * `distinct_id` / `$session_id`, never by event name.
 *
 * So this is its own event. Anything that wants both reads them as two series.
 * Carries only the model id + the flag — no field values, no PII.
 */
export function trackLlmParseRan(args: { model: string }): void {
  const { event, props } = buildLlmParseRanEvent(args);
  track(event, props);
}

/**
 * The degenerate-case LLM escape hatch ran (#243). Distinct from the
 * comparison-pass (#242, `trackLlmParseRan`) because this one is a recovery:
 * the cascade produced too little to use and the LLM re-parsed from scratch.
 * Same reasoning as above for why it is not a `cascade_parse_completed`
 * re-emit. Carries only the model id — no field values, no PII.
 */
export function trackLlmFallbackRan(args: { model: string }): void {
  const { event, props } = buildLlmFallbackRanEvent(args);
  track(event, props);
}

export function trackRenderError(args: { errorName: string }): void {
  // Never pass the error message — it can echo text fragments from the file
  // being parsed and would violate the footer's privacy claim.
  track("render_error", {
    error_name: args.errorName,
  });
}

/**
 * The on-device LLM content-quality critique ran (#244). Emits a single
 * anonymized event carrying the model id, the total bullet count judged, and
 * the count of non-ok findings. No bullet text, no field values, no PII.
 */
export function trackCritiqueRan(args: {
  model: string;
  bulletCount: number;
  flaggedCount: number;
  missingSectionCount: number;
}): void {
  track("llm_critique_ran", {
    model: args.model,
    bullet_count: args.bulletCount,
    flagged_count: args.flaggedCount,
    missing_section_count: args.missingSectionCount,
  });
}

// WebLLM funnel. The call-sites (capability.ts, web-llm.ts, rewrite-section.ts,
// rewrite-resume.ts) gate the one-shot events so each fires at most once per
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

/**
 * The WebGPU-unavailable explainer notice was shown (#276). Fires once per page
 * when `detectWebGpu()` resolves to a non-`"available"` state and the notice
 * renders in place of the rewrite UI. Sliced by the detected browser + os so we
 * can size which populations hit the wall (Firefox-macOS vs Linux-no-Vulkan vs
 * old-Safari) and judge whether the per-browser guidance is worth maintaining.
 * `webllm_capability_detected` already carries `capability` but no platform —
 * this is the platform-bearing companion, not a duplicate. No PII: browser/os
 * are coarse enums.
 */
export function trackWebllmNoticeShown(args: {
  capability: WebGpuCapability;
  browser: Browser;
  os: Os;
}): void {
  track("webllm_notice_shown", {
    capability: args.capability,
    browser: args.browser,
    os: args.os,
  });
}

export function trackWebllmDownloadStarted(args: { model: string }): void {
  track("webllm_download_started", { model: args.model });
}

export function trackWebllmLoaded(args: { model: string }): void {
  track("webllm_loaded", { model: args.model });
}

// Section-rewrite funnel (issue #63). Kept distinct from resume-rewrite
// so each path's first-rewrite conversion stays independently measurable.

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

// Resume-rewrite funnel (issue #67 — chain-of-sections whole-resume pipeline).
// Kept distinct from the per-bullet / per-section keys above so each path's
// first-rewrite conversion remains independently measurable. Same env-gating
// semantics as the rest of the WebLLM events; when VITE_POSTHOG_KEY is unset,
// these compile away to no-ops.
//
// Section kinds map 1:1 to the orchestrator's SectionInput.kind discriminator
// so the funnel can be sliced by "did the model rewrite the summary OK and
// then drop a bullet in role 3?" without a separate JOIN.

export type ResumeRewriteSectionKind = "summary" | "experience";

export function trackWebllmResumeRewriteStarted(args: {
  model: string;
  sectionCount: number;
}): void {
  track("webllm_resume_rewrite_started", {
    model: args.model,
    section_count: args.sectionCount,
  });
}

export function trackWebllmResumeRewriteSectionCompleted(args: {
  model: string;
  sectionIndex: number;
  sectionKind: ResumeRewriteSectionKind;
  /** Bullets in for "experience"; 1 for "summary" (the paragraph itself). */
  inputUnitCount: number;
  /** Bullets out for "experience"; 0 or 1 for "summary" (empty model output → 0). */
  outputUnitCount: number;
  numbersPreserved: boolean;
}): void {
  track("webllm_resume_rewrite_section_completed", {
    model: args.model,
    section_index: args.sectionIndex,
    section_kind: args.sectionKind,
    input_unit_count: args.inputUnitCount,
    output_unit_count: args.outputUnitCount,
    numbers_preserved: args.numbersPreserved,
  });
}

export function trackWebllmResumeRewriteCompleted(args: {
  model: string;
  sectionCount: number;
  allNumbersPreserved: boolean;
}): void {
  track("webllm_resume_rewrite_completed", {
    model: args.model,
    section_count: args.sectionCount,
    all_numbers_preserved: args.allNumbersPreserved,
  });
}

export function trackWebllmFirstResumeRewrite(args: { model: string }): void {
  track("webllm_first_resume_rewrite", { model: args.model });
}

// Disagreement detector funnel (#242 — heuristic vs LLM parse, headline). Fires
// once after the opt-in WebLLM pass completes and the two parses are diffed.
// Anonymized BY CONSTRUCTION: only the count of gaps and per-kind tallies leave
// the browser — never a field value, name, email, or recovered text. Matches the
// privacy contract the rest of the parse funnel upholds; compiles away to a
// no-op when VITE_POSTHOG_KEY is unset.
export function trackDisagreementsFound(args: {
  model: string;
  /** Total gaps the diff surfaced (0 is a meaningful "LLM agreed" datapoint). */
  count: number;
  /** Per-kind tally so the funnel can split "which gap kind drives engagement". */
  droppedRole: number;
  droppedSection: number;
  missingField: number;
  mergedRoles: number;
  /** Active layout triggers — already anonymized (a fixed enum, no PII). */
  triggers: readonly LayoutTrigger[];
}): void {
  track("disagreements_found", {
    model: args.model,
    count: args.count,
    dropped_role: args.droppedRole,
    dropped_section: args.droppedSection,
    missing_field: args.missingField,
    merged_roles: args.mergedRoles,
    triggers: [...args.triggers],
  });
}

/**
 * The user reported a parsing gap (#245) — i.e. they generated and downloaded
 * the structure-only repro artifact to attach to an issue manually. COUNT ONLY:
 * a `gap_disagreements` integer (how many characterized gaps the report
 * carried, 0 when the reporter had not run the WebLLM comparison) plus the
 * active layout triggers (a fixed enum). NEVER the artifact contents, the
 * résumé text, or any field value — the artifact itself is PII-free by
 * construction (see `lib/heuristics/repro-artifact.ts`), and this event carries
 * even less. Env-gated like every other tracker: no-op when VITE_POSTHOG_KEY is
 * unset.
 */
export function trackGapReported(args: {
  /** How many characterized disagreements the report carried (0 if none). */
  disagreementCount: number;
  /** Active layout triggers — already anonymized (a fixed enum, no PII). */
  triggers: readonly LayoutTrigger[];
}): void {
  track("gap_reported", {
    gap_disagreements: args.disagreementCount,
    triggers: [...args.triggers],
  });
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

// Blank/from-scratch authoring funnel (#313). Fires once when a user enters
// the no-upload authoring flow via the "Start from scratch" CTA.
export function trackBlankResumeStarted(): void {
  track("blank_resume_started", {});
}

/** Which flow produced the downloaded PDF (#313) — `"blank"` for a from-
 *  scratch authored resume, `"upload"` for the existing parse→edit→export
 *  path. Derived in `useDownloadPdf.ts` from the result's `tiers` (empty only
 *  for `buildBlankResult()`'s output), not threaded as an extra prop, since
 *  `ReconstructedResume` (which owns the download click) is out of scope for
 *  this change. */
export type DownloadSource = "blank" | "upload";

/**
 * A reconstructed résumé was downloaded as a PDF. There was no prior
 * download-tracking event to extend (`useDownloadPdf.ts` didn't track at
 * all) — this is a new event, distinguishing blank-authored from uploaded
 * downloads via `source` per #313's requirement. `format` (#552) distinguishes
 * the ATS PDF from the plain-text `cv.md` markdown export sharing this event;
 * it defaults to `"pdf"` so every existing call site (and every already-fired
 * event) stays unchanged.
 */
export function trackDownloadCompleted(args: {
  source: DownloadSource;
  format?: "pdf" | "markdown";
}): void {
  track("download_completed", { source: args.source, format: args.format ?? "pdf" });
}

/** Which format the shareable audit report (#343) was exported in. */
export type ReportFormat = "pdf" | "json";

/**
 * A shareable audit report was downloaded (#343). Carries only the chosen
 * format and whether the user opted to include identity — no field values, no
 * PII. Env-gated like every other tracker: no-op when VITE_POSTHOG_KEY is unset.
 */
export function trackReportDownloaded(args: {
  format: ReportFormat;
  includeIdentity: boolean;
}): void {
  track("report_downloaded", {
    format: args.format,
    include_identity: args.includeIdentity,
  });
}
