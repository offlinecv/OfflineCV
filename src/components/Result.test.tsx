// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression coverage for the #313 score-reveal gate (Result / ParsedCard).
 *
 * The threshold reveal gate is BLANK-AUTHORING ONLY. `ParsedCard` is also the
 * primary "drop a PDF → see your score" view for every ordinary upload, where a
 * missing phone/email (or zero experience) is a common failure this app exists
 * to FLAG. Gating the score there killed the diagnostic on the main `/` lane.
 * This test proves the upload path (`tiers.length > 0`) renders the score ring
 * UNCONDITIONALLY even with critical contact fields missing — not the
 * "your score will appear once…" placeholder. Raw createRoot, matching the
 * other feature render tests.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement, useMemo } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The on-device lane, stubbed to the shape the recovery test below drives: a
// WebGPU-capable browser and an engine that returns a parse immediately. No
// weights are fetched and no analytics fire (`track()` short-circuits without
// VITE_POSTHOG_KEY), so the rest of this file is unaffected.
//
// Mutable rather than a constant so the #544 suite at the bottom can run the
// NO-WebGPU regime, which is the precondition that made that defect real. It
// defaults to "available" and every test that flips it restores it, so the
// rest of the file reads exactly as it did.
const webgpu = vi.hoisted(() => ({ capability: "available" as string }));
vi.mock("../lib/webllm/capability.ts", () => ({
  detectWebGpu: () => Promise.resolve(webgpu.capability),
}));
// The consent dialog lives in `PageShell`, which this suite does not mount;
// the user is taken to have already accepted the model's terms (#1015).
vi.mock("../hooks/useModelConsent.ts", () => ({
  requestModelConsent: () => Promise.resolve(true),
}));
vi.mock("../lib/webllm/web-llm.ts", () => ({
  loadEngine: () => Promise.resolve({ chat: {} }),
  acquireInference: () => {},
  releaseInference: () => {},
}));
vi.mock("../lib/webllm/parse-resume.ts", () => ({
  parseResumeWithLlm: () =>
    Promise.resolve({
      full_name: "Dana Fixture",
      email: null,
      phone: null,
      location: null,
      summary: null,
      skills: ["Kubernetes"],
      experience: [
        {
          company: "Acme",
          title: "Recovered Architect",
          description: "Cut p99 latency 42%.",
        },
      ],
      education: [],
    }),
}));

import { Result } from "./Result.tsx";
import {
  useEditableParse,
  type EditableParse,
} from "../hooks/useEditableParse.ts";
import { useLlmRecovery } from "../hooks/useLlmRecovery.ts";
import {
  useAutosaveResume,
  type SavableResumeLibrary,
} from "../hooks/useAutosaveResume.ts";
import { computeAnonymousAtsScore } from "../lib/score/score.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Module-scope so the autosave hook's dep lists see a stable library and its
 *  debounce is not restarted by this host re-rendering. */
const SAVE_STUB: SavableResumeLibrary = { save: async () => "record-1" };

// A real parsed upload (tiers non-empty) whose contact section is missing BOTH
// email and phone — exactly the case that regressed. Experience is present so
// there is something to score, but the critical-contact bar is not cleared, so
// the old shared `isScoreRevealed` gate would have hidden the ring here.
function uploadResultMissingContact(): CascadeResult {
  return {
    canonical: {
      fields: {
        full_name: "",
        email: "",
        phone: "",
        skills: ["TypeScript", "React"],
        experience: [
          {
            title: "Senior Engineer",
            company: "Acme",
            start_date: "2020",
            end_date: "2022",
            description: "Shipped 3 products increasing revenue by 40%.",
          },
        ],
        education: [],
      },
      sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
      fieldConfidence: {},
    },
    confidence: 0.6,
    triggers: [],
    suggestedEscalation: "none",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "Senior Engineer at Acme. Shipped 3 products increasing revenue by 40%.",
    markdown: "",
    linkAnnotations: [],
    diagnostics: { rawCharCount: 100, extractedCharCount: 80, pages: 1, elapsedMs: 10 },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  } as unknown as CascadeResult;
}

let container: HTMLDivElement;
let root: Root;

function Host({ result }: { result: CascadeResult }) {
  const edit = useEditableParse();
  const score = computeAnonymousAtsScore({
    parsed: result.canonical.fields,
    fieldConfidence: result.canonical.fieldConfidence,
    triggers: result.triggers,
    rawText: result.rawText,
    // Minimal SectionedResume — the accomplishment pool is empty so the scorer
    // falls back to pooling the parsed experience descriptions (which is what we
    // want to score here).
    sections: { accomplishmentSections: [], byName: new Map(), source: "regex" },
  });
  // The real hook `App` calls, so this host builds the same `recovery` the app
  // does rather than a hand-shaped stand-in. `result` doubles as the
  // pristine-parse identity — this host renders one résumé and never replaces
  // it, so a constant is faithful.
  const recovery = useLlmRecovery(result, score, result);
  // Likewise the real autosave hook (#824), over a library that accepts writes
  // and forgets them. Nothing here edits, so it never writes — what it supplies
  // is the header's save state, which `ParsedHeader` now renders.
  const autosave = useAutosaveResume({
    library: SAVE_STUB,
    parseKey: result,
    hasEdits: edit.hasEdits,
    resume:
      recovery === null
        ? null
        : {
            filename: "cv.pdf",
            sourceKind: "pdf",
            result: recovery.activeResult,
            score: recovery.activeScore,
          },
  });
  if (recovery === null) throw new Error("recovery is non-null for a real parse");
  return createElement(Result, {
    result,
    parseKey: result,
    sourceKind: "pdf" as const,
    onReset: () => {},
    edit,
    recovery,
    autosave,
  });
}

async function render(result: CascadeResult) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(Host, { result }));
  });
  // The on-device capability probe resolves asynchronously; settling it here
  // keeps every assertion below outside a pending state update.
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("Result score-reveal gate — issue 313 upload lane", () => {
  it("shows the score on the upload path even when email AND phone are missing", async () => {
    const el = await render(uploadResultMissingContact());
    // The score readout is present…
    expect(el.textContent).toContain("Your resume score");
    // …and the blank-authoring placeholder is NOT shown on the upload path.
    expect(el.textContent).not.toContain(
      "Your score will appear once your contact info",
    );
  });
});

describe("Result — exactly one export surface (#823)", () => {
  it("offers no download control anywhere below the score card", async () => {
    // The AC is that `/` has ONE way out with an artifact: the `ExportDialog`
    // the journey rail's Download stage opens, mounted at page level. Three
    // buttons used to sit in a row above the résumé — "Download report",
    // "Download as Markdown", "Download resume" — and a second one reappearing
    // anywhere in this tree is #680 items 5 and 7 coming straight back, with
    // nothing failing to say so.
    const el = await render(uploadResultMissingContact());
    // "Download" plus one of the three artifact names. The model-weights CTA in
    // the on-device status line ("Download · ~1.9 GB") is deliberately outside
    // this — it fetches the model, not something the user leaves with.
    const artifact = /\b(pdf|markdown|report|r[ée]sum[ée]|cv\.md)\b/i;
    const downloads = [...el.querySelectorAll("button")]
      .map((b) => b.textContent ?? "")
      .filter((label) => /\bdownload\b/i.test(label) && artifact.test(label));
    expect(downloads).toEqual([]);
  });
});

// ── The recovery confirmation survives the next keystroke (#823) ─────────────

/** A degenerate parse — the state that offers the on-device recovery pass. */
function degenerateResult(): CascadeResult {
  const base = uploadResultMissingContact() as unknown as Record<string, unknown>;
  return {
    ...base,
    suggestedEscalation: "llm",
    rawText: "Dana Fixture. Some text a model can still read.",
    markdown: "Dana Fixture. Some text a model can still read.",
  } as unknown as CascadeResult;
}

/**
 * A host that mimics `useAnalyzedResume` where it matters here: `displayResult`
 * is a MEMO over the override maps, so a single keystroke mints a fresh
 * `CascadeResult` for the same parse. A host that passed the constant `result`
 * straight through could not reproduce the defect at all — the reset it keys on
 * would simply never fire.
 */
async function renderCapturingEdit(
  parse: CascadeResult,
  sink: { current: EditableParse | null },
): Promise<HTMLElement> {
  function EditHost() {
    const edit = useEditableParse();
    sink.current = edit;
    const displayResult = useMemo(
      () => ({
        ...parse,
        canonical: {
          ...parse.canonical,
          fields: {
            ...parse.canonical.fields,
            full_name:
              edit.contactOverrides.full_name ?? parse.canonical.fields.full_name,
          },
        },
      }),
      [edit.contactOverrides],
    ) as CascadeResult;
    const score = computeAnonymousAtsScore({
      parsed: displayResult.canonical.fields,
      fieldConfidence: displayResult.canonical.fieldConfidence,
      triggers: displayResult.triggers,
      rawText: displayResult.rawText,
      sections: { accomplishmentSections: [], byName: new Map(), source: "regex" },
    });
    const recovery = useLlmRecovery(displayResult, score, parse);
    const autosave = useAutosaveResume({
      library: SAVE_STUB,
      parseKey: parse,
      hasEdits: edit.hasEdits,
      resume:
        recovery === null
          ? null
          : {
              filename: "cv.pdf",
              sourceKind: "pdf",
              result: recovery.activeResult,
              score: recovery.activeScore,
            },
    });
    if (recovery === null) throw new Error("recovery is non-null for a real parse");
    return createElement(Result, {
      result: displayResult,
      parseKey: parse,
      sourceKind: "pdf" as const,
      onReset: () => {},
      edit,
      recovery,
      autosave,
    });
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(EditHost));
  });
  // Let the async WebGPU capability probe settle, so the offer is advertised.
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

// ── The recovery offer and the critique, in the score card (#955) ───────────

/**
 * These three blocks moved from `ResultDetail.test.tsx`, where they covered the
 * same two surfaces before #955 folded them into the score card's details
 * region. They are stronger here: over there the escape hatch and the analysis
 * were hand-shaped controller objects, so the `done` transition was a prop
 * swap; here the real `useLlmEscapeHatch`/`useResumeAnalysisLlm` run against
 * the stubbed WebLLM modules at the top of this file, and the transition is
 * what clicking the real CTA produces.
 */
describe("Result — the degenerate-parse recovery offer (#243, moved by #955)", () => {
  it("is inline in the score card, above the résumé, behind no disclosure", async () => {
    // #243 gave the offer the on-device-AI tab's LABEL so it had a permanent
    // slot. Behind a collapsed section that slot stops existing, and the one
    // affordance that repairs a degenerate parse becomes invisible on the
    // parses that need it.
    const el = await render(degenerateResult());
    expect(el.textContent).toContain("Not everything parsed cleanly");

    const offer = [...el.querySelectorAll("h2")].find((n) =>
      (n.textContent ?? "").includes("Not everything parsed cleanly"),
    );
    expect(offer).toBeDefined();
    // Not inside any `<details>` — the score details region is a plain
    // `hidden`-toggled div, not a disclosure.
    expect(offer!.closest("details")).toBeNull();

    // ABOVE the résumé, not merely present: a card below a 1000-line résumé is
    // as good as behind a collapsed section.
    const resume = el.querySelector("#reconstructed-resume");
    expect(resume).not.toBeNull();
    expect(
      offer!.compareDocumentPosition(resume!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // One offer at a time — the critique's own model-loading CTA must not sit
    // beside the recovery pass's.
    expect(el.textContent).not.toContain("Local AI feedback");
    expect(el.textContent).not.toContain("What the model checks");
  });

  it("is not REMOUNTED as the pass completes, and hands the critique back", async () => {
    // The hatch stays `isAvailable` after a successful pass (it is keyed on
    // the ORIGINAL result so it can be re-run), so the panel's gate is
    // `isAvailable` ALONE. Gate it on the offer standing instead and the panel
    // unmounts in the very render that fires `onRecovered`, and the recovered
    // parse never reaches the score above it. The behavioural guard is the
    // panel's confirmation text below: an unmounted panel never renders it.
    // Its TAIL, because `ParsedHeader`'s provenance badge carries the
    // "Recovered with on-device AI" prefix too. The test below this one pins
    // the same invariant by DOM identity instead of text.
    const el = await render(degenerateResult());

    const cta = [...el.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Try a local AI pass"),
    );
    expect(cta).toBeDefined();
    await act(async () => cta!.click());

    // Collapsed to its one-line confirmation, still on screen…
    expect(el.textContent).toContain("your score and fields are updated");
    expect(el.textContent).not.toContain("Not everything parsed cleanly");
    // …and the section it was withholding is back. The PANEL's own heading,
    // not the summary label — those were the same string until the heading was
    // renamed, so a label assertion never proved the panel mounted.
    expect(el.textContent).toContain("What the model checks");
  });

  it("keeps the escape-hatch wrapper's element type stable across done (#687)", async () => {
    // #687: the previous test's confirmation-text guard cannot tell a panel
    // that stays mounted through `done` from one unmounted and remounted at
    // `done` — a fresh instance renders the same confirmation text on its
    // first (and only) render too. This test instead captures the DOM node of
    // `LlmEscapeHatchPanel`'s OWN `<div className="contents">` wrapper (#687),
    // which is unconditionally the same element across every branch inside the
    // panel — the panel's inner root swaps element type at `done` (`section` →
    // `div[role=status]`), so this is the shallowest node whose identity is
    // meaningful to compare. `Result`'s own `border-b` wrapper one level above
    // it is NOT meaningful here: it is gated on `escapeHatch.isAvailable`
    // alone, which does not flip at `done` either, so it stays put even if the
    // panel instance below it remounts. A regression that re-adds a
    // `status.kind !== "done"` mount gate would remove this wrapper (and the
    // panel inside it) the moment `done` is reached, so `confirmationAfter`
    // would be undefined and the `toBeDefined` below would already fail; a
    // regression that keys the panel on `status.kind` instead would replace
    // this wrapper with a fresh instance, which the `toBe` below catches.
    const el = await render(degenerateResult());

    const headingBefore = [...el.querySelectorAll("h2")].find((n) =>
      (n.textContent ?? "").includes("Not everything parsed cleanly"),
    );
    expect(headingBefore).toBeDefined();
    // heading -> …-> `contents` div (panel's own stable wrapper, #687).
    const wrapperBefore = headingBefore!.closest(".contents");
    expect(wrapperBefore).not.toBeNull();

    const cta = [...el.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Try a local AI pass"),
    );
    expect(cta).toBeDefined();
    await act(async () => cta!.click());

    const confirmationAfter = [...el.querySelectorAll("p")].find((n) =>
      (n.textContent ?? "").includes("your score and fields are updated"),
    );
    expect(confirmationAfter).toBeDefined();
    const wrapperAfter = confirmationAfter!.closest(".contents");

    expect(wrapperAfter).toBe(wrapperBefore);
  });
});

describe("Result — Local AI feedback when WebGPU cannot run (#276, moved by #955)", () => {
  afterEach(() => {
    webgpu.capability = "available";
  });

  it("warn-marks the summary and explains in place instead of vanishing", async () => {
    webgpu.capability = "no-webgpu";
    // `degenerateResult`, for its non-empty `markdown` alone: `hasText` reads
    // `markdown ?? rawText`, and `uploadResultMissingContact` carries an empty
    // string there — not nullish, so it wins the coalesce and the section is
    // absent for "no text" rather than for the capability under test. With no
    // WebGPU the recovery offer is unavailable too, so nothing withholds the
    // critique and this is the unavailable branch on its own.
    const el = await render(degenerateResult());
    const summary = [...el.querySelectorAll("summary")].find((n) =>
      (n.textContent ?? "").includes("Local AI feedback"),
    );
    // Warn marker is announced, not colour-only.
    expect(summary?.textContent).toContain("setup needed");
    // The panel explains the unavailability in place.
    expect(el.textContent).toContain("On-device AI isn't available");
  });
});

describe("Result — a completed recovery pass survives an edit (#823)", () => {
  it("keeps the confirmation and the Local AI feedback section after a keystroke", async () => {
    // Under the old tab rail, resetting the escape hatch on a new `result`
    // identity only relabelled a tab. Under #823's inline layout the same reset
    // is a settled confirmation reverting to a "Try a local AI pass" CTA AND the
    // whole "Local AI feedback" section vanishing (`ResultDetail` withholds the
    // quality panel while an offer stands) — while `ParsedHeader` still shows
    // the "Recovered with on-device AI" badge, because that is keyed on
    // `parseKey`. `result` here is `displayResult`, re-memoized on every
    // keystroke, so this fired on the first character the user typed.
    const editSink: { current: EditableParse | null } = { current: null };
    const el = await renderCapturingEdit(degenerateResult(), editSink);

    expect(el.textContent).toContain("Not everything parsed cleanly");
    const cta = [...el.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Try a local AI pass"),
    );
    expect(cta).toBeDefined();
    await act(async () => cta!.click());

    expect(el.textContent).toContain("Recovered with on-device AI");
    expect(el.textContent).toContain("Local AI feedback");

    // One keystroke in the inline editor — a real override, which is what mints
    // a fresh `displayResult` in the app.
    act(() => editSink.current!.setContactField("full_name", "Dana Fixture"));

    expect(el.textContent).toContain("Recovered with on-device AI");
    expect(el.textContent).toContain("Local AI feedback");
    expect(el.textContent).not.toContain("Not everything parsed cleanly");
  });
});

// ── Skills-ordering placement (#544, moved here by #955) ──────────────────

/**
 * The heuristic skills-ordering finding must reach the user WITHOUT the
 * on-device model. It first shipped inside `CritiqueResults`, which mounts only
 * under `status.kind === "done"` — so on a browser with no WebGPU the "Local AI
 * feedback" disclosure is absent entirely and the finding was computed on every
 * render and then thrown away.
 *
 * These lived in `ResultDetail.test.tsx` until #955 moved `TargetingSection`,
 * and the single `useSkillsReorder` instance behind it, into the score card.
 * There they asserted a PROP reached a mocked `ReconstructedResume`; here the
 * whole tree is real, so what is asserted is the row's own copy — the thing
 * the user can actually read.
 */

/** Buried-skill résumé: "Engineering Leadership" is the top-scoring skill
 *  against the title and sits outside the front window (skills-order.ts). */
function buriedSkillsResult(): CascadeResult {
  const base = uploadResultMissingContact() as unknown as {
    canonical: { fields: Record<string, unknown> };
  };
  return {
    ...(base as unknown as CascadeResult),
    canonical: {
      ...base.canonical,
      fields: {
        ...base.canonical.fields,
        skills: [
          "Docker",
          "AWS",
          "Kubernetes",
          "Engineering Leadership",
          "Terraform",
        ],
        experience: [{ title: "Engineering Manager", company: "Acme" }],
      },
    },
  } as unknown as CascadeResult;
}

/** The coaching row's own sentence (`SkillsOrderFinding.tsx`) — not a testid,
 *  so a row that renders with the wrong skill named fails. */
const ORDERING_COPY =
  '"Engineering Leadership" looks highly relevant to your target role';

describe("Result — skills-ordering placement (#544)", () => {
  afterEach(() => {
    webgpu.capability = "available";
  });

  it("shows the finding on a browser with no WebGPU", async () => {
    webgpu.capability = "no-webgpu";
    const el = await render(buriedSkillsResult());
    // The precondition that made this a real defect: with no WebGPU the
    // "Local AI feedback" section is absent entirely, so a row hosted inside
    // it would have been unreachable on this exact render.
    expect(el.textContent).not.toContain("Local AI feedback");
    expect(el.textContent).toContain(ORDERING_COPY);
  });

  it("shows it on a WebGPU browser too — one mount, not two", async () => {
    const el = await render(buriedSkillsResult());
    expect(el.textContent).toContain(ORDERING_COPY);
    // One instance, not two: `SkillsReorderController` is shared state, so a
    // second mounted row would flip into the confirmation strip on one Apply.
    const occurrences = (el.textContent ?? "").split(ORDERING_COPY).length - 1;
    expect(occurrences).toBe(1);
  });

  it("says nothing for a résumé with nothing buried", async () => {
    const el = await render(uploadResultMissingContact());
    expect(el.textContent).not.toContain("looks highly relevant");
  });
});

// ── Targeting disclosure chrome — this mount is inside a bordered Card (#1013) ──

describe("Result — targeting disclosure rides the score card's own border (#1013)", () => {
  it("mounts the targeting disclosure on the borderless \"plain\" variant", async () => {
    // `Result` mounts `ResumeTargeting` inside `ScoreDetails`, which sits
    // inside the score card's own bordered `Card` — a second, nested border
    // here would read as boxes-inside-a-box. `AuthoringResume`'s equivalent
    // mount (see `AuthoringResume.test.tsx` #1013) has no such ancestor and
    // keeps the default "card" variant instead.
    const el = await render(uploadResultMissingContact());
    const summary = [...el.querySelectorAll("summary")].find((n) =>
      (n.textContent ?? "").includes("Targeting"),
    );
    expect(summary).toBeDefined();
    const details = summary!.closest("details");
    expect(details?.className).not.toContain("rounded-xl");
    expect(details?.className).toContain("border-b");
  });
});
