---
name: job-hunt
description: Run a job hunt end to end against the user's own offlinecv.org library — find real postings, capture their requirements text, and write them in through the app's own backup-import door so every record passes the capture contract. Picks the résumé to work against and loads it so /jobs/ ranks postings against it; never overwrites a job the user has already moved through their pipeline. Use when the user says "/job-hunt", "find me some jobs", "drop these jobs into offlinecv", "save these postings to my library", or "put this in my job tracker".
---

# job-hunt — Claude Code as an outside producer for offlinecv

offlinecv's storage layer was designed for a producer exactly like this skill.
`docs/job-capture-contract.md` and `docs/cover-letter-contract.md` are **normative**;
this skill is one implementation of them. Read them when anything below is ambiguous —
they win.

Everything in this file was verified end-to-end against live `offlinecv.org`
(release `283a7bd`, `DB_VERSION 3`) on 2026-08-01. Where the obvious approach was
tried and failed, that is called out — do not re-derive it.

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

---

## Phase 0 — Open and take stock

Load the Chrome tools in **one** `ToolSearch` call:

```
select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__find,mcp__claude-in-chrome__file_upload,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__list_connected_browsers,mcp__claude-in-chrome__switch_browser
```

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

Two sources, in this order:

1. **Company board indexes** — `job-boards.greenhouse.io/<co>`, `jobs.lever.co/<co>`,
   `jobs.ashbyhq.com/<co>`. Read the anchors. Live by construction, and the cheapest
   source of URLs that actually resolve.
2. **Web search**, restricted to those hosts via `allowed_domains`. Faster for breadth,
   but see below — its results decay.

The app's own `/jobs/` Search tab is the other option, and it is the user's to drive: it
egresses a keyword string built from their query, which is a deliberate, documented
boundary (`src/lib/job-search/providers/keywords.ts`). Do not automate it on their behalf
without saying so.

### Verify the posting is live before you capture it

Search indexes go stale fast — postings close within days. Observed on 2026-08-01: of
four URLs taken from search results, **three were dead**. Greenhouse silently redirects a
closed job id to the company's board index (so a fetch "succeeds" and returns the wrong
listings); Lever returns an honest 404. Capturing either writes a dead link into the
user's tracker with a plausible title.

Fetch each posting and confirm the page is the posting itself — an `h1`/headline matching
the title you are about to write. A cheaper source of live URLs: load the company's board
index and read the anchors, which are live by construction.

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
- jobs written / already-present-and-skipped / refused, each refusal with its reason
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
