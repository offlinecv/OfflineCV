// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Auto-bold key metrics in resume description text.
 *
 * Pure TypeScript, zero dependencies.
 * Idempotent — running twice on the same text produces the same result.
 */

/**
 * Patterns that match quantifiable metrics worth bolding.
 * Each pattern is applied independently. Already-bolded text is skipped.
 *
 * Matches:
 * - Percentages: 40%, 2.5%
 * - Dollar amounts: $2M, $500K ARR, $1,200
 * - Multipliers: 2x, 10x
 * - Scale with unit: 50K records/day, 2.3M users
 * - Headcounts: 12 engineers, 200-person team
 * - Time durations: 6 weeks, 4 hours to 12 minutes
 * - Quantities with context: 3 products, 15 clients
 */
const METRIC_REGEXES: RegExp[] = [
  // Dollar amounts with optional scale suffix and trailing word (e.g., "$500K ARR", "$2M revenue")
  /\$[\d,.]+[KMBkmb]?\+?(?:\s+[A-Za-z]+)?/g,

  // Percentages (e.g., "40%", "2.5%")
  /\d+(?:\.\d+)?%/g,

  // Multipliers (e.g., "2x", "10X")
  /\d+[xX]\b/g,

  // Scale numbers with unit suffix (e.g., "50K", "2.3M+", "1B")
  // Followed by optional noun (e.g., "50K records/day", "2.3M users")
  /\d+(?:\.\d+)?[KMBkmb]\+?(?:\s+[a-z]+(?:\/[a-z]+)?)?/gi,

  // Headcount patterns (e.g., "12 engineers", "200-person team")
  /\d+(?:-\d+)?\s*(?:-?\s*)?(?:person|engineers?|developers?|people|team members?|reports?|employees?|staff|managers?)\b/gi,

  // Duration / time savings (e.g., "6 weeks", "4 hours to 12 minutes", "18 months")
  /\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)(?:\s+to\s+\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?))?/gi,

  // Quantities with context nouns (e.g., "3 products", "15 clients", "8 microservices")
  /\d+(?:\+)?\s+(?:products?|projects?|services?|applications?|systems?|clients?|customers?|accounts?|markets?|countries|regions?|teams?|microservices?|APIs?|endpoints?|repositories|databases?|servers?|clusters?|pipelines?|dashboards?|features?)\b/gi,

  // Rate metrics (e.g., "50K records/day", "1M requests/sec")
  /\d+(?:\.\d+)?[KMBkmb]?\s*(?:records?|transactions?|requests?|queries?|events?|messages?)\/(?:day|hour|minute|second|sec|min|mo(?:nth)?|week)/gi,
];

/**
 * Check if a position in the text is inside an existing bold marker.
 * Scans for **...** pairs and returns true if `pos` falls within one.
 */
function isInsideBold(text: string, start: number, end: number): boolean {
  const boldRegex = /\*\*[^*]+\*\*/g;
  let match: RegExpExecArray | null;
  while ((match = boldRegex.exec(text)) !== null) {
    const bStart = match.index;
    const bEnd = match.index + match[0].length;
    if (start < bEnd && end > bStart) return true;
  }
  return false;
}

/**
 * Apply auto-bold to a single description string.
 * Wraps detected metrics in **bold** markers. Idempotent.
 */
export function autoBoldText(text: string): string {
  const ranges: { start: number; end: number }[] = [];

  for (const pattern of METRIC_REGEXES) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      if (isInsideBold(text, start, end)) continue;
      if (/^\d+$/.test(match[0].trim())) continue;

      ranges.push({ start, end });
    }
  }

  if (ranges.length === 0) return text;

  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i].start <= last.end) {
      last.end = Math.max(last.end, ranges[i].end);
    } else {
      merged.push(ranges[i]);
    }
  }

  let result = text;
  for (let i = merged.length - 1; i >= 0; i--) {
    const { start, end } = merged[i];
    const segment = result.slice(start, end).trim();
    if (segment.length === 0) continue;
    result = result.slice(0, start) + `**${segment}**` + result.slice(end);
  }

  return result;
}

/**
 * Apply auto-bold to all experience descriptions in a resume's parsed data.
 * Returns a new experience array (does not mutate the original).
 */
export function autoBoldExperience<
  T extends { description?: string },
>(experience: T[]): T[] {
  return experience.map((exp) => {
    if (!exp.description) return exp;
    const bolded = autoBoldText(exp.description);
    if (bolded === exp.description) return exp;
    return { ...exp, description: bolded };
  });
}
