// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Value-locking regression for #1026 — the Skia/Chromium twin of #1021's
 * two-line role header:
 *
 *   University of California, Berkeley                     Berkeley, CA
 *   Transfer Center Peer                          September 2025-Present
 *
 * The Word/Quartz export leaves a real column gap on the company row, so line
 * assembly cuts the `City, ST` cell off and #1021's row-partner capture reads
 * it. The Skia export bridges that gap with ONE wide whitespace-only item (the
 * #891 tab-justified shape), so the row reaches the above-anchor header walk
 * welded: role 1 came back with location "Berkeley Berkeley, CA", and role 2's
 * "Freelance Berkeley, CA" matched the pure-location shape, was skipped as a
 * location, and left `company` null. The walk now peels the flush-right cell
 * off with the same `peelFlushRightLocation` the below-anchor run uses.
 *
 * The lossy `*.expected.json` golden records counts, not values, and the
 * fixture has no truth sidecar — hence this file.
 *
 * Persona is synthetic (Jordan Rivera / jordan.rivera@example.com), per the
 * fixtures PII policy.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "./cascade.ts";
import { runRoundtripHop } from "./roundtrip-hop.ts";
import type { HeuristicParsedResume } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../../..",
  "tests/fixtures/pdfs/google-docs/google-docs-skia-proxy-programs-skills-software.pdf",
);

type Role = NonNullable<HeuristicParsedResume["experience"]>[number];

const TWO_LINE_ROLES = [
  {
    title: "Transfer Center Peer",
    company: "University of California, Berkeley",
    location: "Berkeley, CA",
  },
  { title: "English Tutor", company: "Freelance", location: "Berkeley, CA" },
];

const headerOf = (r: Role) => ({ title: r.title, company: r.company, location: r.location });

describe("Skia two-line role header with a welded flush-right location (#1026)", () => {
  let roles: Role[];
  let reparsed: Role[];

  beforeAll(async () => {
    const before = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
    roles = before.canonical.fields.experience ?? [];
    const hop = await runRoundtripHop(before);
    expect(hop.renderError).toBeUndefined();
    reparsed = hop.after?.canonical.fields.experience ?? [];
  });

  it("splits the company from its flush-right city on both two-line headers", () => {
    expect(roles.slice(0, 2).map(headerOf)).toEqual(TWO_LINE_ROLES);
  });

  it("survives export → re-parse", () => {
    expect(reparsed.slice(0, 2).map(headerOf)).toEqual(TWO_LINE_ROLES);
  });
});
