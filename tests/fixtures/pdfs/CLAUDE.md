# Fixtures — PII policy (directory-scoped)

Every PDF in this tree ships in a **public** repo. **Synthetic personas only** —
fake name, `@example.com` email, and a phone using a **real area code + `555`
exchange + `0100`–`0199` subscriber** (e.g. `(312) 555-0123`) — passes
`libphonenumber-js` validation, never a real line. Not area-code-`555`
(`(555) 010-0123`): `555` is an invalid NANP area code, so the validator drops
the field. No real people, ever.

**"Self-published upstream" is not an exception.** OSS résumé templates often
ship the author's *own real résumé* as the demo PDF (Awesome-CV → posquit0,
Deedy-Resume → Debarghya Das, carrying real email + phone). Re-export the
template filled with synthetic data instead of committing the demo verbatim.

**`npm run check:fixtures` enforces some of this — not all of it.** It runs in
`verify` and in CI, so what it *does* catch cannot merge. Read the split
carefully, because the gap is where a leak gets through.

It checks every **PDF** binary in this tree — scanning each one's **text**, its
**link annotations** (`tel:`/`mailto:` hrefs) and its **metadata** — for:

| Rule | Enforced? |
|---|---|
| Email is `@example.com` | ✅ mechanically † |
| Phone is a real area code + `555` exchange + `0100`–`0199` subscriber | ✅ mechanically † |
| No denylisted real person (posquit0, Debarghya Das, …) | ✅ mechanically |
| Metadata `Author` / `dc:creator` does not name the exporter | ✅ mechanically † |
| **The name is synthetic** | ❌ **you** — no check can decide this |
| Non-PDF fixtures (png/jpeg/docx) | ❌ **you** — the gate only walks PDFs |

† **Subject to the `EXCEPTIONS` table** in `scripts/check-fixture-pii.mjs`. An
entry pins **one value in one file** and must state a reason, so it cannot widen
by accident — but it does mean a fixture in this tree can legitimately violate a
row above. Two do today: `unknown/openresume-react-pdf.pdf` (upstream project
address) and `word/openresume-laverne-word-quartz.pdf` (whose phone,
`(909) 555-5555`, is outside the reserved `0100`–`0199` block — fictional by
convention only; re-export tracked in #481). Prefer re-exporting the fixture over
adding an entry. A new entry in a PR is a review-Blocking change.

A fake-looking name is not something a script can judge, and the gate does not
try. **A green check does not mean the fixture is clean.** Run it before adding a
PDF here, or approving a PR that does — and then look at the binary yourself:

    npm run check:fixtures              # the gate
    pdftotext <file>.pdf - | head -40   # the other half of the surface

Run both. They see different things, and neither subsumes the other.
`pdftotext` prints only the **drawn page**, so it cannot see a **link
annotation** — two fixtures here drew a compliant phone while their `tel:` href
still pointed at a forbidden area-code-`555` number — nor the **Info dict**,
where an exporter parks `/Company` and `/Manager`. The gate scans all three
surfaces. What `pdftotext` does print, it prints faithfully, and reading it is
how you judge the **name**. Never believe the PR prose over either.

The `*.expected.json` snapshots are lossy by design (keys + counts only, never
field values), so they stay PII-safe automatically — but the **PDF binary** is
the real exposure surface. Full policy: ../../../docs/CONTRIBUTING-PROCESS.md ·
./README.md — and the binding one-liner in ../../../CLAUDE.md ("Hard rules").
