// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

export {
  extractJdTerms,
  stripBoilerplate,
  BOILERPLATE_ANCHORS,
} from "./extract-jd-terms.ts";
export type {
  ExtractedTerm,
  ExtractJdTermsResult,
  ExtractOptions,
} from "./extract-jd-terms.ts";

export {
  computeCoverage,
  buildCorpus,
  SKILL_WEIGHT,
  NOUN_WEIGHT,
} from "./coverage.ts";
export type { CoverageResult } from "./coverage.ts";

export { SKILLS, getSkillIndex, skillCount } from "./skills.ts";
export type { SkillEntry } from "./skills.ts";

export { fetchJdFromUrl, parseAtsUrl, htmlToPlaintext } from "./fetch-jd.ts";
export type { AtsPlatform } from "./fetch-jd.ts";
