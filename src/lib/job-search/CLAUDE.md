# CLAUDE.md — job-search lane

Query builder → provider search → rank by resume fit → deep links. Owns its own HTML
entry, `/jobs/` (`jobs/index.html` → `src/jobs/JobsApp.tsx`). Since #690, `JobsApp` is a
`Tabs` host with two peer views — Search (`FindJobsPanel`, this lane) and Saved jobs (the
job-tracker library) — not "`FindJobsPanel` is the whole page" as it was pre-#690; both
panels stay mounted across the switch. `/` keeps no search surface at all since #823 — the
journey rail's Match-jobs stage hands the parse over through `src/lib/jobs-departure.ts`
(which writes `src/lib/jobs-handoff.ts`) and navigates. Consumes the parsed resume, never the raw
PDF — this surface cannot parse a PDF at all. Read the root `CLAUDE.md` first; this file
adds only the lane-specific rules that are silent to break.

## Privacy invariant (hard)

- **`providers/keywords.ts` is the sole resume-derived egress helper** in the whole
  app. It builds a short keyword string from the user-editable query title + skills —
  never the resume text. Used by the keyless aggregator feeds, and (since #691's fix)
  by `company-search-link.ts` for the term it templates into an employer's own careers
  URL — that one leaves only when the **user clicks**, same as `deep-links.ts`.
- **Company adapters egress only the public company slug** (plus static caps like
  `?limit=`) — never resume-derived data, not even via `keywords.ts`. The role filter
  (`filterPostingsByRole`) is local.
- Before adding any `fetch()` here, confirm what leaves. A new adapter that sends more
  than its slug breaks epic #528's privacy posture and the root-`CLAUDE.md` custody claim.

## Soft axes rank; three hard filters remove

Only `refineSearchResult` (`refine.ts`) removes a posting, and only through three
user-armed filters: role families (#568), exclude terms (#563), and local-only (#809).
Everything else that sounds like narrowing — target level, comp floor, and location's
DEFAULT behavior — is a bounded soft axis inside `rankPostings` that reorders and drops
nothing. That was a deliberate correction (#570 de-boosted location from a sort key,
#716 bounded the axes), and #809 re-litigating "search returns everything" does **not**
reopen it: the answer is an explicit lever the user can see, never a re-inflated implicit
boost. Do not add a fourth remover without a visible control that arms it.

All three share the **never-fail-closed** floor: when a filter would reduce a non-empty
set to empty, it is skipped, the input is kept, and a `*Suppressed` flag goes back for the
panel's notice. A blank panel the user cannot diagnose is worse than an unfiltered one.

A remover must also never report a fact it does not have. A posting whose feed omitted
`location` **passes** the local-only filter — `locationMatches` reads the blank as a
non-match because it is scoring a rating with no evidence to credit, but hiding it and
calling it "too far away" would state a location the app never saw. The two readers of
that blank differ on purpose (`filterPostingsByLocation`), and `locationFilteredOut`
counts only postings that stated a location somewhere else.

`location-match.ts` owns the ONE location predicate. `rank.ts` reads it for the soft
axis, `refine.ts` for the hard filter — so the local-only toggle can never hide a posting
whose own card shows a location match. It is a string comparison, not geography: no
radius, no geocoding, because a distance model needs a geocoder and that is a network
call this app does not make.

## Per-vendor adapters duplicate on purpose

Each provider in `providers/` is its own factory with its own inline `mapJob`/post-filter
(`greenhouse.ts`, `lever.ts`, `ashby.ts`, `remotive.ts`, `arbeitnow.ts`, `jobicy.ts`).
fallow flags the mapping bodies as a clone group (`dup:… ×N`). **This is the house
pattern, not a shared-helper miss** — vendor response shapes diverge (Lever top-level
array + unix-ms `createdAt`; Ashby `{jobs:[]}` + ISO `publishedAt`; Greenhouse needs a
separate lazy `hydrate` call), so a "shared" mapper would be a switch-on-vendor that is
worse than the duplication. When fallow or a reviewer re-raises this on the next adapter:
**Nit / no-action.**

Shared contract every adapter maps into: `JobPosting` in `types.ts` — includes optional
`departments?: string[]` (the #534 role-title filter reads it). New adapters emit
`departments` from the vendor's team/department field.

## `await writeCachedBoard` is load-bearing

In `company-boards.ts`, `if (cacheable) await writeCachedBoard(…)` (~line 179) looks like
a fire-and-forget candidate (one IndexedDB put that never rejects). It is **not**.
`company-boards.test.ts` (the "no re-fetch" case, ~line 304) asserts a second `search()`
issues **1** board fetch, not 2 — the write must commit before `search()` resolves or a
rapid follow-up misses the cache. The await enforces the happens-before. Do not "fire-and-
forget the non-critical write."
