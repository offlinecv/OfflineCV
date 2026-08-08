// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `useResumeRewrite` — controller for the whole-résumé "rewrite resume" flow
 * (#67). Owns the state machine and the orchestrator invocation; returns
 * raw state + actions so the feature component (`ResumeRewrite.tsx`) can
 * render the UI without the hook reaching into components/ from hooks/.
 *
 * State machine: `idle` → `loading` (engine download) → `running` (per-step
 * progress) → `proposed` (all sections rewritten) → `error`. A stale-source
 * guard auto-dismisses a proposal when the underlying section list changes
 * — otherwise an edit to a role's bullets could leave the proposed panel
 * showing rewrites that the model never saw.
 *
 * Concurrency:
 *   - The same `useSectionRewriteLock` that gates per-role rewrites also
 *     gates this one. Holding the lock for the whole run disables every
 *     per-role `SectionRewrite` button — exactly the "one rewrite at a
 *     time" contract from #63.
 *   - The orchestrator's inner `rewrite*WithLlm` calls bracket each step
 *     with `acquireInference`, so the cross-model picker can defer
 *     `.unload()` until a step completes.
 *
 * WebGPU gating: `available` is the only branch that exposes any
 * interactive surface; the other two collapse to `available === false` so
 * the feature component can render `null` for trigger + panel (silent
 * absence, matching `RewriteButton` / `SectionRewrite`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { detectWebGpu } from "../lib/webllm/capability.ts";
import {
  acquireInference,
  loadEngine,
  releaseInference,
} from "../lib/webllm/web-llm.ts";
import {
  rewriteResumeWithLlm,
  type ResumeRewriteProgress,
  type ResumeRewriteResult,
  type SectionInput,
} from "../lib/webllm/rewrite-resume.ts";
import type {
  PageTarget,
  RewriteSteering,
} from "../lib/webllm/steering.ts";
import type {
  ProgressUpdate,
  WebGpuCapability,
} from "../lib/webllm/types.ts";
import { useModelSelection } from "./useModelSelection.ts";
import { usePersistentFlag } from "./usePersistentFlag.ts";
import { findingsFromCritique } from "../lib/webllm/rewrite-findings.ts";
import { findingsKey } from "../lib/webllm/steering.ts";
import type { ResumeCritique } from "../lib/webllm/critique-resume.ts";
import { useSectionRewriteLock } from "./useSectionRewriteLock.ts";

/** localStorage keys for the last-used steering (issue #210). */
const INSTRUCTIONS_KEY = "ocv_rewrite_instructions";
const PAGE_TARGET_KEY = "ocv_rewrite_page_target";
/** Findings channel opt-out (#608). "1" = on (the default), "" = off. */
const USE_FINDINGS_KEY = "ocv_rewrite_use_findings";

function parsePageTarget(stored: string): PageTarget | null {
  return stored === "1" || stored === "2" || stored === "3"
    ? (Number(stored) as PageTarget)
    : null;
}

export type ResumeRewriteStatus =
  | { kind: "idle" }
  | { kind: "loading"; progress: ProgressUpdate }
  | { kind: "running"; progress: ResumeRewriteProgress }
  | {
      kind: "proposed";
      result: ResumeRewriteResult;
      /** Snapshot of the section list the model actually saw — see useEffect below. */
      snapshot: readonly SectionInput[];
    }
  | {
      /** Apply just committed its writes (#508) — held in place for a few
       *  seconds instead of dismissing the panel silently. */
      kind: "applied";
      count: number;
      sections: readonly string[];
      /** Reverses the whole applied batch (issue 510). Absent when the batch
       *  couldn't be snapshotted in full — then no Undo is offered. */
      undo?: () => void;
    }
  | {
      /** Undo just ran (issue 510) — acknowledged in the same strip rather
       *  than reverting silently. One-shot: there is no re-apply. */
      kind: "undone";
      count: number;
      sections: readonly string[];
    }
  | { kind: "error"; message: string };

export interface ResumeRewriteController {
  /** Current state. The feature component renders off this discriminator. */
  status: ResumeRewriteStatus;
  /**
   * `null` while WebGPU detection is in flight; `true` lets the feature
   * component render the CTA, `false` hides every surface (silent absence).
   */
  isAvailable: boolean;
  /**
   * The rewriteable section subset the orchestrator will see — empty (no
   * bullets / no summary) sections are pre-filtered so the hook and the UI
   * agree on what "nothing to rewrite" means.
   */
  rewriteableSections: readonly SectionInput[];
  /** True when any rewrite (per-role or whole-résumé) is in flight anywhere. */
  isLocked: boolean;
  /** True iff the lock is held by a different consumer (per-role rewrite). */
  isLockedByOther: boolean;
  /** Start the whole-résumé run. No-op if the lock is already held. */
  start: () => Promise<void>;
  /** Drop a proposed/error/applied state back to idle. */
  dismiss: () => void;
  /** Move from "proposed" to "applied" (#508) — Apply just committed its
   *  writes; hold the confirmation instead of dismissing synchronously.
   *  `undo` reverses the whole batch (issue 510). */
  confirmApplied: (
    count: number,
    sections: readonly string[],
    undo?: () => void,
  ) => void;
  /** Run the applied batch's undo and move to "undone" (issue 510). One-shot:
   *  a no-op unless the current status is "applied" WITH an undo. */
  undoApplied: () => void;
  /** Freeform "what I want from this rewrite" text (#210). Persisted. */
  userInstructions: string;
  /** Update the freeform instructions (persists to localStorage). */
  setUserInstructions: (value: string) => void;
  /** Selected page-length target, or null when none is chosen (#210). */
  pageTarget: PageTarget | null;
  /** Set/clear the page-length target (persists to localStorage). */
  setPageTarget: (target: PageTarget | null) => void;
  /**
   * True when a critique has produced at least one ACTIONABLE finding for a
   * line this run would rewrite (#608). Drives whether the steering dialog
   * offers the toggle at all — a user who never ran the critique, or whose
   * résumé came back clean, is shown nothing rather than a dead control.
   */
  hasFindings: boolean;
  /** Whether to feed the critique's findings into the rewrite (#608).
   *  Persisted; defaults ON — a user who ran a critique and then clicked
   *  Rewrite has already expressed the intent. */
  useFindings: boolean;
  /** Toggle the findings channel (persists to localStorage). */
  setUseFindings: (value: boolean) => void;
  /**
   * The steering `start()` would run with, right now — the SAME object, not a
   * reconstruction (#609).
   *
   * The copyable-prompt disclosure has to show a prompt carrying the user's
   * current intent, and the intent is not simply `{userInstructions,
   * pageTarget}`: the JD-driven tailor path (#576, from `/jobs/`) folds a JD
   * context in front of the user's own text, and the findings channel rides
   * the same object. Exposing the assembled value means the copied prompt
   * cannot disagree with the button beside it — a second assembly in the UI
   * layer would drift the first time either input changed. `undefined` when
   * nothing is set, exactly as `start()` sees it.
   */
  steering: RewriteSteering | undefined;
}

export function labelForResumeRewrite(
  status: ResumeRewriteStatus,
  lockedByOther: boolean,
): string {
  if (lockedByOther) return "Another rewrite running…";
  switch (status.kind) {
    case "loading":
      return "Loading model…";
    case "running":
      return `Rewriting ${Math.min(status.progress.currentIndex + 1, status.progress.totalSections)} of ${status.progress.totalSections}…`;
    case "proposed":
      return "Rewrite again";
    case "error":
      return "Try again";
    default:
      return "Rewrite full résumé";
  }
}

export function sectionsEqual(
  a: readonly SectionInput[],
  b: readonly SectionInput[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (ai.kind !== bi.kind) return false;
    if (ai.id !== bi.id) return false;
    if (ai.kind === "summary" && bi.kind === "summary") {
      if (ai.text !== bi.text) return false;
    } else if (ai.kind === "experience" && bi.kind === "experience") {
      if (ai.bullets.length !== bi.bullets.length) return false;
      for (let j = 0; j < ai.bullets.length; j++) {
        if (ai.bullets[j] !== bi.bullets[j]) return false;
      }
    }
  }
  return true;
}

export function useResumeRewrite(
  sections: readonly SectionInput[],
  /**
   * Optional JD-driven steering text (#226, #576). Set only when the JD
   * tailor handoff (`tailor-handoff.ts`, written by `/jobs/`) landed for this
   * visit — `ResultDetailTabs` consumes the handoff on mount and threads the
   * instruction here. It names the JD's missing terms so the rewrite
   * prioritizes them; it is folded INTO the steering's `userInstructions`
   * (alongside the user's own freeform text), so the engine stays single.
   * Undefined → byte-identical generic rewrite prompt.
   */
  jdContext?: string,
  /**
   * The LLM critique of THIS résumé, when the user has run one (#608). Its
   * per-bullet findings are folded into the rewrite steering so a rewrite acts
   * on the feedback the app already showed the user. Undefined (no critique
   * run, or WebGPU unavailable) → byte-identical pre-#608 prompt.
   */
  critique?: ResumeCritique,
): ResumeRewriteController {
  const [capability, setCapability] = useState<WebGpuCapability | null>(null);
  const [status, setStatus] = useState<ResumeRewriteStatus>({ kind: "idle" });
  const { isLocked, acquire } = useSectionRewriteLock();
  const { selectedModelId } = useModelSelection();

  // Steering (#210): freeform instructions + page-length target, persisted so a
  // re-run keeps the user's last intent. pageTarget round-trips through a string
  // key ("" | "1" | "2" | "3").
  const [userInstructions, setUserInstructionsRaw] =
    usePersistentFlag(INSTRUCTIONS_KEY);
  const [pageTargetRaw, setPageTargetRaw] = usePersistentFlag(PAGE_TARGET_KEY);
  const pageTarget = parsePageTarget(pageTargetRaw);

  // Findings channel (#608). Default "1" (on): reaching the Rewrite button
  // after running a critique already expresses the intent to act on it, and an
  // opt-in that starts off would leave the defect this issue fixes in place for
  // everyone who doesn't find the checkbox.
  const [useFindingsRaw, setUseFindingsRaw] = usePersistentFlag(
    USE_FINDINGS_KEY,
    "1",
  );
  const useFindings = useFindingsRaw === "1";
  const setUseFindings = useCallback(
    (value: boolean) => setUseFindingsRaw(value ? "1" : ""),
    [setUseFindingsRaw],
  );
  const setPageTarget = useCallback(
    (target: PageTarget | null) => {
      setPageTargetRaw(target === null ? "" : String(target));
    },
    [setPageTargetRaw],
  );

  const rewriteableSections = useStableSections(
    useMemo(() => sections.filter(isNonEmptyForUi), [sections]),
  );

  // The critique's findings, keyed by the line they describe (#608). Built off
  // `rewriteableSections` so `summaryFeedback` is filed under the very summary
  // string this run will rewrite — `findingsFromCritique` has no other way to
  // key it, and a mismatch would silently drop it.
  const findings = useMemo(() => {
    const summary = rewriteableSections.find((s) => s.kind === "summary");
    return findingsFromCritique(critique, summary?.text);
  }, [critique, rewriteableSections]);

  // Whether the toggle is worth showing: findings exist AND at least one of
  // them names a line this run would actually rewrite. A critique whose only
  // actionable findings are on bullets the user has since deleted leaves the
  // map non-empty while contributing nothing, and offering a control that
  // provably changes no prompt is worse than offering none.
  const hasFindings = useMemo(() => {
    if (findings === undefined) return false;
    return rewriteableSections.some((section) =>
      section.kind === "summary"
        ? findings.has(findingsKey(section.text))
        : section.bullets.some((b) => findings.has(findingsKey(b))),
    );
  }, [findings, rewriteableSections]);

  // The one assembly of "what this rewrite is being asked to do" (#609). Built
  // here rather than inside `start` so the copyable-prompt disclosure can show
  // the very object the run would use — see `ResumeRewriteController.steering`.
  const steering = useMemo<RewriteSteering | undefined>(() => {
    // Combine the user's freeform instructions with the optional JD-driven
    // steering (#226) into ONE userInstructions string. The JD context leads
    // (it sets the tailoring intent); the user's own text follows so it stays
    // the most-salient, last instruction. Both empty → no userInstructions.
    const jd = jdContext?.trim();
    const userText = userInstructions.trim();
    const combinedInstructions = [jd, userText]
      .filter((s): s is string => !!s)
      .join("\n\n");
    // The app's own findings (#608) ride the SAME steering channel rather than
    // a fourth parameter on `rewriteResumeWithLlm` — one intent channel, per
    // #608's reuse analysis. Gated on the user's toggle, so opting out restores
    // the pre-#608 prompt exactly.
    const activeFindings = useFindings ? findings : undefined;
    if (!combinedInstructions && pageTarget === null && !activeFindings) {
      return undefined;
    }
    return {
      ...(combinedInstructions ? { userInstructions: combinedInstructions } : {}),
      ...(pageTarget !== null ? { pageTarget } : {}),
      ...(activeFindings ? { findings: activeFindings } : {}),
    };
  }, [jdContext, userInstructions, pageTarget, useFindings, findings]);

  useEffect(() => {
    let cancelled = false;
    void detectWebGpu().then((c) => {
      if (!cancelled) setCapability(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-dismiss a stale proposal when the underlying sections change.
  useEffect(() => {
    if (status.kind !== "proposed") return;
    if (!sectionsEqual(status.snapshot, rewriteableSections)) {
      setStatus({ kind: "idle" });
    }
  }, [rewriteableSections, status]);

  const start = useCallback(async () => {
    const release = acquire();
    if (release === null) return;
    // Snapshot the model id so the same id is released that we acquired —
    // ModelSelector could in principle update `selectedModelId` mid-run.
    const modelId = selectedModelId;
    // Acquire the inference guard SYNCHRONOUSLY, before any await — closes
    // the load→use TOCTOU window from #148. Held across the WHOLE chain
    // (summary + every experience role) so the engine cannot be torn down
    // by a concurrent picker switch at any step boundary, not just at the
    // first loadEngine. Released in `finally` whether the run completes
    // successfully or errors out.
    acquireInference(modelId);
    try {
      setStatus({
        kind: "loading",
        progress: { progress: 0, text: "Starting…" },
      });
      const engine = await loadEngine(modelId, (progress) => {
        setStatus({ kind: "loading", progress });
      });
      const result = await rewriteResumeWithLlm(
        rewriteableSections,
        engine,
        modelId,
        (progress) => {
          setStatus({ kind: "running", progress });
        },
        steering,
      );
      if (result.sections.length === 0) {
        setStatus({
          kind: "error",
          message: "Nothing to rewrite in this résumé.",
        });
        return;
      }
      setStatus({
        kind: "proposed",
        result,
        snapshot: rewriteableSections,
      });
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Couldn't load the rewrite model",
      });
    } finally {
      releaseInference(modelId);
      release();
    }
    // `steering` replaces the five inputs this callback used to assemble
    // inline (#609). The lint plugin is not registered in this repo (CLAUDE.md
    // → Data & hooks), so a stale closure here would lint green and silently
    // run with last render's intent — reading ONE memoized value instead of
    // five raw ones is one dep to get wrong instead of five, and it is the same
    // value the disclosure shows the user.
  }, [acquire, rewriteableSections, selectedModelId, steering]);

  const dismiss = useCallback(() => {
    setStatus({ kind: "idle" });
  }, []);

  const confirmApplied = useCallback(
    (count: number, sections: readonly string[], undo?: () => void) => {
      setStatus({ kind: "applied", count, sections, undo });
    },
    [],
  );

  // Read the live status through a ref rather than a `setStatus` updater: the
  // undo thunk is a side effect, and an updater is re-invoked under StrictMode.
  // (The restore is idempotent, but a state updater is the wrong place for it.)
  const statusRef = useRef(status);
  statusRef.current = status;
  const undoApplied = useCallback(() => {
    const current = statusRef.current;
    if (current.kind !== "applied" || !current.undo) return;
    current.undo();
    setStatus({
      kind: "undone",
      count: current.count,
      sections: current.sections,
    });
  }, []);

  const isAvailable =
    capability === "available" && rewriteableSections.length > 0;

  const myBusy = status.kind === "loading" || status.kind === "running";
  const isLockedByOther = isLocked && !myBusy;

  return {
    status,
    isAvailable,
    rewriteableSections,
    isLocked,
    isLockedByOther,
    start,
    dismiss,
    confirmApplied,
    undoApplied,
    userInstructions,
    setUserInstructions: setUserInstructionsRaw,
    pageTarget,
    setPageTarget,
    hasFindings,
    useFindings,
    setUseFindings,
    steering,
  };
}

/**
 * Hold the previous section array whenever the new one says the same thing.
 *
 * `ReconstructedResume` calls `buildResumeSections(…)` in its render body — a
 * plain call, not a `useMemo` — so `sections` is a fresh array on EVERY render,
 * and filtering it produced a fresh `rewriteableSections` on every render too.
 * That identity churn propagated to `findings`, `steering`, `start` and (since
 * #609) the copyable prompt's `useMemo`, which therefore memoized nothing: it
 * rebuilt the prompt string on every render of the disclosure. Nothing broke —
 * every consumer is derived, so recomputing yields the same value, and `start`
 * is called on click rather than watched — but a `useMemo` whose deps change
 * every render is a claim the code does not keep, and the next consumer to
 * watch `steering` in an effect would get a re-fire per render (#732 review).
 *
 * STRICTER THAN `sectionsEqual`, DELIBERATELY. That comparator ignores `label`,
 * which is right where it is used: the stale-proposal guard should not throw
 * away a live proposal because the user retyped an employer name. Here the
 * identity being gated feeds what the user SEES — the progress line ("Rewriting
 * 2 of 5: Engineer — Acme") and every heading in the proposal panel read
 * `label` off these very objects — so holding an array whose labels went stale
 * would show the old employer against the new bullets.
 *
 * Adjusts state during render rather than writing a ref, which is React's
 * documented shape for "a value derived from props that has to stay stable":
 * the `setHeld` call makes React discard this render pass and immediately redo
 * it with the new array, so no effect ever observes the stale value. It costs
 * one extra pass on a real edit and nothing at all on the churn it exists to
 * absorb.
 */
function useStableSections(
  sections: readonly SectionInput[],
): readonly SectionInput[] {
  const [held, setHeld] = useState(sections);
  if (held !== sections && !sameSectionsForDisplay(held, sections)) {
    setHeld(sections);
    return sections;
  }
  return held;
}

/** `sectionsEqual` plus the display labels — see {@link useStableSections}. */
function sameSectionsForDisplay(
  a: readonly SectionInput[],
  b: readonly SectionInput[],
): boolean {
  // `sectionsEqual` checks length first, so the index into `b` is in range.
  return sectionsEqual(a, b) && a.every((s, i) => s.label === b[i]!.label);
}

function isNonEmptyForUi(section: SectionInput): boolean {
  if (section.kind === "summary") return section.text.trim().length > 0;
  return section.bullets.some((b) => b.trim().length > 0);
}
