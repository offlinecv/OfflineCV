// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render coverage for ResultDetailTabs (#275, consolidated in #273) — the
 * tabbed detail card extracted out of ParsedCard. Renders both visibility
 * regimes so every conditional tab / panel branch executes: (1) analysis
 * unavailable → only reconstructed + diagnostics tabs; (2) analysis available →
 * the single "Resume Quality" insight tab mounts (2nd position). A tiny host
 * component supplies a real EditableParse via useEditableParse. Raw createRoot,
 * matching the other feature render tests.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
// The jdContext tests observe the value through a stubbed `ReconstructedResume`
// that renders the prop. Asserting on sessionStorage instead would be vacuous:
// nothing writes the key back after the mount consume, so those assertions hold
// even with the reset guard deleted. The probe is what makes "the steering
// actually reached the rewrite path" observable (#576).
vi.mock("./ReconstructedResume.tsx", () => ({
  ReconstructedResume: (props: { jdContext?: string }) =>
    createElement(
      "div",
      { "data-testid": "reconstructed-probe" },
      `jdContext=${props.jdContext ?? "NULL"}`,
    ),
}));

import { ResultDetailTabs } from "./ResultDetailTabs.tsx";
import { useEditableParse } from "../../hooks/useEditableParse.ts";
import {
  writeTailorHandoff,
  fingerprintParse,
  TAILOR_HANDOFF_KEY,
} from "../../lib/tailor-handoff.ts";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { AnalysisController } from "../../hooks/useResumeAnalysisLlm.ts";
import type { EscapeHatchController } from "../../hooks/useLlmEscapeHatch.ts";
import type { WebGpuCapability } from "../../lib/webllm/types.ts";
import type { ResumeCritique } from "../../lib/webllm/critique-resume.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const EMPTY_CRITIQUE: ResumeCritique = { bulletFindings: [], missingSections: [] };

function result(summary?: string, title?: string): CascadeResult {
  return {
    canonical: {
      fields: {
        skills: [],
        experience: title ? [{ title }] : [],
        education: [],
        ...(summary ? { summary } : {}),
      },
      sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
      fieldConfidence: {},
    },
    confidence: 0.6,
    triggers: ["two_column"],
    suggestedEscalation: "none",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "RAWTEXT_MARKER",
    markdown: "RAWTEXT_MARKER",
    linkAnnotations: [],
    diagnostics: { rawCharCount: 100, extractedCharCount: 50, pages: 1, elapsedMs: 10 },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  } as unknown as CascadeResult;
}

const score = { overall: 60, verdict: "Getting There" } as unknown as AnonymousAtsScore;

/** The stamp `/jobs/` would have written for a handoff aimed at this parse. */
function fingerprintOf(res: CascadeResult): string {
  return fingerprintParse(res.canonical.fields);
}

/** Stand-in for the `{ parseKey, llmOverride }` token `Result.tsx` builds. A
 *  fresh object per call, so a test that wants "the parse was replaced" just
 *  calls it again — and one that wants "the user edited" reuses the same one. */
function parseIdentity(): object {
  return {};
}

interface ControllerOpts {
  isAvailable: boolean;
  capability?: WebGpuCapability | null;
  hasText?: boolean;
  /** Degenerate-parse recovery offer (#243) — folded into this tab. */
  escapeHatch?: "offered" | "recovered";
}

function escapeHatchController(
  opts: ControllerOpts,
): EscapeHatchController {
  return {
    status:
      opts.escapeHatch === "recovered"
        ? { kind: "done", llmParsed: {} }
        : { kind: "idle" },
    isAvailable: opts.escapeHatch !== undefined,
    isBusy: false,
    run: () => Promise.resolve(),
  } as unknown as EscapeHatchController;
}

function controller(opts: ControllerOpts): AnalysisController {
  return {
    status: { kind: "done", disagreements: [], critique: EMPTY_CRITIQUE },
    isAvailable: opts.isAvailable,
    // Default to the coherent pairing (available ⇒ has GPU + text) unless a
    // test overrides to exercise the unavailable-with-notice branch.
    capability: opts.capability ?? (opts.isAvailable ? "available" : null),
    hasText: opts.hasText ?? opts.isAvailable,
    isBusy: false,
    run: () => Promise.resolve(),
  } as unknown as AnalysisController;
}

let container: HTMLDivElement;
let root: Root;

const HOST_IDENTITY = parseIdentity();

function Host({ opts, summary }: { opts: ControllerOpts; summary?: string }) {
  const edit = useEditableParse();
  const res = result(summary);
  return createElement(ResultDetailTabs, {
    activeResult: res,
    parseIdentity: HOST_IDENTITY,
    activeScore: score,
    result: res,
    sourceKind: "pdf",
    edit,
    analysis: controller(opts),
    escapeHatch: escapeHatchController(opts),
    onRecovered: () => {},
    triggerCount: res.triggers.length,
  });
}

function render(opts: ControllerOpts, summary?: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(Host, { opts, summary }));
  });
  return container;
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("ResultDetailTabs", () => {
  it("hides the on-device-AI tab while capability is still detecting / no text", () => {
    const el = render({ isAvailable: false });
    expect(el.textContent).toContain("Your resume");
    expect(el.textContent).toContain("Find jobs");
    expect(el.textContent).toContain("Raw text & flags");
    expect(el.textContent).not.toContain("Local AI feedback");
  });

  it("mounts the single on-device-AI tab (3rd position) when analysis is available", () => {
    const el = render(
      { isAvailable: true },
      "Senior engineer with a track record of shipping.",
    );
    const labels = Array.from(el.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? "",
    );
    // Exactly four tabs: reconstructed, Find jobs (#318, always present),
    // "Local AI feedback", diagnostics last.
    expect(labels).toHaveLength(4);
    expect(labels[0]).toContain("Your resume");
    expect(labels[1]).toContain("Find jobs");
    expect(labels[2]).toContain("Local AI feedback");
    expect(labels[3]).toContain("Raw text & flags");
    // No recovery offer, so no warn mark on this tab.
    expect(labels[2]).not.toContain("parse needs attention");
  });

  it("turns the on-device-AI tab into the recovery offer when the escape hatch is available", () => {
    // The banner used to render above the score card; the tab label is now the
    // whole pre-click signal, so it has to carry both the offer and the warning
    // (and the warning has to say what it means, not "setup needed").
    const el = render(
      { isAvailable: true, escapeHatch: "offered" },
      "Senior engineer with a track record of shipping.",
    );
    const qualityTab = Array.from(el.querySelectorAll('[role="tab"]')).find((t) =>
      (t.textContent ?? "").includes("local AI pass"),
    );
    expect(qualityTab).toBeDefined();
    expect(qualityTab?.textContent).toContain("didn't parse cleanly");
    expect(qualityTab?.textContent).toContain("parse needs attention");
    expect(qualityTab?.textContent).not.toContain("setup needed");
    // The offer owns the tab body alone — the quality panel's own CTA must not
    // sit under it, or the tab carries two model-loading CTAs at once.
    expect(el.textContent).toContain("Not everything parsed cleanly");
    expect(el.textContent).not.toContain("Analyze with on-device model");
  });

  it("drops the recovery label once the pass has run, keeping the banner", () => {
    // The hatch stays `isAvailable` after a successful pass (it is keyed on the
    // ORIGINAL result so it can be re-run), so without the status gate the tab
    // would keep inviting a pass the user already took.
    const el = render(
      { isAvailable: true, escapeHatch: "recovered" },
      "Senior engineer with a track record of shipping.",
    );
    const labels = Array.from(el.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? "",
    );
    expect(labels[2]).toContain("Local AI feedback");
    expect(labels[2]).not.toContain("local AI pass");
    expect(labels[2]).not.toContain("parse needs attention");
    // Collapsed confirmation + the quality panel it handed the tab back to.
    // Assert the PANEL's own heading, not the tab label: those were the same
    // string until the heading was renamed, so this line passed off `labels[2]`
    // above and never proved the panel had mounted at all.
    expect(el.textContent).toContain("Recovered with on-device AI");
    expect(el.textContent).toContain("What the model checks");
  });

  it("reseeds the Find jobs query when the LLM escape hatch swaps activeResult (keyed remount)", () => {
    // Original heuristic parse and a distinct recovered parse — same `result`
    // (the pre-LLM cascade), different `activeResult` once recovery lands. The
    // Find jobs panel seeds its query once from the parse; without the parse-
    // identity key it would keep the heuristic title while runSearch ranks the
    // recovered parse (PR #337 review). Keyed remount reseeds it.
    const heuristic = result(undefined, "Heuristic Engineer");
    const recovered = result(undefined, "Recovered Architect");
    const opts: ControllerOpts = { isAvailable: false };

    const before = parseIdentity();
    const after = parseIdentity();

    function RecoveryHost({ recover }: { recover: boolean }) {
      const edit = useEditableParse();
      return createElement(ResultDetailTabs, {
        activeResult: recover ? recovered : heuristic,
        parseIdentity: recover ? after : before,
        activeScore: score,
        result: heuristic,
        sourceKind: "pdf",
        edit,
        analysis: controller(opts),
        escapeHatch: escapeHatchController(opts),
        onRecovered: () => {},
        triggerCount: heuristic.triggers.length,
      });
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(RecoveryHost, { recover: false }));
    });
    expect(container.textContent).toContain("Heuristic Engineer");

    // Escape hatch recovers a better parse: activeResult now !== result.
    act(() => {
      root.render(createElement(RecoveryHost, { recover: true }));
    });
    expect(container.textContent).toContain("Recovered Architect");
    expect(container.textContent).not.toContain("Heuristic Engineer");
  });

  it("keeps the on-device-AI tab (warn-marked) with the notice when WebGPU is unavailable", () => {
    const el = render(
      { isAvailable: false, capability: "no-webgpu", hasText: true },
      "Senior engineer with a track record of shipping.",
    );
    const qualityTab = Array.from(el.querySelectorAll('[role="tab"]')).find((t) =>
      (t.textContent ?? "").includes("Local AI feedback"),
    );
    expect(qualityTab).toBeDefined();
    // Warn marker is announced, not colour-only.
    expect(qualityTab?.textContent).toContain("setup needed");
    // The panel explains the unavailability in place instead of vanishing.
    expect(el.textContent).toContain("On-device AI isn't available");
  });

  it("consumes a tailor handoff on mount and lands on the Reconstructed tab (#576)", () => {
    // The round-trip claim: `/jobs/`'s tailor button stashes an instruction in
    // sessionStorage and navigates here; `ResultDetailTabs` must (1) pick that
    // instruction up on mount, (2) forward the instruction to
    // `ReconstructedResume` (where the rewrite hook consumes it), (3) switch
    // to the Reconstructed tab so the rewrite affordance is on screen, and
    // (4) clear the key so a manual reload of `/` falls back to a generic
    // rewrite prompt.
    writeTailorHandoff({
      jdContext: "prefer wording that surfaces Kubernetes",
      parseFingerprint: fingerprintOf(result()),
    });
    const el = render({ isAvailable: false });
    // Consumed: the read cleared the key.
    expect(sessionStorage.getItem(TAILOR_HANDOFF_KEY)).toBeNull();
    // Landed on Reconstructed — the tab strip announces the selection via
    // `aria-selected`, so the assertion is on that rather than on textContent
    // (which lists every tab label regardless of which panel is showing).
    const selected = el.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toContain("Your resume");
    // The load-bearing observable: the value the handoff carried actually
    // reaches `ReconstructedResume`'s `jdContext` prop, so the rewrite is
    // steered — not just consumed off storage.
    const probe = el.querySelector('[data-testid="reconstructed-probe"]');
    expect(probe?.textContent).toBe(
      "jdContext=prefer wording that surfaces Kubernetes",
    );
  });

  it("keeps jdContext on mount and nulls it when the parse identity changes (#576)", () => {
    // Two invariants in one test, both observable through the mocked
    // `ReconstructedResume` probe:
    //
    //  (a) On mount with a handoff waiting, jdContext reaches the probe. A
    //      mounted-flag guard on the reset effect fails this under React
    //      StrictMode — the reset effect's second setup runs with the ref
    //      already `true` and nulls out the value the handoff effect just set.
    //  (b) A subsequent change of `parseIdentity` (the LLM escape hatch
    //      recovering, a résumé loaded from the library) MUST clear jdContext:
    //      a tailoring instruction derived from one parse must not survive
    //      into another.
    const heuristic = result(undefined, "Heuristic Engineer");
    const recovered = result(undefined, "Recovered Architect");
    writeTailorHandoff({
      jdContext: "surface Kubernetes",
      parseFingerprint: fingerprintOf(heuristic),
    });
    const opts: ControllerOpts = { isAvailable: false };
    const before = parseIdentity();
    const after = parseIdentity();

    function SwapHost({ recover }: { recover: boolean }) {
      const edit = useEditableParse();
      return createElement(ResultDetailTabs, {
        activeResult: recover ? recovered : heuristic,
        parseIdentity: recover ? after : before,
        activeScore: score,
        result: heuristic,
        sourceKind: "pdf",
        edit,
        analysis: controller(opts),
        escapeHatch: escapeHatchController(opts),
        onRecovered: () => {},
        triggerCount: heuristic.triggers.length,
      });
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(SwapHost, { recover: false }));
    });
    // Invariant (a): mount consumed the handoff AND the value survived the
    // reset effect's first fire (which is what would have gone red under
    // the mounted-flag guard, since refs persist across StrictMode replay).
    let probe = container.querySelector('[data-testid="reconstructed-probe"]');
    expect(probe?.textContent).toBe("jdContext=surface Kubernetes");

    // Invariant (b): the parse is replaced — mirrors what the LLM escape
    // hatch does. jdContext must reset to null.
    act(() => {
      root.render(createElement(SwapHost, { recover: true }));
    });
    probe = container.querySelector('[data-testid="reconstructed-probe"]');
    expect(probe?.textContent).toBe("jdContext=NULL");
  });

  it("keeps jdContext when an edit mints a new activeResult for the SAME parse (#576)", () => {
    // The counterpart to the test above, and the reason the reset is keyed on
    // `parseIdentity` rather than on `activeResult`. On `/`, `activeResult` is
    // a memo over the edit override maps (`useAnalyzedResume`'s
    // `displayResult`), so every keystroke in the inline editor produces a
    // structurally-equal object with a fresh identity. Keyed on that, the
    // reset fires on the first character the user types and the steering they
    // came back from `/jobs/` to apply is silently gone — the whole feature
    // dead the moment it is used as intended.
    //
    // Mirror what `displayResult` actually produces: a new result object AND a
    // new `canonical`/`fields` underneath it, structurally equal because this
    // edit changed nothing observable. A bare `{ ...base }` would not do — it
    // shares `canonical` by reference, so it would pass even for an
    // implementation keyed on the fields object.
    const base = result(undefined, "Platform Engineer");
    const editedCopy = {
      ...base,
      canonical: { ...base.canonical, fields: { ...base.canonical.fields } },
    };
    expect(editedCopy.canonical.fields).not.toBe(base.canonical.fields);
    writeTailorHandoff({
      jdContext: "surface Kubernetes",
      parseFingerprint: fingerprintOf(base),
    });
    const opts: ControllerOpts = { isAvailable: false };
    const sameParse = parseIdentity();

    function EditHost({ edited }: { edited: boolean }) {
      const edit = useEditableParse();
      return createElement(ResultDetailTabs, {
        // Same parse identity on both renders — only the memo output changed.
        activeResult: edited ? editedCopy : base,
        parseIdentity: sameParse,
        activeScore: score,
        result: base,
        sourceKind: "pdf",
        edit,
        analysis: controller(opts),
        escapeHatch: escapeHatchController(opts),
        onRecovered: () => {},
        triggerCount: base.triggers.length,
      });
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(EditHost, { edited: false }));
    });
    let probe = container.querySelector('[data-testid="reconstructed-probe"]');
    expect(probe?.textContent).toBe("jdContext=surface Kubernetes");

    act(() => {
      root.render(createElement(EditHost, { edited: true }));
    });
    probe = container.querySelector('[data-testid="reconstructed-probe"]');
    expect(probe?.textContent).toBe("jdContext=surface Kubernetes");
  });

  it("ignores a handoff stamped for a different résumé (#576)", () => {
    // One-shot bounds how many times a payload is read, not which résumé
    // reads it. When `/` is not restored from bfcache — tab reloaded, résumé
    // reset — the next `ResultDetailTabs` to mount is a DIFFERENT parse, and
    // it would consume the key exactly once against the wrong résumé, steering
    // the rewrite toward gaps computed from a file the user already replaced.
    const other = result(undefined, "Somebody Else's Résumé");
    writeTailorHandoff({
      jdContext: "surface Kubernetes",
      parseFingerprint: fingerprintOf(other),
    });
    const el = render({ isAvailable: false });
    const probe = el.querySelector('[data-testid="reconstructed-probe"]');
    expect(probe?.textContent).toBe("jdContext=NULL");
    // Dropped, not deferred — the payload does not linger for a later mount.
    expect(sessionStorage.getItem(TAILOR_HANDOFF_KEY)).toBeNull();
  });

  it("consumes a handoff written AFTER mount, on the next pageshow (#576, bfcache)", () => {
    // The primary tailor flow returns to `/` via `history.back()`, which is a
    // bfcache RESTORE on every modern browser — no remount, no useEffect
    // re-fire, so a mount-only consume strands the handoff key in
    // sessionStorage until a later unrelated visit picks it up against the
    // wrong résumé (#576). `pageshow` fires on both the initial load and
    // every bfcache restore, so the same handler covers cold mount and warm
    // restore. Simulated here with a
    // plain `Event("pageshow")` — jsdom emits no navigation, so this is
    // the closest signal to the browser's real bfcache event without
    // fabricating a `PageTransitionEvent` the runtime does not construct.
    const el = render({ isAvailable: false });
    // No handoff yet: mount consume ran and found nothing → NULL.
    let probe = el.querySelector('[data-testid="reconstructed-probe"]');
    expect(probe?.textContent).toBe("jdContext=NULL");

    // Now imagine the user clicked "Tailor résumé to this job" over on
    // `/jobs/` — that surface writes the handoff and calls
    // `history.back()`. Simulate the bfcache restore with a pageshow event
    // dispatched on window.
    writeTailorHandoff({
      jdContext: "surface bfcache",
      parseFingerprint: fingerprintOf(result()),
    });
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    probe = el.querySelector('[data-testid="reconstructed-probe"]');
    expect(probe?.textContent).toBe("jdContext=surface bfcache");
    // One-shot: the key was consumed, so a spurious second pageshow does
    // nothing.
    expect(sessionStorage.getItem(TAILOR_HANDOFF_KEY)).toBeNull();
  });

  it("survives StrictMode's simulated remount without nulling jdContext (#576)", () => {
    // `main.tsx` wraps `App` in `<StrictMode>`, and StrictMode replays every
    // effect setup → cleanup → setup within one commit to prove they are
    // idempotent. A boolean mounted-flag guard on the reset effect misfires
    // here: refs persist across the replay, so the second setup finds
    // `mountedRef.current === true` and calls `setJdContext(null)` — the
    // feature is silently dead under `npm run dev`, exactly the class
    // `useArrivedFromRoot`'s docblock warns about. The identity-keyed shape
    // returns early on the replay because the identity has not changed.
    writeTailorHandoff({
      jdContext: "surface Rust",
      parseFingerprint: fingerprintOf(result()),
    });
    const opts: ControllerOpts = { isAvailable: false };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(Host, { opts }),
        ),
      );
    });
    const probe = container.querySelector('[data-testid="reconstructed-probe"]');
    expect(probe?.textContent).toBe("jdContext=surface Rust");
  });

  it("stays on the default tab and jdContext-free when no tailor handoff was written", () => {
    // Pre-existing behaviour must survive the handoff addition: an ordinary
    // mount lands on Reconstructed with a null jdContext (generic rewrite).
    const el = render({ isAvailable: false });
    const selected = el.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toContain("Your resume");
    // No side-effect on storage either — the read is one-shot but must not
    // write anything of its own.
    expect(sessionStorage.getItem(TAILOR_HANDOFF_KEY)).toBeNull();
  });
});

// ── The journey rail's two wires (#812) ──────────────────────────────────────

/**
 * `requestedTab` (down) and `onJdContextChange` (up) are the whole of this
 * component's contract with `/`'s L1 rail, and neither is exercised by anything
 * above. Both fail silently: a landing request that stops working leaves the
 * rail's Fix it / Tailor / Download stages as dead clicks, and a steering report
 * that stops arriving leaves the rail marking — or failing to mark — Tailor
 * over a résumé that has no steering.
 */
describe("ResultDetailTabs — the journey rail wires (#812)", () => {
  /** Click the tab whose label contains `label`. */
  function selectTab(el: HTMLElement, label: string) {
    const tab = [...el.querySelectorAll('[role="tab"]')].find((t) =>
      (t.textContent ?? "").includes(label),
    ) as HTMLElement;
    if (!tab) throw new Error(`no tab labelled ${label}`);
    act(() => tab.click());
  }

  function selectedLabel(el: HTMLElement): string {
    return (
      el.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? ""
    );
  }

  /** A host whose `requestedTab` this test drives, exactly as `App` does. */
  function railHost(
    onJdContextChange?: (jdContext: string | null) => void,
  ): (requestedTab?: { id: string; nonce: number }) => void {
    const opts: ControllerOpts = { isAvailable: false };
    const res = result();
    const identity = parseIdentity();
    function RailHost({
      requestedTab,
    }: {
      requestedTab?: { id: string; nonce: number };
    }) {
      const edit = useEditableParse();
      return createElement(ResultDetailTabs, {
        activeResult: res,
        parseIdentity: identity,
        activeScore: score,
        result: res,
        sourceKind: "pdf",
        edit,
        analysis: controller(opts),
        escapeHatch: escapeHatchController(opts),
        onRecovered: () => {},
        triggerCount: res.triggers.length,
        requestedTab,
        onJdContextChange,
      });
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const paint = (requestedTab?: { id: string; nonce: number }) => {
      act(() => {
        root.render(createElement(RailHost, { requestedTab }));
      });
    };
    paint();
    return paint;
  }

  it("honours a REPEAT request for the tab the user is already on", () => {
    // The nonce is the whole point, and this is the assertion that proves it.
    // Key the effect on `[requestedTab?.id]` — the shape a reader reaches for —
    // and the first request below still works, so a test that asked once would
    // pass either way. The second one is where it dies: the id has not changed,
    // the effect does not re-fire, and the rail's Fix it / Tailor / Download
    // stages become dead clicks for the rest of the page's life for any user
    // who ever navigated away from Reconstructed by hand.
    const paint = railHost();
    const el = container;

    selectTab(el, "Raw text & flags");
    expect(selectedLabel(el)).toContain("Raw text & flags");

    paint({ id: "reconstructed", nonce: 1 });
    expect(selectedLabel(el)).toContain("Your resume");

    // Same id, next nonce — a second, identical rail click.
    selectTab(el, "Raw text & flags");
    expect(selectedLabel(el)).toContain("Raw text & flags");
    paint({ id: "reconstructed", nonce: 2 });
    expect(selectedLabel(el)).toContain("Your resume");
  });

  it("reports null on mount, so a stale Tailor mark cannot outlive its résumé", () => {
    const reports = vi.fn();
    railHost(reports);
    expect(reports).toHaveBeenCalledWith(null);
  });

  it("reports the steering it consumed, so the rail can mark Tailor", () => {
    writeTailorHandoff({
      jdContext: "surface Kubernetes",
      parseFingerprint: fingerprintOf(result()),
    });
    const reports = vi.fn();
    railHost(reports);
    // The initial null still goes up first — that ordering is what lets `App`
    // clear a mark from a previous résumé before this one reports its own.
    expect(reports.mock.calls.map((c) => c[0])).toEqual([
      null,
      "surface Kubernetes",
    ]);
  });
});
