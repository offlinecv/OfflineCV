// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * SaveJobFromMatch — the "save this job" affordance on `/jd-fit/` (#323 AC).
 *
 * Turns a moment-in-time JD match into a tracked job in one click: the pasted
 * JD text and the match result ride onto the new record, so the tracker on `/`
 * shows what was matched and how it scored without re-running anything. The
 * title is seeded from the JD's first line (`deriveJobTitleFromJd`) and is
 * inline-editable in the tracker — we never scrape the posting (#323 non-goal).
 *
 * Deliberately a button and a confirmation line, not a form: asking for
 * title/company here would put a data-entry step between the user and the
 * match they came for, and both fields are editable one surface over. The two
 * surfaces are separate HTML entries sharing one IndexedDB origin, so the save
 * lands in the same store `/` reads — hence the cross-surface pointer in the
 * confirmation rather than an in-place list.
 */

import { useState } from "react";
import { Button } from "@design-system";
import { deriveJobTitleFromJd } from "../../lib/job-tracker.ts";
import { useJobTracker, type JobTracker } from "../../hooks/useJobTracker.ts";
import type { JdMatchResult } from "../../lib/jd-match";

interface SaveJobFromMatchProps {
  tracker: JobTracker;
  /** The JD the user pasted — stored verbatim on the record. */
  jdText: string;
  /** The match the user just ran, carried onto the job record. */
  matchResult: JdMatchResult;
}

/**
 * Flag-gated entry point that OWNS the hook, mirroring `JobTrackerSection` on
 * `/`. Calling `useJobTracker` in `JdFitApp` above the flag check would open
 * IndexedDB on every `/jd-fit/` visit for a button nobody can see; a hook can't
 * be called conditionally, so the gate has to be a component boundary.
 */
export function SaveJobFromMatchSection(
  props: Omit<SaveJobFromMatchProps, "tracker">,
) {
  const tracker = useJobTracker();
  return <SaveJobFromMatch tracker={tracker} {...props} />;
}

export function SaveJobFromMatch({
  tracker,
  jdText,
  matchResult,
}: SaveJobFromMatchProps) {
  // Keyed to the JD it belongs to, NOT a bare boolean: the common way a user
  // reaches a second posting is select-all + paste, which moves `jdText` from
  // old to new in one change event. `jdMatch` recomputes truthy without ever
  // passing through null, so this component never unmounts — a boolean would
  // leave the confirmation up and the Save button gone for the rest of the
  // session. Comparing against the current JD resets it for free.
  const [savedFor, setSavedFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const save = async () => {
    setSaving(true);
    setFailed(false);
    try {
      await tracker.saveFromMatch({
        title: deriveJobTitleFromJd(jdText),
        jdText,
        matchResult,
      });
      setSavedFor(jdText);
    } catch {
      // A write can genuinely fail — quota exceeded, a blocked IndexedDB
      // upgrade, a private-mode origin. Swallowing it would re-enable the
      // button looking untouched and let the user believe the job was saved,
      // so confirm the failure in place (the repo has no toast primitive).
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (savedFor === jdText) {
    return (
      <p className="text-xs text-content-muted">
        Saved to your tracked jobs — open the parser-audit page to rename it,
        set a status, or link the resume you used. Stored in this browser only.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="sm" disabled={saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save as tracked job"}
      </Button>
      <span className="text-xs text-content-muted">
        {failed
          ? "Couldn't save — this browser may be out of storage or in private mode. Your JD match is unaffected."
          : "Keeps this JD and its match result in your browser."}
      </span>
    </div>
  );
}
