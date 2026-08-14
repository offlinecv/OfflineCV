// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * useResumeLibrary — the one behaviour that lives in the hook rather than the
 * domain layer: deleting a resume must also clear it from any tracked job that
 * pointed at it (#323 AC, "deleting that resume degrades gracefully — link
 * cleared, job kept"), and since #711 from any cover letter too.
 *
 * The lib-level `clearResumeLink` / `clearLetterResumeLink` are covered in
 * `job-tracker.test.ts` and `storage/letters.test.ts`; what is asserted here is
 * the *wiring* — that the resume-delete path actually calls them. Exercised
 * through a probe component against `fake-indexeddb`, since the project has no
 * @testing-library/react (same pattern as the other hook tests).
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DB_NAME,
  closeDB,
  saveResume,
  saveLetter,
  getLetter,
} from "../lib/storage/index.ts";
import { createJob, listJobs } from "../lib/job-tracker.ts";
import {
  useResumeLibrary,
  saveChangesNothingListed,
  type ResumeLibrary,
  type SaveResumeParams,
} from "./useResumeLibrary.ts";
import type { ResumeLibraryEntry } from "../lib/resume-library.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLElement;
let root: Root;

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** jsdom's `File`/`Blob` don't implement `.text()` (checked against the
 *  jsdom version this project pins) — `importBackup` calls it to read the
 *  picked file, so a real `new File(...)` throws here. Same class of gap as
 *  `ResumeLibrary.test.tsx`'s `HTMLDialogElement` polyfill: patch just the
 *  method the code under test needs, on a real `Blob` instance so `instanceof
 *  Blob` still holds. */
function jsonFile(json: string, name = "backup.json"): File {
  const blob = new Blob([json], { type: "application/json" });
  return Object.assign(blob, {
    name,
    lastModified: Date.now(),
    text: () => Promise.resolve(json),
  }) as unknown as File;
}

/** Render the hook and hand its value back through a ref-ish capture. */
async function mountLibrary(): Promise<() => ResumeLibrary> {
  let current: ResumeLibrary | undefined;
  function Probe() {
    current = useResumeLibrary();
    return null;
  }
  await act(async () => {
    root.render(<Probe />);
  });
  return () => {
    if (!current) throw new Error("hook not mounted");
    return current;
  };
}

describe("useResumeLibrary: delete clears tracked-job links", () => {
  it("keeps a job that pointed at the deleted resume, minus the link", async () => {
    const resume = await saveResume({
      filename: "resume-v1.pdf",
      blob: new Blob(["%PDF-1.4"], { type: "application/pdf" }),
    });
    const linked = await createJob({ title: "SWE", resumeId: resume.id });
    const untouched = await createJob({ title: "PM", resumeId: "other-resume" });

    const library = await mountLibrary();
    await act(async () => {
      await library().remove(resume.id);
    });

    const jobs = await listJobs();
    // The job survives — only the dangling link is dropped.
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.id === linked.id)?.title).toBe("SWE");
    expect(jobs.find((j) => j.id === linked.id)?.resumeId).toBeUndefined();
    // A link to a different resume is not collateral damage.
    expect(jobs.find((j) => j.id === untouched.id)?.resumeId).toBe(
      "other-resume",
    );
  });

  it("keeps a cover letter that pointed at the deleted resume, minus the link (#711)", async () => {
    const resume = await saveResume({
      filename: "resume-v1.pdf",
      blob: new Blob(["%PDF-1.4"], { type: "application/pdf" }),
    });
    const linked = await saveLetter({
      jobId: "job-1",
      body: "Dear hiring team,",
      resumeId: resume.id,
    });
    const untouched = await saveLetter({
      jobId: "job-2",
      body: "Another draft",
      resumeId: "other-resume",
    });

    const library = await mountLibrary();
    await act(async () => {
      await library().remove(resume.id);
    });

    // Same degrade jobs get: the prose survives, only the dangling link goes.
    // `clearLetterResumeLink` itself is covered in `storage/letters.test.ts`;
    // what this asserts is that the delete path actually calls it.
    expect((await getLetter(linked.id))?.body).toBe("Dear hiring team,");
    expect((await getLetter(linked.id))?.resumeId).toBeUndefined();
    expect((await getLetter(untouched.id))?.resumeId).toBe("other-resume");
  });

  it("deletes a resume with no tracked jobs at all without throwing", async () => {
    const resume = await saveResume({
      filename: "lonely.pdf",
      blob: new Blob(["%PDF-1.4"], { type: "application/pdf" }),
    });
    const library = await mountLibrary();
    await act(async () => {
      await library().remove(resume.id);
    });
    expect(library().entries).toHaveLength(0);
  });
});

describe("useResumeLibrary: load failure has a voice (#756)", () => {
  it("load() resolves undefined for a record with no snapshot and no stored bytes", async () => {
    // No `parse` (no cached snapshot) and an empty blob (nothing to re-parse
    // from, e.g. a DOCX record with no source bytes kept at rest) — the one
    // genuinely unrecoverable case `loadResumeFromLibrary` still returns
    // `undefined` for after #755's re-parse fallback.
    const unrecoverable = await saveResume({
      filename: "no-bytes.pdf",
      blob: new Blob([], { type: "application/pdf" }),
    });
    const library = await mountLibrary();

    let loaded: unknown;
    await act(async () => {
      loaded = await library().load(unrecoverable.id);
    });
    expect(loaded).toBeUndefined();
  });

  it("load() clears a loadError left by a previous failed attempt", async () => {
    const unrecoverable = await saveResume({
      filename: "no-bytes.pdf",
      blob: new Blob([], { type: "application/pdf" }),
    });
    const library = await mountLibrary();

    // Simulate App.tsx having set an error after a prior failed load.
    await act(async () => {
      library().setLoadError("stale error from a previous attempt");
    });
    expect(library().loadError).toBe("stale error from a previous attempt");

    // A new attempt — even one that itself fails — clears the stale error
    // before it resolves, so App.tsx's fresh `setLoadError` (or lack of one,
    // on success) is never racing a leftover message.
    await act(async () => {
      await library().load(unrecoverable.id);
    });
    expect(library().loadError).toBeNull();
  });
});

describe("useResumeLibrary: merge-mode import reconciles dangling resume links (#547)", () => {
  it("clears the link on an incoming job whose resumeId nothing in the merge carries", async () => {
    const survivor = await saveResume({
      filename: "survivor.pdf",
      blob: new Blob(["%PDF-1.4"], { type: "application/pdf" }),
    });
    // A backup whose one job points at a resume this device never had, and
    // this file doesn't carry either — the losing case: if the sweep didn't
    // run, this job would stay linked to a resume that doesn't exist.
    const backup = {
      version: 1,
      exportedAt: Date.now(),
      resumes: [],
      jobs: [
        {
          id: "orphaned-job",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          title: "Staff Engineer",
          company: "Acme",
          status: "interested",
          resumeId: "ghost-resume",
        },
      ],
    };
    const file = jsonFile(JSON.stringify(backup));

    const library = await mountLibrary();
    await act(async () => {
      await library().importBackup(file, "merge");
    });

    const jobs = await listJobs();
    const job = jobs.find((j) => j.id === "orphaned-job");
    expect(job).toBeDefined();
    expect(job?.resumeId).toBeUndefined();
    // The survivor resume (untouched by the merge) proves the sweep read ids
    // AFTER the import write, not a stale pre-import snapshot.
    expect(library().entries.map((e) => e.id)).toContain(survivor.id);
  });

  it("keeps a merge-imported job's link when its resume is included in the same file", async () => {
    const resume = await saveResume({
      filename: "linked.pdf",
      blob: new Blob(["%PDF-1.4"], { type: "application/pdf" }),
    });
    const backup = {
      version: 1,
      exportedAt: Date.now(),
      resumes: [],
      jobs: [
        {
          id: "linked-job",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          title: "Staff Engineer",
          company: "Acme",
          status: "interested",
          resumeId: resume.id,
        },
      ],
    };
    const file = jsonFile(JSON.stringify(backup));

    const library = await mountLibrary();
    await act(async () => {
      await library().importBackup(file, "merge");
    });

    const jobs = await listJobs();
    expect(jobs.find((j) => j.id === "linked-job")?.resumeId).toBe(resume.id);
  });
});

describe("useResumeLibrary: a save that changes nothing skips the refresh (#824)", () => {
  // `save()` refreshed the whole list after every write — `listLibrary()` plus
  // `estimateStorageUsage()`, both round-tripping IndexedDB. Fine for a button
  // click; wrong for the autosave firing behind every edit. `navigator.storage
  // .estimate` is the probe because only `refresh()` reaches it.
  let estimate: ReturnType<typeof vi.fn>;
  let persist: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    estimate = vi.fn(async () => ({ usage: 1024, quota: 1_000_000 }));
    persist = vi.fn(async () => false);
    Object.defineProperty(navigator, "storage", {
      value: {
        estimate,
        persist,
        persisted: async () => false,
      },
      configurable: true,
    });
  });

  const params = (id: string | undefined, overall: number) => ({
    id,
    filename: "cv.pdf",
    bytes: new ArrayBuffer(4),
    sourceKind: "pdf" as const,
    result: {} as never,
    score: { overall } as never,
  });

  it("re-reads on a new record and on a changed score, and not in between", async () => {
    const library = await mountLibrary();
    const afterMount = estimate.mock.calls.length;

    let id = "";
    await act(async () => {
      id = await library().save(params(undefined, 70));
    });
    // A new row: the picker has never seen it, so the list must be re-read.
    expect(estimate.mock.calls.length).toBe(afterMount + 1);

    await act(async () => {
      await library().save(params(id, 70));
    });
    // Same filename, same score, same kind — nothing `ResumeLibraryEntry`
    // carries has moved, so the write stands alone.
    expect(estimate.mock.calls.length).toBe(afterMount + 1);

    await act(async () => {
      await library().save(params(id, 84));
    });
    // The score is listed, so a score change is not skippable.
    expect(estimate.mock.calls.length).toBe(afterMount + 2);
    expect(library().entries[0].scoreOverall).toBe(84);
  });

  it("asks for durable storage once per mount, not once per write", async () => {
    // `navigator.storage.persist()` raises a user-visible permission doorhanger
    // in Firefox. It used to open `save()`, which was fine behind a button and
    // wrong behind the debounced autosave: the user would be prompted on the
    // first inline edit and again every quiet period, having clicked nothing.
    const library = await mountLibrary();
    let id = "";
    await act(async () => {
      id = await library().save(params(undefined, 70));
    });
    expect(persist).toHaveBeenCalledTimes(1);

    await act(async () => {
      await library().save(params(id, 84));
    });
    await act(async () => {
      await library().save(params(id, 91));
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe("saveChangesNothingListed — which saves are skippable (#824)", () => {
  const entry = (over: Partial<ResumeLibraryEntry> = {}): ResumeLibraryEntry => ({
    id: "r1",
    filename: "cv.pdf",
    savedAt: 1,
    scoreOverall: 70,
    sourceKind: "pdf",
    hasCachedParse: true,
    ...over,
  });
  const save = (over: Partial<SaveResumeParams> = {}): SaveResumeParams => ({
    id: "r1",
    filename: "cv.pdf",
    sourceKind: "pdf",
    result: {} as never,
    score: { overall: 70 } as never,
    ...over,
  });

  it("skips a save that moves no listed field", () => {
    expect(saveChangesNothingListed([entry()], save())).toBe(true);
  });

  it("never skips a NEW record — the picker has never seen the row", () => {
    expect(saveChangesNothingListed([entry()], save({ id: undefined }))).toBe(false);
  });

  it("never skips an id this list does not hold", () => {
    // Saved in another tab, or listed before this record existed. The row has
    // to appear, so the list must be re-read.
    expect(saveChangesNothingListed([entry()], save({ id: "elsewhere" }))).toBe(false);
  });

  it.each([
    ["filename", save({ filename: "tailored.pdf" })],
    ["score", save({ score: { overall: 84 } as never })],
    ["sourceKind", save({ sourceKind: "docx" })],
  ])("never skips a changed %s", (_field, params) => {
    expect(saveChangesNothingListed([entry()], params)).toBe(false);
  });

  it("never skips a record that is gaining its first cached parse", () => {
    // #757: a record an outside producer wrote with no snapshot lists at score
    // 0 and `hasCachedParse: false`. This save gives it one — visibly.
    expect(saveChangesNothingListed([entry({ hasCachedParse: false })], save())).toBe(
      false,
    );
  });
});
