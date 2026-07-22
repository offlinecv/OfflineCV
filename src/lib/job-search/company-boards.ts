// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The bounded company-board pipeline (#533, slice 5 — the integration — of the
 * job-search-v2 epic #528).
 *
 * The five build slices (#529–#532, #534) each shipped a piece with no wiring.
 * This is where they connect, and the ONE thing it exists to guarantee is that
 * a big board stays cheap:
 *
 *   cached light index (or fetch it)   board-cache.ts / the slice-1/2 adapters
 *     → filterPostingsByRole           role-keywords.ts (#534)
 *     → capPerCompany                  role-keywords.ts (#534)
 *     → hydrate ONLY the survivors     hydrateGreenhouse / hydrateLever
 *
 * ORDER IS THE WHOLE POINT. A 1000-role Greenhouse board costs exactly one
 * light-index request plus at most `perCompanyCap` description fetches, because
 * hydration runs strictly AFTER the filter and the cap. Hydrating first — or
 * capping after hydrating — would issue 1000 requests for descriptions that are
 * then thrown away.
 *
 * DESCRIPTIONS PER VENDOR (they do NOT behave alike):
 *   - Greenhouse: light index has `description: ""`; every survivor is hydrated
 *     per-job via `hydrateGreenhouse`.
 *   - Lever: a FRESH board fetch already carries `descriptionPlain` inline, so
 *     its survivors need no hydrate — but the cache stores light rows only
 *     (descriptions stripped), so on a CACHE HIT a Lever survivor is re-hydrated
 *     per-job via `hydrateLever`. `hydrateDescriptions` keys off the empty
 *     description, so it fetches exactly the survivors that lost their text.
 *   - Ashby: no keyless per-job endpoint exists, so a stripped light cache could
 *     never rehydrate it. Ashby is therefore NOT cached at all; its small,
 *     monolithic board is fetched fresh each search (descriptions intact) and
 *     never hydrated.
 *
 * Each board is wrapped as an ordinary `JobProvider`, so the orchestrator's
 * existing `allSettled` semantics carry over unchanged and for free: a board
 * that 404s, times out, or is blocked by CORS lands in `degradedProviders` and
 * the rest of the search still returns. That is also why the pipeline lives
 * behind the provider interface rather than in a parallel fan-out.
 *
 * PRIVACY: the request carries the public company slug (and a job id when
 * hydrating) and nothing else. `roleFilterForResume` and `filterPostingsByRole`
 * run purely on-device over already-fetched postings, so this slice adds no
 * egress. `providers/keywords.ts` — the single audited resume-derived egress
 * helper — is used only by the keyless feeds and is deliberately not imported
 * here.
 */

import type { CompanyEntry } from "./company-registry.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { JobProvider, JobPosting } from "./types.ts";
import {
  roleFilterForResume,
  filterPostingsByRole,
  capPerCompany,
  DEFAULT_PER_COMPANY_CAP,
  type RoleFilter,
} from "./role-keywords.ts";
import { makeCompanyProvider } from "./providers/index.ts";
import { hydrateGreenhouse } from "./providers/greenhouse.ts";
import { hydrateLever } from "./providers/lever.ts";
import { readCachedBoard, writeCachedBoard } from "./board-cache.ts";
import { mapWithConcurrency } from "./concurrency.ts";

/**
 * Description fetches in flight per board. Lower than the board-level fan-out
 * cap because these are same-host requests — Greenhouse would queue them behind
 * its own connection limit anyway, and this is the only place we issue a burst
 * of requests to one origin.
 */
const HYDRATE_CONCURRENCY = 4;

/** `id` on a Greenhouse posting is `greenhouse:{slug}:{jobId}` (see
 *  `providers/greenhouse.ts`). Recover the job id by stripping the known
 *  prefix — a substring search for the last ":" would break on a slug that
 *  itself contains one. Returns "" when the shape doesn't match, which the
 *  caller reads as "not hydratable". */
export function greenhouseJobId(slug: string, postingId: string): string {
  const prefix = `greenhouse:${slug}:`;
  return postingId.startsWith(prefix) ? postingId.slice(prefix.length) : "";
}

/** `id` on a Lever posting is `lever:{slug}:{jobId}` (see `providers/lever.ts`).
 *  Recover the job id by stripping the known prefix, exactly as
 *  `greenhouseJobId` does — a last-":" search would break on a slug that itself
 *  contains one. Returns "" when the shape doesn't match, read by the caller as
 *  "not hydratable". */
export function leverJobId(slug: string, postingId: string): string {
  const prefix = `lever:${slug}:`;
  return postingId.startsWith(prefix) ? postingId.slice(prefix.length) : "";
}

/**
 * Fill in `description` for the postings that survived filtering + capping.
 *
 * Only survivors whose description is EMPTY are hydrated — that is exactly the
 * set that lost its text: a Greenhouse light-index row (always `""`) or a
 * cache-hit row whose description `writeCachedBoard` stripped. A survivor that
 * still carries text (a fresh Lever board fetch) is left untouched, so a Lever
 * cache MISS costs zero per-job requests. Ashby is a hard no-op: it has no
 * per-job endpoint and is never cached, so its board-fetch descriptions are
 * always already present.
 *
 * A hydrate failure costs that ONE posting its description, never its place in
 * THIS function's output — an undescribed posting still has a title, company,
 * and link, so hydration never drops it. The guarantee is provider-local,
 * though: downstream, `searchJobs` re-filters every posting through
 * `matchesQuery` (title + description), so a text-less survivor whose title
 * carries no query token can still be dropped there. That is a deliberate
 * second gate, not a hydrate bug — it just means the "never dropped" promise
 * holds for hydration, not end-to-end. An undescribed posting also ranks lower,
 * the honest consequence of having no text to match against.
 */
export async function hydrateDescriptions(
  entry: CompanyEntry,
  postings: readonly JobPosting[],
  signal: AbortSignal,
): Promise<JobPosting[]> {
  if (entry.ats === "ashby") return [...postings];

  const settled = await mapWithConcurrency(
    postings,
    HYDRATE_CONCURRENCY,
    async (posting) => {
      // Already-hydrated survivor (a fresh Lever fetch) — no request.
      if (posting.description !== "") return posting.description;
      if (entry.ats === "greenhouse") {
        const jobId = greenhouseJobId(entry.slug, posting.id);
        return jobId ? hydrateGreenhouse(entry.slug, jobId, signal) : posting.description;
      }
      // entry.ats === "lever"
      const jobId = leverJobId(entry.slug, posting.id);
      return jobId ? hydrateLever(entry.slug, jobId, signal) : posting.description;
    },
  );

  return postings.map((posting, i) => {
    const outcome = settled[i];
    return outcome.status === "fulfilled"
      ? { ...posting, description: outcome.value }
      : posting;
  });
}

/**
 * Wrap one registry entry as a bounded `JobProvider`. `search()` runs the full
 * pipeline and returns only the filtered, capped, hydrated postings — so the
 * orchestrator downstream never sees the raw board.
 */
export function makeBoardProvider(
  entry: CompanyEntry,
  filter: RoleFilter,
  perCompanyCap: number = DEFAULT_PER_COMPANY_CAP,
): JobProvider {
  const base = makeCompanyProvider(entry);
  // Ashby has no keyless per-job endpoint, so a light (description-stripped)
  // cache could never rehydrate it. Rather than persist a record that would
  // violate the "light index only" invariant, Ashby is never cached: its board
  // is small and monolithic, so a fresh fetch each search is cheap and keeps
  // descriptions intact.
  const cacheable = entry.ats !== "ashby";
  return {
    id: base.id,
    label: base.label,
    async search(query, signal): Promise<JobPosting[]> {
      const cached = cacheable ? await readCachedBoard(entry.ats, entry.slug) : null;
      let index: JobPosting[];
      if (cached) {
        index = cached;
      } else {
        // A rejection here propagates: this board becomes one degraded
        // provider, which is exactly the intended failure mode.
        index = await base.search(query, signal);
        // Awaited deliberately: the write must commit before `search` returns so
        // a rapid follow-up search hits the cache instead of re-fetching the
        // board (company-boards.test.ts pins this). It's one IndexedDB put and
        // never rejects — cheap enough to keep on the path for that guarantee.
        if (cacheable) await writeCachedBoard(entry.ats, entry.slug, index);
      }

      // `capPerCompany` truncates in the board's NATIVE order, before hydrate
      // and before `rankPostings` — a deliberate request-bounding tradeoff: a
      // strong-fit role past the cap in board order is dropped before ranking
      // can see it. Fit-aware selection here would need a pre-hydrate signal
      // (title/skill-in-title); today the cap is board-order, and rank only
      // reorders the survivors. See the epic-#528 follow-up on skills ranking.
      const survivors = capPerCompany(
        filterPostingsByRole(index, filter),
        perCompanyCap,
      );
      return hydrateDescriptions(entry, survivors, signal);
    },
  };
}

/**
 * Bounded providers for every selected company. The role filter is derived from
 * the resume ONCE here and shared by every board — it does not vary per company,
 * and recomputing it per board would re-scan the resume for each one.
 */
export function makeBoardProviders(
  entries: readonly CompanyEntry[],
  parsed: HeuristicParsedResume,
  perCompanyCap: number = DEFAULT_PER_COMPANY_CAP,
): JobProvider[] {
  const filter = roleFilterForResume(parsed);
  return entries.map((entry) => makeBoardProvider(entry, filter, perCompanyCap));
}
