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
 * 2026-07-21.
 *
 * IMPORTANT — slugs are NOT CORS-verified. Unlike the slice-1/2 adapters
 * (whose docblocks note "unverified from a browser origin" pending a live
 * check), these slugs have not even been curl-checked for existence; they
 * are a best-effort curated list. #533 (the live wiring slice) is expected
 * to browser-verify each board it actually queries and silently drop any
 * slug that 404s or fails CORS — a dead entry here costs nothing worse than
 * an empty search result. Treat this list as "plausible, needs-verification"
 * data, not a source of truth for "company X uses ATS Y". A periodic
 * re-verify/refresh pass is future work, not this slice.
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
  { name: "Plaid", ats: "greenhouse", slug: "plaid", sectors: ["fintech"] },
  { name: "Robinhood", ats: "greenhouse", slug: "robinhood", sectors: ["fintech"] },
  { name: "Affirm", ats: "greenhouse", slug: "affirm", sectors: ["fintech"] },
  { name: "Chime", ats: "greenhouse", slug: "chime", sectors: ["fintech"] },
  { name: "Brex", ats: "greenhouse", slug: "brex", sectors: ["fintech"] },
  { name: "Ramp", ats: "ashby", slug: "ramp", sectors: ["fintech"] },
  { name: "Mercury", ats: "ashby", slug: "mercury", sectors: ["fintech"] },
  { name: "Coinbase", ats: "greenhouse", slug: "coinbase", sectors: ["fintech", "crypto-web3"] },
  { name: "Marqeta", ats: "greenhouse", slug: "marqeta", sectors: ["fintech"] },
  { name: "Wealthfront", ats: "greenhouse", slug: "wealthfront", sectors: ["fintech"] },
  { name: "Klarna", ats: "lever", slug: "klarna", sectors: ["fintech"] },
  { name: "Gusto", ats: "greenhouse", slug: "gusto", sectors: ["fintech", "enterprise-saas"] },
  { name: "Carta", ats: "greenhouse", slug: "carta", sectors: ["fintech"] },

  // -- devtools -------------------------------------------------------------
  { name: "GitLab", ats: "greenhouse", slug: "gitlab", sectors: ["devtools"] },
  { name: "GitHub", ats: "greenhouse", slug: "github", sectors: ["devtools"] },
  { name: "HashiCorp", ats: "greenhouse", slug: "hashicorp", sectors: ["devtools"] },
  { name: "Docker", ats: "greenhouse", slug: "docker", sectors: ["devtools"] },
  { name: "Postman", ats: "lever", slug: "postman", sectors: ["devtools"] },
  { name: "Vercel", ats: "ashby", slug: "vercel", sectors: ["devtools"] },
  { name: "Netlify", ats: "lever", slug: "netlify", sectors: ["devtools"] },
  { name: "CircleCI", ats: "greenhouse", slug: "circleci", sectors: ["devtools"] },
  { name: "JFrog", ats: "greenhouse", slug: "jfrog", sectors: ["devtools"] },
  { name: "Sentry", ats: "greenhouse", slug: "sentry", sectors: ["devtools"] },
  { name: "LaunchDarkly", ats: "greenhouse", slug: "launchdarkly", sectors: ["devtools"] },
  { name: "Replit", ats: "ashby", slug: "replit", sectors: ["devtools"] },
  { name: "Warp", ats: "ashby", slug: "warp", sectors: ["devtools"] },

  // -- data-ml --------------------------------------------------------------
  { name: "Databricks", ats: "greenhouse", slug: "databricks", sectors: ["data-ml"] },
  { name: "Snowflake", ats: "greenhouse", slug: "snowflake", sectors: ["data-ml"] },
  { name: "Scale AI", ats: "ashby", slug: "scaleai", sectors: ["data-ml"] },
  { name: "Weights & Biases", ats: "greenhouse", slug: "wandb", sectors: ["data-ml"] },
  { name: "Hugging Face", ats: "lever", slug: "huggingface", sectors: ["data-ml"] },
  { name: "DataRobot", ats: "greenhouse", slug: "datarobot", sectors: ["data-ml"] },
  { name: "Fivetran", ats: "greenhouse", slug: "fivetran", sectors: ["data-ml"] },
  { name: "dbt Labs", ats: "greenhouse", slug: "dbtlabs", sectors: ["data-ml"] },
  { name: "Anthropic", ats: "greenhouse", slug: "anthropic", sectors: ["data-ml"] },
  { name: "Cohere", ats: "ashby", slug: "cohere", sectors: ["data-ml"] },
  { name: "Pinecone", ats: "ashby", slug: "pinecone", sectors: ["data-ml"] },
  { name: "Modal", ats: "ashby", slug: "modal", sectors: ["data-ml"] },

  // -- healthtech -------------------------------------------------------------
  { name: "Oscar Health", ats: "greenhouse", slug: "oscarhealth", sectors: ["healthtech"] },
  { name: "Ro", ats: "greenhouse", slug: "ro", sectors: ["healthtech"] },
  { name: "Cedar", ats: "greenhouse", slug: "cedar", sectors: ["healthtech"] },
  { name: "Tempus", ats: "greenhouse", slug: "tempus", sectors: ["healthtech"] },
  { name: "Zocdoc", ats: "greenhouse", slug: "zocdoc", sectors: ["healthtech"] },
  { name: "Included Health", ats: "greenhouse", slug: "includedhealth", sectors: ["healthtech"] },
  { name: "Komodo Health", ats: "greenhouse", slug: "komodohealth", sectors: ["healthtech"] },
  { name: "Clover Health", ats: "greenhouse", slug: "cloverhealth", sectors: ["healthtech"] },
  { name: "Benchling", ats: "greenhouse", slug: "benchling", sectors: ["healthtech", "data-ml"] },
  { name: "Devoted Health", ats: "greenhouse", slug: "devotedhealth", sectors: ["healthtech"] },
  { name: "Nuna", ats: "lever", slug: "nuna", sectors: ["healthtech"] },
  { name: "Maven Clinic", ats: "greenhouse", slug: "mavenclinic", sectors: ["healthtech"] },

  // -- ecommerce --------------------------------------------------------------
  { name: "Shopify", ats: "lever", slug: "shopify", sectors: ["ecommerce"] },
  { name: "Wayfair", ats: "greenhouse", slug: "wayfair", sectors: ["ecommerce"] },
  { name: "Instacart", ats: "greenhouse", slug: "instacart", sectors: ["ecommerce"] },
  { name: "Faire", ats: "greenhouse", slug: "faire", sectors: ["ecommerce"] },
  { name: "Whatnot", ats: "ashby", slug: "whatnot", sectors: ["ecommerce", "consumer-social"] },
  { name: "Allbirds", ats: "greenhouse", slug: "allbirds", sectors: ["ecommerce"] },
  { name: "Warby Parker", ats: "greenhouse", slug: "warbyparker", sectors: ["ecommerce"] },
  { name: "Glossier", ats: "lever", slug: "glossier", sectors: ["ecommerce"] },
  { name: "Stitch Fix", ats: "greenhouse", slug: "stitchfix", sectors: ["ecommerce"] },
  { name: "Chewy", ats: "greenhouse", slug: "chewy", sectors: ["ecommerce"] },
  { name: "Poshmark", ats: "greenhouse", slug: "poshmark", sectors: ["ecommerce"] },

  // -- gaming ---------------------------------------------------------------
  { name: "Discord", ats: "greenhouse", slug: "discord", sectors: ["gaming", "consumer-social"] },
  { name: "Roblox", ats: "greenhouse", slug: "roblox", sectors: ["gaming"] },
  { name: "Riot Games", ats: "greenhouse", slug: "riotgames", sectors: ["gaming"] },
  { name: "Unity", ats: "greenhouse", slug: "unity", sectors: ["gaming"] },
  { name: "Niantic", ats: "greenhouse", slug: "niantic", sectors: ["gaming"] },
  { name: "Twitch", ats: "greenhouse", slug: "twitch", sectors: ["gaming", "media-adtech"] },
  { name: "Epic Games", ats: "greenhouse", slug: "epicgames", sectors: ["gaming"] },
  { name: "Scopely", ats: "greenhouse", slug: "scopely", sectors: ["gaming"] },
  { name: "Zynga", ats: "greenhouse", slug: "zynga", sectors: ["gaming"] },
  { name: "Rec Room", ats: "ashby", slug: "recroom", sectors: ["gaming"] },

  // -- security ---------------------------------------------------------------
  { name: "CrowdStrike", ats: "greenhouse", slug: "crowdstrike", sectors: ["security"] },
  { name: "Okta", ats: "greenhouse", slug: "okta", sectors: ["security"] },
  { name: "SentinelOne", ats: "greenhouse", slug: "sentinelone", sectors: ["security"] },
  { name: "1Password", ats: "lever", slug: "1password", sectors: ["security"] },
  { name: "Snyk", ats: "greenhouse", slug: "snyk", sectors: ["security", "devtools"] },
  { name: "Wiz", ats: "ashby", slug: "wiz", sectors: ["security"] },
  { name: "Vanta", ats: "ashby", slug: "vanta", sectors: ["security"] },
  { name: "Tailscale", ats: "ashby", slug: "tailscale", sectors: ["security", "devtools"] },
  { name: "Netskope", ats: "greenhouse", slug: "netskope", sectors: ["security"] },
  { name: "Rapid7", ats: "greenhouse", slug: "rapid7", sectors: ["security"] },
  { name: "Datadog", ats: "greenhouse", slug: "datadog", sectors: ["security", "devtools"] },

  // -- enterprise-saas --------------------------------------------------------
  { name: "Asana", ats: "greenhouse", slug: "asana", sectors: ["enterprise-saas"] },
  { name: "Notion", ats: "lever", slug: "notion", sectors: ["enterprise-saas"] },
  { name: "Airtable", ats: "greenhouse", slug: "airtable", sectors: ["enterprise-saas"] },
  { name: "Zapier", ats: "lever", slug: "zapier", sectors: ["enterprise-saas"] },
  { name: "DocuSign", ats: "greenhouse", slug: "docusign", sectors: ["enterprise-saas"] },
  { name: "Calendly", ats: "lever", slug: "calendly", sectors: ["enterprise-saas"] },
  { name: "Rippling", ats: "ashby", slug: "rippling", sectors: ["enterprise-saas"] },
  { name: "Checkr", ats: "greenhouse", slug: "checkr", sectors: ["enterprise-saas"] },
  { name: "Samsara", ats: "greenhouse", slug: "samsara", sectors: ["enterprise-saas", "hardware-iot"] },
  { name: "Figma", ats: "greenhouse", slug: "figma", sectors: ["enterprise-saas", "consumer-social"] },
  { name: "Monday.com", ats: "lever", slug: "monday", sectors: ["enterprise-saas"] },
  { name: "Miro", ats: "greenhouse", slug: "miro", sectors: ["enterprise-saas"] },
  { name: "Coda", ats: "ashby", slug: "coda", sectors: ["enterprise-saas"] },

  // -- consumer-social ----------------------------------------------------
  { name: "Reddit", ats: "greenhouse", slug: "reddit", sectors: ["consumer-social"] },
  { name: "Pinterest", ats: "greenhouse", slug: "pinterest", sectors: ["consumer-social"] },
  { name: "Medium", ats: "lever", slug: "medium", sectors: ["consumer-social"] },
  { name: "Patreon", ats: "lever", slug: "patreon", sectors: ["consumer-social"] },
  { name: "Quora", ats: "lever", slug: "quora", sectors: ["consumer-social"] },
  { name: "Duolingo", ats: "greenhouse", slug: "duolingo", sectors: ["consumer-social", "edtech"] },
  { name: "Nextdoor", ats: "greenhouse", slug: "nextdoor", sectors: ["consumer-social"] },
  { name: "Bumble", ats: "greenhouse", slug: "bumble", sectors: ["consumer-social"] },
  { name: "Strava", ats: "greenhouse", slug: "strava", sectors: ["consumer-social"] },
  { name: "Letterboxd", ats: "ashby", slug: "letterboxd", sectors: ["consumer-social"] },
  { name: "Cameo", ats: "greenhouse", slug: "cameo", sectors: ["consumer-social"] },

  // -- hardware-iot -----------------------------------------------------------
  { name: "Anduril", ats: "ashby", slug: "anduril", sectors: ["hardware-iot", "government-defense"] },
  { name: "Ouster", ats: "greenhouse", slug: "ouster", sectors: ["hardware-iot"] },
  { name: "Skydio", ats: "greenhouse", slug: "skydio", sectors: ["hardware-iot"] },
  { name: "Zipline", ats: "greenhouse", slug: "zipline", sectors: ["hardware-iot"] },
  { name: "Verkada", ats: "greenhouse", slug: "verkada", sectors: ["hardware-iot", "security"] },
  { name: "Wyze", ats: "greenhouse", slug: "wyze", sectors: ["hardware-iot"] },
  { name: "Particle", ats: "greenhouse", slug: "particle", sectors: ["hardware-iot"] },
  { name: "Bird", ats: "greenhouse", slug: "bird", sectors: ["hardware-iot", "logistics-mobility"] },
  { name: "Astranis", ats: "ashby", slug: "astranis", sectors: ["hardware-iot"] },

  // -- crypto-web3 --------------------------------------------------------------
  { name: "Kraken", ats: "greenhouse", slug: "kraken", sectors: ["crypto-web3"] },
  { name: "Circle", ats: "greenhouse", slug: "circle", sectors: ["crypto-web3", "fintech"] },
  { name: "Uniswap Labs", ats: "ashby", slug: "uniswaplabs", sectors: ["crypto-web3"] },
  { name: "Consensys", ats: "greenhouse", slug: "consensys", sectors: ["crypto-web3"] },
  { name: "Alchemy", ats: "ashby", slug: "alchemy", sectors: ["crypto-web3", "devtools"] },
  { name: "OpenSea", ats: "ashby", slug: "opensea", sectors: ["crypto-web3"] },
  { name: "Chainalysis", ats: "greenhouse", slug: "chainalysis", sectors: ["crypto-web3", "security"] },
  { name: "Anchorage Digital", ats: "greenhouse", slug: "anchoragedigital", sectors: ["crypto-web3"] },
  { name: "Ripple", ats: "greenhouse", slug: "ripple", sectors: ["crypto-web3", "fintech"] },
  { name: "Gemini", ats: "greenhouse", slug: "gemini", sectors: ["crypto-web3"] },

  // -- edtech -----------------------------------------------------------------
  { name: "Coursera", ats: "greenhouse", slug: "coursera", sectors: ["edtech"] },
  { name: "Udemy", ats: "greenhouse", slug: "udemy", sectors: ["edtech"] },
  { name: "Khan Academy", ats: "lever", slug: "khanacademy", sectors: ["edtech"] },
  { name: "Course Hero", ats: "greenhouse", slug: "coursehero", sectors: ["edtech"] },
  { name: "Outschool", ats: "greenhouse", slug: "outschool", sectors: ["edtech"] },
  { name: "Guild Education", ats: "greenhouse", slug: "guildeducation", sectors: ["edtech"] },
  { name: "Handshake", ats: "greenhouse", slug: "handshake", sectors: ["edtech"] },
  { name: "Quizlet", ats: "greenhouse", slug: "quizlet", sectors: ["edtech"] },
  { name: "Photomath", ats: "ashby", slug: "photomath", sectors: ["edtech"] },
  { name: "ClassDojo", ats: "greenhouse", slug: "classdojo", sectors: ["edtech"] },

  // -- logistics-mobility -------------------------------------------------
  { name: "Flexport", ats: "greenhouse", slug: "flexport", sectors: ["logistics-mobility"] },
  { name: "Convoy", ats: "greenhouse", slug: "convoy", sectors: ["logistics-mobility"] },
  { name: "Getaround", ats: "greenhouse", slug: "getaround", sectors: ["logistics-mobility"] },
  { name: "Turo", ats: "greenhouse", slug: "turo", sectors: ["logistics-mobility"] },
  { name: "Gopuff", ats: "greenhouse", slug: "gopuff", sectors: ["logistics-mobility", "ecommerce"] },
  { name: "Deliverr", ats: "greenhouse", slug: "deliverr", sectors: ["logistics-mobility"] },
  { name: "Route", ats: "greenhouse", slug: "route", sectors: ["logistics-mobility", "ecommerce"] },
  { name: "Loadsmart", ats: "ashby", slug: "loadsmart", sectors: ["logistics-mobility"] },
  { name: "Fleetio", ats: "greenhouse", slug: "fleetio", sectors: ["logistics-mobility"] },

  // -- media-adtech -------------------------------------------------------------
  { name: "Spotify", ats: "lever", slug: "spotify", sectors: ["media-adtech", "consumer-social"] },
  { name: "The Trade Desk", ats: "greenhouse", slug: "thetradedesk", sectors: ["media-adtech"] },
  { name: "Criteo", ats: "greenhouse", slug: "criteo", sectors: ["media-adtech"] },
  { name: "Roku", ats: "greenhouse", slug: "roku", sectors: ["media-adtech"] },
  { name: "Vimeo", ats: "greenhouse", slug: "vimeo", sectors: ["media-adtech"] },
  { name: "Buzzfeed", ats: "greenhouse", slug: "buzzfeed", sectors: ["media-adtech"] },
  { name: "Outbrain", ats: "greenhouse", slug: "outbrain", sectors: ["media-adtech"] },
  { name: "Taboola", ats: "greenhouse", slug: "taboola", sectors: ["media-adtech"] },
  { name: "Chartbeat", ats: "lever", slug: "chartbeat", sectors: ["media-adtech"] },
  { name: "Nielsen", ats: "greenhouse", slug: "nielsen", sectors: ["media-adtech"] },

  // -- government-defense -------------------------------------------------
  { name: "Palantir", ats: "greenhouse", slug: "palantir", sectors: ["government-defense", "data-ml"] },
  { name: "Shield AI", ats: "ashby", slug: "shieldai", sectors: ["government-defense"] },
  { name: "Rebellion Defense", ats: "ashby", slug: "rebelliondefense", sectors: ["government-defense"] },
  { name: "Saildrone", ats: "greenhouse", slug: "saildrone", sectors: ["government-defense", "hardware-iot"] },
  { name: "HawkEye 360", ats: "greenhouse", slug: "hawkeye360", sectors: ["government-defense"] },
  { name: "Second Front Systems", ats: "ashby", slug: "secondfrontsystems", sectors: ["government-defense"] },
  { name: "Vannevar Labs", ats: "ashby", slug: "vannevarlabs", sectors: ["government-defense"] },
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
