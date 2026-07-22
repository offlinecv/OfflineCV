// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * company-registry.ts — curated `company → ATS → slug` data (#532, slice 4
 * of the job-search-v2 epic #528).
 *
 * Sector tags reuse `Sector` from `./sector.ts` verbatim — this module does
 * NOT fork a second taxonomy. Slice 5 (#533) dynamic-imports this module
 * (same cascade-tier lazy-load discipline as `src/lib/heuristics/`) so the
 * payload never enters the entry chunk, and turns a `companiesForSector()`
 * result into live providers via the slice-1/2 adapter factories
 * (`makeGreenhouseProvider` / `makeLeverProvider` / `makeAshbyProvider`).
 *
 * Sourcing: hand-curated from each ATS vendor's public board directory and
 * general familiarity with well-known companies' public careers pages, one
 * company per entry, tagged with 1-2 sectors from `./sector.ts`. Curated
 * 2026-07-21; EXISTENCE-AUDITED 2026-07-22 (#533).
 *
 * EXISTENCE-audited, NOT CORS-verified — two different claims, do not
 * conflate them:
 *
 *  - What the audit proves: every entry below was fetched from its vendor
 *    endpoint and returned HTTP 200 with at least one real posting. The
 *    original curated list was 162 entries and only 68 of them resolved;
 *    46 were wrong about the VENDOR rather than the company (Notion is on
 *    Ashby, not Lever; Vercel on Greenhouse, not Ashby) and were corrected,
 *    and 48 whose board could not be found on any of the three vendors were
 *    REMOVED rather than left as known-404s. Two lookalike boards were also
 *    dropped after inspection: `ashby:rec` is a recreation-booking startup,
 *    not Rec Room, and `ashby:circle` carries no USDC/stablecoin signal, so
 *    it is not Circle Internet Financial.
 *  - What the audit does NOT prove: browser CORS. The audit ran over `curl`,
 *    which ignores CORS entirely, so a 200 here says the board EXISTS — not
 *    that a page on offlinecv.org may read it. Browser-origin CORS
 *    verification per vendor remains an open task (a human/dev step).
 *
 * Boards churn: a company can move ATS or close its board at any time, so a
 * stale entry is expected drift, not a bug. The wiring in `company-boards.ts`
 * treats a dead board as one degraded provider, never a failed search, so the
 * cost of drift stays bounded. A periodic re-verify pass is future work.
 *
 * STRUCTURAL LIMITATION — large self-hosted-careers employers (#542): Apple,
 * Google, Meta, and most other FAANG-scale companies run their own careers
 * site rather than a Greenhouse/Lever/Ashby board, so they cannot be added
 * here as-is — there is no API endpoint of the shape this registry (and
 * `company-boards.ts`) assumes. This is a structural boundary of the
 * three-vendor design, not a bug or a curation gap. Those employers are
 * reachable through `FindJobsPanel`'s "Search external boards" deep links
 * (LinkedIn / Indeed / Google Jobs), which crawl self-hosted sites too. A 4th
 * source (a scraper for company-owned careers pages) would close this gap
 * properly but is a separate, larger lane — see #542's "explicitly out of
 * scope".
 */

import type { Sector } from "./sector.ts";

/** ATS vendor identifier — maps 1:1 to the slice-1/2 adapter factories. */
export type Ats = "greenhouse" | "lever" | "ashby";

export interface CompanyEntry {
  /** Display name, e.g. "Stripe" — used for the provider label/source. */
  name: string;
  /** Which adapter factory builds this entry's provider. */
  ats: Ats;
  /** The ATS board slug, e.g. "stripe". */
  slug: string;
  /** One or more sectors this company belongs to (from `./sector.ts`). */
  sectors: Sector[];
}

/**
 * The curated registry. Order is deliberate and stable — `companiesForSector`
 * relies on declaration order for its deterministic result order.
 */
export const COMPANY_REGISTRY: readonly CompanyEntry[] = [
  // -- fintech ------------------------------------------------------------
  { name: "Stripe", ats: "greenhouse", slug: "stripe", sectors: ["fintech"] },
  { name: "Plaid", ats: "ashby", slug: "plaid", sectors: ["fintech"] },
  { name: "Robinhood", ats: "greenhouse", slug: "robinhood", sectors: ["fintech"] },
  { name: "Affirm", ats: "greenhouse", slug: "affirm", sectors: ["fintech"] },
  { name: "Chime", ats: "greenhouse", slug: "chime", sectors: ["fintech"] },
  { name: "Brex", ats: "greenhouse", slug: "brex", sectors: ["fintech"] },
  { name: "Ramp", ats: "ashby", slug: "ramp", sectors: ["fintech"] },
  { name: "Mercury", ats: "greenhouse", slug: "mercury", sectors: ["fintech"] },
  { name: "Coinbase", ats: "greenhouse", slug: "coinbase", sectors: ["fintech", "crypto-web3"] },
  { name: "Marqeta", ats: "greenhouse", slug: "marqeta", sectors: ["fintech"] },
  { name: "Wealthfront", ats: "lever", slug: "wealthfront", sectors: ["fintech"] },
  { name: "Gusto", ats: "greenhouse", slug: "gusto", sectors: ["fintech", "enterprise-saas"] },
  { name: "Carta", ats: "greenhouse", slug: "carta", sectors: ["fintech"] },

  // -- devtools -------------------------------------------------------------
  { name: "GitLab", ats: "greenhouse", slug: "gitlab", sectors: ["devtools"] },
  { name: "Docker", ats: "ashby", slug: "docker", sectors: ["devtools"] },
  { name: "Postman", ats: "greenhouse", slug: "postman", sectors: ["devtools"] },
  { name: "Vercel", ats: "greenhouse", slug: "vercel", sectors: ["devtools"] },
  { name: "Netlify", ats: "greenhouse", slug: "netlify", sectors: ["devtools"] },
  { name: "CircleCI", ats: "greenhouse", slug: "circleci", sectors: ["devtools"] },
  { name: "JFrog", ats: "greenhouse", slug: "jfrog", sectors: ["devtools"] },
  { name: "Sentry", ats: "ashby", slug: "sentry", sectors: ["devtools"] },
  { name: "LaunchDarkly", ats: "greenhouse", slug: "launchdarkly", sectors: ["devtools"] },
  { name: "Replit", ats: "ashby", slug: "replit", sectors: ["devtools"] },
  { name: "Warp", ats: "ashby", slug: "warp", sectors: ["devtools"] },

  // -- data-ml --------------------------------------------------------------
  { name: "Databricks", ats: "greenhouse", slug: "databricks", sectors: ["data-ml"] },
  { name: "Snowflake", ats: "ashby", slug: "snowflake", sectors: ["data-ml"] },
  { name: "Scale AI", ats: "greenhouse", slug: "scaleai", sectors: ["data-ml"] },
  { name: "Fivetran", ats: "greenhouse", slug: "fivetran", sectors: ["data-ml"] },
  { name: "Anthropic", ats: "greenhouse", slug: "anthropic", sectors: ["data-ml"] },
  { name: "Cohere", ats: "ashby", slug: "cohere", sectors: ["data-ml"] },
  { name: "Pinecone", ats: "ashby", slug: "pinecone", sectors: ["data-ml"] },
  { name: "Modal", ats: "ashby", slug: "modal", sectors: ["data-ml"] },

  // -- healthtech -------------------------------------------------------------
  { name: "Oscar Health", ats: "greenhouse", slug: "oscar", sectors: ["healthtech"] },
  { name: "Ro", ats: "lever", slug: "ro", sectors: ["healthtech"] },
  { name: "Cedar", ats: "ashby", slug: "cedar", sectors: ["healthtech"] },
  { name: "Zocdoc", ats: "greenhouse", slug: "zocdoc", sectors: ["healthtech"] },
  { name: "Included Health", ats: "lever", slug: "includedhealth", sectors: ["healthtech"] },
  { name: "Komodo Health", ats: "greenhouse", slug: "komodohealth", sectors: ["healthtech"] },
  { name: "Clover Health", ats: "greenhouse", slug: "cloverhealth", sectors: ["healthtech"] },
  { name: "Benchling", ats: "ashby", slug: "benchling", sectors: ["healthtech", "data-ml"] },
  { name: "Nuna", ats: "ashby", slug: "nuna", sectors: ["healthtech"] },
  { name: "Maven Clinic", ats: "greenhouse", slug: "mavenclinic", sectors: ["healthtech"] },

  // -- ecommerce --------------------------------------------------------------
  { name: "Instacart", ats: "greenhouse", slug: "instacart", sectors: ["ecommerce"] },
  { name: "Faire", ats: "greenhouse", slug: "faire", sectors: ["ecommerce"] },
  { name: "Glossier", ats: "greenhouse", slug: "glossier", sectors: ["ecommerce"] },
  { name: "Stitch Fix", ats: "greenhouse", slug: "stitchfix", sectors: ["ecommerce"] },
  { name: "Poshmark", ats: "ashby", slug: "poshmark", sectors: ["ecommerce"] },

  // -- gaming ---------------------------------------------------------------
  { name: "Discord", ats: "greenhouse", slug: "discord", sectors: ["gaming", "consumer-social"] },
  { name: "Roblox", ats: "greenhouse", slug: "roblox", sectors: ["gaming"] },
  { name: "Riot Games", ats: "greenhouse", slug: "riotgames", sectors: ["gaming"] },
  { name: "Twitch", ats: "greenhouse", slug: "twitch", sectors: ["gaming", "media-adtech"] },
  { name: "Epic Games", ats: "greenhouse", slug: "epicgames", sectors: ["gaming"] },
  { name: "Scopely", ats: "greenhouse", slug: "scopely", sectors: ["gaming"] },

  // -- security ---------------------------------------------------------------
  { name: "Okta", ats: "greenhouse", slug: "okta", sectors: ["security"] },
  { name: "1Password", ats: "ashby", slug: "1password", sectors: ["security"] },
  { name: "Wiz", ats: "greenhouse", slug: "wizinc", sectors: ["security"] },
  { name: "Vanta", ats: "ashby", slug: "vanta", sectors: ["security"] },
  { name: "Tailscale", ats: "greenhouse", slug: "tailscale", sectors: ["security", "devtools"] },
  { name: "Netskope", ats: "greenhouse", slug: "netskope", sectors: ["security"] },
  { name: "Datadog", ats: "greenhouse", slug: "datadog", sectors: ["security", "devtools"] },

  // -- enterprise-saas --------------------------------------------------------
  { name: "Asana", ats: "greenhouse", slug: "asana", sectors: ["enterprise-saas"] },
  { name: "Notion", ats: "ashby", slug: "notion", sectors: ["enterprise-saas"] },
  { name: "Airtable", ats: "greenhouse", slug: "airtable", sectors: ["enterprise-saas"] },
  { name: "Zapier", ats: "ashby", slug: "zapier", sectors: ["enterprise-saas"] },
  { name: "Calendly", ats: "greenhouse", slug: "calendly", sectors: ["enterprise-saas"] },
  { name: "Checkr", ats: "greenhouse", slug: "checkr", sectors: ["enterprise-saas"] },
  { name: "Samsara", ats: "greenhouse", slug: "samsara", sectors: ["enterprise-saas", "hardware-iot"] },
  { name: "Figma", ats: "greenhouse", slug: "figma", sectors: ["enterprise-saas", "consumer-social"] },
  { name: "Miro", ats: "ashby", slug: "miro", sectors: ["enterprise-saas"] },

  // -- consumer-social ----------------------------------------------------
  { name: "Reddit", ats: "greenhouse", slug: "reddit", sectors: ["consumer-social"] },
  { name: "Pinterest", ats: "greenhouse", slug: "pinterest", sectors: ["consumer-social"] },
  { name: "Medium", ats: "greenhouse", slug: "medium", sectors: ["consumer-social"] },
  { name: "Patreon", ats: "ashby", slug: "patreon", sectors: ["consumer-social"] },
  { name: "Quora", ats: "ashby", slug: "quora", sectors: ["consumer-social"] },
  { name: "Duolingo", ats: "greenhouse", slug: "duolingo", sectors: ["consumer-social", "edtech"] },
  { name: "Nextdoor", ats: "greenhouse", slug: "nextdoor", sectors: ["consumer-social"] },
  { name: "Bumble", ats: "lever", slug: "bumbleinc", sectors: ["consumer-social"] },
  { name: "Strava", ats: "ashby", slug: "strava", sectors: ["consumer-social"] },
  { name: "Cameo", ats: "greenhouse", slug: "cameo", sectors: ["consumer-social"] },

  // -- hardware-iot -----------------------------------------------------------
  { name: "Skydio", ats: "ashby", slug: "skydio", sectors: ["hardware-iot"] },
  { name: "Verkada", ats: "greenhouse", slug: "verkada", sectors: ["hardware-iot", "security"] },
  { name: "Bird", ats: "greenhouse", slug: "bird", sectors: ["hardware-iot", "logistics-mobility"] },
  { name: "Astranis", ats: "greenhouse", slug: "astranis", sectors: ["hardware-iot"] },

  // -- crypto-web3 --------------------------------------------------------------
  { name: "Uniswap Labs", ats: "ashby", slug: "uniswap", sectors: ["crypto-web3"] },
  { name: "Consensys", ats: "greenhouse", slug: "consensys", sectors: ["crypto-web3"] },
  { name: "Alchemy", ats: "ashby", slug: "alchemy", sectors: ["crypto-web3", "devtools"] },
  { name: "OpenSea", ats: "ashby", slug: "opensea", sectors: ["crypto-web3"] },
  { name: "Anchorage Digital", ats: "lever", slug: "anchorage", sectors: ["crypto-web3"] },
  { name: "Ripple", ats: "greenhouse", slug: "ripple", sectors: ["crypto-web3", "fintech"] },
  { name: "Gemini", ats: "greenhouse", slug: "gemini", sectors: ["crypto-web3"] },

  // -- edtech -----------------------------------------------------------------
  { name: "Coursera", ats: "greenhouse", slug: "coursera", sectors: ["edtech"] },
  { name: "Udemy", ats: "greenhouse", slug: "udemy", sectors: ["edtech"] },
  { name: "Khan Academy", ats: "greenhouse", slug: "khanacademy", sectors: ["edtech"] },
  { name: "Outschool", ats: "greenhouse", slug: "outschool", sectors: ["edtech"] },
  { name: "Guild Education", ats: "greenhouse", slug: "guild", sectors: ["edtech"] },
  { name: "Handshake", ats: "ashby", slug: "handshake", sectors: ["edtech"] },
  { name: "ClassDojo", ats: "ashby", slug: "classdojo", sectors: ["edtech"] },

  // -- logistics-mobility -------------------------------------------------
  { name: "Flexport", ats: "greenhouse", slug: "flexport", sectors: ["logistics-mobility"] },
  { name: "Gopuff", ats: "lever", slug: "gopuff", sectors: ["logistics-mobility", "ecommerce"] },
  { name: "Route", ats: "greenhouse", slug: "route", sectors: ["logistics-mobility", "ecommerce"] },
  { name: "Loadsmart", ats: "lever", slug: "loadsmart", sectors: ["logistics-mobility"] },
  { name: "Fleetio", ats: "greenhouse", slug: "fleetio", sectors: ["logistics-mobility"] },

  // -- media-adtech -------------------------------------------------------------
  { name: "Spotify", ats: "lever", slug: "spotify", sectors: ["media-adtech", "consumer-social"] },
  { name: "The Trade Desk", ats: "greenhouse", slug: "thetradedesk", sectors: ["media-adtech"] },
  { name: "Roku", ats: "greenhouse", slug: "roku", sectors: ["media-adtech"] },
  { name: "Buzzfeed", ats: "greenhouse", slug: "buzzfeed", sectors: ["media-adtech"] },
  { name: "Taboola", ats: "greenhouse", slug: "taboola", sectors: ["media-adtech"] },
  { name: "Chartbeat", ats: "greenhouse", slug: "chartbeatinc", sectors: ["media-adtech"] },

  // -- government-defense -------------------------------------------------
  { name: "Palantir", ats: "lever", slug: "palantir", sectors: ["government-defense", "data-ml"] },
  { name: "Shield AI", ats: "lever", slug: "shieldai", sectors: ["government-defense"] },
  { name: "Saildrone", ats: "greenhouse", slug: "saildroneinc", sectors: ["government-defense", "hardware-iot"] },
  { name: "HawkEye 360", ats: "greenhouse", slug: "hawkeye360", sectors: ["government-defense"] },
  { name: "Second Front Systems", ats: "ashby", slug: "second-front-systems", sectors: ["government-defense"] },
  { name: "Vannevar Labs", ats: "greenhouse", slug: "vannevarlabs", sectors: ["government-defense"] },
];

/**
 * Up to `limit` registry entries tagged with `sector`, in stable declaration
 * order (deterministic across calls — the fan-out cap in #533 relies on it).
 */
export function companiesForSector(sector: Sector, limit: number): CompanyEntry[] {
  const result: CompanyEntry[] = [];
  for (const entry of COMPANY_REGISTRY) {
    if (result.length >= limit) break;
    if (entry.sectors.includes(sector)) result.push(entry);
  }
  return result;
}
