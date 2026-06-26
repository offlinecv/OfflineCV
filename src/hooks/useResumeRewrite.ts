// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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

import { useCallback, useEffect, useMemo, useState } from "react";
import { detectWebGpu } from "../lib/webllm/capability.ts";
import { loadEngine } from "../lib/webllm/web-llm.ts";
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
import { useSectionRewriteLock } from "./useSectionRewriteLock.ts";

/** localStorage keys for the last-used steering (issue #210). */
const INSTRUCTIONS_KEY = "rl_rewrite_instructions";
const PAGE_TARGET_KEY = "rl_rewrite_page_target";

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
  /** Drop a proposed/error state back to idle. */
  dismiss: () => void;
  /** Freeform "what I want from this rewrite" text (#210). Persisted. */
  userInstructions: string;
  /** Update the freeform instructions (persists to localStorage). */
  setUserInstructions: (value: string) => void;
  /** Selected page-length target, or null when none is chosen (#210). */
  pageTarget: PageTarget | null;
  /** Set/clear the page-length target (persists to localStorage). */
  setPageTarget: (target: PageTarget | null) => void;
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
  const setPageTarget = useCallback(
    (target: PageTarget | null) => {
      setPageTargetRaw(target === null ? "" : String(target));
    },
    [setPageTargetRaw],
  );

  const rewriteableSections = useMemo(
    () => sections.filter(isNonEmptyForUi),
    [sections],
  );

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
    try {
      setStatus({
        kind: "loading",
        progress: { progress: 0, text: "Starting…" },
      });
      const engine = await loadEngine(selectedModelId, (progress) => {
        setStatus({ kind: "loading", progress });
      });
      const trimmedInstructions = userInstructions.trim();
      const steering: RewriteSteering | undefined =
        trimmedInstructions || pageTarget !== null
          ? {
              ...(trimmedInstructions
                ? { userInstructions: trimmedInstructions }
                : {}),
              ...(pageTarget !== null ? { pageTarget } : {}),
            }
          : undefined;
      const result = await rewriteResumeWithLlm(
        rewriteableSections,
        engine,
        selectedModelId,
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
      release();
    }
  }, [acquire, rewriteableSections, selectedModelId, userInstructions, pageTarget]);

  const dismiss = useCallback(() => {
    setStatus({ kind: "idle" });
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
    userInstructions,
    setUserInstructions: setUserInstructionsRaw,
    pageTarget,
    setPageTarget,
  };
}

function isNonEmptyForUi(section: SectionInput): boolean {
  if (section.kind === "summary") return section.text.trim().length > 0;
  return section.bullets.some((b) => b.trim().length > 0);
}
