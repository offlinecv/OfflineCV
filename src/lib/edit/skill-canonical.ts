// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * skill-canonical — a small, self-contained skills-name normalizer + suggester
 * for the "Add skill" affordance on the reconstructed resume (#176).
 *
 * SCOPE / PROVENANCE: this is a minimal in-repo placeholder, NOT the full
 * Recruidea skills taxonomy. It does case/whitespace normalization, folds a
 * small hand-curated alias map to a canonical display form (e.g. "JS" →
 * "JavaScript", "reactjs" → "React"), and offers cheap prefix/substring
 * suggestions over the union of (a) that canonical vocabulary and (b) the
 * skills already parsed off the current resume. The maintainer can swap `CANONICAL`
 * + `ALIASES` for the real taxonomy port without touching the call sites — the
 * exported function surface is the contract.
 *
 * Pure and dependency-free so it unit-tests directly and ships no PII/IP.
 */

/**
 * Canonical display spellings of common skills. Lower-cased on lookup; the
 * value here is the exact form rendered. Deliberately small — a seed, not a
 * taxonomy.
 */
const CANONICAL: readonly string[] = [
  "JavaScript",
  "TypeScript",
  "Python",
  "Java",
  "C++",
  "C#",
  "Go",
  "Rust",
  "Ruby",
  "PHP",
  "Swift",
  "Kotlin",
  "SQL",
  "HTML",
  "CSS",
  "React",
  "Vue",
  "Angular",
  "Node.js",
  "Next.js",
  "Django",
  "Flask",
  "Spring",
  "Express",
  "GraphQL",
  "REST",
  "Docker",
  "Kubernetes",
  "AWS",
  "Azure",
  "GCP",
  "Terraform",
  "PostgreSQL",
  "MySQL",
  "MongoDB",
  "Redis",
  "Git",
  "Linux",
  "CI/CD",
  "Machine Learning",
  "TensorFlow",
  "PyTorch",
  "Pandas",
  "NumPy",
  "Tailwind CSS",
  "Figma",
];

/**
 * Alias → canonical key. Keys are lower-cased; matched after the same
 * normalization the input goes through, so "react.js", "ReactJS", "react js"
 * all collapse here.
 */
const ALIASES: Readonly<Record<string, string>> = {
  js: "JavaScript",
  javascript: "JavaScript",
  ts: "TypeScript",
  typescript: "TypeScript",
  "react.js": "React",
  reactjs: "React",
  "react js": "React",
  "node js": "Node.js",
  nodejs: "Node.js",
  node: "Node.js",
  "next js": "Next.js",
  nextjs: "Next.js",
  py: "Python",
  golang: "Go",
  postgres: "PostgreSQL",
  postgresql: "PostgreSQL",
  k8s: "Kubernetes",
  ml: "Machine Learning",
  "machine learning": "Machine Learning",
  tf: "TensorFlow",
  gcp: "GCP",
  "google cloud": "GCP",
  "amazon web services": "AWS",
  tailwind: "Tailwind CSS",
  "tailwindcss": "Tailwind CSS",
  cicd: "CI/CD",
  "ci cd": "CI/CD",
};

/** Lower-case + collapse internal whitespace; the shared normalization key. */
function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Canonicalize a free-typed skill. Trims, collapses whitespace, then:
 *   - folds a known alias to its canonical display form, else
 *   - matches a canonical entry case-insensitively (returns the canonical
 *     casing), else
 *   - returns the user's trimmed/space-collapsed text verbatim (we never drop
 *     a skill we don't recognize — recall over precision).
 * Returns "" for blank input so callers can reject it.
 */
export function canonicalizeSkill(raw: string): string {
  const key = normalizeKey(raw);
  if (!key) return "";
  const alias = ALIASES[key];
  if (alias) return alias;
  const canonical = CANONICAL.find((c) => c.toLowerCase() === key);
  if (canonical) return canonical;
  // Unknown skill: keep the user's text, but with collapsed whitespace.
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Suggest up to `limit` canonical skills for a partial query, drawn from the
 * canonical vocabulary plus `existing` (skills already on the resume), case-
 * insensitively, excluding anything already in `existing`. Prefix matches rank
 * before substring matches. An empty query yields no suggestions.
 */
export function suggestSkills(
  query: string,
  existing: readonly string[],
  limit = 6,
): string[] {
  const q = normalizeKey(query);
  if (!q) return [];
  const have = new Set(existing.map((s) => s.toLowerCase()));
  const pool = new Set<string>(CANONICAL);
  for (const s of existing) pool.delete(s); // don't suggest exact dupes below

  const prefix: string[] = [];
  const substring: string[] = [];
  for (const candidate of pool) {
    const lc = candidate.toLowerCase();
    if (have.has(lc)) continue;
    if (lc.startsWith(q)) prefix.push(candidate);
    else if (lc.includes(q)) substring.push(candidate);
  }
  return [...prefix, ...substring].slice(0, limit);
}
