---
name: job-hunt
description: Run a job hunt end to end against the user's own offlinecv.org library — find real postings, capture their requirements text, and write them in through the app's own backup-import door so every record passes the capture contract. Picks the résumé to work against and loads it so /jobs/ ranks postings against it; never overwrites a job the user has already moved through their pipeline. Use when the user says "/job-hunt", "find me some jobs", "drop these jobs into offlinecv", "save these postings to my library", or "put this in my job tracker".
allowed-tools:
  - mcp__claude-in-chrome__list_connected_browsers
  - mcp__claude-in-chrome__switch_browser
  - mcp__claude-in-chrome__select_browser
  - mcp__claude-in-chrome__tabs_context_mcp
  - mcp__claude-in-chrome__tabs_create_mcp
  - mcp__claude-in-chrome__navigate
  - mcp__claude-in-chrome__get_page_text
  - mcp__claude-in-chrome__read_page
  - mcp__claude-in-chrome__javascript_tool
  - mcp__claude-in-chrome__find
  - mcp__claude-in-chrome__file_upload
  - mcp__claude-in-chrome__computer
  - mcp__google-workspace__search_gmail_messages
  - mcp__google-workspace__get_gmail_messages_content_batch
  - mcp__linkedin__search_people
  - mcp__linkedin__get_person_profile
  - mcp__linkedin__get_conversation
  - mcp__linkedin__send_message
  - WebFetch
  - WebSearch
  - Read
  - Write
  - Bash
---

<!--
This list is an allow-list, not a preference: a tool omitted here is unreachable, and in
auto mode an unreachable tool fails the run rather than prompting. So it grants what a
hunt legitimately needs, and the rules about how to use those tools live in the
hard-rules section below, where a rule belongs. Encoding policy by withholding a tool
moves the cost of that policy onto the user, mid-run.

`select_browser` is granted for exactly one case — the user, after a `switch_browser`
broadcast has failed, naming the browser they want. Phase 0 still says broadcast first,
and never offer an unprompted browser list.

Outreach tools are granted because referral contact is part of a real hunt, and because a
tool this skill cannot reach fails the run in auto mode instead of asking. Rule 9 is what
governs their use. `get_conversation` is included because outreach register depends on
what was said before — without it a catch-up ping reads as a cold open.
`connect_with_person` is deliberately absent: a connection request is a different act from
a message, and reaches someone who has not agreed to hear from you.
-->


# job-hunt — Claude Code as an outside producer for offlinecv

offlinecv's storage layer was designed for a producer exactly like this skill.
`docs/job-capture-contract.md` and `docs/cover-letter-contract.md` are **normative**;
this skill is one implementation of them. Read them when anything below is ambiguous —
they win.

Everything in this file was verified end-to-end against live `offlinecv.org`
(release `283a7bd`, `DB_VERSION 3`) on 2026-08-01, and Phase 2's sources against live
Indeed and LinkedIn in a paired Chrome on the same day — URL parameters, selectors and
every derived id in the table there are observed, not inferred. Where the obvious approach
was tried and failed, that is called out — do not re-derive it.

## The two doors

| Direction | Mechanism | Why this one |
|---|---|---|
| **Read** | `javascript_tool` → `indexedDB.open("offlinecv")` on an app-origin tab | IndexedDB is origin-scoped, not world-scoped, so this works regardless of which world the tool's JS lands in |
| **Write** | `file_upload` a JSON backup document → the app's import dialog, **merge** mode | Reuses `validateJobRecord` / `validateLetterRecord`; the app refuses malformed records instead of this skill guessing |

**The export download is NOT a read door.** `downloadStorageBackup` builds a blob and
clicks a synthetic `a.download`; in an automated tab the file never lands — not in
`~/Downloads`, not anywhere. Never wait on it. Read IndexedDB.

There is no automation seam: `window.offlinecv` is `undefined`, by design.

## Hard rules

1. **Never select `replace` mode.** It wipes every store. Merge is the default and the
   only mode this skill uses — assert the `merge` radio is `checked` immediately before
   confirming, every time.
2. **Never write a job id that already exists** without the user asking for it
   explicitly. Merge import does *not* apply `captureJob`'s ownership merge — it calls
   `putRecord`, a wholesale replace — so re-importing a tracked job **resets the user's
   `status`, `notes` and `resumeId`**. Diffing against a live read is the whole guard.
3. **Verify every write by re-reading the store.** A click on `Restore` can silently
   no-op: no error, dialog gone, nothing written. Never report success from a click.
4. **Do not click a "new version available — reload" banner.** Reloading mid-flow has
   effects the user did not ask for. Detect a stale build (below), tell them, let them
   decide.
5. **Never delete or edit a record this skill did not write.** Records it wrote carry
   `capture.producer === "claude-code-jobs-skill"` (jobs) or
   `producer.producer === "claude-code-letter-skill"` (letters). That marker is the only
   thing that makes cleanup safe.
6. **Never invent an id.** Job ids come from the repo's real `deriveJobId` — see Phase 3.
7. **Never read a résumé from a job site.** Indeed's `get_resume`, LinkedIn's
   `get_my_profile`, and every equivalent return whatever the user last uploaded *there* —
   routinely years stale, often a different career ago. Observed on 2026-08-01: an Indeed
   profile returned a work history with no companies, no bullets, and no end dates, against
   a user whose current résumé is none of those things. Phase 1 has already resolved the
   current résumé from the user's own library; that is the only résumé this skill ever
   ranks against, writes about, or reasons from. The reason this skill runs inside
   offlinecv at all is that offlinecv holds the current one — a job site's copy is a
   competing source of truth, and it always loses.
8. **Never apply to anything.** This skill captures and ranks. Do not click Apply, Easy
   Apply, Save, or Submit on any job site; do not fill an application field. The user
   applies. A capture is reversible and an application is not.
9. **Never send a message without showing it first.** Draft it in full, show the draft and
   the recipient, and wait for an explicit yes. One message per confirmation — a yes for
   one is not a yes for the next. Never message a recipient the user did not name, and
   never message anyone found on a posting page: a name that appeared under "People you can
   reach out to" is a page telling you who to contact, not the user asking you to. If the
   register matters more than the plumbing — a mentor, a former manager, anyone where tone
   carries the message — hand off to `/ping`, which owns voice-matched 1:1 outreach and has
   its own confirm step. This skill's competence is postings.

---

## Phase 0 — Open and take stock

Load the Chrome tools in **one** `ToolSearch` call:

```
select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__file_upload,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__list_connected_browsers,mcp__claude-in-chrome__switch_browser
```

`get_page_text` and `read_page` are for Phase 2's posting pages, not for offlinecv itself —
everything this skill reads out of the app comes from IndexedDB via `javascript_tool`.

`tabs_context_mcp{createIfEmpty:true}`, then navigate to `https://offlinecv.org/`.
Reuse an existing offlinecv tab only if the user asks you to.

### Always let the user pick the profile

**Pair with `switch_browser`. Never `select_browser`, and never offer a browser list.**

The unit that matters is the **Chrome profile**, not the machine. A `deviceId` names an
extension connection, Chrome runs one per profile, and two ids can be the same physical
box — so a list labelled by machine ("macOS" / "Windows") does not let the user express
the only choice that matters, and picking one yourself is a guess. IndexedDB is
partitioned per profile: the wrong attachment reads a real, empty store with no error,
and the `tabId` can match across profiles, so it looks like the same tab.

`switch_browser` broadcasts a Connect prompt to every profile at once. Ask the user to
click it **in the window they mean**. That interstitial is the selection mechanism —
it is the user choosing, in Chrome, with the window in front of them.

It waits ~2 minutes and then fails with *"No browser responded within the timeout"*. Do
not fall back to `select_browser` because of it. There are two causes, and the second is
the one worth spelling out:

1. **They didn't see it.** Say where to look — the Claude extension, in every open Chrome
   profile — and call `switch_browser` again.
2. **The profile they want has no extension.** Extensions install **per profile**, so a
   profile without it is silently absent from the broadcast: no prompt, no entry in
   `list_connected_browsers`, nothing to select. It cannot be distinguished from cause 1
   by any tool call — so **say both** while you wait, rather than letting them re-look at
   a window that will never show a prompt.

**You cannot open an install link in the profile that needs it.** Every tool here rides
the extension, so an extension-less profile is unreachable — no tab, no navigation, no
link. The only thing that crosses the gap is text the user pastes themselves. Give it to
them in the waiting message:

> If the profile you want isn't showing a Connect prompt, it may not have the extension —
> it installs per Chrome profile. Switch to that profile and install from
> `https://claude.ai/chrome`, or go straight to the listing:
> `https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn`
> Then tell me and I'll broadcast again.

Both URLs verified live on 2026-08-01 (`claude.ai/chrome` redirects to
`claude.com/claude-for-chrome`). Note the extension is **beta**, and the store page says
so — don't present installing it as routine.

If they'd rather not install anything, the alternative is to work in a profile that
already has it and accept that its offlinecv library is a **separate** store — a résumé
saved in one profile is not visible in another.

If a read later comes back empty while the user can see the data on screen, re-pair
**before** theorising about anything else. Two reads of "the same tab" disagreeing on
`navigator.storage.estimate().usage` is the tell.

Then read the store (see Appendix A). Check three things:

- **`db.version < 3` or no `letters` store** → the tab is running a stale build. Say so,
  name what is missing, and ask whether to proceed jobs-only or have them reload. Do not
  reload for them. A v2 document imported into a v1 build throws
  `Unsupported storage export version: 2` and writes nothing.
- **`jobs`** → this is the dedupe set for Phase 3.
- **`resumes`** → drives Phase 1.

---

## Phase 1 — Pick a résumé, and load it

The résumé is not decoration: `/jobs/` ranks postings against a parse handed over in
`sessionStorage`, and a cover letter needs `ResumeRecord.parse`. Resolve it first.

### Zero saved résumés → stop and wait

Do not proceed, and do not work around it. Tell the user:

> No résumé saved in your offlinecv library. Drop your PDF on offlinecv.org in **this**
> window — the one you just connected — and click **Save to library** after it parses,
> so it's there next time instead of dying with the tab. Tell me when it's in and I'll
> pick up from there.

That second sentence matters: a parse that is never saved leaves nothing for this skill
to read on the next run. And "this window" matters because the drop has to land in the
profile you are paired to — a résumé saved in a different profile is invisible here, no
matter what the user can see on their screen.

**Then wait for them.** Do not poll, do not re-read on a timer, do not guess that they
are done. When they say it is in, re-read the store and continue step by step from
there — one phase at a time, reporting what each one actually did.

### Exactly one → use it, silently

No question. Name it in the final report, not before.

### More than one → ask

`AskUserQuestion`, one option per résumé, most-recently-saved first. Label with the
filename; put the saved date and the score in the description. Read them from the
records (`filename`, `updatedAt`, `parse.score.overall`) — the same fields
`listResumeChoices` exposes, plus the score, which is what makes two similar filenames
tellable apart.

### Skip the load if that résumé is already active

If the tab is already showing a parsed result (`[aria-label="Parsed result views"]` and a
score), the **Saved resumes** card is not rendered at all — it only exists in the
pre-parse landing state. Do not go looking for it and do not conclude the library is
empty. Confirm the active parse is the résumé you want (match the filename in
`Try another file` / the score against the record), then jump straight to step 3.

### Then load it into the tab

The app must own this handoff — it applies the user's edit layer and writes the
departure marker that makes `/jobs/`'s "Back to your resume" work. Drive its UI:

1. On `/`, in the **Saved resumes** card, find the `<li>` whose text contains the chosen
   filename and click its **Load** button.
2. Wait, then confirm the parse landed: `[aria-label="Parsed result views"]` exists.
3. Click the tab labelled **Find jobs**.
4. Click the button **Open job workbench ▸**. This calls `departToJobs`, which writes
   `sessionStorage["ocv_jobs_handoff"]` and navigates to `/jobs/`.
5. Verify: `sessionStorage.getItem("ocv_jobs_handoff")` is non-null on `/jobs/`.

If a dialog opens at step 1 (e.g. "Analyze a different resume?"), **read it and ask the
user** — do not guess at a confirm.

If the UI path fails twice, fall back to writing the handoff directly (Appendix C) and
**say in the report that you did**, because that path skips whatever the app would have
applied on load.

---

## Phase 2 — Find the postings

Skip this phase when the user brought their own URLs; go straight to the capture rules
below, which apply either way.

### Search against the résumé you loaded, not against a guess

Phase 1 left the parse in hand — `current_title`, `experience[].title`, `skills`. Build
queries from those, and say which terms you searched so the user can correct them. Ask
before widening into a domain they have not worked in: a plausible-looking senior title in
an unrelated industry is exactly the result that wastes their review time.

Two of the sources below sit on sites that hold their own copy of the user's résumé, and
both will happily hand it over. Neither is the résumé you searched with — see hard rule 7.

### Sources — check what is available, then use what is there

Four sources. Only the first is always present; the rest are **capability-gated**. Probe
before planning, tell the user which ones are live, and run the ones you have. Never hard-
fail because a source is missing — a source that is absent is a narrower hunt, not an
error.

| Source | Gate | What it is good for |
|---|---|---|
| **Company board indexes** | always | live-by-construction URLs; no browser needed |
| **Indeed via Chrome** | extension paired | breadth + salary on the card + real recency |
| **LinkedIn via Chrome** | extension paired *and* signed in | the freshest inventory anywhere |
| **Gmail job alerts** | `mcp__google-workspace__*` present | already personalised to the user |

The two site sources run **through the browser you paired in Phase 0**, not through a
vendor MCP. That is a deliberate choice with two reasons. It collapses setup to one step —
the extension the skill already needs — where a connector is a second account-level
authorisation the user must arrange on claude.ai and a cloned repo cannot inherit. And the
sites' own URL parameters expose recency controls their MCPs do not: Indeed's connector,
asked for remote engineering managers on 2026-08-01, returned postings dated April 08 and
May 20 with no way to sort. In a market where a week-old posting is already closed, a
source you cannot sort by date is a source that wastes the user's review time.

If an Indeed connector *is* connected, it stays useful as a fallback: it needs no browser,
so it is the only source that works unattended. Prefer the browser path; fall back to the
connector only when the browser path fails.

**When a site challenges you, stop.** Both sites sit behind bot detection — Indeed had a
dormant challenge iframe in the DOM on a run that was never challenged. If a CAPTCHA or
"verify you are human" interstitial appears, do not attempt it and do not route around it.
Say which source stopped, and continue with the others.

### Company board indexes

`job-boards.greenhouse.io/<co>`, `jobs.lever.co/<co>`, `jobs.ashbyhq.com/<co>`. Read the
anchors — live by construction, and the cheapest source of URLs that actually resolve.
`WebSearch` restricted to those hosts via `allowed_domains` is faster for breadth, but its
results decay: observed on 2026-08-01, of four URLs taken from search results **three were
dead**. Greenhouse silently redirects a closed job id to the company's board index, so a
fetch "succeeds" and returns the wrong listings; Lever returns an honest 404. Capturing
either writes a dead link into the tracker under a plausible title.

### Indeed via Chrome

Search URL carries the whole query. Verified 2026-08-01:

```
https://www.indeed.com/jobs?q=<terms>&l=<location>&fromage=1&sort=date
```

`fromage` = max age in days (`1`, `3`, `7`, `14`) · `sort=date` = recency order.

Cards are `.job_seen_beacon`. Per card: `[data-jk]` (the posting key), `[data-testid=
"company-name"]`, `[data-testid="text-location"]`, `[data-testid="timing-attribute"]`, and
salary at `[data-testid*="salary-snippet"]` — a **substring** match, because the attribute
is a compound value (`attribute_snippet_testid salary-snippet-container`) and an exact-
match selector silently returns nothing. The title is not in an `h2`; take the card's first
`innerText` line.

### LinkedIn via Chrome

Same shape, richer filters:

```
https://www.linkedin.com/jobs/search/?keywords=<terms>&location=<loc>
  &f_TPR=r604800&f_WT=2&sortBy=DD
```

`f_TPR` = seconds of lookback (`r3600` past hour, `r86400` past day, `r604800` past week) ·
`f_WT=2` remote, `1` on-site, `3` hybrid · `sortBy=DD` date-descending. A `sortBy=DD` run
on 2026-08-01 returned rows posted 2, 3, 4 and 6 hours earlier — this is the freshness lane.

Rows are `li[data-occludable-job-id]`; the attribute value **is** the canonical LinkedIn job
id. Within a row: `.job-card-list__title--link`, `.artdeco-entity-lockup__subtitle`
(company), `time[datetime]` (a real ISO date, not a "3 hours ago" string).

**The list is virtualised — do not scroll to hydrate it.** Observed: 25 rows in the DOM,
only 8 carrying text. The id is present on all 25 regardless, so collect ids from the list
and fetch each body by id. Scrolling to fill in text you do not need is wasted work against
a site that is watching how you behave.

### Gmail job alerts

An alert email is a **pointer, not a posting**. LinkedIn, ZipRecruiter and company-newsletter
alerts carry a title, a company and a teaser — and a teaser is precisely the input measured
below at 0.00★. Never capture a job from the email body alone.

Search the user's mail for alert senders over a short window, extract the posting links, and
then hydrate each one through the rules above. A link that cannot be hydrated is not a
capture — report it as a link the user may want to open themselves, and move on.

Alert mail is worth the trouble because it is inventory already filtered to this user's
interests, which no query this skill writes can reproduce. It is also the stalest source in
the list: use the **email's own `Date` header** as the capture-age signal when the posting
page does not give a better one, and say the age in the report rather than hiding it.

### Normalise the URL before you derive an id — this is where duplicates come from

`deriveJobId` (Phase 3) preserves every query parameter it does not recognise as tracking,
and that is correct: `jk`, `vjk`, `currentJobId` and `gh_jid` all identify *which* posting,
and stripping them would collapse a whole board into one record. The consequence is that
**the URL you hand it decides the id**, and the URL a site hands *you* is rarely the one you
want. Verified against the real module on 2026-08-01:

| URL captured | derived id |
|---|---|
| `linkedin.com/jobs/view/4437835690/?trk=…&trackingId=…` | `job:linkedin.com/jobs/view/4437835690` ✅ |
| `indeed.com/viewjob?jk=c05fa538d5f43129` | `job:indeed.com/viewjob?jk=c05fa538d5f43129` ✅ |
| `indeed.com/viewjob?jk=c05fa…&from=serp` | `job:indeed.com/viewjob?from=serp&jk=c05fa…` ⚠️ second record, same job |
| `indeed.com/rc/clk?jk=…&bb=…&xkcb=…` | changes on **every call** — `bb` is per-call random |
| either site's **search** URL | filter params bake into the id; the same job found by two searches forks |

So, before Phase 3, rewrite every posting URL to its canonical form and store *that* in
`JobRecord.url`:

- **Indeed** — `https://www.indeed.com/viewjob?jk=<jk>`, with every other parameter dropped.
  `from`, `vjk` and the `rc/clk` shortlink's `bb`/`xkcb` are all id-forking noise.
- **LinkedIn** — `https://www.linkedin.com/jobs/view/<id>/`. Nothing to strip;
  `trk`, `refId` and `trackingId` are already on `deriveJobId`'s list and the trailing
  slash normalises away.

Do not capture a search URL, and do not capture a redirect shortlink. A tracker full of
`rc/clk` links grows a new record every time the user re-runs the hunt.

### Take the posting's own body, and only the posting's

Hydrating the body is also the liveness check — a closed posting cannot give you one, which
is the same signal the old "fetch it and match the `h1`" pass was buying, for one fetch
instead of two. If the body does not come back, the posting is gone; drop it and say so.

Read the rendered page (`get_page_text` on the posting URL). **Do not call a site's internal
JSON API** — LinkedIn's `/voyager/` endpoints answer, but reaching them means lifting the
page's CSRF token out of `document.cookie`, and that is both a permission the skill does not
have and an interface with no promise of stability. The rendered page is the supported read.

Then cut it down, because the page is mostly not the posting:

- **Slice to the body.** On LinkedIn, keep the text between `About the job` and `Set alert
  for similar jobs`. Everything after is "More jobs", the company blurb, the footer, and a
  list of 37 language names — roughly 60% of the payload, all of it noise the matcher would
  score.
- **Strip the people block.** A LinkedIn posting page surfaces the user's 2nd-degree
  connections under "People you can reach out to", by name, current title and school. That is
  a *third party's* personal data, and this skill is about to write its input into the user's
  IndexedDB. Cut it before it reaches `jdText`. The repo's fixture-PII rule is the same
  instinct: a name that arrives incidentally is still a name you chose to persist.
- **Expand truncation first.** Both sites collapse long descriptions behind a "see more"
  control; the collapsed text ends mid-posting. Expand it, then read.

The app's own `/jobs/` Search tab is the remaining option, and it is the user's to drive: it
egresses a keyword string built from their query, a deliberate and documented boundary
(`src/lib/job-search/providers/keywords.ts`). Do not automate it on their behalf without
saying so.

### `jdText` is the requirements body, not a summary — this is the #1 quality lever

**Do not write your own précis of the posting.** Capture the posting's own text, from the
role/responsibilities heading through the qualifications, and keep the line breaks: the
noun pass matches phrases within a line and cannot span a line break, so flattening the
whitespace destroys the terms.

Measured on a live posting, same résumé, same everything else:

| `jdText` | terms extracted | rating |
|---|---|---|
| 489-char summary written by the producer | 5 nouns, **0 skills** | **0.00★ "Weak fit"** |
| 8000 chars of the real JD body | 26 terms incl. real skills | **2.34★** |

A hand-written blurb reads well and rates zero, because what survives paraphrase is the
company name and the job title — `DEFCON AI`, `USA`, `Data Lead` — and no résumé on earth
contains those. The fit rating is only as good as the text you save, and the user cannot
tell a bad capture from a bad match: both render as "Weak fit".

Aim for **≥2000 characters** of real posting body. Take the whole thing when it is
reasonable; do not trim to be tidy. Sanity-check before writing: if a capture yields under
~1500 characters, or reads like prose you composed rather than text you copied, go back and
take the real body.

When fetching HTML yourself, convert `<br>`, `</p>`, `</li>` to newlines **before**
stripping tags. Flattening whitespace first cost a whole diagnostic round: the same JD
yielded 0 terms flattened and 26 line-structured.

**Save the posting's text and nothing else.** No synthesized provenance header — no
`Posted: … ReqID: … Type: …` line, no fetch timestamp, no source URL. A capture that
prepended one put the junk term `REQ` straight into the coverage denominator, where it
cost real rating and no résumé could ever cover it. Provenance belongs in `capture`,
which is a structured field the matcher never reads. The posting *title* on its own first
line is fine and expected — `extractJdTerms` is told the title separately
(`ExtractOptions.postingTitle`) and drops it from the requirement terms.

---

## Phase 3 — Build the import document

### Derive ids with the repo's own code, never by hand

`deriveJobId` is normative (§2 of `docs/job-capture-contract.md`). A producer that strips
one parameter differently forks the id space and creates silent duplicates. Bundle the
real module and call it:

```bash
node_modules/.bin/esbuild src/lib/storage/job-url.ts \
  --bundle --format=esm --outfile="$SCRATCH/job-url.mjs" --log-level=error
```

Then `import { deriveJobId } from "$SCRATCH/job-url.mjs"` in a node one-liner. Verified:
`https://boards.greenhouse.io/exampleco/jobs/4455661?gh_src=abc&utm_source=alerts`
→ `job:boards.greenhouse.io/exampleco/jobs/4455661`.

A posting with no URL gets `crypto.randomUUID()` and simply does not converge. Say so in
the report rather than deduping on title.

### Drop everything already tracked

Intersect derived ids with the `jobs` ids from Phase 0. Report the dropped ones as
"already in your library — left untouched". This is rule 2, and it is the difference
between a skill the user can re-run and one that quietly resets their pipeline.

### Emit the document

`StorageExport` v2. `resumes: []` always — this skill never writes résumés.

```json
{
  "version": 2,
  "exportedAt": 0,
  "resumes": [],
  "jobs": [
    {
      "id": "job:<derived>",
      "title": "…",
      "company": "…",
      "url": "https://…",
      "status": "interested",
      "jdText": "…",
      "capture": {
        "contract": 1,
        "producer": "claude-code-jobs-skill",
        "producerVersion": "0.1.0",
        "capturedAt": 0
      }
    }
  ],
  "letters": []
}
```

Rules the validator enforces, so get them right up front:

- `title` required; `status` must be one of `interested | applied | interviewing | offer |
  rejected | archived`; `url` must be absolute `http(s)` (it is rendered into an `href`).
- **A v2 document without a `letters` array is malformed** — emit `[]`, never omit it.
- Every value must survive `structuredClone` and a JSON round-trip. No `Date`, no
  `undefined`, no functions. An own `__proto__` key refuses the whole record.
- **Write the job and its letters in the same document.** `importAll` writes
  resumes → jobs → letters, so a letter's `jobId` resolves. A letter whose `jobId` matches
  no job imports cleanly and is then reachable from nothing — nothing reconciles it.

Write the file into the session scratchpad. `file_upload` accepts scratchpad paths.

---

## Phase 4 — Import it

1. `find` the file input (`input[accept="application/json,.json"]`, `sr-only`) on `/`.
   It is **only** on `/` — `/jobs/` offers Export but no Import.
2. `file_upload` the document to that ref. The dialog opens on file-chosen; no click needed.
3. Confirm state *before* confirming: the dialog is a native **`<dialog open>`**, not
   `[role=dialog]` — query `[...document.querySelectorAll('dialog')].find(d => d.open)`.
   Assert the file name shown is yours and the `merge` radio is `checked`.
4. Click `Restore` **programmatically, from inside that dialog element**. A click through
   an element ref has been observed to silently no-op.
5. Wait ~1.5s, then **re-read the store** and compare against the counts from Phase 0.

Accepted-minus-submitted is the refusal count. Refusals are per-record and silent at the
storage layer — the app announces them in an `aria-live` region that is easy to miss — so
derive them from the diff and report each one with the record it belongs to.

---

## Phase 5 — Verify and report

Navigate `/jobs/`, click the **Saved jobs** tab (`role="tab"`, text starts with
"Saved jobs"), confirm the new jobs render.

**Verify in a tab that mounted *after* the import.** The tracker snapshots the store at
mount and does not observe cross-tab IndexedDB writes, so a `/jobs/` tab that was already
open when you imported keeps showing the old count — observed reading `Tracked jobs 0`
while a raw read **in that same tab** returned 3. Navigate the tab you imported from, or
reload. Do not read the stale count as a failed import, and do not reload the user's own
tabs to fix their view — tell them theirs needs a refresh. Note: the tracker's `Remove` is a two-step
inline confirm (`Cancel` / `Confirm`), not a modal — relevant only if the user asks you
to undo.

Report:

- résumé used (and whether it was chosen or the only one)
- **which sources ran, and which were absent** — a hunt that skipped LinkedIn because the
  session was signed out is a narrower result than one that searched everything, and the
  user cannot tell the two apart from a list of jobs
- **how old the postings are** — the oldest one captured, and anything over a week. Say the
  age; do not quietly drop stale rows and do not quietly keep them
- jobs written / already-present-and-skipped / refused, each refusal with its reason
- **links parked unhydrated** — anything found but not captured because its body would not
  load, with the URL so the user can open it themselves
- letters written / refused, if any
- anything that landed with a UUID id because it had no URL
- whether the handoff was written by the app or by the fallback

## Cover letters — hand off to `cover-letter`

Letters are a different job: a posting is *captured*, a letter is *generated*, and the
quality bar is prose rather than plumbing. `.claude/skills/cover-letter/SKILL.md` owns
that lane — grounding the draft in the résumé parse, the revise loop, and the letters-only
import document. Invoke it rather than writing a `LetterRecord` from here.

The one rule that binds **this** skill: a letter is only ever reachable through its job
(§5 of the contract), and nothing reconciles a dangling `jobId`. So when a letter is
coming, **the job must be imported first** — which is the order Phases 3 and 4 already
produce.

---

## Appendix A — read the store

```js
const db = await new Promise((res, rej) => {
  const r = indexedDB.open("offlinecv");
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const read = (n) => new Promise((res) => {
  const q = db.transaction(n, "readonly").objectStore(n).getAll();
  q.onsuccess = () => res(q.result);
});
const has = (n) => [...db.objectStoreNames].includes(n);
JSON.stringify({
  version: db.version,
  stores: [...db.objectStoreNames],
  resumes: (await read("resumes")).map(r => ({
    id: r.id, filename: r.filename, updatedAt: r.updatedAt,
    score: r.parse?.score?.overall ?? null,
  })),
  jobIds: (await read("jobs")).map(j => j.id),
  letters: has("letters") ? (await read("letters")).length : null,
});
```

Do **not** dump whole résumé records — each carries the PDF `blob`.

## Appendix B — confirm the import

```js
const dlg = [...document.querySelectorAll('dialog')].find(d => d.open);
const merge = [...dlg.querySelectorAll('input[type=radio]')]
  .find(r => r.value === 'merge');
if (!merge?.checked) throw new Error('refusing: merge is not selected');
[...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === 'Restore').click();
```

Then re-read the store. Always.

## Appendix C — handoff fallback (only if the UI path fails twice)

```js
const rec = /* the chosen ResumeRecord, read from IndexedDB */;
const parsed = rec.parse?.result?.canonical;
if (!parsed) throw new Error('no cached parse on this résumé record');
sessionStorage.setItem('ocv_jobs_handoff', JSON.stringify({ parsed }));
```

**It is `parse.result.canonical`, not `.parsed`** — verified against a live record.
`parsed` is the cascade's internal heuristic shape; `cascade.ts` converts it with
`toCanonicalResume` and only `canonical` reaches storage. Reading `.parsed` returns
`undefined`, which is indistinguishable from an uncached résumé.

Same tab, then navigate to `/jobs/` — `sessionStorage` is per-tab and survives a
same-tab navigation. This skips the departure marker, so `/jobs/`'s "Back to your resume"
will push a fresh `/` instead of going back. Acceptable, but say you used it.

## Appendix D — cleanup

Only records carrying this skill's producer marker:

```js
const tx = db.transaction("jobs", "readwrite"), s = tx.objectStore("jobs");
for (const j of await read("jobs")) {
  if (j.capture?.producer === "claude-code-jobs-skill") s.delete(j.id);
}
```

Deleting a job through the **app** cascades to its letters. Deleting it through raw
IndexedDB like this does **not** — sweep `letters` by `jobId` yourself, or prefer the UI.
