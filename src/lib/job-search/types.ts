// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Provider adapter contract for the in-app job search (#319, slice 2 of the
 * job-search epic).
 *
 * A `JobProvider` fetches postings from one keyless, CORS-open job feed and
 * maps its response shape into the normalized `JobPosting` below. The fan-out
 * orchestrator (`search.ts`) runs every enabled provider through
 * `Promise.allSettled`, so one provider failing (network, CORS, malformed
 * JSON) never rejects the whole search — its results are simply absent and the
 * UI notes the degraded source.
 *
 * The keyed BYOK adapter (#320) implements this same interface and joins the
 * registry only when a key is present — nothing about this contract changes for
 * that slice.
 */

import type { JobQuery } from "./query-builder.ts";

/** A single normalized job posting, provider-agnostic. */
export interface JobPosting {
  /** Provider-prefixed for cross-provider dedup, e.g. `"remotive:1185979"`. */
  id: string;
  title: string;
  company: string;
  /** Often "Remote" / "Worldwide"; "" when the feed omits it. */
  location: string;
  /** Canonical external listing URL. */
  url: string;
  /** Plaintext (HTML stripped via `htmlToPlaintext`) — the corpus we rank on. */
  description: string;
  /** ISO date if the provider supplies one. */
  postedAt?: string;
  /** Provider display name, shown on the card to reinforce the honest-sample
   *  framing ("Remotive"). */
  source: string;
  /** Department/team names, when the provider's feed carries them (e.g. a
   *  Greenhouse board's `departments[].name`). Optional — most keyless feeds
   *  don't have this axis. Consumed by the #534 title/board-size filter. */
  departments?: string[];
}

/** One keyless job feed, adapted to the normalized shape. */
export interface JobProvider {
  /** Stable slug, also the dedup id prefix (e.g. `"remotive"`). */
  id: string;
  /** Human display name shown in degraded notices + card source line. */
  label: string;
  /**
   * Fetch + map postings for `query`. MUST thread `signal` into `fetch` so an
   * in-flight or superseded search can be cancelled. Rejects on transport /
   * parse failure — the orchestrator catches it per-provider via allSettled.
   */
  search(query: JobQuery, signal: AbortSignal): Promise<JobPosting[]>;
}
