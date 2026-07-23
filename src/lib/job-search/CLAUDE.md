# CLAUDE.md — job-search lane

Query builder → provider search → rank by resume fit → deep links. Rides inside the
main page (`FindJobsPanel`), not a separate HTML entry. Consumes the parsed resume,
never the raw PDF. Read the root `CLAUDE.md` first; this file adds only the
lane-specific rules that are silent to break.

## Privacy invariant (hard)

- **`providers/keywords.ts` is the sole resume-derived egress helper** in the whole
  app. It builds a short keyword string from the user-editable query title + skills —
  never the resume text. Used only by the keyless aggregator feeds.
- **Company adapters egress only the public company slug** (plus static caps like
  `?limit=`) — never resume-derived data, not even via `keywords.ts`. The role filter
  (`filterPostingsByRole`) is local.
- Before adding any `fetch()` here, confirm what leaves. A new adapter that sends more
  than its slug breaks epic #528's privacy posture and the root-`CLAUDE.md` custody claim.

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
