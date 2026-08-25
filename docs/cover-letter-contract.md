# Cover letter contract (v2)

**Audience: anyone writing a cover letter into offlinecv from outside this repo** — a Claude Code
skill driving `offlinecv.org` through browser automation, the browser extension, a script that
converts drafts out of another tool. You do not need to read the source to implement this. If a rule
here and the code disagree, that is a bug; file it.

**Status:** version 2, introduced in [#766](https://github.com/offlinecv/OfflineCV/issues/766);
version 1 was [#711](https://github.com/offlinecv/OfflineCV/issues/711). Implemented by
`src/lib/storage/letter-contract.ts` (validation), `src/lib/storage/letters.ts` (the store and its
integrity rules), `src/lib/storage/company-key.ts` (the company normaliser), and
`src/lib/storage/backup.ts` (export/import).

**What v2 changed:** a letter is no longer necessarily *for one job*. `jobId` became **optional** and
`companyKey` joined it, so a letter can be scoped to a job, to a company, or to nothing at all — the
letter half of [#765](https://github.com/offlinecv/OfflineCV/issues/765)'s standard → company → job
hierarchy. **If you already produce letters, nothing you send has to change**: see §6.

Records that violate this contract are **refused**, not repaired. offlinecv would rather tell you
your record was wrong than store a mangled version of it and report success.

Sibling of `docs/job-capture-contract.md`, and deliberately so: where the two say the same thing —
JSON safety, unknown-key preservation, `__proto__`, the two-version rule — they say it identically,
and this document points at that one rather than paraphrasing it.

---

## 0. Why this store exists before any generator does

offlinecv stores letters and does **not** write them. That is the decision #711 encodes, not an
accident of sequencing:

- On-device long-form prose quality is unproven here, and pinning the schema to one engine would be
  backwards.
- Most of what a letter needs is already persisted — `JobRecord.jdText` holds the job description,
  `JobRecord.resumeId` links the résumé, and `ResumeRecord.parse` caches the structured parse — so
  a producer never has to re-run the parser to write one.

The consequence for you: **you are the first real writer of this record type.** There is no in-app
path that produces a letter, so the validator is the only thing standing between your output and
the object store, and provenance (§6) is the only thing that will ever distinguish your drafts from
offlinecv's own.

The **PDF export of a letter is out of scope**, in v2 as in v1. `render-ats-pdf.ts` is résumé-shaped
(sections / roles / bullets); a letter is a different document model and needs a different renderer.

---

## 1. Fields

A record is a **plain JSON object**. Not an array, not `null`, not a class instance. Every field is
JSON-safe (§4) — there is no `Blob` anywhere in a letter, so the whole record survives the backup
document as-is with no encoding step.

### Required

| Field | Type | Meaning |
|---|---|---|
| `id` | non-empty string | Primary key. See §2. |
| `body` | string | The letter itself, **markdown**. May be empty (an empty draft is a real state), but the key must be present. |

### Optional — the scope keys

| Field | Type | Meaning |
|---|---|---|
| `jobId` | non-empty string | The `JobRecord.id` this letter is for. |
| `companyKey` | non-empty string | The company this letter is for, **normalised** — see §1.1. |

These two are optional *individually* but not independent. Their combinations form a three-case
lattice, and **exactly one reading applies to any record**:

| `jobId` | `companyKey` | Reading |
|---|---|---|
| set | — | Letter for one job — every letter that existed before v2 |
| — | set | Letter for one company |
| — | — | **Standard** letter |

**A record carrying both is REFUSED**, with a reason naming both fields. It has no single reading,
and resolving it by precedence would mean picking a rule no producer could guess — your letter would
be filed somewhere you never asked for. Send one key, or neither.

Each key is a non-empty string **when present**, so `""` is a refusal, not a fourth state. **Absent is
not empty.** An absent key is a positive statement about scope; `""` reads as *set* to a key check and
as *unset* to every comparison, which is how a letter ends up in no list at all. If you have no
company name, send no `companyKey` — that is a standard letter, and it is a legitimate record.

### Optional — everything else

| Field | Type | Meaning |
|---|---|---|
| `label` | string | User-facing name, so two drafts for one scope are tellable apart (`"Warm open"`, `"Short version"`). |
| `resumeId` | non-empty string | The `ResumeRecord.id` this letter was written from. **User-owned.** Cleared, not orphaned, if that résumé is deleted — see §5. |
| `producer` | object | Provenance. See §6. |
| `createdAt` / `updatedAt` | finite number (epoch ms) | Timestamps. The store owns them; a backup file carries them so a restore preserves both. |
| `deletedAt` | finite number (epoch ms) | A **tombstone**: the letter is deleted, and its presence says so. See §5. |

`body` is required but **may be empty**, while a scope key that is present may not. The asymmetry is
deliberate: an empty draft is something the user can see and fix, whereas an empty scope key is a
claim to a scope that does not exist.

### 1.1 Deriving `companyKey`

**There is no company entity in offlinecv.** `JobRecord.company` is free text captured off a posting
page; it may be empty, and two postings for one employer may spell it differently or differ only in a
legal suffix. So `companyKey` is a *normalised string*, not a foreign key.

The normalisation is `deriveCompanyKey` in `src/lib/storage/company-key.ts`: lowercase, collapse
whitespace, drop punctuation, strip **one** trailing legal suffix (`Inc` · `LLC` · `Ltd` · `Limited` ·
`Corp` · `Corporation` · `Co` · `GmbH` · `S.A.` · `B.V.` · `Pty`). `Northwind`, `Northwind Inc.` and
`northwind, inc.` all key to `northwind`. An empty or all-punctuation name yields **`undefined`**, not
`""` — precisely so a job with no company gives you "no key" rather than a key this contract refuses.

Two things follow, and both are load-bearing:

- **Derive the key; do not send the raw name.** A letter written under `"Northwind Inc."` and looked
  up under `"Northwind"` is a letter the user cannot find. If you cannot run offlinecv's function,
  reimplement the rules above exactly.
- **The key is ADVISORY.** It drives a *suggestion the user confirms* ("You have a letter for
  Northwind — start from it?"), never an automatic attachment. This is the rule `JobRecord.aliasUrls`
  already states: a link between two things is never inferred, it is confirmed. Normalisation
  collides, and the cost of a collision must be a suggestion declined — not a letter silently filed
  under the wrong employer. Do not build identity on this string.

### Unknown fields are PRESERVED

Exactly as in the job contract — any key not listed above rides through onto the stored record
untouched, its value must be JSON-safe (§4), and an own key literally named **`__proto__`** refuses
the whole record wherever it appears. See §1 of `docs/job-capture-contract.md` for the full
reasoning; it applies here unchanged.

---

## 2. Identity

**There is no derivation. Supply a `crypto.randomUUID()` (or your own unique string) and own
uniqueness yourself.**

This is the one place the letter contract deliberately differs from the job contract, which derives
`id` from the posting URL so two captures of one posting converge. A letter has no such natural key,
and convergence would be the *wrong* behaviour if it did: several drafts per job, and versions of
one draft, are the normal case. Two writes that mean two drafts must produce two records.

The corollary: **re-writing a draft means reusing its `id`.** The store upserts, so writing the same
`id` again replaces the body and preserves `createdAt`. Writing a fresh `id` adds a draft.

---

## 3. Where records enter, and what checks them

| Door | Entry point | Who uses it |
|---|---|---|
| A backup file the user picks | `importFromJson` → `importAll` | "Import backup" in the résumé library |
| A direct write into the store | `saveLetter` | A producer running in the page's own origin |

`validateLetterRecord(value: unknown)` returns either `{ ok: true, record }` or
`{ ok: false, reasons: string[] }`. **Call it yourself before `saveLetter`** — unlike jobs, which
have `captureJob` as a validating front door, `saveLetter` is the raw store wrapper and does not
validate. The validator is exported from `src/lib/storage`.

There is no `warnings` channel. A job has two fields that are accepted-but-suspect (a `status`
outside a closed vocabulary; a `url` about to be rendered into an `href`); a letter has neither, so
every result here is a clean accept or a named refusal.

---

## 4. JSON safety

Identical to §6 of `docs/job-capture-contract.md`, enforced by the same function
(`findJsonSafetyProblem`, now in `src/lib/storage/record-contract.ts` and shared by both contracts).

In short: `null` · booleans · strings · **finite** numbers · arrays · plain objects, with no cycles
and no own `__proto__`. A `Date`, a `Map`, `NaN`, a function or an `undefined` object property
refuses the record with the failing path named. It refuses rather than normalising because
`JSON.parse(JSON.stringify(x))` silently *rewrites* most of those, and a producer who sent a `Date`
meant a `Date`.

This matters more here than it looks: a producer driving the page through browser automation is
handing values across a structured-clone boundary, which carries `Date`s and `Map`s happily right up
until IndexedDB's own clone throws.

---

## 5. Lifecycle — what happens when the job or the résumé goes away

This is the part of the contract with no analogue in the job document, and the two links behave
differently on purpose.

### Deleting the job CASCADES — to that job's letters, and only those

**Deleting a job deletes every letter written for it.** Not orphan-and-keep. A company letter and a
standard letter are untouched.

| Deleted | Job letters for it | Company letters at that company | Standard letters |
|---|---|---|---|
| A job | **Deleted** (tombstoned) | Untouched | Untouched |
| The **last** job at a company | **Deleted** | **Untouched** — it was never that job's | Untouched |
| A résumé | Kept, `resumeId` cleared | Kept, `resumeId` cleared | Kept, `resumeId` cleared |

There is no delete-company action, because there is no company (§1.1). A company letter and a
standard letter are therefore only ever deleted **explicitly**, by the user, one letter at a time.

#### Why the cascade is right, and why it is right *only* for job letters

v1 justified the cascade with an argument that no longer holds, and it is worth stating what
replaced it rather than quietly editing the conclusion. v1 said:

> A letter reaches every surface through its job — a letters list is a list *within* a job. So a
> letter whose job is gone is unreachable: nothing can list it, open it, edit it, or delete it.

That was true when written, and it is exactly what v2 invalidates. Once standard and company letter
surfaces exist, a jobless letter is **reachable on its own terms** — it is listed, opened, edited and
deleted from its own scope, not through a job. So "no job" stopped meaning "no way back".

What survives is the narrower claim, and it is enough. A letter that names a *specific, now-deleted*
job is unreachable: it is scoped to a row that no longer exists, no list can hold it, and keeping it
would only grow the store invisibly against a browser quota the user does not see until it is
exceeded. That is a statement about job letters, and only job letters — which is why `jobId` could
become optional without weakening it.

**The scoping enforces this by construction, not by a guard.** `deleteLettersForJob` sweeps
`lettersForJob`, which matches `letter.jobId === jobId`; a company or standard letter has no `jobId`
at all, and `undefined` never equals a real id. If you are reimplementing this: do **not** widen the
sweep to "letters at this company", and do not add a redundant second check — the first deletes what
this contract exists to protect, and the second is a weaker copy of a rule the scoping already makes
airtight.

The cascade lives in the store (`deleteJob` → `deleteLettersForJob`), not in a UI layer, so no
caller can forget it. The job record is deleted first: if the letter sweep then fails, the delete
the user actually asked for still happened.

### Deletion is a TOMBSTONE, not a removal

Both sides of that cascade write a `deletedAt` and leave the row in place. A record that is simply
gone is indistinguishable from one that never existed, so a second holder of the library — another
device, a backup file the user restores — has no way to tell a deletion from a gap and re-adds it.

Every read above this layer filters tombstones, so a deleted letter is gone from `getAllLetters`,
from `lettersForJob`, and from `getLetter` by id. The row itself stays reachable only through the
raw storage layer.

The cascade tombstones **each letter individually** rather than leaning on the job's tombstone to
hide them. A letter is a record in its own right: it can travel on its own, and a holder that
received the letters but not the job's tombstone would have no reason to stop showing them.

Both the deletion and the cascade are **idempotent** — a repeated delete finds nothing live and
returns without re-stamping a newer `deletedAt`.

Tombstones ride into the **backup document** and restore as deleted. The reasoning is the same one
§5 of `job-capture-contract.md` sets out at length, and it applies unchanged here.

### Deleting the résumé CLEARS the link

**Deleting a résumé clears `resumeId` on every letter that pointed at it, and keeps the letters.**

The opposite call, because `resumeId` is decoration rather than reachability: the letter still opens
from its job, with the résumé line reading "not linked". The prose the user wrote is not the
résumé's to take with it. This is the same graceful degrade `JobRecord.resumeId` gets.

The repair is written with `touch: false`, so `updatedAt` is **not** stamped. A write the user did
not make must not reshuffle a list sorted most-recently-updated-first — otherwise deleting one
résumé floats every letter that merely referenced it to the top.

### Known gap: neither link is reconciled on import

**Merge-mode import can strand either link.** A partial or stale backup from another device can
graft in a letter whose `jobId` matches no job here — that letter is stored but *unreachable*, since
a letter scoped to a specific job is only ever reached through that job — and equally a letter whose
`resumeId` matches no résumé here, which is the milder degrade (the letter still opens; its résumé
line just reads "not linked" forever). Nothing sweeps either one today.

v2 makes this gap strictly **smaller**, not larger. A standard letter has no `jobId` to dangle, and a
company letter's `companyKey` is a derived string rather than a reference — it points at no record,
so there is no record whose absence could strand it. A merge-import of a v2 backup therefore strands
*fewer* letters than the same import under v1, and every letter it does strand is a job letter, for
the same reason as before.

**Sync is the exception, and it is a real one.** The remote `cover_letters` table has no company
column, and the extension's `letter-mapping.ts` **refuses a pulled row with no `local_job_id`** while
happily pushing one — so today a standard or company letter uploads and can never come back, failing
silently on a second device. That asymmetry must be fixed before letters written under v2 are safe to
sync: <https://github.com/s-annam/recruidea-extension/issues/55>. Local storage and the backup
document carry both scope keys fine; it is only the sync path that is short.

Jobs are only half-covered by the existing sweep, and not for the same link: `reconcileResumeLinks`
clears a dangling **`resumeId` on a job**, so it is the analogue of the *second* case above, not the
first. Nothing reconciles a dangling `jobId` on anything. Letters will get the same treatment when
there is a surface that lists them.

Replace-mode import is unaffected: it rebuilds both stores from one document produced by `exportAll`,
whose records are read from a single store snapshot and so cannot reference each other's absences.

If you produce letters, **write the job first**, and write the résumé before the letter that cites it.

---

## 6. Versioning and provenance

Three version numbers exist and they are not the same thing.

- **`StorageExport.version`** numbers the **backup document format** — the file with `resumes`,
  `jobs` and `letters` arrays. It went from `1` to `2` when this store landed. A v1 document has no
  `letters` key at all and **still imports, forever**: a backup on a user's disk never learns about
  a format bump.
- **`LetterRecord.producer.contract`** numbers **this document**. A record outlives the file it
  arrived in, so it carries its own version.
- **`JobRecord.capture.contract`** numbers the job contract. Unrelated to this one; the two move for
  different reasons.

```jsonc
"producer": {
  "contract": 2,                          // required within the object: which version you targeted
  "producer": "claude-code-letter-skill", // optional, free text
  "producerVersion": "0.1.0",             // optional
  "generatedAt": 1753900000000            // optional epoch ms — when YOU generated the draft
}
```

### What the bump to 2 asks of you: nothing

`LETTER_CONTRACT_VERSION` is `2` since #766. A v1 producer — one that always sends `jobId` and has
never heard of `companyKey` — **keeps working untouched**, and is a valid v2 producer that happens to
write only job letters. Nothing here refuses a record for saying `"contract": 1`, and the validator
deliberately does not compare your number against its own (see above).

The bump says there is **more you MAY send**, not that anything you already send became wrong. Take
it up when you have a reason to: a letter that belongs to an employer rather than to one posting, or
a standard letter holding the candidate-specific material that has no place on a résumé.

The field is `producer` and the timestamp is `generatedAt`, where a job carries `capture` and
`capturedAt`. That is the distinction, not an inconsistency: a job is *captured* from a page that
already existed; a letter is *generated*.

`producer` is **optional**, and its absence means "written by offlinecv itself, contract 1" — the
version that was current when the field appeared, and the reading a record with no version has
forever. It
exists in v1 rather than later because a producer version cannot be retrofitted: once third-party
producers are writing records, a record with no version is indistinguishable from one written before
the field existed, and the ambiguity is permanent. Since offlinecv currently writes **no** letters at
all, in practice every letter in a user's store should carry it.

**Producers should always send it.**

---

## 7. Failure handling

`validateLetterRecord` returns `{ ok: false, reasons: string[] }`. Each reason names the field and
what it should have been. Nothing is written — the validator does not touch storage.

On the **import** path a refused letter is **skipped, not fatal**: the rest of the file still
imports, and the skipped letters come back on `ImportCounts.skippedLetters` with a reason each. One
malformed letter must not cost the user their résumés, their jobs, or the file's other letters —
and since `replace` mode has already wiped the stores by the time records are written, it must never
abort the restore partway. Validation therefore runs before any store is touched.

`replace` mode wipes the `letters` store **even when the document is v1** and contributes no
letters. Replace means "make storage match this file"; skipping the wipe would leave letters
stranded on jobs the restore just deleted, which is exactly the orphan §5's cascade exists to make
impossible.

Nothing renders `skippedLetters` yet. It has been reported since the first commit anyway, because a
counter added later cannot recover the records already dropped in silence.

---

## 8. Changing this contract

Adding a field to `LetterRecord` (`src/lib/storage/types.ts`) will not compile until you add a
matching rule to `LETTER_RECORD_RULES` (`src/lib/storage/letter-contract.ts`), because that map is
typed over `keyof Required<LetterRecord>` and its guards are typed against each field's own type.
That is the mechanism keeping the validator from quietly ceasing to cover a field. Update this
document in the same change.

A **cross-field** rule — one where no single value is wrong on its own — has no home in that map and
goes in `validateLetterRecord` itself, after `checkDeclaredFields`. The both-scope-keys refusal (§1)
is the only one today; write the reason so it names every field involved, since a producer that sent
two fields cannot act on a complaint about one.

Changing §5's cascade rule, §2's "no derivation", or §1's scope lattice is a **contract version
bump** — all three are things a producer builds assumptions on top of. Relaxing a rule still counts:
v2 made `jobId` optional, which no existing producer had to react to, and it is a bump anyway,
because the *readings* of a record changed. Adding a field a producer may ignore is what a bump most
often means; §6 is where you say so, so nobody reads a new number as a demand.

---

## Appendix — a complete example

Every value below is synthetic.

### A job letter — one key, and the shape every v1 letter already had

```json
{
  "id": "6f0a3b2c-1d4e-4a77-9b21-0c5e8f7a1234",
  "jobId": "job:boards.example.com/northwind/jobs/4012345",
  "resumeId": "b1c2d3e4-5f60-4718-9a2b-3c4d5e6f7081",
  "label": "Short version",
  "body": "Dear hiring team,\n\nI am applying for the Staff Engineer role at Northwind. I have spent the last six years on browser-side document tooling, most recently leading the parser rewrite that cut our extraction failures by half.\n\nI would welcome the chance to talk.\n\nJordan Vance\njordan.vance@example.com",
  "producer": {
    "contract": 2,
    "producer": "claude-code-letter-skill",
    "producerVersion": "0.1.0",
    "generatedAt": 1753900000000
  },
  "createdAt": 1753900000000,
  "updatedAt": 1753900000000
}
```

### A company letter — `companyKey` instead, never both

Note the key is the *derived* form (§1.1), not `"Northwind, Inc."` as the posting printed it.

```json
{
  "id": "9c4d1e70-8a52-4b39-8f0d-2e6b7c9a4455",
  "companyKey": "northwind",
  "label": "Why Northwind",
  "body": "I have followed Northwind's work on browser-side document tooling since the 3.0 release, and the reason I keep coming back to it is the same reason I want to work there: the constraint that nothing leaves the device is treated as a product decision rather than a limitation.",
  "producer": { "contract": 2, "producer": "claude-code-letter-skill" },
  "createdAt": 1753900000000,
  "updatedAt": 1753900000000
}
```

### A standard letter — neither key

The base the other two are tailored *from* (#765), not a generic letter to submit as-is.

```json
{
  "id": "2b7f5a13-6c04-4d8e-91a7-5f3e0d8c6612",
  "label": "Career change narrative",
  "body": "After six years in infrastructure I moved deliberately into document tooling, and the throughline is the same one I would bring to this role: I like problems where correctness is checkable and the failure modes are silent.",
  "producer": { "contract": 2, "producer": "claude-code-letter-skill" },
  "createdAt": 1753900000000,
  "updatedAt": 1753900000000
}
```
