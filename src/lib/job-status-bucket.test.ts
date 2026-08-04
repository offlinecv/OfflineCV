// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * job-status-bucket (#744). The properties the tracker's grouping leans on: the
 * canonical lifecycle is its own fixed point, the foreign aliases collapse onto
 * the stage they mean, and anything else passes through untouched so it still
 * gets its own fail-loud section.
 */

import { describe, it, expect } from "vitest";
import { jobStatusBucket } from "./job-status-bucket.ts";
import { JOB_STATUS_ORDER } from "./storage/index.ts";

describe("jobStatusBucket", () => {
  it.each(JOB_STATUS_ORDER)("leaves the canonical status %s as its own bucket", (status) => {
    expect(jobStatusBucket(status)).toBe(status);
  });

  it("is idempotent — a bucket key re-bucketed is itself", () => {
    // The tracker keys sections on the RESULT, and `JobStatusPicker` compares a
    // bucket against `JOB_STATUS_ORDER`. Both break if mapping twice moves.
    for (const status of ["shared", "saved", "scouted", "withdrawn", "ghosted", ""]) {
      expect(jobStatusBucket(jobStatusBucket(status))).toBe(jobStatusBucket(status));
    }
  });

  it.each(["saved", "scouted", "shared"])(
    "buckets the pre-application status %s as interested",
    (status) => {
      // The three differ by how the job ARRIVED, not by pipeline stage — one
      // section, not four (the motivating Recruidea sync).
      expect(jobStatusBucket(status)).toBe("interested");
    },
  );

  it("buckets withdrawn as rejected — a closed application either way", () => {
    expect(jobStatusBucket("withdrawn")).toBe("rejected");
  });

  it("passes an unmapped status through as its own bucket", () => {
    // The escape hatch this change narrows but does not remove: a status outside
    // both vocabularies still gets a section labelled with its literal string.
    expect(jobStatusBucket("ghosted")).toBe("ghosted");
    expect(jobStatusBucket("")).toBe("");
  });

  it("matches exactly, so a differently-cased status is not folded in", () => {
    // Deliberate: folding case would guess about a producer nobody has seen.
    expect(jobStatusBucket("Shared")).toBe("Shared");
    expect(jobStatusBucket("INTERESTED")).toBe("INTERESTED");
  });

  it("returns the literal string for a status that names an Object.prototype key", () => {
    // `status` is untrusted imported data. An object-literal alias table would
    // answer these with a function, and the tracker would key a section on a
    // non-string — hence the `Map`.
    for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(jobStatusBucket(key)).toBe(key);
    }
  });
});
