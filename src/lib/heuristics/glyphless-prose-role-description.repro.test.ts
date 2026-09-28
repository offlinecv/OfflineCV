// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Value-locking regression for #1088 — an Experience section whose roles
 * carry NO bullet markers, just a single line of prose under each header.
 *
 * Pre-fix, a glyph-less description line with no internal sentence break (so
 * `isProseLine` missed it — it needs TWO sentences, and a role's own
 * description is one) survived the above-anchor / next-header-start walks in
 * `entry-blocks.ts` as an ordinary header candidate. On a uniformly spaced
 * template (no bullet marker AND no paragraph-sized gap ahead of the next
 * role's header — nothing else to stop the walk), it was claimed as the NEXT
 * role's title: role 1's description became role 2's "title", role 1's own
 * description came back empty, and role 2's real title ("Software Engineer")
 * never appeared anywhere in the parse.
 *
 * `looksLikeBelowAnchorProse` (line-primitives.ts) now recognizes this shape
 * as a fifth signal — a comma-less run of words carrying ≥2 lowercase content
 * words, independent of any trailing period — and `entry-blocks.ts` consults
 * it at both walk sites. Reverting either change turns this file red.
 *
 * Persona is synthetic (Jordan Rivera / jordan.rivera@example.com /
 * (312) 555-0123), per the fixtures PII policy — no real-person data.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "./cascade.ts";
import type { CascadeResult } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../../..",
  "tests/fixtures/pdfs/unknown/glyphless-prose-role-description.pdf",
);

describe("a glyph-less role description does not steal the next role's title (#1088)", () => {
  let cascade: CascadeResult;

  beforeAll(async () => {
    const bytes = readFileSync(FIXTURE);
    cascade = await runCascade(new Uint8Array(bytes));
  });

  it("parses both roles", () => {
    expect(cascade.canonical.fields.experience ?? []).toHaveLength(2);
  });

  it("keeps role 1's real title and company — not swallowed by its own description", () => {
    const [role1] = cascade.canonical.fields.experience ?? [];
    expect(role1.title).toBe("Senior Software Engineer");
    expect(role1.company).toBe("Acme Corp");
  });

  it("recovers role 1's description instead of leaving it empty", () => {
    const [role1] = cascade.canonical.fields.experience ?? [];
    expect(role1.description).toContain(
      "Worked on the billing service and helped the team with various backend tasks.",
    );
  });

  it("keeps role 2's real title — the reported defect was role 1's prose here instead", () => {
    const [, role2] = cascade.canonical.fields.experience ?? [];
    expect(role2.title).toBe("Software Engineer");
    expect(role2.company).toBe("Globex Inc");
  });

  it("recovers role 2's own description", () => {
    const [, role2] = cascade.canonical.fields.experience ?? [];
    expect(role2.description).toContain(
      "Worked on APIs and did general maintenance on the platform.",
    );
  });

  it("never emits either description line as a role title", () => {
    const titles = (cascade.canonical.fields.experience ?? []).map((r) => r.title);
    expect(titles.some((t) => t?.startsWith("Worked on"))).toBe(false);
  });
});
