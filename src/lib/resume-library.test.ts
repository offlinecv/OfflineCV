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
import { DB_NAME, closeDB, getResume, saveResume } from "./storage/index.ts";
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
import { computeSavableResult } from "./edit/edit-pipeline.ts";
import { scoreParsedResume } from "./score/score-cascade.ts";
import { bulletId } from "./score/bullet-id.ts";
import { normalizeBulletText } from "./score/group-bullets.ts";
import type { EditSnapshot } from "../hooks/useEditableParse.ts";

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

describe("resume-library: pristine base + delta (#768)", () => {
  // A distinct marker from `result()` — proves the loaded `baseResult` is the
  // PRISTINE parse, not aliased to the edited `result`.
  const baseResult = () =>
    ({
      marker: "cascade-base-42",
      triggers: [],
      rawText: "",
      canonical: {
        fields: {},
        sections: { byName: new Map([["skills", 1]]), accomplishmentSections: [] },
        fieldConfidence: {},
      },
    }) as unknown as CascadeResult;

  const editSnapshot = () =>
    ({
      contactOverrides: { full_name: "Edited Persona" },
      experienceOverrides: {},
      bulletOverrides: {},
      removedBullets: [],
      educationOverrides: {},
      skillsOverride: { removed: [], added: [] },
      addedEntries: [],
      addedBullets: {},
    }) as unknown as EditSnapshot;

  it("stores and reloads the pristine base alongside the delta", async () => {
    const id = await saveResumeToLibrary({
      filename: "cv.pdf",
      bytes: bytes().buffer,
      sourceKind: "pdf",
      result: result(),
      score: score(72),
      baseResult: baseResult(),
      edit: editSnapshot(),
    });

    const loaded = await loadResumeFromLibrary(id);
    expect(loaded).toBeDefined();
    // The edited result is unchanged — listing/scoring still reads it directly.
    expect((loaded!.result as unknown as { marker: string }).marker).toBe(
      "cascade-42",
    );
    expect((loaded!.baseResult as unknown as { marker: string }).marker).toBe(
      "cascade-base-42",
    );
    expect(loaded!.edit).toEqual(editSnapshot());
  });

  it("a record saved before this change (no baseResult, no edit) still loads flat", async () => {
    const id = await save("legacy.pdf", 58);
    const loaded = await loadResumeFromLibrary(id);
    expect(loaded).toBeDefined();
    expect(loaded!.baseResult).toBeUndefined();
    expect(loaded!.edit).toBeUndefined();
    expect(loaded!.score.overall).toBe(58);
  });

  it("does not re-parse an existing-shape record on load (runCascade untouched)", async () => {
    const id = await saveResumeToLibrary({
      filename: "cv.pdf",
      bytes: bytes().buffer,
      sourceKind: "pdf",
      result: result(),
      score: score(72),
      baseResult: baseResult(),
      edit: editSnapshot(),
    });
    await loadResumeFromLibrary(id);
    expect(runCascade).not.toHaveBeenCalled();
  });

  it("degrades a lone baseResult (no edit) to a flat record — malformed, never produced by this module", async () => {
    // Stamp a real record first so the current `CACHE_SHAPE_VERSION` (private
    // to this module) is on hand, then rewrite its `parse` to the malformed
    // half-a-delta shape at that SAME version, so this exercises the
    // both-or-neither guard rather than the stale-shape re-parse path.
    const id = await saveResumeToLibrary({
      filename: "half.pdf",
      bytes: bytes().buffer,
      sourceKind: "pdf",
      result: result(),
      score: score(50),
    });
    const stamped = await getResume(id);
    await saveResume({
      id,
      filename: "half.pdf",
      blob: stamped!.blob,
      parse: {
        ...(stamped!.parse as Record<string, unknown>),
        baseResult: baseResult(),
        // `edit` deliberately absent.
      },
    });

    const loaded = await loadResumeFromLibrary(id);
    expect(runCascade).not.toHaveBeenCalled();
    expect(loaded!.baseResult).toBeUndefined();
    expect(loaded!.edit).toBeUndefined();
  });

  it.each([
    ["a malformed baseResult", () => ({ marker: "no-canonical" })],
    // What every backup import produces: JSON turns the `byName` Map into `{}`,
    // and `scoreParsedResume` then throws on `byName.get` mid-restore.
    ["a JSON round-tripped baseResult", () => JSON.parse(JSON.stringify(baseResult()))],
    // A base missing `rawText` used to slip past `isRestorableDelta` and throw
    // inside `applyOverrides`' `.split` on load, and `foldUnresolvedOverrides`'s
    // catch swallowed that into a false all-clear (`unresolved: []`) rather than
    // degrading the whole record (review, #1131).
    [
      "a baseResult missing rawText",
      () => {
        const { rawText: _rawText, ...rest } = baseResult();
        return rest;
      },
    ],
    // A base whose `accomplishmentSections` is missing/non-array used to slip
    // past `isRestorableDelta` and throw inside `scoreParsedResume`'s
    // `extractBulletsFromSections`, which walks it with a bare `for...of`
    // (review, #1131).
    [
      "a baseResult whose accomplishmentSections is not an array",
      () =>
        ({
          marker: "cascade-base-42",
          triggers: [],
          rawText: "",
          canonical: {
            fields: {},
            sections: { byName: new Map([["skills", 1]]) },
            fieldConfidence: {},
          },
        }) as unknown as CascadeResult,
    ],
  ])("degrades %s to a flat record instead of restoring it (review, #1087)", async (_label, badBase) => {
    const id = await saveResumeToLibrary({
      filename: "imported.pdf",
      bytes: bytes().buffer,
      sourceKind: "pdf",
      result: result(),
      score: score(64),
    });
    const stamped = await getResume(id);
    await saveResume({
      id,
      filename: "imported.pdf",
      blob: stamped!.blob,
      parse: {
        ...(stamped!.parse as Record<string, unknown>),
        baseResult: badBase(),
        edit: editSnapshot(),
      },
    });

    const loaded = await loadResumeFromLibrary(id);
    expect(runCascade).not.toHaveBeenCalled();
    expect(loaded!.baseResult).toBeUndefined();
    expect(loaded!.edit).toBeUndefined();
    expect(loaded!.score.overall).toBe(64);
  });

  it("degrades an edit snapshot whose bulletOverrides is null to a flat record (review, #1131)", async () => {
    // `applyOverrides` defaults `bulletOverrides` with `= {}`, which only fires
    // on `undefined` — a stored `null` reaches its `Object.entries` call and
    // throws, so `isRestorableDelta` must reject it before `hydrateFromLibrary`
    // gets there.
    const id = await saveResumeToLibrary({
      filename: "imported.pdf",
      bytes: bytes().buffer,
      sourceKind: "pdf",
      result: result(),
      score: score(64),
    });
    const stamped = await getResume(id);
    await saveResume({
      id,
      filename: "imported.pdf",
      blob: stamped!.blob,
      parse: {
        ...(stamped!.parse as Record<string, unknown>),
        baseResult: baseResult(),
        edit: { ...editSnapshot(), bulletOverrides: null },
      },
    });

    const loaded = await loadResumeFromLibrary(id);
    expect(runCascade).not.toHaveBeenCalled();
    expect(loaded!.baseResult).toBeUndefined();
    expect(loaded!.edit).toBeUndefined();
    expect(loaded!.score.overall).toBe(64);
  });

  it("a save made while LLM-recovered stores neither field (App.tsx contract)", async () => {
    // This module has no opinion on recovery — it is App.tsx's call site that
    // omits `baseResult`/`edit` for that branch. Pinned here as the storage
    // half of that contract: omitting both fields on the way in must read back
    // as a flat record, exactly like a pre-#768 save.
    const id = await saveResumeToLibrary({
      filename: "recovered.pdf",
      bytes: bytes().buffer,
      sourceKind: "pdf",
      result: result(),
      score: score(80),
    });
    const loaded = await loadResumeFromLibrary(id);
    expect(loaded!.baseResult).toBeUndefined();
    expect(loaded!.edit).toBeUndefined();
  });

  it("a stale-shape re-parse comes back without baseResult/edit even if the stale record somehow had them", async () => {
    const reparsed = reparsedResult();
    vi.mocked(runCascade).mockResolvedValue(reparsed);

    const rec = await saveResume({
      filename: "old.pdf",
      blob: new Blob([bytes().buffer], { type: "application/pdf" }),
      parse: {
        result: { parsed: { full_name: "Stale Persona" }, sections: { byName: new Map() } },
        score: score(41),
        sourceKind: "pdf",
        baseResult: baseResult(),
        edit: editSnapshot(),
        // shapeVersion intentionally absent — a pre-#445 record.
      },
    });

    const loaded = await loadResumeFromLibrary(rec.id);
    expect(runCascade).toHaveBeenCalledTimes(1);
    expect(loaded!.baseResult).toBeUndefined();
    expect(loaded!.edit).toBeUndefined();
  });

  it("listLibrary still reads the score without touching baseResult/edit", async () => {
    await saveResumeToLibrary({
      filename: "cv.pdf",
      bytes: bytes().buffer,
      sourceKind: "pdf",
      result: result(),
      score: score(72),
      baseResult: baseResult(),
      edit: editSnapshot(),
    });
    const [entry] = await listLibrary();
    expect(entry.scoreOverall).toBe(72);
    expect(entry.hasCachedParse).toBe(true);
  });

  it("stays JSON-safe: survives export → import → export unchanged", async () => {
    // Fully Map-free `result`/`baseResult` — a `sections.byName` Map (the shape
    // `result()` above stubs for the IndexedDB-only tests) is not JSON-safe,
    // and `resume-record-contract.ts` REFUSES such a record on JSON reimport
    // outright rather than degrading it — the whole `parse` payload has to
    // clear that bar, not just the two new fields. That refusal is exactly why
    // the record round-trips through IndexedDB structured clone in ordinary
    // use, never through this backup path (see `resume-library.ts`'s module
    // docblock); this test pins that a genuinely JSON-safe record — including
    // its `baseResult`/`edit` — stays STABLE across a second export/import.
    const jsonSafeResult = { marker: "cascade-jsonsafe" } as unknown as CascadeResult;
    const jsonSafeBase = { marker: "cascade-base-jsonsafe" } as unknown as CascadeResult;

    await saveResumeToLibrary({
      filename: "cv.pdf",
      bytes: bytes().buffer,
      sourceKind: "pdf",
      result: jsonSafeResult,
      score: score(72),
      baseResult: jsonSafeBase,
      edit: editSnapshot(),
    });

    const { exportAll, importAll } = await import("./storage/backup.ts");
    const firstDump = await exportAll();
    expect(firstDump.resumes).toHaveLength(1);
    const firstParse = firstDump.resumes[0]!.parse as Record<string, unknown>;
    expect(firstParse.baseResult).toEqual(jsonSafeBase);
    expect(firstParse.edit).toEqual(editSnapshot());

    await closeDB();
    await deleteDB(DB_NAME);
    await importAll(firstDump);

    const secondDump = await exportAll();
    // Both dumps carry a fresh `exportedAt`; compare everything else.
    const { exportedAt: _a, ...firstRest } = firstDump;
    const { exportedAt: _b, ...secondRest } = secondDump;
    expect(secondRest).toEqual(firstRest);

    // The pair round-trips byte-stable, but a base that has crossed JSON is
    // not RESTORABLE (no live `byName` Map for `scoreParsedResume`), so the
    // load degrades to the flat record rather than throwing mid-restore
    // (review, #1087).
    const [entryId] = (await listLibrary()).map((e) => e.id);
    const reloaded = await loadResumeFromLibrary(entryId!);
    expect(reloaded!.baseResult).toBeUndefined();
    expect(reloaded!.edit).toBeUndefined();
    expect(reloaded!.score.overall).toBe(72);
  });

  // Step 4 (#769): `loadResumeFromLibrary` folds `edit` over `baseResult` at
  // load time and exposes what didn't resolve. Unlike `baseResult()` above —
  // a minimal double `applyOverrides` cannot fold (no `accomplishmentSections`
  // on its `sections`) — these need a base the fold can actually run against,
  // so they build one shaped enough for `scoreParsedResume` + `applyOverrides`.
  describe("unresolved overrides on load (#769)", () => {
    const A = "Built the ingest pipeline";
    const B = "Built the ingest pipeline handling 2M events/day";

    /** A canonical-shaped base whose one role carries exactly `bullets`. */
    function deltaBaseResult(bullets: readonly string[]): CascadeResult {
      const marked = bullets.map((b) => `• ${b}`);
      return {
        canonical: toCanonicalResume(
          {
            full_name: "Delta Persona",
            skills: [],
            experience: [
              {
                title: "Engineer",
                company: "Acme",
                start_date: "2020",
                end_date: "2022",
                description: bullets.join("\n"),
              },
            ],
            education: [],
          },
          {
            byName: new Map([["experience", marked]]),
            accomplishmentSections: ACCOMPLISHMENT_SECTION_NAMES,
            source: "regex",
          },
          {},
        ),
        confidence: 1,
        triggers: [],
        suggestedEscalation: "none",
        tiers: ["t0_layout", "t1_openresume"],
        rawText: marked.join("\n"),
        linkAnnotations: [],
        diagnostics: { rawCharCount: 0, extractedCharCount: 0, pages: 1, elapsedMs: 0 },
        timings: { t0_layout_ms: 0, t1_openresume_ms: 0 },
      } as unknown as CascadeResult;
    }

    /** A delta that edits bullet A to B, keyed by A's content-derived id. */
    const bulletEditSnapshot = () =>
      ({
        contactOverrides: {},
        experienceOverrides: {},
        bulletOverrides: { [bulletId(A, 0)]: B },
        removedBullets: [],
        educationOverrides: {},
        skillsOverride: { removed: [], added: [] },
        addedEntries: [],
        addedBullets: {},
      }) as unknown as EditSnapshot;

    it("reproduces the stored result and reports no unresolved overrides when the base has not moved", async () => {
      const base = deltaBaseResult([A]);
      const edit = bulletEditSnapshot();
      // The observations the restore path folds with: App hydrates `done`
      // with `scoreParsedResume(baseResult)`, so its score's bullets.
      const observations = (b: CascadeResult) => scoreParsedResume(b).bullets ?? [];
      const stored = computeSavableResult(base, observations(base), edit);

      const id = await saveResumeToLibrary({
        filename: "cv.pdf",
        bytes: bytes().buffer,
        sourceKind: "pdf",
        result: stored,
        score: score(70),
        baseResult: base,
        edit,
      });

      const loaded = await loadResumeFromLibrary(id);
      expect(loaded!.unresolved).toEqual([]);
      // The invariant, not the storage round-trip: re-folding the LOADED pair
      // reproduces the loaded `result`. `loaded.result` alone is just the
      // stored blob read back, so comparing it to `stored` proves nothing.
      expect(
        computeSavableResult(
          loaded!.baseResult!,
          observations(loaded!.baseResult!),
          loaded!.edit!,
        ),
      ).toEqual(loaded!.result);
    });

    it("reports a bullet override the base has since rewritten (delta keyed id(A) -> B, base now holds A′)", async () => {
      const edit = bulletEditSnapshot();
      const stored = computeSavableResult(deltaBaseResult([A]), [], edit);
      // The standard résumé moved on: no line normalises to A any more.
      const movedBase = deltaBaseResult([
        "Built the ingest pipeline from scratch",
      ]);

      const id = await saveResumeToLibrary({
        filename: "cv.pdf",
        bytes: bytes().buffer,
        sourceKind: "pdf",
        result: stored,
        score: score(70),
        baseResult: movedBase,
        edit,
      });

      const loaded = await loadResumeFromLibrary(id);
      expect(loaded!.unresolved).toEqual([
        {
          channel: "bulletOverrides",
          key: bulletId(A, 0),
          text: normalizeBulletText(A),
          edited: B,
        },
      ]);
    });

    it("reports a removed-bullet override whose base bullet has since been deleted, with no crash", async () => {
      const edit = {
        ...bulletEditSnapshot(),
        bulletOverrides: {},
        removedBullets: [bulletId(A, 0)],
      } as unknown as EditSnapshot;
      const stored = computeSavableResult(deltaBaseResult([A]), [], edit);
      const movedBase = deltaBaseResult(["Shipped the dashboard"]);

      const id = await saveResumeToLibrary({
        filename: "cv.pdf",
        bytes: bytes().buffer,
        sourceKind: "pdf",
        result: stored,
        score: score(70),
        baseResult: movedBase,
        edit,
      });

      const loaded = await loadResumeFromLibrary(id);
      expect(loaded!.unresolved).toEqual([
        {
          channel: "removedBullets",
          key: bulletId(A, 0),
          text: normalizeBulletText(A),
        },
      ]);
    });

    it("is absent for a flat record (no delta)", async () => {
      const id = await save("legacy.pdf", 58);
      const loaded = await loadResumeFromLibrary(id);
      expect(loaded!.unresolved).toBeUndefined();
      expect("unresolved" in loaded!).toBe(false);
    });

    it("is absent for the re-parse recovery branch", async () => {
      vi.mocked(runCascade).mockResolvedValue(reparsedResult());
      const rec = await saveResume({
        filename: "old.pdf",
        blob: new Blob([bytes().buffer], { type: "application/pdf" }),
        parse: {
          result: { parsed: { full_name: "Stale Persona" }, sections: { byName: new Map() } },
          score: score(41),
          sourceKind: "pdf",
          baseResult: deltaBaseResult([A]),
          edit: bulletEditSnapshot(),
          // shapeVersion intentionally absent — a pre-#445 record.
        },
      });
      const loaded = await loadResumeFromLibrary(rec.id);
      expect(loaded!.unresolved).toBeUndefined();
      expect("unresolved" in loaded!).toBe(false);
    });
  });
});
