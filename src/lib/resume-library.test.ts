// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Resume-library domain tests (#322): save → list → load → rename → delete
 * against `fake-indexeddb`, exercising the real storage foundation. Asserts the
 * cached parse round-trips losslessly (including a `Map`, which IndexedDB
 * structured clone preserves) and that source bytes reload byte-identically.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as storage from "./storage/index.ts";
import { DB_NAME, closeDB, saveResume } from "./storage/index.ts";
import type { ResumeRecord } from "./storage/types.ts";
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

/** What the mocked cascade hands back on a re-parse, tagged "Reparsed Persona"
 *  so a test can prove the loaded result came from the blob rather than from a
 *  snapshot. Shared by every re-parse path — the stale-shape guard and the
 *  no-cached-parse recovery both land on the same recovery code. */
const reparsedResult = () =>
  ({
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
  }) as unknown as CascadeResult;

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
    expect(list[0]).toMatchObject({ scoreOverall: 84, sourceKind: "pdf", hasCachedParse: true });
  });

  it("breaks ties deterministically on same-millisecond savedAt", async () => {
    const tiedSavedAt = 1_700_000_000_000;
    const recordA: ResumeRecord = {
      id: "id-a",
      filename: "a.pdf",
      blob: new Blob([bytes()]),
      parse: { result: result(), score: score(80), sourceKind: "pdf", shapeVersion: "1:1" },
      createdAt: tiedSavedAt,
      updatedAt: tiedSavedAt,
    };
    const recordB: ResumeRecord = {
      id: "id-b",
      filename: "b.pdf",
      blob: new Blob([bytes()]),
      parse: { result: result(), score: score(70), sourceKind: "pdf", shapeVersion: "1:1" },
      createdAt: tiedSavedAt,
      updatedAt: tiedSavedAt,
    };

    // Return the tied records in reverse primary-key order ("id-b" before "id-a")
    // to prove that listLibrary's explicit tiebreaker overrides the underlying
    // store's return order rather than merely agreeing with it by coincidence (#907).
    vi.spyOn(storage, "getAllResumes").mockResolvedValue([recordB, recordA]);
    try {
      const list = await listLibrary();
      expect(list).toHaveLength(2);
      expect(list.map((e) => e.id)).toEqual(["id-a", "id-b"]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("preserves newest-first save order when saves occur in the same clock millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await save("first.pdf", 70);
      await save("second.pdf", 80);
      const list = await listLibrary();
      expect(list.map((e) => e.filename)).toEqual(["second.pdf", "first.pdf"]);
    } finally {
      vi.restoreAllMocks();
    }
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

describe("resume-library: bytes on an update (#824)", () => {
  // The autosave writes on every quiet period behind an edit, and the parse is
  // the only thing that can have moved: `saveResumeToLibrary` rebuilding the
  // Blob would re-copy and re-write a multi-MB PDF per debounce window. These
  // two pin BOTH halves — the fast path carries the stored bytes forward, and
  // it is opt-in, so a caller that really does mean to replace them still can.
  const otherBytes = () => new Uint8Array([0x00, 0x11, 0x22]).buffer;

  it("carries the stored bytes forward when the caller asserts they are unchanged", async () => {
    const id = await save("cv.pdf", 61);
    // Different bytes, plus the assertion that they are not. A rebuild would
    // land them; carrying the stored Blob forward cannot.
    await saveResumeToLibrary({
      id,
      filename: "cv.pdf",
      bytes: otherBytes(),
      sourceKind: "pdf",
      result: result(),
      score: score(77),
      bytesUnchanged: true,
    });
    const loaded = await loadResumeFromLibrary(id);
    expect([...new Uint8Array(loaded!.bytes!)]).toEqual([...bytes()]);
    // The parse and score DO advance — that is the entire content of the write.
    expect(loaded!.score.overall).toBe(77);
    // …and it UPDATED, it did not add. "The library never grows past one entry
    // for one parse" is the whole point of keying the autosave's record id to
    // `parseKey`, and read back off the store it is a fact rather than a claim
    // about what a mock was called with.
    const list = await listLibrary();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    expect(list[0].scoreOverall).toBe(77);
  });

  it("rewrites the bytes by default, so the fast path is never inherited", async () => {
    const id = await save("cv.pdf", 61);
    await saveResumeToLibrary({
      id,
      filename: "cv.pdf",
      bytes: otherBytes(),
      sourceKind: "pdf",
      result: result(),
      score: score(61),
    });
    const loaded = await loadResumeFromLibrary(id);
    expect([...new Uint8Array(loaded!.bytes!)]).toEqual([0x00, 0x11, 0x22]);
    // Still one row, on this path too.
    expect(await listLibrary()).toHaveLength(1);
  });

  it("falls back to a rebuild when the asserted record has gone", async () => {
    // Deleted in another tab between the assertion and this write: a stale id
    // must degrade to a fresh record with real bytes, never to one with none.
    const id = await saveResumeToLibrary({
      id: "vanished",
      filename: "cv.pdf",
      bytes: bytes().buffer,
      sourceKind: "pdf",
      result: result(),
      score: score(50),
      bytesUnchanged: true,
    });
    expect([...new Uint8Array((await loadResumeFromLibrary(id))!.bytes!)]).toEqual([
      ...bytes(),
    ]);
    // Exactly one row, re-created under the id the caller was already holding —
    // so the autosave keeps writing to the same record rather than minting a
    // new one per debounce window for the rest of the session.
    const list = await listLibrary();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
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
    const reparsed = reparsedResult();
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

describe("resume-library: record with no cached parse (#693 producer write)", () => {
  /** A record an outside producer writes through the backup-import door: the
   *  PDF bytes and nothing else, because a producer cannot run the cascade. */
  async function producerWritten(blob: Blob) {
    return saveResume({ filename: "from-producer.pdf", blob });
    // `parse` deliberately absent.
  }

  it("re-parses from the stored blob instead of refusing the record", async () => {
    const reparsed = reparsedResult();
    vi.mocked(runCascade).mockResolvedValue(reparsed);

    const rec = await producerWritten(
      new Blob([bytes().buffer], { type: "application/pdf" }),
    );

    const loaded = await loadResumeFromLibrary(rec.id);

    // Before this fix the missing snapshot short-circuited to `undefined`, which
    // is what left `/jobs/`'s #724 fallback rating nothing at all.
    expect(runCascade).toHaveBeenCalledTimes(1);
    expect(loaded).toBeDefined();
    expect(loaded!.result).toBe(reparsed);
    expect(loaded!.sourceKind).toBe("pdf");
    expect(loaded!.score).toBeDefined();
  });

  it("re-stamps the record so the next load does not re-parse", async () => {
    vi.mocked(runCascade).mockResolvedValue(reparsedResult());

    const rec = await producerWritten(
      new Blob([bytes().buffer], { type: "application/pdf" }),
    );
    await loadResumeFromLibrary(rec.id);
    await loadResumeFromLibrary(rec.id);

    expect(runCascade).toHaveBeenCalledTimes(1);
  });

  it("drops a parse-less record with no bytes to re-parse from", async () => {
    const rec = await producerWritten(new Blob([], { type: "application/pdf" }));
    expect(await loadResumeFromLibrary(rec.id)).toBeUndefined();
    expect(runCascade).not.toHaveBeenCalled();
  });

  it("drops a parse-less record whose bytes are not a PDF", async () => {
    const rec = await producerWritten(
      new Blob([bytes().buffer], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );
    expect(await loadResumeFromLibrary(rec.id)).toBeUndefined();
    expect(runCascade).not.toHaveBeenCalled();
  });

  it("listLibrary reports hasCachedParse: false and does not claim a score for it (#757)", async () => {
    await producerWritten(new Blob([bytes().buffer], { type: "application/pdf" }));
    const [entry] = await listLibrary();
    expect(entry.hasCachedParse).toBe(false);
    // `scoreOverall` is a placeholder here, not a genuine zero — the UI must
    // read `hasCachedParse` rather than trust this number on its own.
    expect(entry.scoreOverall).toBe(0);
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
