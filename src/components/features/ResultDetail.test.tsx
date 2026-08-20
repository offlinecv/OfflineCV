// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render coverage for ResultDetail (#275, consolidated in #273, un-tabbed in
 * #823) — everything on `/` below the score card.
 *
 * Both visibility regimes are rendered so every conditional branch executes:
 * (1) analysis unavailable → the résumé plus the "Raw text & flags" disclosure
 * alone; (2) analysis available → the "Local AI feedback" disclosure as well.
 * A tiny host component supplies a real EditableParse via useEditableParse. Raw
 * createRoot, matching the other feature render tests.
 *
 * What the #823 tests below are actually pinning, beyond "it renders": the
 * disclosures must not unmount their children, and the degenerate-parse
 * recovery offer must be reachable without opening anything. Both are silent
 * failures — a collapsed section that discards its panel state, and a repair
 * affordance invisible on exactly the parses that need it.
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
// The `apply rewrite` trigger is a SIBLING of the probe, not a child: several
// assertions below read the probe's whole `textContent`, so a button inside it
// would append its label to every one of them.
vi.mock("./ReconstructedResume.tsx", async () => {
  // The `Button` primitive, not a raw `<button>`: `src/components/**` is inside
  // the forbid-elements scope, tests included.
  const { Button } = await import("@design-system");
  return {
    ReconstructedResume: (props: {
      jdContext?: string;
      onRewriteApplied?: () => void;
      skillsOrder?: { finding?: { buried: string[] } };
    }) =>
      createElement(
        "div",
        null,
        createElement(
          "div",
          { key: "probe", "data-testid": "reconstructed-probe" },
          `jdContext=${props.jdContext ?? "NULL"}`,
        ),
        // Its own testid, not appended to the probe above: several assertions
        // read that probe's whole `textContent` with `toBe`.
        createElement(
          "div",
          { key: "skills-order", "data-testid": "skills-order-probe" },
          `buried=${props.skillsOrder?.finding?.buried.join(",") ?? "NONE"}`,
        ),
        createElement(
          "div",
          { key: "apply", "data-testid": "apply-rewrite" },
          createElement(
            Button,
            { onClick: () => props.onRewriteApplied?.() },
            "apply rewrite",
          ),
        ),
      ),
  };
});

import { ResultDetail } from "./ResultDetail.tsx";
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

function result(
  summary?: string,
  title?: string,
  skills: string[] = [],
): CascadeResult {
  return {
    canonical: {
      fields: {
        skills,
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

/** Stand-in for the `{ parseKey, llmOverride }` token `useLlmRecovery` builds.
 *  A fresh object per call, so a test that wants "the parse was replaced" just
 *  calls it again — and one that wants "the user edited" reuses the same one. */
function parseIdentity(): object {
  return {};
}

interface ControllerOpts {
  isAvailable: boolean;
  capability?: WebGpuCapability | null;
  hasText?: boolean;
  /** Degenerate-parse recovery offer (#243) — its own card since #823. */
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

function Host({
  opts,
  summary,
  buriedSkills,
}: {
  opts: ControllerOpts;
  summary?: string;
  /** A résumé whose Skills section trips the ordering heuristic (#544). */
  buriedSkills?: { title: string; skills: string[] };
}) {
  const edit = useEditableParse();
  const res = buriedSkills
    ? result(summary, buriedSkills.title, buriedSkills.skills)
    : result(summary);
  return createElement(ResultDetail, {
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

function render(
  opts: ControllerOpts,
  summary?: string,
  buriedSkills?: { title: string; skills: string[] },
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(Host, { opts, summary, buriedSkills }));
  });
  return container;
}

/** Every disclosure summary row, in document order. */
function summaries(el: HTMLElement): string[] {
  return [...el.querySelectorAll("summary")].map((s) => s.textContent ?? "");
}

/** The `<details>` whose summary contains `label`. */
function disclosure(el: HTMLElement, label: string): HTMLDetailsElement {
  const found = [...el.querySelectorAll("details")].find((d) =>
    (d.querySelector("summary")?.textContent ?? "").includes(label),
  );
  if (!found) throw new Error(`no disclosure labelled ${label}`);
  return found;
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("ResultDetail", () => {
  it("omits the on-device-AI section while capability is still detecting / no text", () => {
    const el = render({ isAvailable: false });
    expect(summaries(el)).toEqual(["▸Raw text & flags1"]);
    expect(el.textContent).not.toContain("Local AI feedback");
  });

  it("has no tab rail and no second route to /jobs/ (#823)", () => {
    // The whole point of the change: L1 owns navigation now. A `Find jobs` tab
    // here would be a second door onto the corridor the rail's Match-jobs stage
    // already opens, running the identical `departToJobsAndNavigate`.
    const el = render({ isAvailable: true }, "Senior engineer.");
    expect(el.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(el.querySelectorAll('[role="tablist"]')).toHaveLength(0);
    expect(el.textContent).not.toContain("Find jobs");
    expect(el.textContent).not.toContain("Open job workbench");
  });

  it("renders the résumé unconditionally, with both sections collapsed under it", () => {
    const el = render({ isAvailable: true }, "Senior engineer.");
    // The résumé needs no click to reach — it is the page body.
    expect(el.querySelector('[data-testid="reconstructed-probe"]')).not.toBeNull();
    // Insight before evidence (#263, #273), and both start shut.
    const labels = summaries(el);
    // Exact, not `toContain`: "byte-identical to the tab labels they replace"
    // is the claim, so the assertion has to be able to catch a rename. The
    // leading glyph is the chevron the summary draws itself.
    expect(labels).toEqual(["▸Local AI feedback", "▸Raw text & flags1"]);
    for (const d of el.querySelectorAll("details")) expect(d.open).toBe(false);
    // No recovery offer, so no warn mark anywhere.
    expect(el.textContent).not.toContain("setup needed");
  });

  it("carries the layout-flag count on the collapsed evidence summary", () => {
    // `triggerCount` used to ride the tab's `count` prop. The number has to
    // survive the move, or a two-column warning is invisible until the user
    // opens a section they have no reason to open.
    const el = render({ isAvailable: false });
    const summary = disclosure(el, "Raw text & flags").querySelector("summary");
    expect(summary?.textContent).toContain("1");
    expect(result().triggers).toHaveLength(1);
  });

  it("keeps a disclosure's children MOUNTED across a close/open cycle (#243 guard)", () => {
    // The regression this exists to catch: swap `Disclosure` for anything that
    // renders its body on demand and the panels below the résumé are unmounted
    // whenever they are shut — which discards their state and, for the escape
    // hatch's neighbours, kills effects that report upward. Node IDENTITY, not
    // presence: a remount would produce a different element for the same panel.
    const el = render({ isAvailable: false });
    const details = disclosure(el, "Raw text & flags");
    const before = details.querySelector('[role="group"]');
    expect(before).not.toBeNull();

    // Driven through the summary, not by assigning `details.open`: the
    // property assignment does not notify React, so an `onToggle`-gated rewrite
    // of this component would never re-render and the `act` blocks would be
    // inert — the test would pass against exactly the change it exists to catch.
    const summary = details.querySelector("summary");
    if (!summary) throw new Error("disclosure has no summary row");
    act(() => summary.click());
    expect(details.open).toBe(true);
    act(() => summary.click());
    expect(details.open).toBe(false);

    expect(details.querySelector('[role="group"]')).toBe(before);
  });

  it("shows the degenerate-parse recovery offer inline, without opening anything (#243)", () => {
    // #243 gave the offer the on-device-AI tab's LABEL so it had a permanent
    // slot. Behind a collapsed section that slot stops existing, so the offer
    // is its own card now — above the résumé, always visible.
    const el = render(
      { isAvailable: true, escapeHatch: "offered" },
      "Senior engineer with a track record of shipping.",
    );
    expect(el.textContent).toContain("Not everything parsed cleanly");
    // Not behind a disclosure: only the evidence section is present at all…
    expect(summaries(el)).toEqual(["▸Raw text & flags1"]);
    // …and the offer is not inside the one that IS there.
    expect(
      disclosure(el, "Raw text & flags").textContent,
    ).not.toContain("Not everything parsed cleanly");
    // One offer at a time — the quality panel's own CTA must not sit beside a
    // second model-loading CTA.
    expect(el.textContent).not.toContain("Analyze with on-device model");
    expect(el.textContent).not.toContain("What the model checks");
    // ABOVE the résumé, not merely present: the offer's permanent slot is what
    // #243 bought by giving it the tab's label, and a card below a 1000-line
    // résumé is as good as behind a collapsed section.
    const offer = [...el.querySelectorAll("h2")].find((n) =>
      (n.textContent ?? "").includes("Not everything parsed cleanly"),
    );
    const resume = el.querySelector('[data-testid="reconstructed-probe"]');
    expect(offer).toBeDefined();
    expect(resume).not.toBeNull();
    expect(
      offer!.compareDocumentPosition(resume!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the recovery panel mounted through `done` and hands the section back", () => {
    // The hatch stays `isAvailable` after a successful pass (it is keyed on the
    // ORIGINAL result so it can be re-run). The card must therefore be gated on
    // `isAvailable` ALONE: gating it on the offer standing would unmount the
    // panel in the very render that fires `onRecovered`.
    const el = render(
      { isAvailable: true, escapeHatch: "recovered" },
      "Senior engineer with a track record of shipping.",
    );
    // Collapsed to its one-line confirmation, still on screen.
    expect(el.textContent).toContain("Recovered with on-device AI");
    expect(el.textContent).not.toContain("Not everything parsed cleanly");
    // …and the quality section it was withholding is back. Assert the PANEL's
    // own heading, not the summary label — those were the same string until the
    // heading was renamed, so a label assertion never proved the panel mounted.
    const quality = disclosure(el, "Local AI feedback");
    expect(quality.textContent).toContain("What the model checks");
  });

  it("does not REMOUNT the recovery card as the pass completes", () => {
    // The test above mounts fresh at `recovered`, so it can only see the end
    // state — wrap the card as `<Card key={escapeHatch.status.kind}>` and it
    // stays green while `onRecovered` fires from a brand-new panel instance on
    // every pass. This runs the transition AS a transition, within one mount,
    // and asserts NODE IDENTITY: a remount is a different element.
    const opts = (escapeHatch: "offered" | "recovered"): ControllerOpts => ({
      isAvailable: true,
      escapeHatch,
    });
    function TransitionHost({ done }: { done: boolean }) {
      const edit = useEditableParse();
      const res = result("Senior engineer with a track record of shipping.");
      const o = opts(done ? "recovered" : "offered");
      return createElement(ResultDetail, {
        activeResult: res,
        parseIdentity: HOST_IDENTITY,
        activeScore: score,
        result: res,
        sourceKind: "pdf",
        edit,
        analysis: controller(o),
        escapeHatch: escapeHatchController(o),
        onRecovered: () => {},
        triggerCount: res.triggers.length,
      });
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(TransitionHost, { done: false }));
    });
    // The recovery card is the first child — above the résumé, by design.
    const cardBefore = container.firstElementChild;
    expect(cardBefore?.textContent).toContain("Not everything parsed cleanly");

    act(() => {
      root.render(createElement(TransitionHost, { done: true }));
    });
    expect(container.firstElementChild).toBe(cardBefore);
    expect(cardBefore?.textContent).toContain("Recovered with on-device AI");
  });

  it("warn-marks the on-device-AI summary and explains in place when WebGPU is unavailable", () => {
    const el = render(
      { isAvailable: false, capability: "no-webgpu", hasText: true },
      "Senior engineer with a track record of shipping.",
    );
    const summary = disclosure(el, "Local AI feedback").querySelector("summary");
    // Warn marker is announced, not colour-only.
    expect(summary?.textContent).toContain("setup needed");
    // The panel explains the unavailability in place instead of vanishing.
    expect(el.textContent).toContain("On-device AI isn't available");
  });

  it("consumes a tailor handoff on mount and steers the rewrite (#576)", () => {
    // The round-trip claim: `/jobs/`'s tailor button stashes an instruction in
    // sessionStorage and navigates here; `ResultDetail` must (1) pick that
    // instruction up on mount, (2) forward the instruction to
    // `ReconstructedResume` (where the rewrite hook consumes it), and (3) clear
    // the key so a manual reload of `/` falls back to a generic rewrite prompt.
    // The third half of the old contract — landing on the Reconstructed TAB —
    // is now a scroll to `#reconstructed-resume`, which the mocked résumé does
    // not render, so there is no tab selection left to assert.
    writeTailorHandoff({
      jdContext: "prefer wording that surfaces Kubernetes",
      parseFingerprint: fingerprintOf(result()),
    });
    const el = render({ isAvailable: false });
    // Consumed: the read cleared the key.
    expect(sessionStorage.getItem(TAILOR_HANDOFF_KEY)).toBeNull();
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
      return createElement(ResultDetail, {
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
      return createElement(ResultDetail, {
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
    // reset — the next `ResultDetail` to mount is a DIFFERENT parse, and
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

  it("reports jdContext-free on mount when no tailor handoff was written", () => {
    // Pre-existing behaviour must survive the handoff addition: an ordinary
    // mount renders with a null jdContext (generic rewrite).
    const el = render({ isAvailable: false });
    const probe = el.querySelector('[data-testid="reconstructed-probe"]');
    expect(probe?.textContent).toBe("jdContext=NULL");
    // No side-effect on storage either — the read is one-shot but must not
    // write anything of its own.
    expect(sessionStorage.getItem(TAILOR_HANDOFF_KEY)).toBeNull();
  });
});

// ── The journey rail's one remaining wire (#812) ─────────────────────────────

/**
 * `requestedTab` (down) went with the tab rail in #823 — Fix it and Tailor are
 * plain anchor scrolls now, owned by `App`. `onJdContextChange` (up) survives,
 * and it still fails silently: a steering report that stops arriving leaves the
 * rail marking — or failing to mark — Tailor over a résumé that has no steering.
 */
describe("ResultDetail — the journey rail's steering report (#812)", () => {
  /** A host that reports steering upward, exactly as `App` receives it. */
  function reportingHost(
    onJdContextChange: (jdContext: string | null) => void,
    onTailorApplied?: () => void,
  ) {
    const opts: ControllerOpts = { isAvailable: false };
    const res = result();
    const identity = parseIdentity();
    function RailHost() {
      const edit = useEditableParse();
      return createElement(ResultDetail, {
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
        onJdContextChange,
        onTailorApplied,
      });
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(RailHost));
    });
  }

  it("reports null on mount, so a stale Tailor mark cannot outlive its résumé", () => {
    const reports = vi.fn();
    reportingHost(reports);
    expect(reports).toHaveBeenCalledWith(null);
  });

  it("reports the steering it consumed, so the rail can mark Tailor", () => {
    writeTailorHandoff({
      jdContext: "surface Kubernetes",
      parseFingerprint: fingerprintOf(result()),
    });
    const reports = vi.fn();
    reportingHost(reports);
    // The initial null still goes up first — that ordering is what lets `App`
    // clear a mark from a previous résumé before this one reports its own.
    expect(reports.mock.calls.map((c) => c[0])).toEqual([
      null,
      "surface Kubernetes",
    ]);
  });

  it("reports the Tailor stage DONE only when a JD was steering (#826)", () => {
    // The stage is "a whole-résumé rewrite completed while a JD steered it",
    // and its two halves live in two different places: the applied transition
    // is four levels down in `useResumeRewrite`, the steering is here. This is
    // where they meet, so this is where the gate has to hold.
    writeTailorHandoff({
      jdContext: "surface Kubernetes",
      parseFingerprint: fingerprintOf(result()),
    });
    const applied = vi.fn();
    reportingHost(() => {}, applied);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="apply-rewrite"] button')
        ?.click(),
    );
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it("reports nothing for a rewrite the user ran with no JD behind it", () => {
    // An ordinary rewrite is the `Fix it` stage, not `Tailor` — marking it
    // would claim the user tailored to a posting they never opened.
    const applied = vi.fn();
    reportingHost(() => {}, applied);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="apply-rewrite"] button')
        ?.click(),
    );
    expect(applied).not.toHaveBeenCalled();
  });
});

// ── Skills-ordering placement (#544) ──────────────────────────────────────────

/**
 * The heuristic skills-ordering finding must reach the user WITHOUT the
 * on-device model. It first shipped inside `CritiqueResults`, which mounts only
 * under `status.kind === "done"` — so on a browser with no WebGPU the "Local AI
 * feedback" disclosure is absent entirely and the finding was computed on every
 * render and then thrown away. These pin the wiring that fixed it: the
 * controller travels to `ReconstructedResume` (→ `TargetingSection` →
 * `SkillTermGuidance`), which renders unconditionally.
 *
 * `ReconstructedResume` is mocked at the top of this file, so what is asserted
 * here is the hand-off, not the row's markup — the row itself is covered in
 * `SkillTermGuidance.test.tsx`.
 */
describe("ResultDetail — skills-ordering placement (#544)", () => {
  /** Buried-skill résumé: "Engineering Leadership" is the top-scoring skill
   *  against the title and sits outside the front window (skills-order.ts). */
  const BURIED = {
    title: "Engineering Manager",
    skills: [
      "Docker",
      "AWS",
      "Kubernetes",
      "Engineering Leadership",
      "Terraform",
    ],
  };

  function buried(el: HTMLElement): string {
    return (
      el.querySelector('[data-testid="skills-order-probe"]')?.textContent ?? ""
    );
  }

  /** Substring, not equality: `summaries()` returns the row's whole text, and
   *  `Disclosure` prefixes its own ▸ glyph. An `toContain` over the array
   *  would pass vacuously in BOTH directions. */
  function hasAiSection(el: HTMLElement): boolean {
    return summaries(el).some((s) => s.includes("Local AI feedback"));
  }

  it("hands the finding to the résumé surface on a browser with no WebGPU", () => {
    const el = render({ isAvailable: false }, undefined, BURIED);
    // The precondition that made this a real defect: with no WebGPU there is
    // no "Local AI feedback" section at all, so a row hosted inside it would
    // have been unreachable on this exact render.
    expect(hasAiSection(el)).toBe(false);
    expect(buried(el)).toBe("buried=Engineering Leadership");
  });

  it("hands it over on a WebGPU browser too — one mount, not two", () => {
    const el = render({ isAvailable: true }, undefined, BURIED);
    expect(hasAiSection(el)).toBe(true);
    expect(buried(el)).toBe("buried=Engineering Leadership");
    // The critique body is the surface it LEFT. A second mount there would put
    // two rows over one shared controller, so both would enter the
    // confirmation strip on a single Apply.
    expect(el.textContent).not.toContain("Skills ordering");
  });

  it("passes a controller with no finding for a résumé with nothing buried", () => {
    const el = render({ isAvailable: false });
    expect(buried(el)).toBe("buried=NONE");
  });
});
