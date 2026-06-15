# PDF corpus

Snapshot-driven regression tests for the cascade + scorer. Each PDF under one of the category subfolders pairs with a co-located `*.expected.json` snapshot that captures the cascade's structural output (counts, dimension scores, triggered tiers — never raw text or field values).

Walked and diffed by [`src/lib/heuristics/corpus.test.ts`](../../../src/lib/heuristics/corpus.test.ts) on every `npm run test` run.

## Layout

```
tests/fixtures/pdfs/
├── latex/          XeLaTeX / pdfTeX / LuaTeX exports
├── word/           Microsoft Word exports (incl. Word → macOS Quartz prints)
├── google-docs/    Google Docs "Download as PDF" (Skia/PDF renderer) — also
│                   accepts Chromium `--print-to-pdf` Skia exports as a
│                   deliberate proxy, since Google Docs uses the same
│                   Skia/PDF renderer. Such proxy fixtures use the
│                   `google-docs-skia-proxy-*` filename prefix and will
│                   self-identify with `Creator: HeadlessChrome/<v>` in the
│                   PDF Info dict — that is by design, not a mislabel.
├── mac-pages/      Apple Pages → PDF
├── mac-preview/    macOS Preview re-save (Quartz PDFContext)
├── indesign/       Adobe InDesign exports
└── unknown/        Generator unknown or one-off (e.g. react-pdf,
                    WeasyPrint, other non-categorised renderers)
```

Empty subfolders are fine and tracked via `.gitkeep` — they signal a category we haven't seeded yet.

## Adding a new PDF

1. Drop the PDF into the right `<category>/` subfolder. Use a descriptive, persona-free filename — e.g. `awesome-cv-resume.pdf`, `google-docs-skia-m146.pdf`. Avoid real names in the filename.
2. Run `npm run bake-fixtures`. The harness writes a fresh `<name>.expected.json` next to the PDF.
3. **Eyeball the snapshot before committing.** Open the JSON, sanity-check the counts (`skillsCount`, `experienceCount`, `bulletCount`, score numbers). Anything that looks obviously wrong is a parser bug — file an issue with the PDF and the snapshot as the reproducer, **don't** commit the snapshot until the bug is filed.
4. `git add` both the PDF and the `.expected.json`. Commit message: `test(corpus): add <generator> sample (<one-line characterization>)`.

## Updating an existing snapshot

Only when the cascade improvement is intentional — never silently. The workflow:

1. Make the cascade or scorer change on its own branch.
2. `npm run test` — every fixture whose snapshot changed will fail with a diff.
3. Review each diff. Did the parser get better? Worse? Same-but-different?
4. For each diff that reflects an intentional improvement: `npm run bake-fixtures` to regenerate.
5. Commit the cascade change, the regenerated snapshots, and a note in the commit body listing which snapshots moved and why.

If a snapshot regresses on a change you didn't expect to touch the cascade, **that's the signal this corpus exists to surface**. Investigate before re-baking.

## Privacy

This repo is **public**. The PDF binary committed here is the exposure
surface — purging a leaked fixture after merge means `git filter-repo` +
a GitHub Support ticket. Catch it before merge.

**Synthetic personas only** — fake name, `@example.com` email, and a phone
using a **real area code with the `555` exchange and a `0100`–`0199`
subscriber** (e.g. `(312) 555-0123`). That form passes the parser's
`libphonenumber-js` validation while staying a reserved, never-rings number.
Avoid area-code-`555` numbers like `(555) 010-0123` — `555` is an invalid NANP
area code, so the validator rejects them and the fixture's `phone` field drops
out of the score. **Real-user PDFs do not belong here, ever.**

**"Self-published upstream" is not an exception.** Several OSS résumé
templates ship the author's *own real résumé* as the demo PDF — e.g.
Awesome-CV embeds posquit0's CV (real email + phone), Deedy-Resume
embeds Debarghya Das's. Downloading those verbatim re-hosts a real
person's contact info here. Re-export the template filled with
synthetic data instead.

Sources for PII-free fixtures:

- [OpenResume sample fixtures](https://github.com/xitanggg/open-resume/tree/main/public/resume-example) — placeholder personas (`John Doe`, `Leo Leopard`), the upstream this parser was ported from
- [Awesome-CV](https://github.com/posquit0/Awesome-CV) — LaTeX template. Clone, replace persona fields in `examples/resume.tex` / `examples/cv.tex` with `Jane Smith` / `jane.smith@example.com` / `+1 (312) 555-0123`, compile with `latexmk -lualatex`
- [Deedy-Resume](https://github.com/deedy/Deedy-Resume) — XeLaTeX template, two font variants. Same workflow: edit the persona block in `deedy_resume.tex`, compile with `xelatex`
- Any LaTeX/Word/Docs template, filled with synthetic data, exported
- A friend's PDF with explicit permission → redact name/email/phone/address **in the source document**, re-export, then commit

Before adding a PDF — or approving a PR that does — verify the binary,
not the PR description:

```bash
pdftotext tests/fixtures/pdfs/<category>/<file>.pdf - | head -40
```

Confirm the name, email, and phone are fake.

## What the snapshot captures (and doesn't)

The `.expected.json` shape is intentionally lossy. **Captured:**

- Layout triggers (`two_column` / `scanned` / `fonts_unmappable`)
- Which tiers ran and which escalation was suggested
- Which top-level parsed fields are non-empty (keys only, never values)
- Counts: skills, experience entries, education entries, bullets, link annotations, page count, raw-text char count
- Anonymous ATS score dimensions and overall
- Cascade confidence (rounded to 2 decimals)
- Whether markdown emission produced output and which section-splitter ran

**Not captured:**

- Raw text or any field values (zero PII surface)
- Timings (volatile across machines)
- Per-bullet observations (covered separately by `score.test.ts`)

Schema is versioned via `schemaVersion` in the snapshot. Bump `SNAPSHOT_SCHEMA_VERSION` in [`corpus.test.ts`](../../../src/lib/heuristics/corpus.test.ts) whenever the shape changes so stale snapshots visibly fail until re-baked.
