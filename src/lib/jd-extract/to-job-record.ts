// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The one bridge from an {@link ExtractedPosting} to the job capture contract
 * (#719).
 *
 * The two types are deliberately not the same type, and this module is the
 * reason that costs nothing. `ExtractedPosting` is an internal extraction result
 * that changes whenever the extractors improve; `JobRecord` is a PUBLIC contract
 * with a version number, a compile-enforced field-rule map and a prose spec a
 * third party reimplements against. Routing every crossing through one function
 * means an extractor change can never silently alter what a producer writes —
 * to change the capture payload you have to edit this file, which sits next to
 * the doc that says what the payload is.
 *
 * What crosses is exactly {@link POSTING_FACT_FIELDS} plus title, company, url
 * and the body. Extraction internals — `extractionTier`, `structuredDataHash`,
 * `schemaOrgRaw`, `algorithmVersion`, `jobId`, `atsDetected`, `applyUrl` — stop
 * here. They describe how we read the page, not what the posting says, and a
 * capture contract that carried them would oblige every third-party producer to
 * either fabricate them or explain their absence.
 *
 * Output is a capture CANDIDATE, not a stored record: no `id`, no timestamps, no
 * `status`. `captureJob` (`src/lib/storage/capture.ts`) owns all four, and the
 * id it derives is the entire point of the `atsUrl` rule below.
 */

// Both imports reach past the storage barrel on purpose. This module ends up in
// a bundle injected into a live page, and the barrel pulls the IndexedDB layer,
// the backup path and the record validators — none of which a producer-side
// mapper needs. `types.ts` has zero imports and `job-url.ts` is zero-dependency,
// so what lands in the bundle is one integer and one URL predicate.
import { isCapturableJobUrl } from "../storage/job-url.ts";
import { JOB_CAPTURE_CONTRACT_VERSION, type JobRecord } from "../storage/types.ts";
import type { ExtractedPosting } from "./types.ts";

/**
 * A capture payload: the fields a producer supplies, and nothing the store owns.
 *
 * Derived from `JobRecord` with `Pick` rather than declared independently — the
 * whole argument of this module is that there is one definition of a job record,
 * so a second hand-written field list here would reintroduce the drift the
 * contract's mapped type exists to prevent.
 */
export type JobCaptureInput = Pick<
  JobRecord,
  | "title"
  | "company"
  | "url"
  | "jdText"
  | "capture"
  | (typeof POSTING_FACT_FIELDS)[number]
>;

/**
 * The posting facts that cross into a `JobRecord`, in one list so the bridge is
 * readable at a glance and testable as a set.
 *
 * Both types declare all six as an optional `string`, so the copy below needs no
 * per-field code and no cast. A field added to one type but not the other stops
 * compiling here, which is the cheapest possible place to find out.
 */
export const POSTING_FACT_FIELDS = [
  "location",
  "salaryRange",
  "datePosted",
  "workModel",
  "employmentType",
  "validThrough",
] as const;

/** Who captured this, for `JobRecord.capture`. The contract version is not here:
 *  it is this build's to state, not a caller's to claim. */
export interface CaptureProducer {
  /** Free-text producer id, e.g. `"claude-code-job-hunt-skill"`. */
  producer?: string;
  /** The producer's own release version. */
  producerVersion?: string;
  /** Epoch ms of capture. Defaults to now — the mapper runs at capture time, so
   *  a caller only passes this when replaying an earlier extraction. */
  capturedAt?: number;
}

/**
 * The `atsUrl` rule.
 *
 * When apply-link discovery finds the ATS-hosted original behind an aggregator
 * listing, THAT is the URL the record carries — so `deriveJobId` keys on it and
 * the same posting found via LinkedIn, via Indeed, and on the company's own
 * board collapses to one record instead of three.
 *
 * Two consequences, both accepted rather than overlooked:
 *
 *  - **Aggregator provenance is lost.** `JobCaptureProvenance` has no
 *    source-URL field, so nothing records that this record was found on
 *    LinkedIn. The user still has the ATS URL, which is where they apply.
 *  - **Dedup becomes extraction-dependent.** Capture a posting once where
 *    apply-link misses and again where it hits, and you get two records. That is
 *    a fork, not a merge, and it lands on the safe side of the asymmetry
 *    `job-url.ts` names: *under-merging is a duplicate the user can delete;
 *    over-merging destroys a record.*
 *
 * A non-http(s) `atsUrl` is ignored rather than passed on: the tracker renders
 * this straight into an anchor's `href`, and the contract would refuse it
 * anyway — better to fall back to a URL that works than to hand `captureJob` a
 * record it will reject whole.
 */
function captureUrl(posting: ExtractedPosting, pageUrl: string): string | undefined {
  if (posting.atsUrl !== undefined && isCapturableJobUrl(posting.atsUrl)) return posting.atsUrl;
  return isCapturableJobUrl(pageUrl) ? pageUrl : undefined;
}

/**
 * Map an extraction result onto a capture payload.
 *
 * `pageUrl` is the page the posting was read from. It is a separate argument
 * rather than a field on `ExtractedPosting` because the extractors take the URL
 * as an input — a `Document` that was parsed rather than navigated to has no
 * usable `location` — and the extraction result should not restate its own
 * input.
 *
 * An absent value is OMITTED rather than written as `""`. The contract accepts
 * an empty string, but the two mean different things to a reader: empty is "the
 * posting says nothing here", absent is "we did not look". Only the second is
 * true of a tier that never populates a field.
 */
export function toJobRecord(
  posting: ExtractedPosting,
  pageUrl: string,
  producer: CaptureProducer = {},
): JobCaptureInput {
  const url = captureUrl(posting, pageUrl);

  const facts: Partial<Record<(typeof POSTING_FACT_FIELDS)[number], string>> = {};
  for (const field of POSTING_FACT_FIELDS) {
    const value = posting[field];
    if (value !== undefined && value !== "") facts[field] = value;
  }

  return {
    title: posting.title,
    company: posting.company,
    ...(url !== undefined && { url }),
    ...(posting.body !== "" && { jdText: posting.body }),
    ...facts,
    capture: {
      contract: JOB_CAPTURE_CONTRACT_VERSION,
      ...(producer.producer !== undefined && { producer: producer.producer }),
      ...(producer.producerVersion !== undefined && {
        producerVersion: producer.producerVersion,
      }),
      capturedAt: producer.capturedAt ?? Date.now(),
    },
  };
}
