// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { ScoreTier } from "../../lib/score/types.ts";

/** Maps a score tier to the Tailwind text-color token for that band. */
export function scoreBandTextClass(tier: ScoreTier): string {
  switch (tier) {
    case "high":
      return "text-feedback-success-icon";
    case "medium":
      return "text-brand-amber";
    case "low":
      return "text-feedback-warning-icon";
    default:
      return "text-feedback-warning-icon";
  }
}
