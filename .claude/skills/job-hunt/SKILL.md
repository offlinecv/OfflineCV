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
  - mcp__claude-in-chrome__browser_batch
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

`browser_batch` is granted because a hunt is mostly predictable multi-step sequences —
navigate, wait, read the cards — and batching them is one round trip instead of five. It
was missing from this list until 2026-08-01, and the failure mode is worth remembering: a
run that batches happily for twenty calls and then hits a *standalone* `javascript_tool`
gets that one call refused in auto mode, which reads like a page or a domain problem and
is neither.

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

Phase 2's extraction step (`jd-extract`, Appendix E) replaced hand-written page slicing in
#719, and the inject-and-call round trip **was** run against live Indeed and LinkedIn on
2026-08-01. The result splits by site, and the split is the important part:

- **Indeed works, and is the best lane in this skill.** `indeed.com/viewjob?jk=…` ships a
  JSON-LD `JobPosting`, so extraction lands on tier 1 `schema_org` with a real `datePosted`,
  `salaryRange` and `employmentType`, and it does **not** depend on the SPA having rendered.
  Fifteen captures on one run: bodies 2.9–10.2 KB, every one rated (2.4★–4.6★), none weak.
- **LinkedIn does not work, and Phase 2's LinkedIn section below is retained for its search
  and id-collection value only — do not expect to capture a body from it.** See the box
  below before spending a run on it.

**LinkedIn: the adapter matches the page that has no description.** Verified on two
different postings, waiting 25 s+ each:

| Path | Result |
|---|---|
| `/jobs/view/<id>/` — the only URL `M.matches()` accepts | LinkedIn renders a **stub**. No `h1`, no JSON-LD, no description, `main` ≈ 1.4 KB. Body came back **812 chars** of page chrome |
| `/jobs/search/?currentJobId=<id>` — where the description actually renders (6.3 KB, ~15 s to arrive) | Adapter does **not** match. Forcing it with a synthetic view URL makes it read all of `main`: **14.8 KB polluted** with the results list at the head and a "Trending employee content" rail at the tail, `company: "Unknown"` |

Two component defects fall out of this, both worth fixing before the lane is usable:

1. `v()` (the `document.title` fallback) splits on `-`, so
   `"Head of Engineering ($225k-$325k + Equity)… | Jack & Jill | LinkedIn"` yields the title
   **`"Head of Engineering ($225k"`**. It only runs when `h1` is missing — which on LinkedIn
   is always.
2. `prune.ts` does not drop the SERP results list: it is neither `nav`/`aside` nor under a
   heading matching `ht`, so the "read the pane" workaround cannot be made safe by pruning
   alone.

A 14.8 KB body of search chrome is exactly the input measured at 0.00★ further down. Report
it; do not ship it.

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

`get_page_text` and `read_page` are for Phase 2's **search result** pages, not for offlinecv
itself and not for posting bodies — everything this skill reads out of the app comes from
IndexedDB via `javascript_tool`, and posting bodies come from the injected extractor
(Appendix E). A posting body assembled from `get_page_text` is the failure #719 removed.

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

**`fromage` is not an age guarantee — filter again on the extracted `datePosted`.** It
bounds Indeed's *index* date, not the posting's own declared date. Observed 2026-08-01: a
`fromage=14` search returned a posting whose schema.org `datePosted` was **2026-06-05, 57
days old**. The extractor gives you the publisher's own date, so check it before you capture
and say the real age in the report.

Indeed's relevance is also weak, and quoting does not fix it: a quoted boolean query for
engineering-leadership titles returned dog-walking, tennis-coaching and port-engineer
listings alongside the real ones. Expect to discard most of a result page by hand. A few
cards also carry placeholder-looking `jk` values (`a1b2c3d4e5f67890`,
`456789abcdef0123`) that duplicate a neighbouring real card — do not capture those.

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

Hand that canonical URL to `JD.toJobRecord` as its second argument — **the extractor does
not rewrite it for you.** What the mapper does do is prefer the posting's `atsUrl` over it:
when the page links through to a Greenhouse or Lever original, that ATS URL becomes
`JobRecord.url` instead, so the same job found on LinkedIn, on Indeed, and on the company's
own board collapses to one record. The cost is that a posting captured once where that
link is readable and once where it is not forks into two records — a duplicate the user can
delete, which is the side of the trade `job-url.ts` deliberately lands on.

### Take the posting's body with `jd-extract`, never by reading the page yourself

**Do not slice the page text by hand.** `src/lib/jd-extract/` is this repo's job-posting
extractor, and the app and the browser extension run the same code — that is the whole point
of it existing (#719, the same argument `src/lib/storage/job-url.ts` makes for id
derivation). This section used to describe extraction as English prose over string sentinels
— "keep the text between `About the job` and `Set alert for similar jobs`" — and that is the
implementation the module replaced. Do not re-derive it.

Build the injectable bundle once per session:

```bash
node_modules/.bin/esbuild src/lib/jd-extract/index.ts \
  --bundle --format=iife --global-name=JD --minify \
  --outfile="$SCRATCH/jd-extract.js" --log-level=error
```

~24 KB, network-free by construction: the barrel deliberately omits the `ats_api` tier
because that one imports `fetch()`, so nothing you inject into the user's page can make a
request. Read the file and pass its contents to `javascript_tool` on the posting tab,
followed by the call — see Appendix E for the exact shape.

Injection runs in the **page's own context**, so `window.JD` survives until the tab
navigates. On LinkedIn that is worth using: the jobs search is an SPA, so you can inject
once and then read posting after posting by changing `currentJobId` without paying the
bundle again. Anywhere each posting is a real navigation, re-inject.

What comes back is one ~1 KB JSON object, not the page. That direction matters: a LinkedIn
job page is 1–2 MB of HTML, so shipping the page out to slice it here costs far more than
shipping ~24 KB of extractor in.

`JD.extract` returns `null` when the page is not a posting — a closed listing, a search
results page, an interstitial. That **is** the liveness check, for one read instead of two.
A `null` is not an error to retry; drop the posting and report the URL as unhydrated.

**Do not call a site's internal JSON API** — LinkedIn's `/voyager/` endpoints answer, but
reaching them means lifting the page's CSRF token out of `document.cookie`, which is both a
permission this skill does not have and an interface with no promise of stability. The
rendered page is the supported read.

**Expand truncation before you extract.** Both sites collapse long descriptions behind a
"see more" control, and the extractor reads the DOM it is given — a collapsed description
extracts cleanly and stops mid-posting, which is the failure that looks most like success.
Click it, then inject.

### What the extractor already handles, so you do not

- **The people block.** A LinkedIn posting page surfaces the user's 2nd-degree connections
  under "People you can reach out to", by name, current title and school. That is a *third
  party's* personal data, and `jdText` gets persisted to the user's IndexedDB.
  `src/lib/jd-extract/prune.ts` drops that subtree, along with "More jobs for you" rails and
  page chrome, before the body is built. Verified by test, not by inspection — but if you
  ever see a person's name in a body you are about to write, stop and say so rather than
  editing it out by hand, because a name reaching that far means the guard has rotted and
  the extension is leaking it too.
- **Line structure.** The body comes back as Markdown, with the list structure the
  requirements live in. The old advice to convert `<br>`/`</p>`/`</li>` to newlines before
  stripping tags is now the module's job.
- **The canonical ATS URL.** Where a listing links through to a Greenhouse or Lever
  original, `toJobRecord` puts *that* in `url` — see Phase 3.

The app's own `/jobs/` Search tab is the remaining option, and it is the user's to drive: it
egresses a keyword string built from their query, a deliberate and documented boundary
(`src/lib/job-search/providers/keywords.ts`). Do not automate it on their behalf without
saying so.

### `jdText` is the requirements body, not a summary — this is the #1 quality lever

**Never hand-write, paraphrase, or top-and-tail the body.** Pass through exactly what
`JD.extract` returned. Measured on a live posting, same résumé, same everything else:

| `jdText` | terms extracted | rating |
|---|---|---|
| 489-char summary written by the producer | 5 nouns, **0 skills** | **0.00★ "Weak fit"** |
| 8000 chars of the real JD body | 26 terms incl. real skills | **2.34★** |

A hand-written blurb reads well and rates zero, because what survives paraphrase is the
company name and the job title — and no résumé on earth contains those. The fit rating is
only as good as the text you save, and the user cannot tell a bad capture from a bad match:
both render as "Weak fit".

**Add nothing to it.** No synthesized provenance header — no `Posted: … ReqID: … Type: …`
line, no fetch timestamp, no source URL. A capture that prepended one put the junk term
`REQ` straight into the coverage denominator, where it cost real rating and no résumé could
ever cover it. Provenance belongs in `capture`, a structured field the matcher never reads.

**Check the extraction before you keep it.** Two fields on the result say how much to trust
it, and both belong in the report:

- `extractionTier` — `schema_org` is the publisher's own machine-readable declaration and is
  the best case. `ats_extractor` is a host adapter. `dom_metadata` is the floor, and on a
  LinkedIn posting it is also the *expected* value, because LinkedIn's adapter reports that
  tier deliberately — it is an aggregator, not an ATS.
- `body.length` — aim for **≥2000 characters**. Under ~1500 usually means the description
  was still collapsed behind "see more", or the SPA had not rendered when you injected.
  Expand, re-inject, re-read. If it stays short, keep it and say so in the report; do not
  pad it and do not silently drop it.

---

## Phase 3 — Build the import document

### The record is already built — `JD.toJobRecord` made it

Phase 2's injected call returned a capture payload, not raw extraction output. It carries
`title`, `company`, `url`, `jdText`, the six posting facts the contract added in v2
(`location`, `salaryRange`, `datePosted`, `workModel`, `employmentType`, `validThrough`),
and a filled `capture` block. **Pass those fields through unchanged.** Do not re-derive one,
do not add one the mapper omitted, and do not fill a blank — an omitted field means "the
posting did not say", and inventing a value there is the drift `to-job-record.ts` exists to
prevent.

What it deliberately does **not** give you is an `id` or a `status`. Those are next.

### Derive ids with the repo's own code, never by hand

`deriveJobId` is normative (§2 of `docs/job-capture-contract.md`). A producer that strips
one parameter differently forks the id space and creates silent duplicates. It is not on the
injectable barrel — the page has no reason to derive an id — so bundle it separately and
call it here:

```bash
node_modules/.bin/esbuild src/lib/storage/job-url.ts \
  --bundle --format=esm --outfile="$SCRATCH/job-url.mjs" --log-level=error
```

Then `import { deriveJobId } from "$SCRATCH/job-url.mjs"` in a node one-liner, and feed it
**the `url` the mapper returned**, not the URL you navigated to — they differ whenever the
`atsUrl` rule fired, and that difference is the entire point of it. Verified:
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

Each job is the mapper's payload plus the two fields it does not own — the derived `id` and
`status: "interested"`:

```json
{
  "version": 2,
  "exportedAt": 0,
  "resumes": [],
  "jobs": [
    {
      "id": "job:<derived>",
      "status": "interested",

      "title": "…",
      "company": "…",
      "url": "https://…",
      "jdText": "…",
      "location": "Austin, TX",
      "salaryRange": "$180k – $220k",
      "datePosted": "2026-07-28",
      "workModel": "remote",
      "employmentType": "FULL_TIME",
      "validThrough": "2026-09-01",
      "capture": {
        "contract": 2,
        "producer": "claude-code-jobs-skill",
        "producerVersion": "0.2.0",
        "capturedAt": 1754006400000
      }
    }
  ],
  "letters": []
}
```

The blank line marks the seam: everything below it came from `JD.toJobRecord` verbatim.
The six posting facts are all optional — **emit only the ones the mapper returned.** They
are display-only record-keeping; nothing ranks on them, so a missing one costs the user
nothing and a guessed one is just wrong.

Rules the validator enforces, so get them right up front:

- `title` required; `status` must be one of `interested | applied | interviewing | offer |
  rejected | archived`; `url` must be absolute `http(s)` (it is rendered into an `href`).
- **A v2 document without a `letters` array is malformed** — emit `[]`, never omit it.
- Every value must survive `structuredClone` and a JSON round-trip. No `Date`, no
  `undefined`, no functions. An own `__proto__` key refuses the whole record.
- **Write the job and its letters in the same document.** `importAll` writes
  resumes → jobs → letters, so a letter's `jobId` resolves. A letter whose `jobId` matches
  no job imports cleanly and is then reachable from nothing — nothing reconciles it.
- `datePosted` and `validThrough` are accepted whatever they say, but a value that does not
  start `YYYY-MM-DD` earns a warning. Never convert a relative date — `"3 days ago"` is
  wrong tomorrow and nothing downstream can tell. Pass through what the mapper returned;
  it is already the posting's own declared value.

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
- **how well each posting extracted** — its `extractionTier` and body length. A run where
  everything landed on `dom_metadata` at 600 characters produced worse ratings than one on
  `schema_org` at 8000, and the ratings alone do not distinguish a weak match from a weak
  capture. Say which it was
- **any posting whose `url` came from `atsUrl` rather than the page you captured it on** —
  the record points at the ATS original, so the user clicking through will not land back on
  the LinkedIn or Indeed listing they would expect
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

## Appendix E — extract a posting

Build once per session (Phase 2), then per posting: read `$SCRATCH/jd-extract.js` and send
its contents as the **first part** of one `javascript_tool` call, with this appended.
`javascript_tool` has REPL semantics — top-level `await` works and the last expression is
the return value, so there is no `return` here and there must not be one.

```js
// …contents of $SCRATCH/jd-extract.js above this line, defining `JD`…

const canonical = "https://www.indeed.com/viewjob?jk=<jk>"; // Phase 2's normalised URL
const posting = await JD.extract(document, new URL(location.href));

JSON.stringify(
  posting && {
    tier: posting.extractionTier,
    bodyChars: posting.body.length,
    fromAtsUrl: Boolean(posting.atsUrl),
    record: JD.toJobRecord(posting, canonical, {
      producer: "claude-code-jobs-skill",
      producerVersion: "0.2.0",
    }),
  },
);
```

`document` and `location.href` are the *page's* — what it actually rendered, including
whatever you expanded. `canonical` is a separate argument on purpose: the extractor reads
the page it is on, and normalising away tracking parameters is Phase 2's job, not its.

`null` back means the page is not a posting — a closed listing, a search page, an
interstitial. Drop it and report the URL; do not retry.

**Keep the `JSON.stringify`.** The record must cross the tool boundary as JSON, not as an
object — an object built in the page's realm has that realm's `Object.prototype`, and
`validateJobRecord` refuses it with `` `capture`: a Object is not a plain JSON object ``,
which reads like a malformed record and is not one. Serialising is what re-homes it.

The bundle runs in the page's own context, so `window.JD` persists until the tab navigates.
Re-sending it is harmless — it just redefines `JD` — but on a page that still has it,
sending only the call is free.
