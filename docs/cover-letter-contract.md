# Cover letter contract (v1)

**Audience: anyone writing a cover letter into offlinecv from outside this repo** — a Claude Code
skill driving `offlinecv.org` through browser automation, the browser extension, a script that
converts drafts out of another tool. You do not need to read the source to implement this. If a rule
here and the code disagree, that is a bug; file it.

**Status:** version 1, introduced in [#711](https://github.com/offlinecv/OfflineCV/issues/711).
Implemented by `src/lib/storage/letter-contract.ts` (validation), `src/lib/storage/letters.ts` (the
store and its integrity rules), and `src/lib/storage/backup.ts` (export/import).

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

The **PDF export of a letter is out of scope** in v1. `render-ats-pdf.ts` is résumé-shaped
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
| `jobId` | non-empty string | The `JobRecord.id` this letter is for. See §5 — this link is what makes the letter reachable. |
| `body` | string | The letter itself, **markdown**. May be empty (an empty draft is a real state), but the key must be present. |

### Optional

| Field | Type | Meaning |
|---|---|---|
| `label` | string | User-facing name, so two drafts for one job are tellable apart (`"Warm open"`, `"Short version"`). |
| `resumeId` | non-empty string | The `ResumeRecord.id` this letter was written from. **User-owned.** Cleared, not orphaned, if that résumé is deleted — see §5. |
| `producer` | object | Provenance. See §6. |
| `createdAt` / `updatedAt` | finite number (epoch ms) | Timestamps. The store owns them; a backup file carries them so a restore preserves `createdAt`. |

`body` is required but **may be empty**, while `jobId` may not. The asymmetry is deliberate: an
empty draft is something the user can see and fix, whereas a letter with no job is reachable from
nothing and survives no cascade.

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

### Deleting the job CASCADES

**Deleting a job deletes every letter written for it.** Not orphan-and-keep.

A letter reaches every surface through its job — a letters list is a list *within* a job. So a
letter whose job is gone is unreachable: nothing can list it, open it, edit it, or delete it.
Keeping it would not preserve anything the user could ever get back; it would only grow the store
invisibly, against a browser quota they do not see until it is exceeded. `jobId` is required
precisely so this rule has no exceptions.

The cascade lives in the store (`deleteJob` → `deleteLettersForJob`), not in a UI layer, so no
caller can forget it. The job record is deleted first: if the letter sweep then fails, the delete
the user actually asked for still happened.

### Deleting the résumé CLEARS the link

**Deleting a résumé clears `resumeId` on every letter that pointed at it, and keeps the letters.**

The opposite call, because `resumeId` is decoration rather than reachability: the letter still opens
from its job, with the résumé line reading "not linked". The prose the user wrote is not the
résumé's to take with it. This is the same graceful degrade `JobRecord.resumeId` gets.

The repair is written with `touch: false`, so `updatedAt` is **not** stamped. A write the user did
not make must not reshuffle a list sorted most-recently-updated-first — otherwise deleting one
résumé floats every letter that merely referenced it to the top.

### Known gap in v1: neither link is reconciled on import

**Merge-mode import can strand either link.** A partial or stale backup from another device can
graft in a letter whose `jobId` matches no job here — that letter is stored but *unreachable*, since
§5 says a letter is only ever reached through its job — and equally a letter whose `resumeId` matches
no résumé here, which is the milder degrade (the letter still opens; its résumé line just reads "not
linked" forever). Nothing sweeps either one today.

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
  "contract": 1,                          // required within the object: which version you targeted
  "producer": "claude-code-letter-skill", // optional, free text
  "producerVersion": "0.1.0",             // optional
  "generatedAt": 1753900000000            // optional epoch ms — when YOU generated the draft
}
```

The field is `producer` and the timestamp is `generatedAt`, where a job carries `capture` and
`capturedAt`. That is the distinction, not an inconsistency: a job is *captured* from a page that
already existed; a letter is *generated*.

`producer` is **optional**, and its absence means "written by offlinecv itself, contract 1". It
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

Nothing renders `skippedLetters` yet — v1 ships the store with no UI at all. It is reported from the
first commit anyway, because a counter added later cannot recover the records already dropped in
silence.

---

## 8. Changing this contract

Adding a field to `LetterRecord` (`src/lib/storage/types.ts`) will not compile until you add a
matching rule to `LETTER_RECORD_RULES` (`src/lib/storage/letter-contract.ts`), because that map is
typed over `keyof Required<LetterRecord>` and its guards are typed against each field's own type.
That is the mechanism keeping the validator from quietly ceasing to cover a field. Update this
document in the same change.

Changing §5's cascade rule, or §2's "no derivation", is a **contract version bump** — both are
things a producer builds assumptions on top of.

---

## Appendix — a complete example

Every value below is synthetic.

```json
{
  "id": "6f0a3b2c-1d4e-4a77-9b21-0c5e8f7a1234",
  "jobId": "job:boards.example.com/northwind/jobs/4012345",
  "resumeId": "b1c2d3e4-5f60-4718-9a2b-3c4d5e6f7081",
  "label": "Short version",
  "body": "Dear hiring team,\n\nI am applying for the Staff Engineer role at Northwind. I have spent the last six years on browser-side document tooling, most recently leading the parser rewrite that cut our extraction failures by half.\n\nI would welcome the chance to talk.\n\nJordan Vance\njordan.vance@example.com",
  "producer": {
    "contract": 1,
    "producer": "claude-code-letter-skill",
    "producerVersion": "0.1.0",
    "generatedAt": 1753900000000
  },
  "createdAt": 1753900000000,
  "updatedAt": 1753900000000
}
```
