// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * SkillsOrderFinding — the skills-ordering coaching row (#544).
 *
 * A HEURISTIC finding (`useSkillsReorder`, `lib/heuristics/skills-order.ts`),
 * independent of the on-device LLM critique. Apply/confirm/undo reuses
 * `ApplyConfirmation`/`UndoBatchButton` — the same components the
 * whole-résumé and per-role rewrite panels use — rather than a new mechanism.
 *
 * ITS ONE MOUNT IS `SkillTermGuidance`, the résumé lane's other heuristic
 * skills advisory, which renders on every parse. It was originally a row in
 * `CritiqueResults` and kept the finding-row shape it was given there —
 * an `<li>`, in the visual language of `BulletFindingRow`/`MissingSectionRow`
 * — so its host supplies the `<ul>`. It left that panel because the panel
 * mounts only under `status.kind === "done"`: a heuristic that a visitor can
 * reach only by owning a WebGPU browser and opting into a model download is
 * indistinguishable, to that visitor, from LLM output they chose not to run.
 * Keep the single mount: `SkillsReorderController` is shared state, so two
 * mounted rows would both flip into the confirmation strip on one Apply.
 *
 * It lives in this file rather than inline in its host for the reason it was
 * split from `CritiquePanel.tsx` in the first place — both hosts are at or
 * past the ~200 LOC guideline (CLAUDE.md).
 *
 * Design rules (CLAUDE.md): semantic tokens only, `<Button>` from
 * "@design-system", no raw `<button>`.
 */

import { Button, StatusBadge } from "@design-system";
import { ApplyConfirmation, UndoBatchButton, UNDO_HOLD_MS } from "./ApplyConfirmation.tsx";
import type { SkillsReorderController } from "../../hooks/useSkillsReorder.ts";

/** Coaching copy for the finding — never a hard error (#544 acceptance
 *  criteria: advisory only). */
function skillsOrderMessage(buried: string[]): string {
  if (buried.length === 1) {
    return `"${buried[0]}" looks highly relevant to your target role but sits well down your Skills list.`;
  }
  return `${buried.length} skills highly relevant to your target role sit well down your Skills list: ${buried.join(", ")}.`;
}

/**
 * `buried` may be empty here even though the row is rendering: once Apply
 * reorders the list the underlying finding recomputes to `undefined` (the
 * skills are no longer buried), but the confirmation strip still needs to
 * show until its own hold elapses.
 */
export function SkillsOrderFindingRow({
  skillsOrder,
}: {
  skillsOrder: SkillsReorderController;
}) {
  const { finding, canApply, applied, apply, undo, dismiss } = skillsOrder;

  if (applied) {
    return (
      <li className="rounded border border-border-light bg-surface-subtle p-3">
        <ApplyConfirmation
          count={1}
          sections={["Skills"]}
          onCollapse={dismiss}
          holdMs={UNDO_HOLD_MS}
          action={<UndoBatchButton onUndo={undo} />}
        />
      </li>
    );
  }

  if (!finding) return null;

  return (
    <li className="flex flex-col gap-1.5 rounded border border-border-light bg-surface-subtle p-3">
      <div className="flex flex-col gap-1">
        <StatusBadge tone="info">Ordering</StatusBadge>
        <p className="text-sm text-content-secondary leading-snug">
          {skillsOrderMessage(finding.buried)} Readers and keyword scans
          weight earlier items more.
        </p>
      </div>
      {canApply ? (
        <Button
          variant="link"
          size="sm"
          onClick={apply}
          className="self-start text-2xs font-medium text-accent-primary"
          aria-label="Move the highly relevant skills to the front of the Skills list"
        >
          Reorder skills →
        </Button>
      ) : (
        <p className="text-sm text-content-tertiary">
          Skills are grouped into categories — use each chip&rsquo;s
          &ldquo;Move to&rdquo; menu (or drag it) to reorder them.
        </p>
      )}
    </li>
  );
}
