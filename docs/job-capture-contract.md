# Job capture contract (v2)

**Audience: anyone writing a job record into offlinecv from outside this repo** — a browser
extension, a bookmarklet, a script that converts another tracker's export. You do not need to read
the source to implement this. If a rule here and the code disagree, that is a bug; file it.

**Status:** version 2. Introduced in [#693](https://github.com/offlinecv/OfflineCV/issues/693);
extended in [#719](https://github.com/offlinecv/OfflineCV/issues/719) with the six posting facts,
and in [#745](https://github.com/offlinecv/OfflineCV/issues/745) with `origin` and
[#746](https://github.com/offlinecv/OfflineCV/issues/746) with `aliasUrls` — no version bump for
either; see §8 and §9.
Implemented by `src/lib/storage/job-record-contract.ts` (validation),
`src/lib/storage/job-url.ts` (identity), and `src/lib/storage/capture.ts` (the write path).

**Upgrading from v1 costs you nothing.** Every field v2 added is optional, so a producer written
against v1 is already a valid v2 producer — send `"contract": 2` when you start sending the new
fields, and not before.

Records that violate this contract are **refused**, not repaired. offlinecv would rather tell you
your record was wrong than store a mangled version of it and report success.

---

## 0. Where records enter, and what checks them

There are exactly two doors into the `jobs` object store from outside the app's own typechecked
code, and both go through the same validator:

| Door | Entry point | Who uses it |
|---|---|---|
| A backup file the user picks | `importFromJson` → `importAll` | "Import backup" in the resume library |
| A record a producer hands over | `captureJob` | An extension, a bookmarklet, a converter |

`captureJob(input: unknown)` returns either `{ ok: true, record, created, warnings }` or
`{ ok: false, reasons }`. It never throws for a bad record, and it never writes a record it
refused.

Everything else — the tracker UI, the JD-match "save this job" button — is inside the build and
typechecked against `JobRecord` directly.

---

## 1. Fields

A record is a **plain JSON object**. Not an array, not `null`, not a class instance.

### Required

| Field | Type | Meaning |
|---|---|---|
| `id` | non-empty string | Primary key. See §2 — **derive it, do not invent it.** |
| `title` | string | The posting title, e.g. `"Senior Frontend Engineer"`. May be empty, but the key must be present. |

### Optional

| Field | Type | Meaning |
|---|---|---|
| `company` | string | Hiring company. Empty is fine; the user fills it in later. |
| `url` | string | The posting URL. Must be an **absolute `http` or `https` URL**. See §3. |
| `status` | string | Lifecycle position. See §4. Omit it and you get `"interested"`. |
| `notes` | string | Free-text notes. **User-owned** — see §5. |
| `resumeId` | non-empty string | Id of a saved résumé in the same store. **User-owned.** Only meaningful if you know one exists. |
| `jdText` | string | The job description, verbatim. |
| `matchResult` | JSON-safe value | An opaque match payload. See §6. |
| `capture` | object | Provenance. See §7. |
| `origin` | string (closed vocabulary) | Where this record came from, **display only**. See §8. |
| `aliasUrls` | array of strings | Other URLs the same posting is reachable at. **Never affects `id`.** See §9. |
| `createdAt` / `updatedAt` | finite number (epoch ms) | Timestamps. **`captureJob` ignores yours** and lets the store own them; a backup file carries them so a restore preserves both. |
| `deletedAt` | finite number (epoch ms) | A **tombstone**: the record is deleted, and its presence says so. **`captureJob` ignores yours** — see §5. A backup file carries it. |

### Optional — the posting facts (added in v2)

Six more optional strings, all describing what the **posting itself says**. Send them when the posting states them and omit them when it does not — an absent field means "not stated", and an empty string means "stated as nothing", which is rarely what you mean.

| Field | Type | Example | Meaning |
|---|---|---|---|
| `location` | string | `"Austin, TX"` | Where the posting says the job is. Free text — not geocoded, not split into city/region. |
| `salaryRange` | string | `"$180k – $220k"` | Compensation as stated. Free text; **do not parse it into numbers.** |
| `datePosted` | string | `"2026-07-28"` | ISO date the posting was published. See the warning below. |
| `workModel` | string | `"remote"` | The posting's own declared arrangement. Take it from structured data — **do not infer it with a regex over the description.** |
| `employmentType` | string | `"FULL_TIME"` | schema.org `employmentType`, passed through unvalidated. Any string is accepted; the vocabulary is the publisher's. |
| `validThrough` | string | `"2026-09-01"` | ISO date the posting declares it expires, where it declares one. |

**All six are passed through verbatim.** Nothing is parsed, normalised, or reconciled against the description. A lossy parse at this boundary is unrecoverable downstream, and offlinecv would rather hold the string you sent.

**`datePosted` and `validThrough` should be absolute dates.** A value that does not start `YYYY-MM-DD` is still accepted, but it comes back as a **warning**, because a posting's age is a fact about the moment you captured it: `"3 days ago"` is not merely a lower-quality value — it becomes wrong the following day, and nothing downstream can tell. If the page only gives you a relative date, resolve it against your own clock before sending it.

These six are **display-only record-keeping.** They are not ranking inputs, and offlinecv does not rank the saved library on them (`src/lib/job-search/rate-saved-jobs.ts` rates on fitness alone, because there is no query behind the library — no location preference, no comp floor).

### Unknown fields are PRESERVED

Any key not listed above rides through onto the stored record untouched. This is deliberate: if a
newer producer adds `employerRating` and the user restores that backup on an older offlinecv,
dropping the field would make an export → import → export cycle silently lossy. Older readers
ignore what they cannot render. (`salaryRange` was this section's example under v1, and is a real
field as of v2 — which is exactly the path an unknown field is expected to take.)

Their **values must be JSON-safe** (§6) — preserving a key whose value could not survive the next
export would be preservation in name only, so a `Date` under an unknown key refuses the record just
as it would under `matchResult`.

The one exception: an own key literally named **`__proto__`** refuses the whole record, wherever it
appears. `JSON.parse` turns it into a real own property, and no legitimate producer emits it.
(`constructor` is allowed — shadowing it on a plain data object is inert here.)

---

## 2. Identity — how to avoid duplicates

**The rule: derive `id` from the posting URL. Two captures of the same posting must produce the
same `id`, because the store upserts by `id` and that is the only thing standing between the user
and a tracker full of the same job.**

```
id = "job:" + canonical(url) with the "http://" or "https://" prefix removed
```

Worked example:

```
https://WWW.Boards.Greenhouse.io/en-US/acme/jobs/4012345/?utm_source=linkedin&gh_src=x#apply
  → canonical:  https://boards.greenhouse.io/acme/jobs/4012345
  → id:         job:boards.greenhouse.io/acme/jobs/4012345
```

The id is readable rather than hashed on purpose: you can reproduce it in any language without
agreeing on a hash function, and it leaks nothing the record's own `url` does not already hold.

### Canonicalisation — what is stripped

Apply in this order. Every step is **normative**: stripping something not on this list, or keeping
something on it, forks the id space and produces duplicates that look like the contract's fault.

| # | Step | Example |
|---|---|---|
| 1 | Refuse anything that is not an absolute `http`/`https` URL | `javascript:…` → no id |
| 2 | Drop userinfo (`user:pw@`) | `https://u:p@acme.com/j` → `https://acme.com/j` |
| 3 | Lowercase the host; drop a trailing `.`; drop a leading `www.` | `WWW.Acme.COM.` → `acme.com` |
| 4 | Drop a default port (`:80` on http, `:443` on https) | `acme.com:443` → `acme.com` |
| 5 | Drop a **first** path segment matching `^[a-z]{2}-[a-z]{2}$` | `/en-US/jobs/1` → `/jobs/1` |
| 6 | Drop one trailing slash, unless the path is `/` | `/jobs/1/` → `/jobs/1` |
| 7 | Drop tracking query parameters (list below) | `?utm_source=li` → *(gone)* |
| 8 | Sort surviving parameters by name, then value, by **code unit** (not `localeCompare`) | `?b=2&a=1` → `?a=1&b=2` |
| 9 | Drop the fragment | `#apply` → *(gone)* |
| 10 | Drop the scheme when forming the id (keep it in the canonical URL) | `http://` and `https://` converge |

Tracking parameters, matched **case-insensitively** on the full name:

- Any name starting with **`utm_`**
- `gclid`, `fbclid`, `msclkid`, `yclid`, `ttclid`, `li_fat_id`
- `mc_cid`, `mc_eid`, `igshid`, `_ga`, `_gl`
- `gh_src`, `lever-source`, `lever-origin`, `lever-via`
- `ref`, `referer`, `referrer`, `refid`, `trk`, `trackingid`, `src`, `source`

#### Known risk: `src`, `source`, `ref`

These three are the generic names on the list, and stripping them is the one place v1 accepts the
over-merge it otherwise refuses. On every board seen so far they carry attribution — but a board is
free to key its posting on one of them, and if it does:

```
https://jobs.example.com/listing?source=100
https://jobs.example.com/listing?source=200
  → both derive  job:jobs.example.com/listing
```

Two distinct postings collapse into **one** record, and the second capture overwrites the first's
producer-owned fields. (`refid` and `trk` are narrower but sit in the same family.) If you produce
records for a board that does this, supply your own `id` (§2, "If you have no URL") — it wins over
the derivation and keeps the postings apart. Removing one of these names from the list is a
**contract version bump**, not a bugfix: every producer must strip exactly the same set.

### What is deliberately KEPT, and why

Under-merging leaves a duplicate the user deletes in one click. **Over-merging collapses two
applications into one and destroys a record.** So every judgement call below resolves toward
keeping:

- **`gh_jid`, `jk`, `vjk`, `currentJobId`, `id`, and every other unrecognised parameter.** These
  identify *which* posting. Greenhouse's `gh_src` (where the click came from) and `gh_jid` (which
  job) sit one letter apart on the same board; dropping the second collapses every posting on an
  embedded board into one record.
- **A bare two-letter first path segment** (`/it/`, `/de/`). Only the unambiguous `ll-CC` shape is
  treated as a locale — `/it/` is as plausibly an "IT" department as it is Italian.
- **Path case.** Most servers are case-sensitive; `/Jobs/AB` and `/jobs/ab` may be different pages.
- **A non-default port.** That is a genuinely different origin.

### An alias is not an identity

`aliasUrls` (§9) records that a posting is *also* reachable at some other URL. It does **not**
take part in the derivation above: `id` comes from `url` and only from `url`. Two records that
list each other's URLs as aliases still have two different ids, and that is correct — merging
them is a decision the user makes, not one a producer or a URL rule may make for them.

### If you have no URL

Then you have no identity, and `captureJob` gives the record a fresh `crypto.randomUUID()`. Two
such captures do **not** converge. If you have a stable posting key of your own that is better than
the URL, supply `id` yourself and it wins over the derivation — but then *you* own uniqueness.

---

## 3. `url`

Must be an **absolute `http` or `https` URL**. An absolute URL with any other scheme —
`javascript:`, `data:`, `file:`, `mailto:` — **refuses the whole record**: the tracker renders this
value straight into an anchor's `href`.

A string that is not an absolute URL at all (`acme.com`, `/jobs/1`) is a different case: it is
**accepted with a warning** and stored as-is. It is inert in an `href`, it is often the user's own
half-typed text from an older record, and refusing it would break backups that already exist.

---

## 4. `status`

The lifecycle vocabulary is a closed set of six:

```
interested · applied · interviewing · offer · rejected · archived
```

- **Omit it** and you get `"interested"`, silently. Producers usually have no opinion about a
  lifecycle they just discovered.
- **Send one of the six** and it is stored as-is.
- **Send anything else that is a string** — `"screening"`, `"Applied"`, a status from a newer
  offlinecv — and it is **preserved verbatim** with a warning. It is *not* dropped and *not*
  coerced to `"interested"`.
- **Send a non-string** and the record is refused.

Why preserve rather than coerce or drop: the tracker already renders an unrecognised status with
its literal label and buckets it into its own section (`JobStatusPicker.jobStatusLabel`,
`JobTracker`'s grouping) precisely so a corrupt or future-version record surfaces instead of
disappearing. Coercing is the swallow those two exist to prevent, and it loses information nothing
can recover. Dropping the record removes the one surface where the user could see and repair the
value — a single click in the status picker fixes it.

---

## 5. Re-capturing a posting you already sent

`captureJob` splits ownership of the record:

| Producer-owned — your value wins | User-owned — the stored value wins |
|---|---|
| `title`, `company`, `url`, `jdText`, `matchResult`, `capture`, `origin`, and the six posting facts | `status`, `notes`, `resumeId` |

You are authoritative about the posting; the user is authoritative about their application. A
re-capture that reset an `interviewing` job to `interested` would be worse than the duplicate it
was meant to prevent.

`aliasUrls` (§9) is in **neither** column: it is **unioned**, and it is the only field that is. An
alias is additive by definition, so the two sides cannot conflict — and the direction that matters
is what producer-wins would do instead. The aliases on a stored record are usually the ones the
*user* put there by merging two rows, and a re-capture that simply omitted the field would undo
that merge silently, which is the same loss as resetting an `interviewing` job to `interested`.
Two spellings of one URL collapse (§2 canonical form), so re-capturing does not grow the list.

A re-capture does **not** stamp `updatedAt`, so it will not float the job to the top of a list
sorted most-recently-updated-first. `created: false` in the result tells you the record was already
there.

### Deleted records, and why you cannot capture one

A deleted job is **tombstoned**, not removed: the row stays with a `deletedAt` timestamp on it. It
has to. A record that is simply gone is indistinguishable from one that was never there, so any
second holder of the library — another device, a backup file, you — has no way to tell a deletion
from a gap, and re-adds it.

Two rules follow, and they point in opposite directions on purpose:

- **`captureJob` strips a `deletedAt` you send.** You are authoritative about the posting; you are
  not in a position to state that the user deleted their record of it. Deletion is not a fact about
  the job market.
- **Capturing a posting the user deleted brings the record back**, reported as `created: true`. The
  tombstone exists to stop a *replica* resurrecting the record behind the user's back — not to stop
  the user saving the posting again. `createdAt` survives from the tombstone, so the revived record
  keeps the date it was first saved.

If you are replicating rather than capturing — propagating a deletion made somewhere else — this is
the wrong entry point. Use the store's own delete path.

### Tombstones ARE in the backup document

A backup carries deleted records, `deletedAt` and all, and restoring one restores them as deleted.
If you read or write export files, expect them.

The decision is not obvious, so here is the whole of it. Omitting tombstones looks tidier and is
wrong in **merge** mode, which is the mode that exists to combine two copies of a library: device A
deletes a job and exports, device B still has it live, and B merging A's file would hand the job
straight back — because a record missing from a file is indistinguishable from one its author never
had. The deletion silently undoes itself and the user cannot tell which device is right. In
**replace** mode the visible result is identical either way, since the stores are wiped first. So
the tie breaks toward carrying them: it costs a few bytes in the mode where it does not matter and
buys convergence in the mode where it does.

Two consequences worth knowing: the document is the state of the store rather than a list of what
the user has, so `export → import → export` is stable rather than quietly shedding rows; and the
counts a restore reports are **live** records, because "restored 40 jobs" has to mean forty the user
can see.

The document **version is not bumped** for this, and the older build's behaviour is the reason. An
export written today still declares version 2, so a build that predates tombstones imports it,
treats `deletedAt` as an unknown field, preserves it, and — having no filter — shows those jobs as
live. That is not great, and every alternative is worse: bumping the version would make that build
reject the whole file with "Unsupported storage export version", costing the user every record
rather than resurrecting a few, and stripping tombstones on export would reintroduce the merge bug
above for everyone. A few deleted jobs reappearing on an old build is exactly what that build did
before deletions were recorded at all.

---

## 6. `matchResult` — what "JSON-safe" means here

A JSON-safe value is built **only** from:

`null` · booleans · strings · **finite** numbers · arrays · plain objects (prototype
`Object.prototype` or `null`)

with **no cycles** and **no own `__proto__` key**, at any depth.

Everything below **refuses the record**, with the failing path named (e.g.
`` `matchResult.rows[2].score` ``):

| Value | Why it is refused rather than fixed |
|---|---|
| `undefined` (as an object property) | `JSON.stringify` silently deletes the key |
| `NaN`, `Infinity`, `-Infinity` | silently become `null` |
| `Date` | silently becomes a string |
| `Map`, `Set`, `RegExp`, any class instance | silently becomes `{}` |
| functions, symbols | silently deleted, and they make IndexedDB's clone throw |
| `BigInt` | throws |
| a cycle | throws |

The point of the table is that a `JSON.parse(JSON.stringify(x))` round-trip does **not** validate
these — it *rewrites* most of them and throws on two. A producer who sent a `Date` meant a `Date`;
handing back a string and reporting success is exactly the failure this contract exists to prevent.

**How to comply:** run your payload through `JSON.parse(JSON.stringify(payload))` on your side
before sending, and fix whatever changes. Or just build it out of the six kinds above.

This matters most for producers, not for backup files: a backup arrived through `JSON.parse` and is
JSON-safe almost by construction, but a record crossing `postMessage` or `chrome.runtime` is
*structured-cloned* and carries `Date`s, `Map`s and cycles happily.

---

## 7. Versioning

Two version numbers exist and they are not the same thing.

- **`StorageExport.version`** (currently `1`) numbers the **backup document format** — the file with
  `resumes` and `jobs` arrays. It is unchanged by this contract.
- **`JobRecord.capture.contract`** numbers the **record contract in this document**. A record
  outlives the file it arrived in, so it carries its own.

```jsonc
"capture": {
  "contract": 2,                      // required within the object: which version you targeted
  "producer": "offlinecv-extension",  // optional, free text
  "producerVersion": "0.3.1",         // optional
  "capturedAt": 1753900000000         // optional epoch ms — when YOU captured it
}
```

### Version history

| Version | Change | Migration |
|---|---|---|
| 1 | The contract as #693 introduced it. | — |
| 2 | Added the six posting facts in §1: `location`, `salaryRange`, `datePosted`, `workModel`, `employmentType`, `validThrough`. | **None.** All six are optional, so a v1 record is already a valid v2 record that omits them. Existing stored records keep loading untouched. |

`origin` (§8, #745) and `aliasUrls` (§9, #746) are **not** in this table: both are additive and
optional like the six posting facts, but neither was judged to need a version bump even as a
courtesy entry — a build that predates them treats them as unknown extra keys (§1) and preserves
them, with no migration to write down.

**offlinecv never refuses a record for its version number.** The validator requires `capture.contract` to be a finite number and does not compare it against its own — so a record from a version this build has never heard of is accepted, and a v1 producer keeps working after a v2 build ships. Refusing a future version is precisely the forward-compatibility failure this section exists to avoid.

`capture` is **optional**, and its absence means "written by offlinecv itself, contract 1". It
exists now rather than later because a producer version cannot be retrofitted: once third-party
producers are writing records, a record with no version is indistinguishable from one written
before the field existed, and the ambiguity is permanent.

**Producers should always send it.** It is the only way a future offlinecv can tell your records
apart from its own and apply a migration to just yours.

---

## 8. `origin`

Where the record says it came from — **display only**. It is never a lifecycle, and it never
feeds merge, dedupe, or sync ordering; the only thing it changes is a short phrase on the tracker
row. The closed vocabulary:

```
capture · alert · shared · import · manual
```

- **Omit it** when you have no better answer than "the user made it here". Every record this
  build's own UI writes omits it, and most producers with no opinion about provenance should too.
- **Send one of the five** and it is stored as-is. The tracker renders a short phrase for it
  ("shared with you", "from a job alert") next to the status badge — never a second badge, and
  never a sentence.
- **Send anything else that is a string** — a term from another system's vocabulary, a value a
  future offlinecv defines — and it is **dropped, with a warning**. This is the opposite choice
  from `status` (§4): an unrecognised status is preserved because the tracker renders it under its
  literal string, giving the user a surface to see and fix it. Nothing renders an unrecognised
  origin, so there is no surface for keeping it to serve, and dropping it costs the user one
  warning line rather than a value that would otherwise sit on the record unexplained forever.
- **Send a non-string** and the record is refused, the same as any other field whose type is
  wrong.

**No `JOB_CAPTURE_CONTRACT_VERSION` bump for this field.** It is additive and optional, so a
producer that sends nothing keeps validating unchanged, and one that sends it needs no version
bump to be understood by a build that predates this field: that build has never heard of `origin`
and preserves it as an unknown extra key (§1), which is exactly the forward-compatibility path
`salaryRange` took under v1 before it became a real field.

---

## 9. `aliasUrls`

Other URLs the same posting is reachable at: the employer's own ATS link found on an aggregator
page, or the `url` of a record the user merged into this one.

```jsonc
"url": "https://boards.greenhouse.io/acme/jobs/4012345",
"aliasUrls": ["https://jobs.example.com/listing/4012345"]
```

The problem it exists for: one posting, reached two ways, becomes two records. A user saves a job
from an aggregator, follows "Apply" to the employer's Workday/Greenhouse/Lever page, and saves it
again. Those two URLs share no host, no path and no parameter, so no canonicalisation rule in §2
can ever relate them, and none should try — the rule that governs §2 is that over-merging destroys
a record. An alias is the missing thing: a link between two URLs, recorded by somebody with more
context than a URL parser.

- **`url` stays canonical, and `id` never moves.** No value of `aliasUrls` may change a record's
  identity; see §2, "An alias is not an identity". Sending an alias to *make* two records converge
  does not work and is not what the field is for — supply the same `id`, or let the user merge.
- **Each entry must be an absolute `http` or `https` URL** — the same bar `url` clears in §3.
- **An entry that is not is DROPPED, with a warning. The record is never refused for it.** Losing
  one alias costs the user a duplicate they can still merge by hand; losing the record costs them
  the application. This is stricter than `url`, which keeps a non-absolute string (§3): `url` has a
  corpus of half-typed values in existing backups to protect and is what the row renders, whereas
  an alias is machine-recorded, is never rendered as the row's link, and — not being
  canonicalisable — could never match anything anyway.
- **An `aliasUrls` that is left empty by that, or that you send empty, is removed.** "No aliases"
  has one representation: an absent key.
- **Send anything that is not an array** — a bare string, an object — **and the record is
  refused**, like any other field whose declared type is wrong.
- **Order and spelling are yours.** Entries are stored verbatim. offlinecv compares them by their
  §2 canonical form when it looks for duplicates, so `www.` and a `utm_` parameter do not make two
  entries out of one, but it does not rewrite what you sent.

The field is additive: recording an alias never rewrites the record it points at. That is also why
it is the one field a re-capture **unions** rather than overwriting — see §5. What offlinecv
does with it locally — surface a "looks like the same posting" prompt, and merge only when the
user clicks — is this build's business, not the contract's. A producer's obligation ends at
sending true URLs.

**No `JOB_CAPTURE_CONTRACT_VERSION` bump for this field**, for the reason given in §8: it is
additive and optional, and a build that predates it preserves it as an unknown extra key (§1).

---

## 10. Failure handling

`captureJob` returns `{ ok: false, reasons: string[] }`. Each reason names the field and what it
should have been. Nothing is written.

On the **import** path a refused record is **skipped, not fatal**: the rest of the file still
imports, and the skipped jobs come back on `ImportCounts.skippedJobs` with a reason each. The
resume library announces them in its status region, because a record dropped without a word is
indistinguishable from a record the file never had. One malformed job must not cost the user the
other forty, and — since `replace` mode has already wiped the stores by the time records are
written — must never abort the restore partway.

---

## 11. Changing this contract

Adding a field to `JobRecord` (`src/lib/storage/types.ts`) will not compile until you add a matching
rule to `JOB_RECORD_RULES` (`src/lib/storage/job-record-contract.ts`), because that map is typed
over `keyof Required<JobRecord>` and its guards are typed against each field's own type. That is
the mechanism keeping the validator from quietly ceasing to cover a field. Update this document in
the same change, and treat a change to §2's strip list as a contract version bump — every producer
must apply exactly the same list or the id space forks.

If the new field is something the extractor can read off a posting page, it also belongs in
`src/lib/jd-extract/to-job-record.ts` — the single mapper from an extraction result to a capture
payload. That file is deliberately the only crossing between the two, so the extraction result can
change without touching this contract, and this contract cannot grow a field by accident.
