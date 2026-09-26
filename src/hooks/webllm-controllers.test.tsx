// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Lifecycle coverage for the two WebGPU-gated WebLLM controllers (#262/#243):
 * `useResumeAnalysisLlm` (the unified parse+critique controller that replaced
 * `useParseDisagreement` + `useResumeCritique`) and `useLlmEscapeHatch`.
 *
 * The engine layer (capability probe, loadEngine, the combined analysis pass,
 * the escape-hatch parse pass, the consent request, analytics) is mocked, so
 * these tests exercise the React/state glue only — availability gating, the
 * consent gate (#1015) and its double-click guard, the idle→loading→done
 * happy path, and the error path —
 * via a probe component
 * (the project has no RTL; same pattern as the other hook tests).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { SectionedResume } from "../lib/heuristics/sections.ts";
import type { SectionName } from "../lib/heuristics/regex.ts";

// ── Mocks (engine layer only) ──────────────────────────────────────────────────

let webgpu: "available" | "unavailable" = "available";
let loadShouldThrow = false;
let consentAnswer = true;

vi.mock("../lib/webllm/capability.ts", () => ({
  detectWebGpu: () => Promise.resolve(webgpu),
}));

vi.mock("../lib/webllm/web-llm.ts", () => ({
  loadEngine: vi.fn((_id: string, onProgress: (p: unknown) => void) => {
    onProgress({ progress: 0.5, text: "Loading…" });
    if (loadShouldThrow) return Promise.reject(new Error("load failed"));
    return Promise.resolve({ chat: {} });
  }),
  acquireInference: vi.fn(),
  releaseInference: vi.fn(),
}));

vi.mock("../lib/webllm/analyze-resume.ts", () => ({
  analyzeResumeWithLlm: vi.fn(() =>
    Promise.resolve({
      parse: {
        full_name: "LLM Name",
        email: null,
        phone: null,
        location: null,
        summary: null,
        skills: [],
        experience: [],
        education: [],
      },
      // Unused by useResumeAnalysisLlm since #1036 — the hook takes its
      // critique from critiqueResumeWithLlm instead. Kept non-empty here so a
      // test that asserted on the wrong source fails loudly, not by luck.
      critique: {
        bulletFindings: [
          { bullet: "STALE — from analyzeResumeWithLlm", issue: "vague" },
        ],
        missingSections: ["skills"],
      },
    }),
  ),
}));

vi.mock("../lib/webllm/critique-resume.ts", () => ({
  critiqueResumeWithLlm: vi.fn(() =>
    Promise.resolve({
      bulletFindings: [
        { bullet: "x", issue: "weak_verb" },
        { bullet: "y", issue: "ok" },
      ],
      missingSections: ["skills"],
    }),
  ),
}));

vi.mock("../lib/webllm/parse-resume.ts", () => ({
  parseResumeWithLlm: () =>
    Promise.resolve({
      full_name: "LLM Name",
      email: null,
      phone: null,
      location: null,
      summary: null,
      skills: [],
      experience: [],
      education: [],
    }),
}));

vi.mock("./useModelConsent.ts", () => ({
  requestModelConsent: vi.fn(() => Promise.resolve(consentAnswer)),
}));

vi.mock("../lib/analytics.ts", () => ({
  trackLlmParseRan: vi.fn(),
  trackDisagreementsFound: vi.fn(),
  trackLlmFallbackRan: vi.fn(),
  trackCritiqueRan: vi.fn(),
}));

import { useResumeAnalysisLlm } from "./useResumeAnalysisLlm.ts";
import { useLlmEscapeHatch } from "./useLlmEscapeHatch.ts";
import {
  acquireInference,
  loadEngine,
  releaseInference,
} from "../lib/webllm/web-llm.ts";
import { analyzeResumeWithLlm } from "../lib/webllm/analyze-resume.ts";
import { critiqueResumeWithLlm } from "../lib/webllm/critique-resume.ts";
import { matchCritiqueFindings } from "../lib/score/critique-match.ts";
import type { BulletObservation } from "../lib/score/score.ts";
import { requestModelConsent } from "./useModelConsent.ts";
import { SHIPPED_MODEL } from "../lib/webllm/models.ts";
import {
  trackLlmParseRan,
  trackDisagreementsFound,
  trackCritiqueRan,
} from "../lib/analytics.ts";

/** A graded bullet stub. Only `id` and `text` take part in the critique join. */
function bullet(id: string, text: string): BulletObservation {
  return {
    id,
    text,
    index: 0,
    hasMetric: true,
    startsWithActionVerb: true,
    wellFormedLength: true,
    wordCount: 8,
  };
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function sectioned(): SectionedResume {
  const byName = new Map<SectionName | "profile", readonly string[]>([
    ["experience", ["a bullet"]],
  ]);
  return { byName, accomplishmentSections: ["experience"], source: "regex" };
}

function result(): CascadeResult {
  return {
    canonical: {
      fields: {
        full_name: "Orig",
        email: "orig@example.com",
        skills: ["s"],
        experience: [
          { company: "Co", title: "T", description: "did a thing", is_current: false },
        ],
        education: [],
      },
      sections: sectioned(),
      fieldConfidence: {},
    },
    confidence: 0.4,
    triggers: ["two_column"],
    suggestedEscalation: "llm",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "some extractable text",
    markdown: "some extractable text",
    linkAnnotations: [],
    diagnostics: { rawCharCount: 100, extractedCharCount: 20, pages: 1, elapsedMs: 5 },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  };
}

let container: HTMLDivElement;
let root: Root;

// Mount a probe that publishes the controller into `sink` on every render.
async function mount<T>(useHook: () => T, sink: { current: T | null }) {
  function Probe() {
    sink.current = useHook();
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });
  // Let the async WebGPU probe settle so `isAvailable` reflects capability.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  webgpu = "available";
  loadShouldThrow = false;
  consentAnswer = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("useResumeAnalysisLlm", () => {
  it("runs the combined pass and reaches done with both halves populated", async () => {
    const r = result();
    const sink: { current: ReturnType<typeof useResumeAnalysisLlm> | null } = {
      current: null,
    };
    await mount(() => useResumeAnalysisLlm(r, r), sink);
    expect(sink.current!.isAvailable).toBe(true);
    await act(async () => {
      await sink.current!.run();
    });
    const status = sink.current!.status;
    expect(status.kind).toBe("done");
    if (status.kind !== "done") return;
    // The diff comes from analyzeResumeWithLlm; the critique comes from the
    // separate critiqueResumeWithLlm pass (#1036) — never the combined pass's
    // own (discarded) critique half.
    expect(status.disagreements).toBeDefined();
    expect(status.critique.bulletFindings).toHaveLength(2);
    expect(status.critique.bulletFindings.map((f) => f.bullet)).not.toContain(
      "STALE — from analyzeResumeWithLlm",
    );
    expect(critiqueResumeWithLlm).toHaveBeenCalledOnce();
    // Consent was asked first (#1015), then the #148 contract: the
    // controller acquires the shipped model's inference slot and releases it.
    expect(requestModelConsent).toHaveBeenCalledOnce();
    expect(acquireInference).toHaveBeenCalledWith(SHIPPED_MODEL.id);
    expect(releaseInference).toHaveBeenCalledWith(SHIPPED_MODEL.id);
    // All three telemetry events fire from the one run, across both passes.
    expect(trackLlmParseRan).toHaveBeenCalledTimes(1);
    expect(trackDisagreementsFound).toHaveBeenCalledTimes(1);
    expect(trackCritiqueRan).toHaveBeenCalledTimes(1);
  });

  it("critiques the EDITED wording, not the extractor's original text (#1036)", async () => {
    // `foldEditedIntoResult` edits `canonical.fields` but keeps `rawText` /
    // `markdown` as the extractor's original — so this result is exactly what
    // `Result.tsx` hands the hook after a bullet edit: the parse fields carry
    // the rewrite, the raw text still carries the pre-edit page.
    const base = result();
    const edited: CascadeResult = {
      ...base,
      canonical: {
        ...base.canonical,
        fields: {
          ...base.canonical.fields,
          experience: [
            {
              ...base.canonical.fields.experience![0]!,
              description: "Rebuilt the payments API",
            },
          ],
        },
      },
    };
    vi.mocked(critiqueResumeWithLlm).mockResolvedValueOnce({
      bulletFindings: [
        { bullet: "Rebuilt the payments API", issue: "weak_verb" },
      ],
      missingSections: [],
    });

    const sink: { current: ReturnType<typeof useResumeAnalysisLlm> | null } = {
      current: null,
    };
    await mount(() => useResumeAnalysisLlm(edited, edited), sink);
    await act(async () => {
      await sink.current!.run();
    });

    // The critique read the EDITED fields...
    expect(critiqueResumeWithLlm).toHaveBeenCalledWith(
      edited.canonical.fields,
      expect.anything(),
    );
    // ...while the parse/diff pass still read the extractor's ORIGINAL text.
    expect(analyzeResumeWithLlm).toHaveBeenCalledWith(
      { rawText: edited.rawText, markdown: edited.markdown },
      expect.anything(),
    );

    const status = sink.current!.status;
    expect(status.kind).toBe("done");
    if (status.kind !== "done") return;
    // A finding for the edited bullet matches it in Fix It (#1008).
    const matched = matchCritiqueFindings(status.critique.bulletFindings, [
      bullet("exp-0-bullet-0", "Rebuilt the payments API"),
    ]);
    expect(matched.get("exp-0-bullet-0")?.issue).toBe("weak_verb");
  });

  it("declined consent: nothing loads and the panel stays idle", async () => {
    consentAnswer = false;
    const r = result();
    const sink: { current: ReturnType<typeof useResumeAnalysisLlm> | null } = {
      current: null,
    };
    await mount(() => useResumeAnalysisLlm(r, r), sink);
    await act(async () => {
      await sink.current!.run();
    });
    expect(sink.current!.status.kind).toBe("idle");
    expect(loadEngine).not.toHaveBeenCalled();
    expect(acquireInference).not.toHaveBeenCalled();
  });

  it("a double-click while consent is pending starts one run, and a decline frees the next", async () => {
    const r = result();
    const sink: { current: ReturnType<typeof useResumeAnalysisLlm> | null } = {
      current: null,
    };
    await mount(() => useResumeAnalysisLlm(r, r), sink);
    await act(async () => {
      const first = sink.current!.run();
      const second = sink.current!.run();
      await Promise.all([first, second]);
    });
    expect(requestModelConsent).toHaveBeenCalledOnce();
    expect(loadEngine).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    consentAnswer = false;
    await act(async () => {
      await sink.current!.run();
    });
    consentAnswer = true;
    await act(async () => {
      await sink.current!.run();
    });
    expect(requestModelConsent).toHaveBeenCalledTimes(2);
    expect(loadEngine).toHaveBeenCalledOnce();
  });

  it("is unavailable without WebGPU", async () => {
    webgpu = "unavailable";
    const r = result();
    const sink: { current: ReturnType<typeof useResumeAnalysisLlm> | null } = {
      current: null,
    };
    await mount(() => useResumeAnalysisLlm(r, r), sink);
    expect(sink.current!.isAvailable).toBe(false);
  });

  it("an edit keeps a finished critique; a new résumé resets it (#1008)", async () => {
    // `Result` hands this hook an edit-folded parse that is a NEW object on
    // every keystroke. Keyed on that object, the first edit wiped a finished
    // critique — and with it the findings Fix It steps through.
    const sink: { current: ReturnType<typeof useResumeAnalysisLlm> | null } = {
      current: null,
    };
    function Probe({ r, parseKey }: { r: CascadeResult; parseKey: unknown }) {
      sink.current = useResumeAnalysisLlm(r, parseKey);
      return null;
    }
    const parseKey = {};
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Probe r={result()} parseKey={parseKey} />);
    });
    await act(async () => {
      await sink.current!.run();
    });
    expect(sink.current!.status.kind).toBe("done");

    // An edit: a new result object, the same parse.
    await act(async () => {
      root.render(<Probe r={result()} parseKey={parseKey} />);
    });
    expect(sink.current!.status.kind).toBe("done");

    // A new résumé.
    await act(async () => {
      root.render(<Probe r={result()} parseKey={{}} />);
    });
    expect(sink.current!.status.kind).toBe("idle");
  });
});

describe("useLlmEscapeHatch", () => {
  it("runs and reaches done", async () => {
    const r = result();
    const sink: { current: ReturnType<typeof useLlmEscapeHatch> | null } = {
      current: null,
    };
    await mount(() => useLlmEscapeHatch(r, r), sink);
    expect(sink.current!.isAvailable).toBe(true);
    await act(async () => {
      await sink.current!.run();
    });
    expect(sink.current!.status.kind).toBe("done");
    // Consent was asked first (#1015), then the #148 contract: the
    // controller acquires the shipped model's inference slot and releases it.
    expect(requestModelConsent).toHaveBeenCalledOnce();
    expect(acquireInference).toHaveBeenCalledWith(SHIPPED_MODEL.id);
    expect(releaseInference).toHaveBeenCalledWith(SHIPPED_MODEL.id);
  });

  it("declined consent: nothing loads and the offer stays idle", async () => {
    consentAnswer = false;
    const r = result();
    const sink: { current: ReturnType<typeof useLlmEscapeHatch> | null } = {
      current: null,
    };
    await mount(() => useLlmEscapeHatch(r, r), sink);
    await act(async () => {
      await sink.current!.run();
    });
    expect(sink.current!.status.kind).toBe("idle");
    expect(loadEngine).not.toHaveBeenCalled();
  });

  it("a double-click while consent is pending starts one run, and a decline frees the next", async () => {
    const r = result();
    const sink: { current: ReturnType<typeof useLlmEscapeHatch> | null } = {
      current: null,
    };
    await mount(() => useLlmEscapeHatch(r, r), sink);
    await act(async () => {
      const first = sink.current!.run();
      const second = sink.current!.run();
      await Promise.all([first, second]);
    });
    expect(requestModelConsent).toHaveBeenCalledOnce();
    expect(loadEngine).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    consentAnswer = false;
    await act(async () => {
      await sink.current!.run();
    });
    consentAnswer = true;
    await act(async () => {
      await sink.current!.run();
    });
    expect(requestModelConsent).toHaveBeenCalledTimes(2);
    expect(loadEngine).toHaveBeenCalledOnce();
  });

  it("surfaces an error when the engine fails to load", async () => {
    loadShouldThrow = true;
    const r = result();
    const sink: { current: ReturnType<typeof useLlmEscapeHatch> | null } = {
      current: null,
    };
    await mount(() => useLlmEscapeHatch(r, r), sink);
    await act(async () => {
      await sink.current!.run();
    });
    expect(sink.current!.status.kind).toBe("error");
  });

  it("keeps a completed pass across an edit and drops it when the parse changes", async () => {
    // #823 made this distinction load-bearing. The `result` a caller passes is
    // `displayResult` — a memo over the edit override maps — so a keystroke
    // mints a fresh object for the SAME parse. Keyed on that, a settled
    // "Recovered with on-device AI" confirmation reverts to the "Try a local AI
    // pass" CTA on the first character the user types, and `ResultDetail`
    // withholds the whole "Local AI feedback" section while an offer stands, so
    // a visible section goes with it — while `ParsedHeader` above still reads
    // "Recovered", because that IS keyed on `parseKey`. One keystroke, and the
    // page contradicts itself.
    const parseA = result();
    const sink: { current: ReturnType<typeof useLlmEscapeHatch> | null } = {
      current: null,
    };
    function Probe({ res, pk }: { res: CascadeResult; pk: unknown }) {
      sink.current = useLlmEscapeHatch(res, pk);
      return null;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Probe res={parseA} pk={parseA} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await sink.current!.run();
    });
    expect(sink.current!.status.kind).toBe("done");

    // One keystroke. Mirrors what `displayResult` actually produces: a new
    // result AND a new `canonical`/`fields` underneath it, structurally equal.
    const edited = {
      ...parseA,
      canonical: { ...parseA.canonical, fields: { ...parseA.canonical.fields } },
    };
    await act(async () => {
      root.render(<Probe res={edited} pk={parseA} />);
    });
    expect(sink.current!.status.kind).toBe("done");

    // A genuinely different résumé — a drop, a replace, a library load. The
    // pass belonged to the one before it.
    const parseB = result();
    await act(async () => {
      root.render(<Probe res={parseB} pk={parseB} />);
    });
    expect(sink.current!.status.kind).toBe("idle");
  });
});
