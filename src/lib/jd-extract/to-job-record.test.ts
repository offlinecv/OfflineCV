// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The bridge from extraction to the capture contract (#719).
 *
 * Two things are worth pinning here and nothing else really is. The first is the
 * `atsUrl` rule, because it decides record IDENTITY — get it wrong and the user
 * gets three records for one job, or (far worse) one record for three jobs. The
 * second is the boundary: extraction internals must not cross, and the way that
 * fails is silently, by someone adding a field to `ExtractedPosting` and
 * spreading the whole object.
 *
 * The payload is fed through `validateJobRecord` rather than only inspected,
 * because "the mapper produces a contract-valid record" is the claim that
 * matters and shape assertions cannot make it.
 */

import { describe, expect, it } from "vitest";
import {
  JOB_CAPTURE_CONTRACT_VERSION,
  validateJobRecord,
} from "../storage/job-record-contract.ts";
import { deriveJobId } from "../storage/job-url.ts";
import { POSTING_FACT_FIELDS, toJobRecord } from "./to-job-record.ts";
import type { ExtractedPosting } from "./types.ts";

const PAGE_URL = "https://www.linkedin.com/jobs/view/4012345/";
const ATS_URL = "https://boards.greenhouse.io/acme/jobs/4012345";

function posting(overrides: Partial<ExtractedPosting> = {}): ExtractedPosting {
  return {
    title: "Staff Engineer",
    company: "Acme",
    body: "## About\n\n- 5 years TypeScript\n",
    descriptionPreview: "About",
    extractionTier: "schema_org",
    ...overrides,
  };
}

describe("toJobRecord: the posting facts that cross", () => {
  it("carries all six, verbatim", () => {
    const result = toJobRecord(
      posting({
        location: "Austin, TX",
        salaryRange: "$180k – $220k",
        datePosted: "2026-07-28",
        workModel: "remote",
        employmentType: "FULL_TIME",
        validThrough: "2026-09-01",
      }),
      PAGE_URL,
    );

    expect(result).toMatchObject({
      location: "Austin, TX",
      salaryRange: "$180k – $220k",
      datePosted: "2026-07-28",
      workModel: "remote",
      employmentType: "FULL_TIME",
      validThrough: "2026-09-01",
    });
  });

  it("copies the title, company and body", () => {
    const result = toJobRecord(posting(), PAGE_URL);
    expect(result.title).toBe("Staff Engineer");
    expect(result.company).toBe("Acme");
    expect(result.jdText).toBe("## About\n\n- 5 years TypeScript\n");
  });

  // Absent is not the same as empty: empty means the posting said nothing there,
  // absent means we did not look. Only the second is true of a tier that never
  // populates a field.
  it.each(POSTING_FACT_FIELDS)("omits `%s` rather than writing an empty string", (field) => {
    const result = toJobRecord(posting({ [field]: "" }), PAGE_URL);
    expect(field in result).toBe(false);
  });

  it("omits jdText when the body is empty", () => {
    expect("jdText" in toJobRecord(posting({ body: "" }), PAGE_URL)).toBe(false);
  });

  it("pins the crossing set, so adding one is a visible diff", () => {
    expect([...POSTING_FACT_FIELDS]).toEqual([
      "location",
      "salaryRange",
      "datePosted",
      "workModel",
      "employmentType",
      "validThrough",
    ]);
  });
});

describe("toJobRecord: extraction internals stop at the boundary", () => {
  // The failure this guards is someone spreading `...posting` into the payload.
  // It would look fine — every assertion above would still pass — and it would
  // put fields into a versioned public contract that no third-party producer
  // could ever supply.
  it("drops every internal, including ones a spread would carry", () => {
    const result = toJobRecord(
      posting({
        jobId: "4012345",
        atsDetected: "greenhouse",
        applyUrl: "https://acme.com/apply",
        structuredDataHash: "abc123",
        schemaOrgRaw: { "@type": "JobPosting" },
        algorithmVersion: 9,
        requirements: ["TypeScript"],
        qualifications: ["BSc"],
        descriptionPreview: "About",
      }),
      PAGE_URL,
    );

    for (const internal of [
      "extractionTier",
      "jobId",
      "atsDetected",
      "applyUrl",
      "structuredDataHash",
      "schemaOrgRaw",
      "algorithmVersion",
      "requirements",
      "qualifications",
      "descriptionPreview",
      "body",
      "atsUrl",
    ]) {
      expect(internal in result, internal).toBe(false);
    }
  });
});

describe("toJobRecord: the atsUrl rule", () => {
  // The point of the whole rule: one posting, three places it was found, one id.
  it("prefers the ATS original over the page it was found on", () => {
    const result = toJobRecord(posting({ atsUrl: ATS_URL }), PAGE_URL);
    expect(result.url).toBe(ATS_URL);
  });

  it("collapses an aggregator capture and a direct capture onto one id", () => {
    const viaLinkedIn = toJobRecord(posting({ atsUrl: ATS_URL }), PAGE_URL);
    const viaIndeed = toJobRecord(
      posting({ atsUrl: ATS_URL }),
      "https://www.indeed.com/viewjob?jk=abc123",
    );
    const direct = toJobRecord(posting(), ATS_URL);

    expect(deriveJobId(viaLinkedIn.url!)).toBe(deriveJobId(direct.url!));
    expect(deriveJobId(viaIndeed.url!)).toBe(deriveJobId(direct.url!));
  });

  // The accepted cost, pinned so it is a decision rather than a surprise: a
  // capture where apply-link missed forks from one where it hit. Under-merging
  // is a duplicate the user can delete; over-merging destroys a record.
  it("forks — does not merge — when apply-link missed on one of two captures", () => {
    const found = toJobRecord(posting({ atsUrl: ATS_URL }), PAGE_URL);
    const missed = toJobRecord(posting(), PAGE_URL);
    expect(deriveJobId(found.url!)).not.toBe(deriveJobId(missed.url!));
  });

  it("falls back to the page URL when there is no ATS original", () => {
    expect(toJobRecord(posting(), PAGE_URL).url).toBe(PAGE_URL);
  });

  // Falling back beats handing `captureJob` a record it refuses whole — and the
  // tracker renders this value into an anchor's `href`.
  it.each(["javascript:alert(1)", "data:text/html,x", "not a url"])(
    "ignores an atsUrl of %s and uses the page URL",
    (atsUrl) => {
      expect(toJobRecord(posting({ atsUrl }), PAGE_URL).url).toBe(PAGE_URL);
    },
  );

  it("omits url entirely when neither is capturable", () => {
    const result = toJobRecord(posting(), "about:blank");
    expect("url" in result).toBe(false);
  });
});

describe("toJobRecord: provenance", () => {
  it("stamps this build's contract version, not a caller's claim", () => {
    const result = toJobRecord(posting(), PAGE_URL, { producer: "x", producerVersion: "1" });
    expect(result.capture?.contract).toBe(JOB_CAPTURE_CONTRACT_VERSION);
  });

  it("carries the producer identity through", () => {
    const result = toJobRecord(posting(), PAGE_URL, {
      producer: "claude-code-job-hunt-skill",
      producerVersion: "0.1.0",
      capturedAt: 1_700_000_000_000,
    });
    expect(result.capture).toEqual({
      contract: JOB_CAPTURE_CONTRACT_VERSION,
      producer: "claude-code-job-hunt-skill",
      producerVersion: "0.1.0",
      capturedAt: 1_700_000_000_000,
    });
  });

  it("stamps capture time when the caller does not", () => {
    const before = Date.now();
    const captured = toJobRecord(posting(), PAGE_URL).capture?.capturedAt ?? 0;
    expect(captured).toBeGreaterThanOrEqual(before);
  });

  it("omits an unstated producer rather than inventing one", () => {
    const capture = toJobRecord(posting(), PAGE_URL).capture!;
    expect("producer" in capture).toBe(false);
    expect("producerVersion" in capture).toBe(false);
  });
});

describe("toJobRecord: the output satisfies the capture contract", () => {
  // `captureJob` supplies the id; everything else must already be valid.
  function validate(input: ReturnType<typeof toJobRecord>) {
    return validateJobRecord({ ...input, id: "job-1" });
  }

  it("accepts a fully-populated posting with no warnings", () => {
    const result = validate(
      toJobRecord(
        posting({
          atsUrl: ATS_URL,
          location: "Austin, TX",
          salaryRange: "$180k – $220k",
          datePosted: "2026-07-28",
          workModel: "remote",
          employmentType: "FULL_TIME",
          validThrough: "2026-09-01",
        }),
        PAGE_URL,
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
  });

  it("accepts the minimum a tier can produce", () => {
    expect(validate(toJobRecord(posting({ body: "" }), "about:blank")).ok).toBe(true);
  });

  // A JSON round trip is the real transport: the injected bundle returns a
  // string, and an extension's message is structured-cloned.
  it("survives a JSON round trip", () => {
    const input = toJobRecord(posting({ location: "Austin, TX" }), PAGE_URL);
    expect(JSON.parse(JSON.stringify(input))).toEqual(input);
  });
});
