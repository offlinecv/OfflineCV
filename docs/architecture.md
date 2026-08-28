# Architecture at a glance

A one-page map of offlinecv for someone about to make their first change.
It is deliberately shallow: enough to know which folder your issue lives in,
and which constraint you must not break on the way.

![The offlinecv pipeline drawn inside a dashed box labelled "your browser tab":
drop a résumé file, read it with pdf.js, parse it in tiers, score it, edit it,
export an ATS-safe PDF. Local storage and job matching also sit inside the box.
Three dashed arrows leave the box — a keyword string, a pasted job-description
URL, and a product-analytics event — and a footnote names what else leaves,
including the on-device model download.](./architecture-diagram.svg)

## The one constraint

**The PDF bytes and the résumé text never leave the browser.** Every box in the
dashed area above runs in the visitor's tab; nothing in it sends your résumé
to a server, because offlinecv has no backend of its own.

Scope that claim to **data custody, not runtime**. "Everything runs on your
device" is falsifiable — several things do cross the line, and they are listed
below rather than hidden. When you write copy, a docblock, or a PR description
that touches this, say what is true of the *data*, and check what the app
actually calls before you say anything about the network.

Grepping `fetch(` under `src/` is where that check starts, not where it ends.
The largest call the app makes — the on-device model download — is issued
inside `@mlc-ai/web-llm` and never appears as a `fetch(` literal in this repo.
Read the table below, and watch a real session in devtools before you write
down a number.

There is **no BYOK cloud-LLM provider in the tree**. A few docblocks mention
one; it is unbuilt ([#320](https://github.com/offlinecv/OfflineCV/issues/320)).
Don't describe a cloud model path as if it ships.

## The parse cascade

`runCascade()` in `src/lib/heuristics/` runs three tiers over the bytes and
returns one `CascadeResult`. Each tier is dynamic-imported so the entry chunk
stays small.

| Tier | Module | Does |
|---|---|---|
| 0 | `pdf-extract.ts` (pdf.js) + `pdf-layout.ts` | Pulls text items, pages, raw text and link annotations; probes for scanned and two-column layouts |
| 1 | `openresume.ts` | Heuristic structured parse — the main event |
| 1.5 | `regex-fallback.ts` | Fills in individual fields tier 1 missed |

`computeAnonymousAtsScore()` (`src/lib/score/score.ts`) then scores the result on
Specificity (0.4), Structure (0.3) and Completeness (0.3), multiplied by a
layout-trigger penalty — 1.0, 0.85, 0.70, or 0 if the PDF is scanned. See
[`docs/scoring.md`](./scoring.md) for the dimensions in detail.

## Where things live

Everything below is under `src/`.

| Area | Folder |
|---|---|
| The drop target | `components/DropZone.tsx` |
| Parse cascade and its tiers | `lib/heuristics/` |
| Scoring | `lib/score/` |
| Inline edits and overrides | `lib/edit/` |
| On-device AI (WebGPU): parse, critique, rewrite | `lib/webllm/` |
| PDF / Markdown / audit-report export | `lib/pdf/` |
| IndexedDB résumé and job library | `lib/storage/` |
| Job discovery, ranking, deep links | `lib/job-search/` |
| Matching a résumé to a job description | `lib/jd-match/` |
| Shared UI primitives and tokens | `design-system/` |

The build ships two HTML entries: `/` is the parser-audit lane (drop → parse →
score → edit → export) and `/jobs/` is the job-search lane. `/jobs/` has no drop
zone — parsing is `/`'s job, and the parsed résumé travels between them through
`sessionStorage`.

A parsed résumé is written to IndexedDB **automatically only once you have
edited it** (`src/hooks/useAutosaveResume.ts`). Someone who drops a PDF, reads
the score and leaves has left nothing at rest. The one way a record exists
before an edit is if you ask for it: the parse header offers an explicit **Save
to library** for keeping an unedited parse
(`src/components/features/ParsedHeader.tsx`). That is a stronger promise than
"saves locally" and it is easy to break by accident — see
[IndexedDB](../README.md#indexeddb-local-first-storage) in the README.

## What leaves the tab

| What | When | Where it lives |
|---|---|---|
| A keyword string — your job title and skills, never résumé text | You click "Search jobs" | [`lib/job-search/providers/keywords.ts`](../src/lib/job-search/providers/keywords.ts) |
| A public company slug — no résumé text, no keywords | The same search, against the company boards (Greenhouse, Lever, Ashby) | [`lib/job-search/company-boards.ts`](../src/lib/job-search/company-boards.ts) |
| A job-description URL | You paste one into the JD panel | [`lib/jd-match/fetch-jd.ts`](../src/lib/jd-match/fetch-jd.ts) |
| A model-file request — 1.6–2.3 GB from `huggingface.co` and `raw.githubusercontent.com` | You start an on-device AI action and accept that model's licence | [`lib/webllm/web-llm.ts`](../src/lib/webllm/web-llm.ts) |
| A product-analytics event — and, if you send feedback, the opt-in email and free text you typed | Hosted builds only; dead-code-eliminated when `VITE_POSTHOG_KEY` is unset, so a clone ships none | [`lib/analytics.ts`](../src/lib/analytics.ts) |

One further call carries neither résumé data nor anything you typed — the
footer's GitHub star count (`src/hooks/useGitHubStars.ts`). The version check
(`src/lib/version.ts`) is **same-origin**: it fetches this app's own
`version.json`, so no third party is involved.

Every row in the table above reveals the visitor's IP to that third party. The
README covers several of them in more detail:
[Telemetry](../README.md#telemetry),
[GitHub star count](../README.md#github-star-count),
[Job-search feeds](../README.md#job-search-feeds).

## Making your first change

1. Pick something from the [open `good first issue`
   list](https://github.com/offlinecv/OfflineCV/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
   and comment that you're starting —
   [Claiming an issue](../CONTRIBUTING.md#claiming-an-issue) explains why the
   comment matters.
2. Find the row in [Where things live](#where-things-live) that matches it, and
   open the closest existing file in that folder before writing anything. The
   repo has a consistent house style and the fastest way to match it is to
   mirror a neighbour.
3. Run the gates: `npm run verify:quick` — typecheck, lint, and the tests your
   change touches. Lint is the one that enforces the design-system and
   colour-token rules, so running it here rather than at push time is what
   saves you a surprise. `npm run verify` is the full pre-push gate and runs
   automatically on `git push`.

`CLAUDE.md` carries the same pipeline in more depth, alongside the rules for
writing code in this repo. Read it when this page runs out.
