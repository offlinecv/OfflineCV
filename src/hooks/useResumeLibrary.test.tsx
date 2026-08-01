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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { useResumeLibrary, type ResumeLibrary } from "./useResumeLibrary.ts";

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
