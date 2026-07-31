# Job capture contract (v1)

**Audience: anyone writing a job record into offlinecv from outside this repo** — a browser
extension, a bookmarklet, a script that converts another tracker's export. You do not need to read
the source to implement this. If a rule here and the code disagree, that is a bug; file it.

**Status:** version 1, introduced in [#693](https://github.com/offlinecv/OfflineCV/issues/693).
Implemented by `src/lib/storage/job-record-contract.ts` (validation),
`src/lib/storage/job-url.ts` (identity), and `src/lib/storage/capture.ts` (the write path).

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
| `createdAt` / `updatedAt` | finite number (epoch ms) | Timestamps. **`captureJob` ignores yours** and lets the store own them; a backup file carries them so a restore preserves `createdAt`. |

### Unknown fields are PRESERVED

Any key not listed above rides through onto the stored record untouched. This is deliberate: if a
newer producer adds `salaryRange` and the user restores that backup on an older offlinecv, dropping
the field would make an export → import → export cycle silently lossy. Older readers ignore what
they cannot render.

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
| `title`, `company`, `url`, `jdText`, `matchResult`, `capture` | `status`, `notes`, `resumeId` |

You are authoritative about the posting; the user is authoritative about their application. A
re-capture that reset an `interviewing` job to `interested` would be worse than the duplicate it
was meant to prevent.

A re-capture does **not** stamp `updatedAt`, so it will not float the job to the top of a list
sorted most-recently-updated-first. `created: false` in the result tells you the record was already
there.

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
  "contract": 1,                      // required within the object: which version you targeted
  "producer": "offlinecv-extension",  // optional, free text
  "producerVersion": "0.3.1",         // optional
  "capturedAt": 1753900000000         // optional epoch ms — when YOU captured it
}
```

`capture` is **optional**, and its absence means "written by offlinecv itself, contract 1". It
exists now rather than later because a producer version cannot be retrofitted: once third-party
producers are writing records, a record with no version is indistinguishable from one written
before the field existed, and the ambiguity is permanent.

**Producers should always send it.** It is the only way a future offlinecv can tell your records
apart from its own and apply a migration to just yours.

---

## 8. Failure handling

`captureJob` returns `{ ok: false, reasons: string[] }`. Each reason names the field and what it
should have been. Nothing is written.

On the **import** path a refused record is **skipped, not fatal**: the rest of the file still
imports, and the skipped jobs come back on `ImportCounts.skippedJobs` with a reason each. The
resume library announces them in its status region, because a record dropped without a word is
indistinguishable from a record the file never had. One malformed job must not cost the user the
other forty, and — since `replace` mode has already wiped the stores by the time records are
written — must never abort the restore partway.

---

## 9. Changing this contract

Adding a field to `JobRecord` (`src/lib/storage/types.ts`) will not compile until you add a matching
rule to `JOB_RECORD_RULES` (`src/lib/storage/job-record-contract.ts`), because that map is typed
over `keyof Required<JobRecord>` and its guards are typed against each field's own type. That is
the mechanism keeping the validator from quietly ceasing to cover a field. Update this document in
the same change, and treat a change to §2's strip list as a contract version bump — every producer
must apply exactly the same list or the id space forks.
