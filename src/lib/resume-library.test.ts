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
import { beforeEach, describe, expect, it } from "vitest";
import { DB_NAME, closeDB } from "./storage/index.ts";
import {
  saveResumeToLibrary,
  listLibrary,
  loadResumeFromLibrary,
  renameLibraryResume,
  removeLibraryResume,
} from "./resume-library.ts";
import type { CascadeResult } from "./heuristics/types.ts";
import type { AnonymousAtsScore } from "./score/score.ts";

beforeEach(async () => {
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
