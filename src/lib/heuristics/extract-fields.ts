// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Barrel re-export — keeps `openresume.ts` and test imports stable while the
 * per-field modules live under `./extract/`. No logic lives here.
 */

export { extractName } from "./extract/name.ts";
export { extractContact } from "./extract/contact.ts";
export { extractSummary } from "./extract/summary.ts";
export { extractSkills } from "./extract/skills.ts";
export { extractExperience } from "./extract/experience.ts";
export { extractProjects } from "./extract/projects.ts";
export { extractAchievements } from "./extract/achievements.ts";
export { extractEducation } from "./extract/education.ts";
