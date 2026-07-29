// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `/jd-fit` exports the SAME contact block as `/` for the same edit (#648).
 *
 * #648 Phase 3 removed `buildContact`'s `contactOverrides` fallback, on the
 * stated precondition that the canonical résumé handed to it already carries the
 * user's contact edits AND their bumped `fieldConfidence`. That precondition was
 * true on `/` (`useAnalyzedResume` folds `edited.fieldConfidence` into
 * `displayResult`) and FALSE on `/jd-fit`, which rebuilt its result with `fields`
 * only and kept the BASE confidence.
 *
 * The consequence was silent and export-only: `buildContactFields` marks a field
 * `gated` below `CONTACT_DISPLAY_CONFIDENCE_FLOOR` (0.5) but RETAINS its value at
 * `low_confidence`, so a corrected field kept rendering on screen while
 * `buildContact` returned `""` for it — the downloaded PDF and the visible card
 * disagreed. `/jd-fit` reaches that export through `JdFitApp` → `<Result>` →
 * `ResultDetailTabs` → `ReconstructedResume`, which renders "Download resume"
 * unconditionally, and through `useDownloadReport`'s identity block.
 *
 * Every assertion is an EQUALITY against `/`'s own pipeline, not a hand-written
 * expectation — the same discipline as the sibling
 * `useJdFitResume.duplicate-bullet-identity.repro.test.tsx`. The claim is not
 * "jd-fit exports this phone number", it is "jd-fit exports what `/` exports from
 * the same edit", so a lane that drifts fails here even when its own output looks
 * plausible in isolation.
 *
 * PII-free: synthetic persona, all fields fabricated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useJdFitResume, type JdFitResume } from "./useJdFitResume.ts";
import type { AnalyzedResume } from "../hooks/useAnalyzedResume.ts";
import type {
  ContactOverrides,
  EditSnapshot,
} from "../hooks/useEditableParse.ts";
import { writeJdFitHandoff, type JdFitHandoff } from "../lib/jd-fit-handoff.ts";
import { applyOverrides } from "../lib/edit/apply-overrides.ts";
import { buildContact } from "../lib/pdf/ats-resume-model.ts";
import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
} from "../lib/score/score.ts";
import { buildBlankResult } from "../lib/heuristics/empty-result.ts";
import { toCanonicalResume } from "../lib/heuristics/canonical.ts";
import type { SectionedResume } from "../lib/heuristics/sections.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** The correction under test — the commonest contact edit there is: the parser
 *  found no phone at all, and the user types one in. */
const TYPED_PHONE = "(415) 555-0173";
const TYPED_LOCATION = "Portland, OR";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

const EMPTY_EDIT: EditSnapshot = {
  contactOverrides: {},
  experienceOverrides: {},
  bulletOverrides: {},
  removedBullets: [],
  educationOverrides: {},
  achievementOverrides: {},
  skillsOverride: { removed: [], added: [] },
  addedEntries: [],
  addedBullets: {},
  profileOverrides: [],
};

function sections(experience: readonly string[]): SectionedResume {
  const byName = new Map<string, readonly string[]>([["experience", experience]]);
  return {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

const BULLET = "Owned the release process end to end.";

/**
 * The pristine parse the handoff carries. `phone` is absent and `location` is
 * present but BELOW the display floor — the two ways a contact row reaches the
 * user needing correction, and both of them `gated` until an edit bumps them.
 */
function baseResult(): CascadeResult {
  const blank = buildBlankResult();
  return {
    ...blank,
    rawText: `• ${BULLET}`,
    canonical: toCanonicalResume(
      {
        full_name: "Robin Vasquez",
        email: "robin.vasquez@example.com",
        location: "Portlnd, OR",
        skills: ["typescript"],
        education: [],
        experience: [
          {
            title: "Staff Engineer",
            company: "Northwind Systems",
            start_date: "2020",
            end_date: "2024",
            description: BULLET,
          },
        ],
      },
      sections([`• ${BULLET}`]),
      // Below CONTACT_DISPLAY_CONFIDENCE_FLOOR (0.5): the parser is unsure, so
      // the row renders as a correctable low-confidence field.
      { location: 0.3 },
    ),
  };
}

function baseScore(base: CascadeResult): AnonymousAtsScore {
  return computeAnonymousAtsScore({
    parsed: base.canonical.fields,
    fieldConfidence: base.canonical.fieldConfidence,
    triggers: base.triggers,
    rawText: base.rawText,
    sections: base.canonical.sections,
  });
}

/** What `/` exports for the same base + the same contact overrides — the
 *  reference. Mirrors `useAnalyzedResume`'s `displayResult` fold exactly:
 *  edited FIELDS **and** edited `fieldConfidence` onto the base canonical. */
function exportedOnSlash(
  base: CascadeResult,
  contactOverrides: ContactOverrides,
): ReturnType<typeof buildContact> {
  const applied = applyOverrides(
    base.canonical.fields,
    base.rawText,
    base.canonical.sections,
    contactOverrides,
    {},
    {},
    baseScore(base).bullets ?? [],
    {},
    { removed: [], added: [] },
    [],
    {},
    new Set<string>(),
    [],
    base.canonical.fieldConfidence,
  );
  return buildContact({
    ...base,
    canonical: {
      ...base.canonical,
      fields: applied.fields,
      fieldConfidence: applied.fieldConfidence,
    },
  });
}

let container: HTMLDivElement;
let root: Root;
let api: JdFitResume | null = null;
let BASE: CascadeResult;

function Probe() {
  // The local-DropZone lane is idle, so the handoff lane is under test.
  api = useJdFitResume({
    state: { phase: "idle" },
    edit: {},
    edited: null,
    reset: () => {},
  } as unknown as AnalyzedResume);
  return null;
}

function mount(): void {
  BASE = baseResult();
  writeJdFitHandoff({
    result: BASE,
    score: baseScore(BASE),
    edit: EMPTY_EDIT,
  } as unknown as JdFitHandoff);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    ),
  );
}

/** The contact block jd-fit would actually export, off the result it hands
 *  `<Result>` — the same value `ReconstructedResume`'s Download button reaches. */
function exported(): ReturnType<typeof buildContact> {
  expect(api, "jd-fit produced no résumé from the handoff").not.toBeNull();
  return buildContact(api!.result);
}

beforeEach(() => {
  (globalThis as { sessionStorage?: Storage }).sessionStorage =
    new MemoryStorage() as unknown as Storage;
  api = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("/jd-fit exports the same contact block as `/` (#648)", () => {
  it("keeps a phone the user typed into an EMPTY field", () => {
    mount();
    act(() => api!.edit.setContactField("phone", TYPED_PHONE));

    // The defect: the value folded into `fields`, but the BASE confidence rode
    // along, so the row read `gated` and `buildContact` returned "".
    expect(exported().phone).toBe(TYPED_PHONE);
    expect(exported()).toEqual(
      exportedOnSlash(BASE, api!.edit.contactOverrides),
    );
  });

  it("keeps a correction to a LOW-CONFIDENCE parsed field", () => {
    mount();
    // The parser read "Portlnd, OR" at 0.3 — under the floor, so it renders as a
    // low-confidence row with its value retained. The user fixes the typo.
    act(() => api!.edit.setContactField("location", TYPED_LOCATION));

    expect(exported().location).toBe(TYPED_LOCATION);
    expect(exported()).toEqual(
      exportedOnSlash(BASE, api!.edit.contactOverrides),
    );
  });

  it("agrees with `/` on the whole block for a multi-field edit", () => {
    mount();
    act(() => {
      api!.edit.setContactField("phone", TYPED_PHONE);
      api!.edit.setContactField("location", TYPED_LOCATION);
    });

    expect(exported()).toEqual(
      exportedOnSlash(BASE, api!.edit.contactOverrides),
    );
  });

  it("agrees with `/` when there is no contact edit at all", () => {
    mount();

    // The control: with no override the two lanes must already have agreed, so a
    // failure here would mean the fix changed the UNEDITED export rather than
    // closing the gap. `location` stays gated on BOTH lanes (0.3 < 0.5).
    expect(exported().location).toBeUndefined();
    expect(exported()).toEqual(exportedOnSlash(BASE, {}));
  });
});
