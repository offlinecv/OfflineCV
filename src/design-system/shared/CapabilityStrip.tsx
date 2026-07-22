// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * CapabilityStrip — replaces the pre-drop trust-chip row (#517).
 *
 * The old chip row (`⚡ A few seconds`, `🔒 Your file never leaves your
 * device`, `✓ No account, no email`, `🔁 Same PDF, same score`) stated four
 * PROPERTIES of the product. None of them told a first-time visitor that
 * OfflineCV also matches a resume against a job description or finds real
 * postings — three of the app's four lanes are invisible pre-drop (#511).
 *
 * This strip states three CAPABILITIES instead — read / fix / match & find —
 * under one persistent local-processing rail. Static and non-interactive: it
 * is a description, not a second entry point competing with the drop zone.
 *
 * Composed entirely from existing `@design-system` exports (Card, StatusBadge,
 * Chip, LockIcon) — no new primitive. `StatusBadge` gives each lane the same
 * small-caps pill treatment a Tab label gets (#516's visual language); `Chip`
 * carries the rail statement, matching how the old chip row phrased itself.
 *
 * Privacy scope (binding, epic #511): the rail claims custody of the RESUME —
 * "Your resume stays in your browser" — deliberately not "nothing leaves" or
 * "runs entirely on your device". Those would be false: the job-search lane
 * this same card advertises does `fetch()` three third-party feeds, and a
 * build with VITE_POSTHOG_KEY set ships analytics the user never opted into.
 * What makes the narrower claim TRUE is `job-search/providers/keywords.ts` —
 * the outbound payload is a short keyword string, never the resume text. That
 * module is the invariant this copy depends on; if it ever sends resume text,
 * or if a cloud LLM path lands (none exists today — there is no BYOK provider
 * in the tree despite older docs implying one), this line becomes a lie and
 * must change with it. Per-feature exceptions stay stated where the user
 * meets them (`FindJobsPanel`), not restated here.
 *
 * The noun is "browser", not "device", and that is deliberate (#537): this
 * rail renders a few inches below `App`'s hero, which says "in your browser"
 * in the headline and "leaving your browser" in the subhead, so a visitor
 * reads all three at once. "Device" also understates the guarantee — another
 * app on the same device cannot read the resume either. If you change the
 * noun here, change it in `App.tsx`'s hero in the same commit. `PageShell`'s
 * footer states a narrower, hedged claim about a different object ("your PDF
 * stays in this browser tab by default") — same noun, not the same sentence.
 */

import { Chip } from "../primitives/Chip.tsx";
import { LockIcon } from "../icons/TrustIcons.tsx";
import { Card } from "./Card.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

interface CapabilityLane {
  label: string;
  description: string;
}

const LANES: CapabilityLane[] = [
  {
    label: "Read it",
    description:
      "A parser in your browser pulls out your experience, skills and contact details",
  },
  {
    label: "Fix it",
    description:
      "Edit inline, save it in your browser, or export a clean PDF",
  },
  {
    label: "Match & find",
    description: "Score against a job description, rank real postings",
  },
];

export function CapabilityStrip() {
  return (
    <Card className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {LANES.map((lane) => (
          // `items-start` pairs with the `w-fit` that `StatusBadge` now carries
          // itself: a column flex stretches its items, so an inline-flex badge
          // blockifies into a full-width `rounded-full` bar. The primitive owns
          // the fix (it shipped stretched in `CritiquePanel`'s column flex too);
          // this stays as belt-and-braces for the grid column.
          <div key={lane.label} className="flex flex-col items-start gap-1.5">
            <StatusBadge tone="info">{lane.label}</StatusBadge>
            <p className="text-sm text-content-secondary">
              {lane.description}
            </p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border-light pt-3">
        <Chip icon={<LockIcon />}>Your resume stays in your browser</Chip>
      </div>
    </Card>
  );
}
