// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * useResumeLibrary — the one behaviour that lives in the hook rather than the
 * domain layer: deleting a resume must also clear it from any tracked job that
 * pointed at it (#323 AC, "deleting that resume degrades gracefully — link
 * cleared, job kept").
 *
 * The lib-level `clearResumeLink` is covered in `job-tracker.test.ts`; what is
 * asserted here is the *wiring* — that the resume-delete path actually calls
 * it. Exercised through a probe component against `fake-indexeddb`, since the
 * project has no @testing-library/react (same pattern as the other hook tests).
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DB_NAME, closeDB, saveResume } from "../lib/storage/index.ts";
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
