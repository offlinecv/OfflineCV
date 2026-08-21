// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * useDownloadPdf behaviour (#313 additions), exercised through a probe
 * component (the project has no @testing-library/react — same pattern as the
 * other hook tests, e.g. `useReportGap.test.tsx`).
 *
 * Covers: a download tags the analytics event with `source: "blank"` when
 * the result came from `buildBlankResult()` (`tiers: []`) vs `source:
 * "upload"` for any real parse; and a successful blank-authored download
 * clears the persisted draft key (#313 AC — "cleared … on successful export").
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  glyphLossMessage,
  useDownloadPdf,
  type UseDownloadPdf,
} from "./useDownloadPdf.ts";
import { buildBlankResult } from "../lib/heuristics/empty-result.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import { computeAnonymousAtsScore } from "../lib/score/score.ts";
import { BLANK_DRAFT_STORAGE_KEY } from "./useResumeAnalysis.ts";

const tracked: Array<{ source: string; format?: string }> = [];
vi.mock("../lib/analytics.ts", () => ({
  trackDownloadCompleted: (args: { source: string; format?: string }) =>
    tracked.push(args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function uploadedResult(): CascadeResult {
  return {
    canonical: {
      fields: {
        full_name: "Jane Doe",
        email: "jane@example.com",
        skills: [],
        experience: [
          { company: "Acme", title: "Engineer", description: "Did work" },
        ],
        education: [],
      },
      sections: {
        byName: new Map(),
        accomplishmentSections: ["experience"],
        source: "regex",
      },
      fieldConfidence: {},
    },
    confidence: 0.8,
    triggers: [],
    suggestedEscalation: "none",
    // Non-empty tiers — a real (uploaded) parse always has at least these.
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "Jane Doe\njane@example.com\nEngineer at Acme\nDid work",
    linkAnnotations: [],
    diagnostics: { rawCharCount: 10, extractedCharCount: 10, pages: 1, elapsedMs: 1 },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  };
}

let container: HTMLDivElement;
let root: Root;
let api: UseDownloadPdf;

function Probe({ result }: { result: CascadeResult }) {
  const score = computeAnonymousAtsScore({
    parsed: result.canonical.fields,
    fieldConfidence: result.canonical.fieldConfidence,
    triggers: result.triggers,
    rawText: result.rawText,
    sections: result.canonical.sections,
  });
  api = useDownloadPdf(result, score, onDownloaded);
  return null;
}

/** The journey's Download-stage mark site (#826), spied on per test. */
let onDownloaded = vi.fn();

function mount(result: CascadeResult): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe result={result} />));
}

beforeEach(() => {
  tracked.length = 0;
  onDownloaded = vi.fn();

  globalThis.URL.createObjectURL = vi.fn(
    () => "blob:mock",
  ) as unknown as typeof URL.createObjectURL;
  globalThis.URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function (this: HTMLAnchorElement) {
      // no-op — jsdom would otherwise try to navigate
    },
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe("useDownloadPdf — download-source tagging (#313)", () => {
  it("tags an uploaded (non-blank) result's download as source: 'upload'", async () => {
    mount(uploadedResult());
    await act(async () => {
      await api.download();
    });

    expect(tracked).toEqual([{ source: "upload", format: "pdf" }]);
  });

  it("tags a blank/authored result's download as source: 'blank'", async () => {
    mount(buildBlankResult());
    await act(async () => {
      await api.download();
    });

    expect(tracked).toEqual([{ source: "blank", format: "pdf" }]);
  });

  it("clears the persisted blank draft on a successful blank-authored download", async () => {
    localStorage.setItem(BLANK_DRAFT_STORAGE_KEY, JSON.stringify({ foo: 1 }));
    mount(buildBlankResult());

    await act(async () => {
      await api.download();
    });

    expect(localStorage.getItem(BLANK_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("does not touch the blank draft key on an uploaded download", async () => {
    localStorage.setItem(BLANK_DRAFT_STORAGE_KEY, JSON.stringify({ foo: 1 }));
    mount(uploadedResult());

    await act(async () => {
      await api.download();
    });

    expect(localStorage.getItem(BLANK_DRAFT_STORAGE_KEY)).not.toBeNull();
  });
});

/**
 * #664 — refuse rather than silently substituting "?" in the user's own fields.
 *
 * The real, correctly-served embedded font (Liberation Sans) covers ś/ł, so
 * there is nothing to refuse over on the happy path — `render-ats-pdf.fonts.
 * test.ts`'s "reports nothing when the embedded font loads" pins that. To
 * exercise the refusal, this block stubs `fetch` to fail and forces a fresh
 * module instance via `vi.resetModules()` + a dynamic re-import (the same
 * pattern `render-ats-pdf.fonts.test.ts` uses) rather than relying on the
 * statically-imported `useDownloadPdf` above: `render-ats-pdf.ts` memoizes a
 * SUCCESSFUL font fetch at module scope for the life of that module instance
 * (#664 — so a repeat download doesn't re-fetch), and the tagging describe
 * above already forced one real success against the shared instance. Without
 * a fresh module, `loadBodyFontBytes()` would short-circuit on that cached
 * success and never call the failing stub at all.
 */
describe("useDownloadPdf — glyph-loss refusal (#664)", () => {
  let freshUseDownloadPdf: typeof useDownloadPdf;

  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unavailable (simulated)");
      }),
    );
    vi.resetModules();
    ({ useDownloadPdf: freshUseDownloadPdf } = await import("./useDownloadPdf.ts"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function namedResult(fullName: string): CascadeResult {
    const base = uploadedResult();
    return {
      ...base,
      canonical: {
        ...base.canonical,
        fields: { ...base.canonical.fields, full_name: fullName },
      },
    };
  }

  function FreshProbe({ result }: { result: CascadeResult }) {
    const score = computeAnonymousAtsScore({
      parsed: result.canonical.fields,
      fieldConfidence: result.canonical.fieldConfidence,
      triggers: result.triggers,
      rawText: result.rawText,
      sections: result.canonical.sections,
    });
    api = freshUseDownloadPdf(result, score, onDownloaded);
    return null;
  }

  function mountFresh(result: CascadeResult): void {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<FreshProbe result={result} />));
  }

  it("refuses the download and names the field when the fallback would mangle the name", async () => {
    mountFresh(namedResult("ANNA WIŚNIEWSKA"));

    await act(async () => {
      await api.download();
    });

    expect(api.error).toContain("Name");
    // The value itself must not be echoed back — a résumé's own text does not
    // belong in an error banner.
    expect(api.error).not.toContain("WIŚNIEWSKA");
    expect(api.isGenerating).toBe(false);
  });

  it("fires no download, no analytics event and no journey mark when it refuses", async () => {
    mountFresh(namedResult("ANNA WIŚNIEWSKA"));

    await act(async () => {
      await api.download();
    });

    // A refused export is not a completed one — counting it would inflate the
    // download metric with PDFs that were never produced, and (#826) would put
    // a ✓ on the Download stage for a file the user never received.
    expect(tracked).toEqual([]);
    expect(onDownloaded).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it("still downloads a pure-ASCII résumé on the same failing-font path", async () => {
    // The gate that keeps a font problem from blocking everyone: this is the
    // identical code path as the refusal above, differing only in the data.
    mountFresh(namedResult("Jane Candidate"));

    await act(async () => {
      await api.download();
    });

    expect(api.error).toBeNull();
    expect(tracked).toEqual([{ source: "upload", format: "pdf" }]);
    // #826 — the bytes reached the user, so the Download stage is done.
    expect(onDownloaded).toHaveBeenCalledTimes(1);
  });
});

describe("glyphLossMessage (#664)", () => {
  it("collapses duplicate fields so a repeated loss reads as one item", () => {
    const msg = glyphLossMessage([
      { where: "Experience", original: "a→b", degraded: "a->b" },
      { where: "Experience", original: "c→d", degraded: "c->d" },
      { where: "Experience", original: "e→f", degraded: "e->f" },
    ]);

    expect(msg).toContain("your Experience.");
    // Not "Experience, Experience and Experience".
    expect(msg.match(/Experience/g)).toHaveLength(1);
  });

  it("joins multiple fields readably and never echoes the values", () => {
    const msg = glyphLossMessage([
      { where: "Name", original: "WIŚNIEWSKA", degraded: "WI?NIEWSKA" },
      { where: "Location", original: "Kraków", degraded: "Krak?w" },
      { where: "Experience", original: "★", degraded: "?" },
    ]);

    expect(msg).toContain("your Name, Location and Experience.");
    expect(msg).not.toContain("WIŚNIEWSKA");
    expect(msg).not.toContain("Kraków");
  });
});
