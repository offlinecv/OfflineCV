# resumelint

**Live preview:** <https://resumelint-org.github.io/resumelint/>

A PDF parser stress test for resumes. Drop a PDF in; see what a generic
text extractor reads back. It is diagnostic, not prescriptive — the tool
reports what its own parser sees, so you can spot the failure modes that
quietly drop a candidate's text on the floor before any downstream system
ever looks at it.

The core failure modes resumelint surfaces are common but rarely visible:
two-column layouts that text extractors read across, image-only PDFs that
return zero selectable text, and "fonts-unmappable" PDFs (Framer, Affinity,
and some InDesign exports) where the source carries real text but the font
encoding doesn't decode to characters. For that last case the parser falls
back to the PDF's embedded link annotations as recovered signal, so a
candidate can still see what survived.

resumelint is the open-source spinoff of `recruidea.app/ats-resume-check` —
the standalone PDF-parser-audit lane of the [Recruidea](https://recruidea.com)
sponsor-assisted job-search product. The audit lives here so it can grow
in the open; the sponsor workflow stays with Recruidea.

New contributors: see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for setup,
branch + commit conventions, and the PR checklist.

## Quick start

```bash
npm install
npm run dev        # vite dev server on http://localhost:5173
npm run build      # static bundle into dist/
npm run test       # vitest run
npm run typecheck  # tsc --noEmit across the project
```

Or use the interactive menu, which wraps all of the above plus deploy:

```bash
./scripts/run_resumelint.sh           # interactive menu
./scripts/run_resumelint.sh dev       # same commands non-interactively
./scripts/run_resumelint.sh deploy --dry-run
```

## Telemetry

resumelint ships with no analytics by default. `package.json` declares
`posthog-js` as a dependency, but the import is dynamic and only resolved
when `VITE_POSTHOG_KEY` is set at build time. In an OSS build (no env vars),
the PostHog branch is dead-code-eliminated by Vite/Rollup and the dep does
not appear in the output bundle.

The hosted build at recruidea.com sets `VITE_POSTHOG_KEY` and emits three
events: `file_accepted`, `parse_completed`, `parse_failed`. The payloads are
listed in `src/lib/analytics.ts` and contain only file size, page count,
parse duration, score breakdown, layout triggers, and error name — never
PDF bytes, never extracted text, never names, emails, or URLs. Session
recording and autocapture are disabled; the distinct ID is in-memory and
reset on tab close.

`.env` and `.env.example` are gitignored, so the only documented surface
for the env vars is this section. To enable telemetry in a local build,
set `VITE_POSTHOG_KEY` (and optionally `VITE_POSTHOG_HOST`, defaulting to
`https://us.i.posthog.com`) in the environment at build time.

## Theming

Colors are plain CSS custom properties split into two layers:

- **`src/styles/theme.css`** — the semantic vocabulary (`--color-surface-card`,
  `--color-content-primary`, `--color-brand-amber`, …). This is the **stable
  contract**: it generates the Tailwind classes (`bg-surface-card`,
  `text-content-primary`, …) that the components use. Names here don't change.
- **`src/styles/tokens.css`** — the raw values behind that vocabulary (the
  default ResumeLint look, light and dark). This is the **swappable layer**.

You can reskin resumelint to your own brand **without forking this repo**, two
ways:

### 1. Cascade override (no build config)

Import your own stylesheet *after* resumelint's and redefine the same
`--color-*` properties. The last definition wins in the cascade:

```css
/* your-brand.css — imported after resumelint's styles */
:root {
  --color-brand-amber: #ff6b35;
  --color-bg-card: #fffaf5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --color-brand-amber: #ffa07a;
    --color-bg-card: #1c1410;
  }
}
```

Only override the properties you want to change; everything else keeps the
default. The contract to implement is the `--color-*` names in
`src/styles/tokens.css`.

### 2. Full replacement (Vite alias)

`src/styles.css` imports the token *values* through a bare `@design-tokens`
specifier. `vite.config.ts` aliases that to the in-tree
`src/styles/tokens.css` by default, so the standalone build is unaffected.
Point the alias at your own complete copy of the tokens file to swap the whole
brand in one place:

```ts
// vite.config.ts (in your downstream repo / config override)
resolve: {
  alias: {
    "@design-tokens": fileURLToPath(
      new URL("./src/brand/my-tokens.css", import.meta.url),
    ),
  },
},
```

Your file must define the full set of `--color-*` properties (copy
`src/styles/tokens.css` as a starting point) so every semantic token resolves.

## Deploy (GCS)

resumelint builds to a static `dist/` directory and can be hosted on any
static-file host. We ship a script for Google Cloud Storage; adapt or
replace it for your platform.

1. Copy `.env.deploy.example` to `.env.deploy` and fill in `PROJECT_ID`
   and `BUCKET_NAME`.
2. (Optional) Set `VITE_POSTHOG_KEY` in `.env.deploy` to enable telemetry
   for the deployed build — see the [Telemetry](#telemetry) section.
3. Run `./scripts/run_resumelint.sh deploy` (or `... deploy --dry-run` to
   preview). The interactive menu has a "Deploy --dry-run" entry too.

Flags: `--skip-build` reuses the existing `dist/`. `--mode=modified`
re-deploys only files changed since the last successful deploy. Pass
`--project=` / `--bucket=` to override `.env.deploy` for a one-off
deploy to a different bucket.

## License

[Apache-2.0](./LICENSE). The patent grant is deliberate — the parser audit
should be safely reusable in commercial LLM-adjacent products. See `NOTICE`
for the attribution string.

## Status

Alpha. The score we surface is our own reference number for iterating on the
parser, not a universal verdict; different applicant tracking systems weigh
things differently and we make no comparative claims about how any one of
them would score a given PDF.
