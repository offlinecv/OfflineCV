# Fixtures — PII policy (directory-scoped)

Every PDF in this tree ships in a **public** repo. **Synthetic personas only** —
fake name, `@example.com` email, `555`-style phone. No real people, ever.

**"Self-published upstream" is not an exception.** OSS résumé templates often
ship the author's *own real résumé* as the demo PDF (Awesome-CV → posquit0,
Deedy-Resume → Debarghya Das, carrying real email + phone). Re-export the
template filled with synthetic data instead of committing the demo verbatim.

Before adding a PDF here — or approving a PR that does — verify the binary, not
the PR description:

    pdftotext <file>.pdf - | head -40   # confirm name / email / phone are fake

The `*.expected.json` snapshots are lossy by design (keys + counts only, never
field values), so they stay PII-safe automatically — but the **PDF binary** is
the real exposure surface. Full policy: ../../../CLAUDE.md · ./README.md
