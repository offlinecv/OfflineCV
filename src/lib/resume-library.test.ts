// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Resume-library domain tests (#322): save → list → load → rename → delete
 * against `fake-indexeddb`, exercising the real storage foundation. Asserts the
 * cached parse round-trips losslessly (including a `Map`, which IndexedDB
 * structured clone preserves) and that source bytes reload byte-identically.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DB_NAME, closeDB, saveResume } from "./storage/index.ts";
import {
  saveResumeToLibrary,
  listLibrary,
  loadResumeFromLibrary,
  renameLibraryResume,
  removeLibraryResume,
} from "./resume-library.ts";
import { runCascade } from "./heuristics/index.ts";
import { toCanonicalResume } from "./heuristics/canonical.ts";
import { ACCOMPLISHMENT_SECTION_NAMES } from "./heuristics/sections.ts";
import type { CascadeResult } from "./heuristics/types.ts";
import type { AnonymousAtsScore } from "./score/score.ts";

// The stale-shape guard re-parses from the stored blob via `runCascade`; mock it
// so the test doesn't need a real parseable PDF, and so we can assert the loaded
// result came from the re-parse rather than a stale-shape deserialize (#445 AC7).
vi.mock("./heuristics/index.ts", () => ({ runCascade: vi.fn() }));

beforeEach(async () => {
  vi.mocked(runCascade).mockReset();
  await closeDB();
  await deleteDB(DB_NAME);
});

const bytes = () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]); // %PDF + binary

// Minimal stand-ins — the library treats `result` opaquely and only reads
// `score.overall`. The `sections.byName` Map proves structured clone survives.
const result = () =>
  ({
    marker: "cascade-42",
    sections: { byName: new Map([["skills", 3]]) },
  }) as unknown as CascadeResult;
const score = (overall: number) => ({ overall }) as AnonymousAtsScore;

async function save(filename: string, overall = 72) {
  return saveResumeToLibrary({
    filename,
    bytes: bytes().buffer,
    sourceKind: "pdf",
    result: result(),
    score: score(overall),
  });
}

describe("resume-library: save + list", () => {
  it("lists saved resumes newest-first with score + kind", async () => {
    await save("general.pdf", 71);
    await save("tailored.pdf", 84);
    const list = await listLibrary();
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.filename)).toEqual(["tailored.pdf", "general.pdf"]);
    expect(list[0]).toMatchObject({ scoreOverall: 84, sourceKind: "pdf" });
  });
});

describe("resume-library: load", () => {
  it("restores the cached parse (Map intact) and byte-identical bytes", async () => {
    const id = await save("cv.pdf", 66);
    const loaded = await loadResumeFromLibrary(id);
    expect(loaded).toBeDefined();
    expect(loaded!.score.overall).toBe(66);
    expect(loaded!.sourceKind).toBe("pdf");
    // Opaque cached parse round-trips, including the sections Map.
    const r = loaded!.result as unknown as {
      marker: string;
      sections: { byName: Map<string, number> };
    };
    expect(r.marker).toBe("cascade-42");
    expect(r.sections.byName.get("skills")).toBe(3);
    // Source bytes reload byte-identically.
    expect([...new Uint8Array(loaded!.bytes!)]).toEqual([...bytes()]);
  });

  it("returns undefined for a missing id", async () => {
    expect(await loadResumeFromLibrary("nope")).toBeUndefined();
  });
});

describe("resume-library: rename + delete", () => {
  it("renames in place, preserving bytes and score", async () => {
    const id = await save("draft.pdf", 55);
    await renameLibraryResume(id, "final.pdf");
    const list = await listLibrary();
    expect(list).toHaveLength(1);
    expect(list[0].filename).toBe("final.pdf");
    expect(list[0].scoreOverall).toBe(55);
    expect((await loadResumeFromLibrary(id))!.bytes).toBeDefined();
  });

  it("deletes an entry", async () => {
    const id = await save("cv.pdf");
    await removeLibraryResume(id);
    expect(await listLibrary()).toHaveLength(0);
  });
});

describe("resume-library: cache-version mismatch (#445 / #321)", () => {
  it("re-parses from the stored blob instead of deserializing a stale-shape record", async () => {
    // A re-parsed canonical result the mocked cascade returns, tagged so we can
    // prove the loaded result came from the re-parse, not the stale snapshot.
    const reparsed = {
      canonical: toCanonicalResume(
        { full_name: "Reparsed Persona", skills: [], experience: [], education: [] },
        {
          byName: new Map(),
          accomplishmentSections: ACCOMPLISHMENT_SECTION_NAMES,
          source: "regex",
        },
        {},
      ),
      confidence: 0,
      triggers: [],
      suggestedEscalation: "none",
      tiers: ["t0_layout", "t1_openresume"],
      rawText: "",
      linkAnnotations: [],
      diagnostics: { rawCharCount: 0, extractedCharCount: 0, pages: 1, elapsedMs: 0 },
      timings: { t0_layout_ms: 0, t1_openresume_ms: 0 },
    } as unknown as CascadeResult;
    vi.mocked(runCascade).mockResolvedValue(reparsed);

    // Write a pre-cutover record DIRECTLY through the storage layer: a stale
    // snapshot with NO `shapeVersion` and the old top-level-`parsed` façade shape,
    // plus a real source blob to re-parse from.
    const staleSnapshot = {
      result: { parsed: { full_name: "Stale Persona" }, sections: { byName: new Map() } },
      score: score(41),
      sourceKind: "pdf",
      // shapeVersion intentionally absent — a pre-#445 record.
    };
    const rec = await saveResume({
      filename: "old.pdf",
      blob: new Blob([bytes().buffer], { type: "application/pdf" }),
      parse: staleSnapshot,
    });

    const loaded = await loadResumeFromLibrary(rec.id);

    // The stale record was NOT deserialized — the cascade re-ran on the blob and
    // its canonical result is what came back, re-graded fresh.
    expect(runCascade).toHaveBeenCalledTimes(1);
    expect(loaded).toBeDefined();
    expect(loaded!.result).toBe(reparsed);
    expect(loaded!.result.canonical.fields.full_name).toBe("Reparsed Persona");
    expect(loaded!.score).toBeDefined();
    // The bytes are still handed back for the preview pane.
    expect([...new Uint8Array(loaded!.bytes!)]).toEqual([...bytes()]);
  });

  it("drops a stale-shape record that has no blob to re-parse from", async () => {
    // A DOCX-style record: stale shape, empty blob → can't re-parse → undefined.
    const rec = await saveResume({
      filename: "old.docx",
      blob: new Blob([], { type: "application/octet-stream" }),
      parse: {
        result: { parsed: {}, sections: { byName: new Map() } },
        score: score(30),
        sourceKind: "docx",
      },
    });
    expect(await loadResumeFromLibrary(rec.id)).toBeUndefined();
    expect(runCascade).not.toHaveBeenCalled();
  });
});

describe("resume-library: DOCX (no source bytes)", () => {
  it("saves without bytes and reloads with bytes undefined", async () => {
    const id = await saveResumeToLibrary({
      filename: "cv.docx",
      sourceKind: "docx",
      result: result(),
      score: score(60),
    });
    const loaded = await loadResumeFromLibrary(id);
    expect(loaded!.sourceKind).toBe("docx");
    expect(loaded!.bytes).toBeUndefined();
    expect(loaded!.score.overall).toBe(60);
  });
});
