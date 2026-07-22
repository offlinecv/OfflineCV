// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * sector.ts — classify a parsed resume into a company sector (#531, slice 3
 * of the job-search-v2 epic #528).
 *
 * `Sector` is the SINGLE SOURCE OF TRUTH for "which companies" (fintech,
 * devtools, healthtech, …) — distinct from #534's `RoleFamily`, which
 * partitions roles WITHIN a board. Slice 4's company registry tags each
 * company with a `Sector` drawn from this same list; slice 5 uses the guess
 * to pick which registry companies to search.
 *
 * Fallback invariant: the heuristic path (`classifySectorHeuristic`) is pure,
 * synchronous, and always answers — `"other"` is the floor, so classification
 * never fails closed. The semantic path (`classifySector`) is a strict
 * upgrade: it is only attempted when WebGPU capability detection says a
 * model can run, and ANY failure — no WebGPU, model not ready, a throw, an
 * off-taxonomy response — resolves to the heuristic guess unchanged. Mirrors
 * the semantic-with-keyword-fallback shape `src/lib/jd-match/llm/run-llm-match.ts`
 * uses for JD matching. WebLLM weights are dynamic-imported (the cascade-tier
 * pattern) so they never enter the entry chunk.
 *
 * Classification is pure over the parsed resume model (`skills` +
 * `experience[].title`/`company`) — no raw-PDF text, no network access.
 */

import type { HeuristicParsedResume } from "../heuristics/types.ts";

/**
 * Fixed sector taxonomy — ~12–16 entries chosen to partition the company
 * registry (slice 4), not to be exhaustive. `"other"` is the always-valid
 * fallback. Reused verbatim by the registry's sector tags — do not fork a
 * second copy of this list.
 */
export const SECTORS = [
  "fintech",
  "devtools",
  "data-ml",
  "healthtech",
  "ecommerce",
  "gaming",
  "security",
  "enterprise-saas",
  "consumer-social",
  "hardware-iot",
  "crypto-web3",
  "edtech",
  "logistics-mobility",
  "media-adtech",
  "government-defense",
  "other",
] as const;

export type Sector = (typeof SECTORS)[number];

const SECTOR_SET: ReadonlySet<string> = new Set(SECTORS);

/** Type guard: is `value` one of the fixed `Sector` literals? */
export function isSector(value: unknown): value is Sector {
  return typeof value === "string" && SECTOR_SET.has(value);
}

export interface SectorGuess {
  sector: Sector;
  /** 0..1. Low/zero when the guess fell to the `"other"` floor. */
  confidence: number;
  source: "heuristic" | "semantic";
  /** Second-best sector, when one cleared the floor alongside the winner —
   *  feeds a "not fintech? try devtools" UI affordance in slice 5. */
  runnerUp?: Sector;
}

/**
 * Weighted keyword table: sector → patterns matched against a lowercased
 * haystack of skills + experience titles (+ lightly, company names). A hit
 * count below `HEURISTIC_FLOOR` falls to `"other"`.
 *
 * Patterns are phrases, not bare nouns, wherever the bare noun belongs to
 * another family's vocabulary: "data warehouse" is data-ml, not logistics;
 * "Kafka streaming" is data-ml, not media; "NFT marketplace" is crypto, not
 * ecommerce. A single-token pattern that cross-matches like that fires on one
 * unrelated skill and, with `HEURISTIC_FLOOR = 1`, decides the sector outright.
 */
const SECTOR_KEYWORDS: Readonly<Record<Exclude<Sector, "other">, RegExp[]>> = {
  fintech: [
    /\bpayments?\b/, /\bledger\b/, /\bkyc\b/, /\btrading\b/, /\bbanking\b/,
    /\bfintech\b/, /\bpayment processing\b/, /\bwire transfer\b/,
    /\bunderwriting\b/, /\bfraud detection\b/, /\bplaid\b/, /\bstripe\b/,
  ],
  devtools: [
    /\bci\/cd\b/, /\bsdk\b/, /\bdeveloper experience\b/, /\bcompiler\b/,
    /\bkubernetes\b/, /\bdevex\b/, /\bcli\b/, /\bbuild system\b/,
    /\blinter\b/, /\bide\b/, /\bdeveloper tools?\b/, /\bapi platform\b/,
  ],
  "data-ml": [
    /\bmachine learning\b/, /\bpytorch\b/, /\betl\b/, /\bspark\b/,
    /\bllm\b/, /\bdata pipeline\b/, /\btensorflow\b/, /\bmlops\b/,
    /\bfeature store\b/, /\bdata warehouse\b/, /\bdata science\b/,
    /\bnlp\b/,
  ],
  healthtech: [
    /\bhealthcare\b/, /\bclinical\b/, /\bhipaa\b/, /\behr\b/, /\bemr\b/,
    /\bpatient\b/, /\btelehealth\b/, /\bpharma(?:ceutical)?\b/,
    /\bmedical device\b/, /\bfhir\b/,
  ],
  ecommerce: [
    /\becommerce\b/, /\be-commerce\b/, /\bcheckout\b/, /\bshopping cart\b/,
    /\bmerchandising\b/, /\bshopify\b/, /\bfulfillment\b/,
    /\b(?:online|retail|seller|consumer) marketplace\b/,
    /\bmarketplace (?:platform|operations)\b/,
    /\binventory management\b/,
  ],
  gaming: [
    /\bgame (?:engine|design|development)\b/, /\bunity3d\b/, /\bunreal engine\b/,
    /\bgameplay\b/, /\bmultiplayer\b/, /\besports\b/, /\bgame studio\b/,
  ],
  security: [
    /\bcybersecurity\b/, /\bpenetration testing\b/, /\bthreat detection\b/,
    /\bsoc 2\b/, /\bvulnerability\b/, /\bincident response\b/,
    /\bzero trust\b/, /\biam\b/, /\bsiem\b/,
  ],
  "enterprise-saas": [
    /\benterprise saas\b/, /\bb2b saas\b/, /\bcrm\b/, /\berp\b/,
    /\bworkflow automation\b/, /\bsalesforce\b/, /\bhrms\b/, /\bsso\b/,
  ],
  "consumer-social": [
    /\bsocial media\b/, /\bsocial network\b/, /\buser engagement\b/,
    /\bconsumer app\b/, /\bcontent feed\b/, /\bcreator economy\b/,
    /\bdating app\b/,
  ],
  "hardware-iot": [
    /\biot\b/, /\bfirmware\b/, /\bembedded systems?\b/, /\brobotics\b/,
    /\bpcb\b/, /\bsensors?\b/, /\bwearables?\b/, /\bhardware engineering\b/,
  ],
  "crypto-web3": [
    /\bblockchain\b/, /\bweb3\b/, /\bcrypto(?:currency)?\b/,
    /\bsmart contracts?\b/, /\bsolidity\b/, /\bdefi\b/, /\bnft\b/,
  ],
  edtech: [
    /\bedtech\b/, /\be-?learning\b/, /\bcurriculum\b/, /\blms\b/,
    /\bonline courses?\b/, /\bstudent engagement\b/,
  ],
  "logistics-mobility": [
    /\blogistics\b/, /\bsupply chain\b/, /\bfleet management\b/,
    /\bride-?sharing\b/, /\blast mile\b/, /\bfreight\b/,
    /\bwarehouse (?:management|operations|automation)\b/,
    /\broute optimization\b/,
  ],
  "media-adtech": [
    /\badtech\b/, /\bad tech\b/, /\bprogrammatic advertising\b/,
    /\bpublishing platform\b/, /\bmedia platform\b/,
    /\b(?:video|live|music) streaming\b/, /\bstreaming (?:platform|service)s?\b/,
    /\bad network\b/, /\bcontent monetization\b/,
  ],
  "government-defense": [
    /\bgovernment contract\b/, /\bdefense\b/, /\bfedramp\b/, /\bdod\b/,
    /\bpublic sector\b/, /\bclearance required\b/, /\bcivic tech\b/,
    /\bmilitary\b/,
  ],
};

/** Minimum weighted hit count a sector needs to beat the `"other"` floor. */
const HEURISTIC_FLOOR = 1;

/** Hit count at which the winner's evidence factor saturates at 1.0. Below it,
 *  confidence is scaled down proportionally — see `classifySectorHeuristic`. */
const CONFIDENT_HITS = 3;

/** Declaration-order index of a sector, for the deterministic tie-break.
 *  Mirrors `role-keywords.ts`'s `FAMILY_ORDER`. */
const SECTOR_ORDER: ReadonlyMap<Exclude<Sector, "other">, number> = new Map(
  (Object.keys(SECTOR_KEYWORDS) as Array<Exclude<Sector, "other">>).map(
    (sector, index) => [sector, index],
  ),
);

/** Build the lowercased haystack the heuristic scans: skills, experience
 *  titles, and (lightly — same weight as titles) company names. */
function buildHaystack(parsed: HeuristicParsedResume): string {
  const parts: string[] = [];
  if (parsed.skills && parsed.skills.length > 0) {
    parts.push(parsed.skills.join(" "));
  }
  for (const exp of parsed.experience ?? []) {
    if (exp.title) parts.push(exp.title);
    if (exp.company) parts.push(exp.company);
  }
  return parts.join(" ").toLowerCase();
}

/** Weighted hit count for one sector's keyword table over `haystack`. */
function scoreSector(haystack: string, patterns: readonly RegExp[]): number {
  let score = 0;
  for (const pattern of patterns) {
    if (pattern.test(haystack)) score += 1;
  }
  return score;
}

/**
 * Heuristic classifier — always available, pure, synchronous. Scores every
 * non-"other" sector by weighted keyword hit count over skills + titles (+
 * lightly, company names), picks the top scorer, and falls to `"other"` when
 * nothing clears `HEURISTIC_FLOOR`. `runnerUp` is set when a second sector
 * also clears the floor.
 */
export function classifySectorHeuristic(
  parsed: HeuristicParsedResume,
): SectorGuess {
  const haystack = buildHaystack(parsed);

  const scored: Array<{ sector: Exclude<Sector, "other">; score: number }> =
    (Object.keys(SECTOR_KEYWORDS) as Array<Exclude<Sector, "other">>).map(
      (sector) => ({ sector, score: scoreSector(haystack, SECTOR_KEYWORDS[sector]) }),
    );

  // Deterministic tie-break: score desc, then taxonomy order (declaration
  // order in SECTOR_KEYWORDS, which mirrors SECTORS) as an explicit secondary
  // key — the ordering does not lean on Array.sort stability.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (SECTOR_ORDER.get(a.sector) ?? 0) - (SECTOR_ORDER.get(b.sector) ?? 0),
  );

  const top = scored[0];
  if (!top || top.score < HEURISTIC_FLOOR) {
    return { sector: "other", confidence: 0, source: "heuristic" };
  }

  const runnerUpCandidate = scored[1];
  const runnerUp =
    runnerUpCandidate && runnerUpCandidate.score >= HEURISTIC_FLOOR
      ? runnerUpCandidate.sector
      : undefined;

  // Confidence has two independent factors, and it needs both:
  //   share    — top score's slice of the top-two total, so a near-tie reads
  //              as low confidence.
  //   evidence — how much absolute evidence the winner rests on, saturating
  //              at CONFIDENT_HITS.
  // Share alone inverts: every sector is scored, so a resume matching exactly
  // one keyword has second === 0 and share === 1.0 — maximum confidence off a
  // single hit — while a genuine 3-vs-2 match reads 0.6. Multiplying by the
  // evidence factor makes confidence monotone in absolute evidence, so one
  // stray hit lands at 1/CONFIDENT_HITS, below any well-evidenced guess.
  const second = runnerUpCandidate?.score ?? 0;
  const share = top.score / (top.score + second);
  const evidence = Math.min(1, top.score / CONFIDENT_HITS);
  const confidence = share * evidence;

  return {
    sector: top.sector,
    confidence,
    source: "heuristic",
    ...(runnerUp ? { runnerUp } : {}),
  };
}

const SECTOR_LIST_FOR_PROMPT = SECTORS.join(", ");

const SEMANTIC_SYSTEM_PROMPT =
  "You classify a resume's most likely target company sector for a job " +
  "search. Respond with ONLY a JSON object of the shape " +
  '{"sector": "<one value>"} where <one value> is EXACTLY one of: ' +
  `${SECTOR_LIST_FOR_PROMPT}. If none clearly fit, use "other". No prose, ` +
  "no markdown fences, no explanation.";

function buildSemanticUserPrompt(parsed: HeuristicParsedResume): string {
  const skills = (parsed.skills ?? []).join(", ");
  const titles = (parsed.experience ?? [])
    .map((exp) => [exp.title, exp.company].filter(Boolean).join(" @ "))
    .filter(Boolean)
    .join("; ");
  return `Skills: ${skills || "(none)"}\nRoles: ${titles || "(none)"}`;
}

/** Headroom for a single short JSON object response. */
const SEMANTIC_MAX_TOKENS = 64;

/**
 * Semantic upgrade over `classifySectorHeuristic`. Gates on WebGPU
 * capability (`src/lib/webllm/capability.ts`); on `"no-webgpu"` /
 * `"unsupported-os"` it returns the heuristic guess immediately without
 * touching WebLLM. When a model is available, dynamic-imports the engine
 * loader, asks it to pick one taxonomy value, and validates the response
 * against `SECTORS` — anything off-enum, unparseable, or a thrown/timed-out
 * engine call falls back to the heuristic guess unchanged. Never rejects.
 */
export async function classifySector(
  parsed: HeuristicParsedResume,
): Promise<SectorGuess> {
  const heuristic = classifySectorHeuristic(parsed);

  try {
    const { detectWebGpu } = await import("../webllm/capability.ts");
    const capability = await detectWebGpu();
    if (capability !== "available") return heuristic;

    const [
      { loadEngine, acquireInference, releaseInference },
      { DEFAULT_MODEL_ID },
      { tryParseJsonObject },
    ] = await Promise.all([
      import("../webllm/web-llm.ts"),
      import("../webllm/models.ts"),
      import("../webllm/json-repair.ts"),
    ]);

    acquireInference(DEFAULT_MODEL_ID);
    try {
      const engine = await loadEngine(DEFAULT_MODEL_ID, () => {});
      const response = await engine.chat.completions.create({
        messages: [
          { role: "system", content: SEMANTIC_SYSTEM_PROMPT },
          { role: "user", content: buildSemanticUserPrompt(parsed) },
        ],
        temperature: 0,
        max_tokens: SEMANTIC_MAX_TOKENS,
      });
      const content = response.choices[0]?.message?.content ?? "";
      const outcome = tryParseJsonObject(content);
      if (!outcome.ok || typeof outcome.value !== "object" || outcome.value === null) {
        return heuristic;
      }
      const candidate = (outcome.value as Record<string, unknown>)["sector"];
      if (!isSector(candidate)) return heuristic;

      return {
        sector: candidate,
        confidence: 1,
        source: "semantic",
        ...(heuristic.sector !== candidate ? { runnerUp: heuristic.sector } : {}),
      };
    } finally {
      releaseInference(DEFAULT_MODEL_ID);
    }
  } catch (err) {
    console.warn(
      "[sector] semantic classification failed; falling back to heuristic:",
      err,
    );
    return heuristic;
  }
}
