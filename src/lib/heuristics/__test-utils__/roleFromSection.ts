// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * One-call harness for the experience-extractor tests: line specs in, parsed
 * roles out, with the whole routing layer (`groupIntoLines` → `splitIntoSections`
 * → `findSection`) run for real in between.
 *
 * It lives here because #492's `experience.anchor-prose-tail.test.ts` and #708's
 * `experience.leading-body-prose.test.ts` wrote the same six lines independently
 * — two issues in one accumulated commit, which is exactly the cross-file
 * duplicate a per-issue review pass cannot see. Sharing it also keeps the two
 * from drifting on WHICH layers a "unit" test of the extractor runs, which is
 * the part that makes these assertions mean anything: the section really has to
 * route, so a fix that only works when the caller hands `extractExperience` a
 * hand-built region does not pass here.
 *
 * The `expect` on the section is an assertion, not a convenience — a test whose
 * `experience` section failed to route would otherwise read as "extractor
 * returned nothing" instead of "routing broke".
 */

import { expect } from "vitest";

import { extractExperience } from "../extract-fields.ts";
import { groupIntoLines, splitIntoSections, findSection } from "../sections.ts";
import { mkItems } from "./mkItem.ts";

/** Parse `specs` as a whole résumé and return the roles of its `experience`
 *  section. Fails the calling test if no `experience` section routed. */
export function roleFromSection(
  specs: Array<{ text: string; fontSize?: number }>,
) {
  const sections = splitIntoSections(groupIntoLines(mkItems(specs)));
  const experience = findSection(sections, "experience");
  expect(experience).toBeDefined();
  return extractExperience(experience).value;
}
