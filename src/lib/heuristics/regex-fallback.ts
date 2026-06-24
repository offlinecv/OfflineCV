// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Tier 1.5 — lightweight regex fallback.
 *
 * Runs after Tier 1 when the heuristic parser missed the basics. Fills in
 * `full_name`, `email`, `phone`, and `linkedin_url` by scanning the concatenated
 * PDF text with patterns from `regex.ts` — no DOM, no pdfjs, no model. Tens of
 * KB of code, measured in ones of milliseconds.
 *
 * Anonymous lead-magnet use case: we do not escalate to Tier 2/3 on
 * the landing page, so this tier exists to recover the cheap easy wins before
 * we concede and route the visitor to signup. Authed dashboard uses it too —
 * same wins for free, and its presence bumps `fieldConfidence` so downstream
 * consumers can treat a regex hit as a valid signal.
 *
 * Design rules:
 *   - Only writes fields the Tier 1 pass left empty. Never overwrites.
 *   - Emits modest confidence (0.6–0.7) — high enough to clear gates, low
 *     enough that the cascade still suggests escalation when something bigger
 *     is wrong.
 *   - Bails on heuristics that would contradict Tier 1 (e.g. a nearby email
 *     already extracted). Tier 1 is more context-aware; Tier 1.5 is a net.
 */

import type {
  HeuristicParsedResume,
  FieldConfidence,
  PdfLinkAnnotation,
} from "./types.ts";
import { EMAIL_RE, LINKEDIN_RE } from "./regex.ts";
import { findFirstPhone, regionFromLocation } from "./phone.ts";

export interface RegexFallbackResult {
  parsed: HeuristicParsedResume;
  fieldConfidence: FieldConfidence;
  /** Which fields the fallback actually filled (for telemetry). */
  fieldsFilled: Array<"full_name" | "email" | "phone" | "linkedin_url">;
}

/**
 * Fill missing contact basics on a Tier 1 result by scanning raw text.
 *
 * The caller passes the Tier 1 output and the raw concatenated text. We only
 * write to fields the Tier 1 pass left empty.
 *
 * `annotations` is a last-chance LinkedIn signal for PDFs whose
 * visible LinkedIn text is just the word "LinkedIn" hyperlinked to the URL —
 * pdfjs's text path returns nothing useful, so neither Tier 1's
 * `extractContact` nor this tier's `LINKEDIN_RE` finds it. The annotation
 * still has the URL.
 */
export function runRegexFallback(
  tier1Parsed: HeuristicParsedResume,
  tier1Confidence: FieldConfidence,
  rawText: string,
  annotations: PdfLinkAnnotation[] = [],
): RegexFallbackResult {
  const parsed: HeuristicParsedResume = { ...tier1Parsed };
  const fieldConfidence: FieldConfidence = { ...tier1Confidence };
  const fieldsFilled: RegexFallbackResult["fieldsFilled"] = [];

  // Email — first match wins. Nearly zero false-positive risk.
  if (!parsed.email) {
    const email = firstMatch(EMAIL_RE, rawText);
    if (email) {
      parsed.email = email.toLowerCase();
      fieldConfidence.email = 0.7;
      fieldsFilled.push("email");
    }
  }

  // Phone — findFirstPhone runs PHONE_RE as a pre-filter then validates via
  // libphonenumber, so the digit-count gate is no longer needed.
  // Use tier-1's already-extracted location to derive region so intl
  // national-format numbers benefit from locale-aware parsing here too.
  if (!parsed.phone) {
    const region = regionFromLocation(parsed.location) ?? "US";
    const phoneResult = findFirstPhone(rawText, region);
    if (phoneResult) {
      parsed.phone = phoneResult.formatted;
      parsed.phoneIsValid = phoneResult.isValid;
      fieldConfidence.phone = 0.6;
      fieldsFilled.push("phone");
    }
  }

  // LinkedIn — try the text first (unambiguous URL pattern), then fall
  // through to annotations if nothing in the visible text matched.
  if (!parsed.linkedin_url) {
    const linkedin = firstMatch(LINKEDIN_RE, rawText);
    if (linkedin) {
      parsed.linkedin_url = normalizeUrl(linkedin);
      fieldConfidence.linkedin_url = 0.8;
      fieldsFilled.push("linkedin_url");
    } else {
      const annUrl = annotations.find((a) =>
        /linkedin\.com\/(in|pub)\//i.test(a.url),
      )?.url;
      if (annUrl) {
        parsed.linkedin_url = annUrl;
        fieldConfidence.linkedin_url = 0.95;
        fieldsFilled.push("linkedin_url");
      }
    }
  }

  // Name — trickiest. Only attempt when Tier 1 had no candidate at all. Use
  // the first non-empty line that has 2–4 title-case words and no digits.
  if (!parsed.full_name) {
    const name = guessNameFromFirstLines(rawText);
    if (name) {
      const { given, family } = splitName(name);
      parsed.full_name = name;
      if (given) parsed.given_name = given;
      if (family) parsed.family_name = family;
      fieldConfidence.full_name = 0.5;
      fieldsFilled.push("full_name");
    }
  }

  return { parsed, fieldConfidence, fieldsFilled };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function firstMatch(re: RegExp, text: string): string | undefined {
  re.lastIndex = 0;
  const m = re.exec(text);
  return m?.[0]?.trim();
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * Scan the first ~8 non-empty lines of raw text looking for something that
 * syntactically looks like a name. Intentionally strict — a wrong name at
 * 0.5 confidence is worse than a missing name.
 */
function guessNameFromFirstLines(rawText: string): string | undefined {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (const line of lines.slice(0, 8)) {
    if (line.length > 60) continue;
    if (/\d/.test(line)) continue;
    if (line.includes("@")) continue;
    const words = line.split(/\s+/);
    if (words.length < 2 || words.length > 4) continue;
    const titleCase = words.every((w) => /^[A-Z][a-zA-Z.\-']*$/.test(w));
    if (!titleCase) continue;
    const letterRatio = line.replace(/[^A-Za-z]/g, "").length / line.length;
    if (letterRatio < 0.7) continue;
    return line;
  }
  return undefined;
}

function splitName(fullName: string): { given?: string; family?: string } {
  const words = fullName.trim().split(/\s+/);
  if (words.length < 2) return {};
  return { given: words[0], family: words[words.length - 1] };
}
