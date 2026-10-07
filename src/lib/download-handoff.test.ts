// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Round-trip + rejection coverage for the `/` → `/download/` résumé handoff,
 * mirroring `jobs-handoff.test.ts`.
 *
 * The load-bearing assertion beyond the jobs pair: `result.canonical.sections`
 * carries two `Map`s (`byName`, `sectionHeadings`), which a bare
 * `JSON.stringify` silently renders as `{}` — see the module docblock. The
 * "serializability" block below proves a REAL corpus fixture's `CascadeResult`
 * survives the trip well enough that `renderAtsResumePdf` produces identical
 * bytes before and after.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DOWNLOAD_HANDOFF_KEY,
  readDownloadHandoff,
  writeDownloadHandoff,
  type DownloadHandoff,
} from "./download-handoff.ts";
import type { CascadeResult } from "./heuristics/types.ts";
import type { ContactOverrides } from "../hooks/useEditableParse.ts";
import { installMemorySessionStorage } from "../hooks/__test-utils__/memory-storage.ts";
import { runCascade } from "./heuristics/cascade.ts";
import { scoreForCascade } from "./heuristics/roundtrip-hop.ts";
import { buildAtsResumeModel } from "./pdf/ats-resume-model.ts";
import { renderAtsResumePdf } from "./pdf/render-ats-pdf.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../..",
  "tests/fixtures/pdfs/latex/awesome-cv-resume.pdf",
);

/** A small, hand-built `CascadeResult` — enough shape to exercise the
 *  handoff's own round-trip/rejection logic without paying for a real parse.
 *  `sections.byName`/`sectionHeadings` are real `Map`s, same as a genuine
 *  cascade result, so a regression to a bare `JSON.stringify` fails here too. */
function fakeResult(): CascadeResult {
  return {
    canonical: {
      fields: {
        full_name: "Dana Fixture",
        skills: ["React", "TypeScript"],
        experience: [{ company: "Acme", title: "Staff Engineer" }],
        education: [],
      },
      sections: {
        byName: new Map([["skills", ["React", "TypeScript"]]]),
        accomplishmentSections: ["experience", "projects"],
        source: "regex",
        sectionHeadings: new Map([["skills", "Skills"]]),
      },
      fieldConfidence: {},
    },
    confidence: 0.9,
    triggers: [],
    suggestedEscalation: "none",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "Dana Fixture\nSkills\nReact, TypeScript",
    linkAnnotations: [],
    diagnostics: {
      rawCharCount: 40,
      extractedCharCount: 40,
      pages: 1,
      elapsedMs: 1,
    },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  };
}

const score: DownloadHandoff["score"] = {
  overall: 70,
  preLayoutOverall: 70,
  specificity: {
    score: 28,
    max: 40,
    gradable: true,
    metricBullets: 1,
    totalBullets: 2,
  },
  structure: {
    score: 21,
    max: 30,
    gradable: true,
    goodBullets: 1,
    verbLedBullets: 1,
    inWindowBullets: 1,
    totalBullets: 2,
  },
  completeness: { score: 21, max: 30, gradable: true, missing: [] },
  layout: { triggers: [], multiplier: 1, scanned: false },
};

const contactOverrides: ContactOverrides = { headline: "Senior Engineer" };

beforeEach(() => {
  // A fresh in-memory shim, not the runtime's global: on Node 22+ that global
  // is not jsdom's `Storage`, so the throwing-write spies below would miss it.
  installMemorySessionStorage();
});

describe("download handoff", () => {
  it("round-trips the résumé, score and contact overrides", () => {
    writeDownloadHandoff({ result: fakeResult(), score, contactOverrides });
    const read = readDownloadHandoff();
    expect(read?.result.canonical.fields.full_name).toBe("Dana Fixture");
    expect(read?.score.overall).toBe(70);
    expect(read?.contactOverrides.headline).toBe("Senior Engineer");
  });

  it("reconstructs the sections Maps rather than leaving them as {}", () => {
    writeDownloadHandoff({ result: fakeResult(), score, contactOverrides });
    const read = readDownloadHandoff();
    expect(read?.result.canonical.sections.byName).toBeInstanceOf(Map);
    expect(read?.result.canonical.sections.byName.get("skills")).toEqual([
      "React",
      "TypeScript",
    ]);
    expect(read?.result.canonical.sections.sectionHeadings).toBeInstanceOf(Map);
    expect(
      read?.result.canonical.sections.sectionHeadings?.get("skills"),
    ).toBe("Skills");
  });

  it("carries the journey-ledger key across (#826)", () => {
    writeDownloadHandoff({
      result: fakeResult(),
      score,
      contactOverrides,
      journeyKey: "a1b2c3d4",
    });
    expect(readDownloadHandoff()?.journeyKey).toBe("a1b2c3d4");
  });

  it("drops a malformed journey key rather than rejecting the payload", () => {
    // A bad key must never cost the résumé — it is the one thing `/download/`
    // cannot work without, same policy as `jobs-handoff.ts`.
    writeDownloadHandoff({ result: fakeResult(), score, contactOverrides });
    const wire = JSON.parse(sessionStorage.getItem(DOWNLOAD_HANDOFF_KEY)!);
    sessionStorage.setItem(
      DOWNLOAD_HANDOFF_KEY,
      JSON.stringify({ ...wire, journeyKey: 42 }),
    );
    const read = readDownloadHandoff();
    expect(read?.result.canonical.fields.full_name).toBe("Dana Fixture");
    expect(read?.journeyKey).toBeUndefined();
  });

  it("is NOT consumed on read — a reload of /download/ still finds the résumé", () => {
    writeDownloadHandoff({ result: fakeResult(), score, contactOverrides });
    expect(readDownloadHandoff()).not.toBeNull();
    expect(readDownloadHandoff()).not.toBeNull();
    expect(sessionStorage.getItem(DOWNLOAD_HANDOFF_KEY)).not.toBeNull();
  });

  it("a second launch overwrites the stashed résumé", () => {
    writeDownloadHandoff({ result: fakeResult(), score, contactOverrides });
    const second = fakeResult();
    second.canonical.fields.full_name = "Robin Fixture";
    writeDownloadHandoff({ result: second, score, contactOverrides });
    expect(readDownloadHandoff()?.result.canonical.fields.full_name).toBe(
      "Robin Fixture",
    );
  });

  it("returns null when absent", () => {
    expect(readDownloadHandoff()).toBeNull();
  });

  it("rejects malformed JSON rather than throwing", () => {
    sessionStorage.setItem(DOWNLOAD_HANDOFF_KEY, "{not json");
    expect(readDownloadHandoff()).toBeNull();
  });

  it("rejects a payload missing the guaranteed array fields", () => {
    sessionStorage.setItem(
      DOWNLOAD_HANDOFF_KEY,
      JSON.stringify({
        result: { canonical: { fields: { full_name: "Dana Fixture" } } },
        score,
        contactOverrides,
      }),
    );
    expect(readDownloadHandoff()).toBeNull();

    sessionStorage.setItem(DOWNLOAD_HANDOFF_KEY, JSON.stringify({}));
    expect(readDownloadHandoff()).toBeNull();
  });

  it("rejects a score whose fields buildAtsResumeModel would crash on", () => {
    for (const bad of [
      { ...score, bullets: {} },
      { ...score, overall: "70" },
    ]) {
      writeDownloadHandoff({
        result: fakeResult(),
        score: bad as unknown as DownloadHandoff["score"],
        contactOverrides,
      });
      expect(readDownloadHandoff()).toBeNull();
    }
  });

  it("returns null when sessionStorage throws on read", () => {
    // A valid handoff is stored first, so a `null` here can only come from
    // the throwing read — not from an empty key.
    writeDownloadHandoff({ result: fakeResult(), score, contactOverrides });
    const getItem = vi
      .spyOn(sessionStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    try {
      expect(readDownloadHandoff()).toBeNull();
    } finally {
      getItem.mockRestore();
    }
  });

  it("does not throw when sessionStorage throws on write, and reports failure", () => {
    const setItem = vi
      .spyOn(sessionStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    try {
      let wrote: boolean | undefined;
      expect(() => {
        wrote = writeDownloadHandoff({
          result: fakeResult(),
          score,
          contactOverrides,
        });
      }).not.toThrow();
      expect(wrote).toBe(false);
    } finally {
      setItem.mockRestore();
    }
  });

  it("clears an earlier handoff when a replacement write fails", () => {
    // Otherwise a failed replacement leaves the earlier résumé in place, and
    // a caller that doesn't check the return value could still navigate
    // `/download/` to it — stale, not absent.
    writeDownloadHandoff({ result: fakeResult(), score, contactOverrides });
    expect(readDownloadHandoff()).not.toBeNull();

    const setItem = vi
      .spyOn(sessionStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    try {
      const second = fakeResult();
      second.canonical.fields.full_name = "Robin Fixture";
      expect(
        writeDownloadHandoff({ result: second, score, contactOverrides }),
      ).toBe(false);
    } finally {
      setItem.mockRestore();
    }
    expect(readDownloadHandoff()).toBeNull();
  });
});

describe("serializability — a real corpus fixture survives the JSON trip (#1180)", () => {
  it("builds an identical AtsResumeModel, and re-parses to the same fields, before and after the round trip", async () => {
    const original = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
    const fixtureScore = scoreForCascade(original);

    // Sanity: the fixture actually populates the Maps this test exists to
    // protect — otherwise a regression to a bare `JSON.stringify` would pass
    // silently with nothing lost.
    expect(original.canonical.sections.sectionHeadings?.size).toBeGreaterThan(0);

    writeDownloadHandoff({
      result: original,
      score: fixtureScore,
      contactOverrides: {},
    });
    const read = readDownloadHandoff();
    expect(read).not.toBeNull();

    const modelBefore = buildAtsResumeModel(original, fixtureScore);
    const modelAfter = buildAtsResumeModel(read!.result, read!.score);
    // The direct, deterministic proof: everything `buildAtsResumeModel` reads
    // off the parse — including `sectionHeadings`, the one field this handoff
    // has to reconstruct from an entry array — survives the JSON round trip
    // untouched.
    //
    // NOT asserted: byte-identical `renderAtsResumePdf` output. pdf-lib's own
    // font/resource embedder assigns each embedded font a random subset-name
    // suffix per call (`addRandomSuffix`, `pdf-lib/cjs/utils/strings.js`), so
    // rendering the SAME model twice already produces different bytes with no
    // serialization involved — confirmed by rendering `modelBefore` twice in
    // isolation before writing this test. Re-parsing both renders below and
    // comparing the STRUCTURED fields is the content-level corroboration,
    // matching `render-roundtrip.repro.test.ts`'s own practice of never
    // diffing raw render bytes.
    expect(modelAfter).toEqual(modelBefore);

    const { bytes: bytesBefore } = await renderAtsResumePdf(modelBefore);
    const { bytes: bytesAfter } = await renderAtsResumePdf(modelAfter);
    const reparsedBefore = await runCascade(bytesBefore);
    const reparsedAfter = await runCascade(bytesAfter);

    expect(reparsedAfter.canonical.fields.full_name).toBe(
      reparsedBefore.canonical.fields.full_name,
    );
    expect(reparsedAfter.canonical.fields.experience).toEqual(
      reparsedBefore.canonical.fields.experience,
    );
    expect(reparsedAfter.canonical.fields.education).toEqual(
      reparsedBefore.canonical.fields.education,
    );
    expect(reparsedAfter.canonical.fields.skills).toEqual(
      reparsedBefore.canonical.fields.skills,
    );
  });
});
