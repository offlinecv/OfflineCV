---
name: cover-letter
description: Write, revise and store cover letters for jobs in the user's own offlinecv.org library. Takes posting URLs (saving them to the job tracker first) or picks from already-tracked jobs, reads each JD, names where the résumé does not match it, and interviews the user for what a résumé structurally cannot carry — then drafts, revises with them, and writes the letters into the letters store through the app's backup-import door so every record passes the cover-letter contract. Use when the user says "/cover-letter", "write a cover letter", "draft a letter for this job", "revise my cover letter", or asks for letters for jobs they have tracked.
---

# cover-letter — write letters into offlinecv's letters store

`docs/cover-letter-contract.md` is **normative**; this skill is one implementation of it.
Read it when anything below is ambiguous — it wins.

This skill is the sibling of **`job-hunt`**, and deliberately thin where they overlap.
Chrome pairing, the two doors, the import mechanics and the store read all live in
`.claude/skills/job-hunt/SKILL.md` — **read that file's Phase 0, Phase 4 and Appendices A
and B before driving the browser.** Do not re-derive them here.

What is different about letters, and why this is a separate skill:

- A job is **captured**; a letter is **generated**. The quality bar is prose, not plumbing.
- Letters have **no natural key** — no `deriveJobId`, no convergence. Ids are yours to own.
- Letters are visible in the app (#715): the Saved jobs library (`/jobs/#saved`) shows an
  icon on any tracked job with a letter, which reveals it as plain text with a Copy to
  clipboard button — several drafts are reachable there too, by `label`. This skill still
  hands over a `.txt` file as well (Phase 7), so the user has something to paste immediately
  without switching to the app.

## Say this once, at the start

> Writing the letter sends your saved résumé parse and the job description to the
> Anthropic API — that is what a Claude Code skill is. The app's "never leaves your
> browser" claim is about the app; this step is outside it, by your choice. The letter is
> stored back in your own library, on your machine.

Once, plainly, then move on. Do not re-hedge it in every phase.

## Hard rules

1. **Emit a letters-only document — `jobs: []`, `resumes: []`.** Never re-include a job
   that is already tracked, not even the one the letter is for. Merge import calls
   `putRecord`, a wholesale replace, so re-writing a tracked job **resets the user's
   `status`, `notes` and `resumeId`**. A letter needs the job to *exist*, not to be rewritten.
2. **Never write a letter whose `jobId` is not already in the `jobs` store.** §5 of the
   contract: a letter is only ever reached through its job, and nothing reconciles a
   dangling `jobId`. It would import cleanly and be unreachable forever. If the job is not
   there, save it first (Phase 1).
3. **Never state a fact neither the résumé nor the user gave you.** Every claim traces to
   a field in `ResumeRecord.parse` — an employer, a title, a date range, a bullet, a
   number — **or to an answer the user gave in Phase 3.5**, which is first-hand evidence
   about their own career and is exactly what a letter is for. What is forbidden is
   invention: a year of experience, a technology, a scale, an outcome that came from
   neither source. That is the one failure the user cannot catch by reading fast, and it
   is the failure that costs them the job.
4. **Name the mismatch out loud.** If the posting's named requirements are largely
   unevidenced, say so to the user — before drafting (Phase 3.5) and again in the report
   (Phase 7). A letter that reads as a strong match for a job the résumé does not support
   is a disservice dressed as helpfulness. Whether to apply anyway is their call, not yours.
5. **Show the draft before writing it.** The user reads and approves prose, then it is
   stored. Never import a letter they have not seen.
6. **Never select `replace` mode**, and **verify every write by re-reading the store** —
   `job-hunt` hard rules 1 and 3, unchanged.
7. **Revise = reuse the `id`.** The store upserts, so the same id replaces the body and
   keeps `createdAt`. A fresh id adds a second draft. Never both by accident — read the
   existing letters for that job before writing.
8. **Never delete or edit a letter this skill did not write.** Its marker is
   `producer.producer === "claude-code-letter-skill"`.

---

## Phase 0 — Pair, and read the store

Run `job-hunt` Phase 0 verbatim: one `ToolSearch` call, `switch_browser` broadcast (never
`select_browser` — the unit is the **Chrome profile**), then Appendix A's store read.

One extra check letters need:

- **No `letters` object store → stop.** The tab is on a build older than `DB_VERSION 3`.
  Unlike jobs, there is no reduced mode to fall back to; a v2 document into a v1 build
  throws `Unsupported storage export version: 2` and writes nothing. Tell them what is
  missing and let them decide to reload. Do not reload for them.

Read, and keep: the `jobs` records (id, title, company, `status`, `resumeId`, `jdText`
length), the existing `letters` (id, `jobId`, `label`, `updatedAt`, body length — **not**
the bodies), and the `resumes` summaries.

---

## Phase 1 — Which jobs, and are they tracked yet?

Ask first, before anything else — and **before pairing Chrome**, since this question does
not need a browser and pairing costs a two-minute broadcast. `AskUserQuestion`:

> **Do you have the postings, or are these jobs already in your library?**
> - **I have URLs** — paste them; I'll save them to your tracker first, then write
> - **Already tracked** — pick from your saved jobs
> - **Both**

### I have URLs

Collect them, then **run `job-hunt` Phases 2, 3 and 4** to capture and import them —
including its `jdText` rule, which matters twice as much here (Phase 3 below). The jobs
land in the tracker as a side effect, which is what the user wants: a letter is for a job
they are pursuing, and a job they are pursuing belongs in the library.

Do not hand-roll a job record in this skill. `deriveJobId` is normative and forking the id
space is silent.

If a URL is already tracked, `job-hunt`'s dedupe drops it — that is correct, and it just
means the job moves to the "already tracked" list below. Say so; do not re-import it.

### Already tracked

`AskUserQuestion` with one option per job, most-recently-updated first. Label
`<Title> — <Company>`; description carries `status` and whether a letter already exists.
**Multi-select** — several letters in one sitting is the normal case.

If a chosen job **already has a letter**, ask which they mean: revise that draft (reuse
its id), or add a second draft (new id, and give both a `label` so they are tellable
apart). This is hard rule 7 and it is invisible if you get it wrong — an accidental
overwrite looks exactly like a successful write.

### Batching

**Work in batches of up to four, and run each phase across the whole batch before moving
on.** Read every JD (Phase 3), interview once (Phase 3.5), draft all, show all, then
import all in **one** document — one dialog, one `Restore`, one verification read.

Four is the ceiling because the interview is what makes a letter specific, and an
interview stretched across more than four postings collapses into generic questions.
Past four, say so and do a second batch rather than diluting it.

Batching does **not** mean one letter reused. Each letter answers its own posting's named
requirements, in that posting's own words.

---

## Phase 2 — Resolve the résumé

A letter needs `ResumeRecord.parse`, not just a filename.

1. **If `JobRecord.resumeId` is set**, that is the user's own answer — use it, and name it
   in the report. It is user-owned; do not second-guess it.
2. **Otherwise** follow `job-hunt` Phase 1's rules: zero saved résumés → stop and tell them
   to drop a PDF and click **Save to library**; exactly one → use it silently; more than
   one → `AskUserQuestion`, most-recent first, filename as label, saved date + score in the
   description.

Read the parse out narrowly. **Never dump a whole `ResumeRecord`; each carries the PDF
`blob`.** The paths, verified against a live record (`DB_VERSION 3`, `shapeVersion` on the
parse envelope):

| What | Path |
|---|---|
| Structured fields | `parse.result.canonical.fields` |
| Sections + per-field confidence | `parse.result.canonical.sections` / `.fieldConfidence` |
| The whole résumé as text | `parse.result.markdown`, else `parse.result.rawText` |
| Score | `parse.score.overall` |

It is **`canonical`, not `parsed`** — `parsed` is the cascade's internal heuristic shape and
never reaches storage (`cascade.ts` builds `canonical` via `toCanonicalResume` and that is
what `CascadeResult` carries). A read for `parse.result.parsed` returns `undefined`, which
looks exactly like an uncached résumé. `docs/canonical-resume-model.md` is the model.

From `canonical.fields` you need: `full_name`, `email`, `phone`, `location`, `linkedin_url`
(use them verbatim — never invent a signature), `summary`, `experience[]` with `title`,
`company`, dates and `description`, `skills`, `education`.

**`parse.result.markdown` is usually the better read for drafting.** The canonical fields
are the ground truth for names and dates, but the markdown carries every bullet in the
order the user wrote them, in one read instead of a walk.

`javascript_tool` truncates its output near 1 kB, so a 6 kB résumé needs slicing —
`(md).slice(0, 900)`, `.slice(900, 1800)`, … Issue the slices as parallel calls; they are
independent reads.

If `parse` is genuinely absent, the résumé was saved by a build that did not cache it. Stop
and ask the user to load it on `/` once; that repopulates the cache.

---

## Phase 3 — Get the real requirements text

**`JobRecord.jdText` is the raw material, and a thin one produces a generic letter.** The
same lever that drives fit ratings drives letter quality: a 400-character blurb contains
the company name and the job title and nothing a letter can answer.

Check the length. Under ~800 characters, **re-fetch the posting** (`WebFetch`, or a Chrome
tab if the board needs JS) and use the fresh body for the letter.

**Do not write the re-fetched text back into the `JobRecord`** as a side effect of asking
for a letter — that is hard rule 1. If the stored `jdText` is thin, say so at the end and
offer `job-hunt` as a separate step.

When converting HTML to text, turn `<br>`, `</p>` and `</li>` into newlines **before**
stripping tags. Flattening line breaks destroys the structure that separates
responsibilities from qualifications.

From each JD, extract explicitly before drafting:

- the **named requirements** — the 3–5 the posting leads with, in its own words
- the **team's problem** — what the role exists to solve, if the posting says
- **must-haves with no evidence in the résumé** — the gap list. Phase 3.5 turns these into
  questions and Phase 5 reports whatever survives.

Do the whole batch here, then move on once. Do not read one JD, draft, and come back.

---

## Phase 3.5 — Interview the user

**This is the phase that makes the letter worth sending.** A résumé is already in the
application; a letter that only restates it adds nothing. What a letter can carry, and a
résumé structurally cannot, is the person: why this role, what they are actually good at
that no bullet captured, what a number leaves out.

Skipping this and drafting from the parse alone produces a competent, forgettable letter.
Do not skip it.

### First, show them the gap

Before asking anything, state plainly where the résumé does **not** meet the posting:

> This JD leads with <requirement>. Your résumé shows <adjacent thing> but nothing direct
> on that. Is there something not on the résumé?

Two reasons this comes first. It is honest — the user should know what a reader will
notice, from you, before they send it. And it is the highest-yield question in the
interview: the answer is either real experience that never made the résumé, or a genuine
gap the letter should stop trying to paper over.

If the résumé is a **weak match overall** — most of the named requirements unevidenced —
say that as a judgement, not a hedge, and ask whether they want to proceed. That is their
call. Do not quietly write an enthusiastic letter for a job the résumé does not support.

### Then ask

Three to five questions. Not a form — pick the ones this posting and this résumé actually
raise, and ask them in one message so the user can answer in one pass. Draw from:

- **Why this company, specifically?** Anything real — a product they use, someone they
  know there, a problem they have watched this team get wrong or right. Generic admiration
  is what the ban list exists to kill; this question is how you get past it.
- **The story behind the strongest bullet.** What the résumé line compresses — what was
  actually hard, what they decided, what it cost. One paragraph of this beats three
  bullets restated.
- **The gap question(s)** from above.
- **A move the résumé makes look odd** — a short stint, a pivot, a gap in dates, a title
  that reads down. Only if the posting's reader would plausibly stop on it. Ask what
  happened; a sentence of context in the letter closes it, and silence lets them guess.
- **What they want next** — the part of this role they actually want, versus the part they
  can already do. A letter that knows the difference reads like a person.
- **Anything they want in and anything they want out.** Cheapest question, frequently the
  most useful.

`AskUserQuestion` when the answers are genuinely a choice among options. Otherwise ask in
prose — these are open questions and a four-option chip does not fit them.

### Batch shape

Ask the **shared** questions once for the whole batch (why this kind of role, the strongest
story, the odd move). Ask **per-job** only what differs — usually the gap question and
"why this company". Do not re-ask the same thing per posting.

### Then use the answers

Everything the user says here is admissible. That is the point: rule 3 forbids facts the
**résumé** does not support *and* the user has not supplied — a thing they tell you about
their own career is evidence, and a letter is exactly where it belongs.

Do not soften it back into résumé language. If they say the migration took eleven months
and two of those were spent convincing people, that sentence is better than any paraphrase.

---

## Phase 4 — Write it

### Format: plain prose

`LetterRecord.body` is typed as markdown, and the user's preference is **plain text** —
these agree, because plain prose *is* valid markdown. So:

- **No markdown syntax.** No `#`, no `**`, no `-` bullets, no tables. An employer pasting
  this into a form or an email must not see asterisks.
- Paragraphs separated by a blank line. `\n\n`, not `<br>`.
- No header block, no date line, no company address — the letter opens with the salutation.
  Modern applications are a textarea or an email body, not a printed page.
- Sign with the real name from `parse.contact`, then email, then phone if present, one per
  line. Nothing else.

**The parsed contact IS the contact. Do not ask the user to confirm it.** The résumé is
the document the employer will hold next to this letter; an address that disagrees with it
is the bug, not an address that matches it. The user chose what to put on their résumé, and
they chose it for employers — a different address they happen to use elsewhere (a work
account, the one they are chatting from) is not more current, it is less relevant. If
`parse.contact` is empty or the parse is low-confidence on a contact field, that is a
**parse** problem: say which field is missing and let them fill it. That is the only
question about contact this skill ever asks.

### Shape: four paragraphs, under 350 words

1. **The specific role, and one concrete reason for this company** — drawn from the
   posting and from the interview, not from adjectives. "You are rebuilding the ingestion
   path for X" beats "I have long admired your work."
2. **One achievement, with its real number**, mapped to a requirement the posting named —
   and told with the Phase 3.5 detail the bullet compressed. The number is the claim; the
   story is why they should believe it.
3. **A second achievement**, mapped to a different requirement. Different in kind from the
   first — do not restate one accomplishment twice.
4. **Close**: what they would be getting, and the contact line.

**Never state availability.** Not "available immediately", not a start date, not a notice
period. Volunteering it weakens the letter and it weakens a senior one most: a leader who
announces they can start tomorrow is answering a question nobody asked, and the reading is
that nothing is currently holding them. Availability is a scheduling detail that belongs in
the first conversation, where it costs nothing. If the posting explicitly asks for a start
date, answer it — in the field that asks, not in the letter.

**At least one paragraph must carry something that is not in the résumé.** If every
sentence could be reconstructed from the parse alone, the interview was wasted and the
letter is redundant with the document sitting next to it.

### Register

The house rules for offlinecv copy apply to a letter as much as to product prose:

- **Defensible, not merely confident.** Every claim points at something real. Do not name
  a system, a scale, or an outcome the résumé does not carry.
- **No false precision.** "Roughly a third" when the bullet says roughly a third.
- **No self-serving negation.** Do not tell them what you are not. Say what you are.
- **Ban list**: "I am excited to apply", "passionate about", "perfect fit", "proven track
  record", "leverage", "synergy", "wear many hats", "hit the ground running", "as you can
  see from my résumé", "available immediately". Any sentence that survives deleting the
  company name is a sentence about nobody.

### Gaps

Phase 3.5 already asked about these. For each one that survived the interview, choose one
and say which you chose in the report:

- **The interview answer** — if the user supplied real experience the résumé omitted, that
  is now evidence. Use it. This is the best outcome and the reason the phase exists.
- **Adjacent and true** — the nearest real experience, named as what it is.
- **Silence** — the letter is not obliged to enumerate every requirement.
- **Never** — a claim neither source supports. Rule 3.

---

## Phase 5 — Show it, revise it

Print the full draft in the conversation — every letter in the batch, in one message.
Under each, say what it claims and where each claim comes from: one line per paragraph,
citing the résumé field or the interview answer. Then ask.

Revising one letter in a batch does not reopen the others. Track which are approved.

Revise in the conversation, not in storage. Only import once the user says it is right.
This costs one round trip and saves the far worse loop of revising a record that already
has an id and a `createdAt`.

---

## Phase 6 — Write it into the library

`StorageExport` v2, letters only:

```json
{
  "version": 2,
  "exportedAt": 0,
  "resumes": [],
  "jobs": [],
  "letters": [
    {
      "id": "<crypto.randomUUID(), or the existing id when revising>",
      "jobId": "job:<the id already in the jobs store>",
      "resumeId": "<the ResumeRecord id from Phase 2>",
      "label": "Draft 1",
      "body": "Dear hiring team,\n\n…",
      "producer": {
        "contract": 1,
        "producer": "claude-code-letter-skill",
        "producerVersion": "0.1.0",
        "generatedAt": 0
      }
    }
  ]
}
```

What the validator enforces, so get it right up front:

- `id`, `jobId`, `body` required. `body` may be empty; `jobId` may not.
- `producer.contract` must be a **finite number**. The rest of the object is optional but
  send it — provenance cannot be retrofitted, and offlinecv writes no letters itself, so
  every letter in the store should carry it.
- Every value JSON-safe: no `Date`, no `undefined`, no `NaN`, no functions. An own
  `__proto__` key refuses the whole record.
- **A v2 document must carry all three arrays.** `jobs: []` and `resumes: []` are written,
  not omitted.
- Unknown keys are preserved, not dropped — so do not stash scratch state on the record.

Then import exactly as `job-hunt` Phase 4 does: `find` the file input on `/` (it is only on
`/`), `file_upload`, assert the open `<dialog>` shows your filename with **merge** checked,
click `Restore` programmatically from inside the dialog, wait, **re-read the store**.

Submitted-minus-accepted is the refusal count. Refusals are per-record and silent at the
storage layer — derive them from the diff and report each with its record.

---

## Phase 7 — Hand it back, twice

**Store it, and also give them a file.** The app shows the letter (#715), but a chat-side
`.txt` is still the fastest way to get it into a form or an email without switching windows.
Write `cover-letter-<company>-<role>.txt` into the session scratchpad and surface it with
`SendUserFile`. Plain `.txt`, the exact body that went into the store.

Report:

- per letter: the job (title, company) and the résumé used, and whether that résumé came
  from `JobRecord.resumeId` or from a pick
- letter id, and whether it **revised an existing draft** or **added a new one**
- letters written / refused, each refusal with its reason
- jobs newly saved to the tracker on the way through, and any URL dropped as already tracked
- which JD requirements each letter answers, and which named must-haves it deliberately did
  not claim
- **the honest match verdict** (rule 4) — for each posting, whether the résumé plus what
  the user told you actually supports it, said as a judgement. This is the line the user
  needs and the one it is most tempting to soften.
- what came from the interview rather than the résumé — so they can see what the letter
  adds over the document they are already sending
- if `jdText` was thin and you re-fetched: say so, say the stored record is unchanged, and
  offer `job-hunt` to re-capture it
- where the `.txt` landed
- where to see it in the app: Saved jobs (`/jobs/#saved`) → the letter icon on this job

---

## Appendix — read letters for a job

```js
const db = await new Promise((res, rej) => {
  const r = indexedDB.open("offlinecv");
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const read = (n) => new Promise((res) => {
  const q = db.transaction(n, "readonly").objectStore(n).getAll();
  q.onsuccess = () => res(q.result);
});
JSON.stringify((await read("letters")).map(l => ({
  id: l.id, jobId: l.jobId, label: l.label ?? null,
  resumeId: l.resumeId ?? null, updatedAt: l.updatedAt,
  bodyChars: l.body.length, producer: l.producer?.producer ?? null,
})));
```

Summaries, not bodies — a bodies dump is the user's own prose scrolling past for no reason.
Read one body only when revising it.

## Appendix — cleanup

Only letters carrying this skill's marker:

```js
const tx = db.transaction("letters", "readwrite"), s = tx.objectStore("letters");
for (const l of await read("letters")) {
  if (l.producer?.producer === "claude-code-letter-skill") s.delete(l.id);
}
```

Deleting the **job** through the app cascades to its letters (`deleteJob` →
`deleteLettersForJob`). Deleting a job through raw IndexedDB does **not** — sweep by
`jobId` yourself, or prefer the UI.
