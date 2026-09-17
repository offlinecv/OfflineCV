// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * formatTriageHeadline — the summary-row headline for `TargetingSection` (#953).
 *
 * Pulled out of a nested ternary so the pluralization matrix is testable
 * without rendering a disclosure. The irregular verb is the trap: "1 bullet
 * NEEDS attention" but "2 bullets NEED attention", while the combined shape is
 * always "need" regardless of either count. A naive `+ "s"` gets the third
 * case wrong and reads fine in code review.
 */

import { describe, it, expect } from "vitest";
import { formatTriageHeadline } from "./TargetingTriageRow.tsx";

describe("formatTriageHeadline", () => {
  it("returns null when nothing is flagged", () => {
    expect(formatTriageHeadline(0, 0)).toBeNull();
  });

  it("uses the singular verb for exactly one bullet", () => {
    expect(formatTriageHeadline(1, 0)).toBe("1 bullet needs attention");
  });

  it("uses the plural verb for several bullets", () => {
    expect(formatTriageHeadline(4, 0)).toBe("4 bullets need attention");
  });

  it("singularizes a lone missing contact field", () => {
    expect(formatTriageHeadline(0, 1)).toBe("1 contact field missing");
  });

  it("pluralizes several missing contact fields", () => {
    expect(formatTriageHeadline(0, 3)).toBe("3 contact fields missing");
  });

  it("keeps the plural verb in the combined shape even at one of each", () => {
    expect(formatTriageHeadline(1, 1)).toBe(
      "1 bullet & 1 contact field need attention",
    );
  });

  it("pluralizes both nouns independently in the combined shape", () => {
    expect(formatTriageHeadline(2, 3)).toBe(
      "2 bullets & 3 contact fields need attention",
    );
  });
});
