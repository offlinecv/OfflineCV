// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Stepper — the ONE ordered, multi-step navigation composition.
 *
 * Reuse analysis (CLAUDE.md's Reuse Gate). `Tabs` was the only candidate and
 * models a DIFFERENT concern: lateral browsing of peer views, where no order
 * exists, nothing is "next", and arriving at the last tab means nothing. A
 * stepper models a sequence that terminates in one commit action — the user
 * needs to know how far through they are and what finishes the flow. Reusing
 * `Tabs` for that leaves the terminal button ("Search jobs") with no visible
 * relationship to the steps, which is exactly the ambiguity this exists to
 * remove. So this is a missing concern, not a second copy of `Tabs`; the two
 * stay separate and neither absorbs the other.
 *
 * Composition (mirrors `Tabs`' shape so the two read alike):
 *   <Stepper value onValueChange id steps>   context provider
 *     <StepperRail aria-label>               <nav><ol>, numbered, aria-current
 *     <StepPanel id>…</StepPanel>            role="group", hidden when inactive
 *     <StepperNav finalAction>               Back / Next, terminal action last
 *
 * Accessibility. There is no ARIA `stepper` role; the established pattern for
 * an ordered progress trail is a `<nav>` + ordered list whose current item
 * carries `aria-current="step"`, which is what `StepperRail` renders. The
 * count is ALSO stated in words ("Step 2 of 4") rather than left to the visual
 * numerals — a screen reader gets the position without having to count the
 * list. Panels are `role="group"` labelled by their rail entry, not
 * `role="tabpanel"`: they are not controlled by tabs, and mislabelling them
 * would promise arrow-key tab semantics this does not implement.
 *
 * Inactive panels stay MOUNTED (`hidden`), same as `Tabs` — child UI state
 * (a half-typed chip draft, an open disclosure) must survive stepping away and
 * back, and the parent owns the real data anyway.
 *
 * Selection affordance follows `Tabs`' #516 decision: the rail is a recessed
 * track (`bg-surface-subtle`) and the current step sits on `bg-surface-card`
 * with a font-weight step — a real surface change, never colour alone, so the
 * rail still resolves in a greyscale render. Text on the recessed track is
 * `content-secondary`, not `content-tertiary`/`content-muted`: those two land
 * at 4.04:1 against `--color-bg-subtle` in dark mode, under the 4.5:1 of
 * WCAG 1.4.3.
 *
 * Design rules (CLAUDE.md): semantic tokens only, `Button` primitive for every
 * control, no raw `<button>`.
 */

import {
  createContext,
  useContext,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { Button } from "../primitives/Button.tsx";

export interface StepDefinition {
  /** Stable id, used for `value` and to wire label ↔ panel. */
  id: string;
  /** Short step name shown in the rail. */
  label: string;
  /**
   * Optional one-line state of that step ("4 titles", "Santa Clara, CA"), shown
   * under the label. A rail that names only the steps tells you where you are
   * but not what you already set — with the panels closed that is the only
   * place the answer can live. Hidden below `sm`, like `Tab`'s `description`,
   * so a 375px viewport degrades to a single-line rail.
   */
  summary?: string;
}

interface StepperContextValue {
  value: string;
  onValueChange: (value: string) => void;
  baseId: string;
  steps: readonly StepDefinition[];
}

const StepperContext = createContext<StepperContextValue | null>(null);

function useStepperContext(component: string): StepperContextValue {
  const ctx = useContext(StepperContext);
  if (ctx == null) throw new Error(`${component} must be used within <Stepper>`);
  return ctx;
}

const stepId = (baseId: string, id: string) => `${baseId}-step-${id}`;
const stepPanelId = (baseId: string, id: string) => `${baseId}-steppanel-${id}`;

export function Stepper({
  value,
  onValueChange,
  id,
  steps,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  /** Stable prefix for step/panel id wiring. */
  id: string;
  steps: readonly StepDefinition[];
  children: ReactNode;
}) {
  return (
    <StepperContext.Provider value={{ value, onValueChange, baseId: id, steps }}>
      <div className="flex flex-col gap-4">{children}</div>
    </StepperContext.Provider>
  );
}

export function StepperRail({
  "aria-label": ariaLabel,
}: {
  "aria-label": string;
}) {
  const { value, onValueChange, baseId, steps } = useStepperContext("StepperRail");
  const currentIndex = steps.findIndex((s) => s.id === value);

  // Left/Right (+ Home/End) walk the rail, matching `TabList`. Unlike a
  // tablist there is no roving tabindex to maintain: every step stays
  // focusable, because jumping straight to step 4 is a legitimate move in a
  // flow whose steps are all optional.
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const delta =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    let next = currentIndex;
    if (delta !== 0) next = (currentIndex + delta + steps.length) % steps.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = steps.length - 1;
    else return;
    const target = steps[next];
    if (target == null) return;
    event.preventDefault();
    onValueChange(target.id);
    document.getElementById(stepId(baseId, target.id))?.focus();
  }

  return (
    <nav aria-label={ariaLabel} onKeyDown={onKeyDown} className="flex flex-col gap-1.5">
      <ol className="flex gap-1 overflow-x-auto overflow-y-hidden rounded-md border border-border-light bg-surface-subtle p-1">
        {steps.map((step, index) => {
          const isCurrent = step.id === value;
          return (
            <li key={step.id} className="min-w-0 flex-1">
              <Button
                variant="tab"
                id={stepId(baseId, step.id)}
                aria-current={isCurrent ? "step" : undefined}
                aria-controls={stepPanelId(baseId, step.id)}
                onClick={() => onValueChange(step.id)}
                className={[
                  "w-full flex-col items-start gap-0 text-left",
                  isCurrent
                    ? "bg-surface-card text-content-primary font-semibold shadow-xs"
                    : "bg-transparent text-content-secondary font-medium hover:bg-surface-hover hover:text-content-primary hover:ring-1 hover:ring-inset hover:ring-border-strong",
                ].join(" ")}
              >
                <span className="truncate">
                  <span aria-hidden="true" className="tabular-nums">
                    {index + 1}.{" "}
                  </span>
                  {step.label}
                </span>
                {step.summary != null && (
                  <span className="hidden max-w-full truncate text-xs font-normal text-content-secondary sm:block">
                    {step.summary}
                  </span>
                )}
              </Button>
            </li>
          );
        })}
      </ol>
      <p className="text-sm text-content-secondary">
        Step {currentIndex + 1} of {steps.length}
      </p>
    </nav>
  );
}

export function StepPanel({ id, children }: { id: string; children: ReactNode }) {
  const { value, baseId } = useStepperContext("StepPanel");
  return (
    <section
      role="group"
      id={stepPanelId(baseId, id)}
      aria-labelledby={stepId(baseId, id)}
      hidden={value !== id}
      className="flex flex-col gap-4"
    >
      {children}
    </section>
  );
}

export function StepperNav({ finalAction }: { finalAction?: ReactNode }) {
  const { value, onValueChange, steps } = useStepperContext("StepperNav");
  const index = steps.findIndex((s) => s.id === value);
  const previous = index > 0 ? steps[index - 1] : undefined;
  const next = index >= 0 && index < steps.length - 1 ? steps[index + 1] : undefined;

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border-light pt-3">
      {previous && (
        <Button size="md" onClick={() => onValueChange(previous.id)}>
          ‹ Back to {previous.label}
        </Button>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-3">
        {next && (
          <Button size="md" onClick={() => onValueChange(next.id)}>
            Next: {next.label} ›
          </Button>
        )}
        {/* The terminal action stays mounted on every step — a user who is
         *  happy with the seeded query must never have to walk to the last
         *  step to run a search. Its position (always last in the row) is what
         *  marks it as the end of the flow, not its presence. */}
        {finalAction}
      </div>
    </div>
  );
}
