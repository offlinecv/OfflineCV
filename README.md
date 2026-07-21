# offlinecv

**Try it:** [offlinecv.org](https://offlinecv.org) — stable, promoted daily once
CI is green · [dev.offlinecv.org](https://dev.offlinecv.org) — bleeding edge,
updated on every push

A PDF parser stress test for resumes. Drop a PDF in; see what a generic
text extractor reads back. It is diagnostic, not prescriptive — the tool
reports what its own parser sees, so you can spot the failure modes that
quietly drop a candidate's text on the floor before any downstream system
ever looks at it.

The core failure modes offlinecv surfaces are common but rarely visible:
two-column layouts that text extractors read across, image-only PDFs that
return zero selectable text, and "fonts-unmappable" PDFs (Framer, Affinity,
and some InDesign exports) where the source carries real text but the font
encoding doesn't decode to characters. For that last case the parser falls
back to the PDF's embedded link annotations as recovered signal, so a
candidate can still see what survived.

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

The `npm` scripts above are the supported entry point — everything you
need to develop, test, and build runs through them on any machine.

### Local pre-push gate

`npm run verify` is the one local gate, and it mirrors CI exactly:
typecheck → lint → coverage → build → `fallow` static analysis. Run it
by hand any time, or let it run automatically — `npm install` installs a
git `pre-push` hook (via the package's `prepare` script) that runs
`npm run verify` before every push, so lint/type/test/build breaks surface
locally instead of on the PR.

- `fallow` is **report-only** locally (same non-blocking posture as CI):
  its findings are printed but never fail the push. Typecheck, lint, test,
  and build failures **do** block the push.
- Bypass the hook for a single push with
  `OFFLINECV_SKIP_HOOKS=1 git push`.
- The hook install is a no-op on tarball installs and CI `npm ci` (no
  `.git/` work tree), so it never breaks a non-developer install.

### On-device AI (WebGPU) in dev

The optional AI rewrite runs on-device via WebGPU, which the browser only
exposes in a **secure context** (HTTPS, or the `localhost`/`127.0.0.1`
exemption). The dev/preview server therefore runs over HTTPS with a throwaway
self-signed cert (`@vitejs/plugin-basic-ssl`), so WebGPU is available at
`https://localhost:5173` and when you reach the server from another machine on
the LAN — e.g. `https://<your-host>.local:5173`. The cert is untrusted, so each
client accepts a one-time browser warning; encryption and the secure-context
flag hold regardless. Over plain `http://` a non-localhost origin is **not** a
secure context, `navigator.gpu` is hidden, and the rewrite path degrades to the
"WebGPU unavailable" notice.

WebGPU also needs a GPU adapter, not just a secure context. On **Linux**,
Chromium rides the Vulkan backend — if `chrome://gpu` shows `Vulkan: Disabled`,
`navigator.gpu.requestAdapter()` returns null and the notice shows the
`unsupported-os` guidance. Enable it via `chrome://flags/#enable-vulkan` →
Enabled → relaunch. (The hosted site is HTTPS, so real users only hit the
adapter question, never the secure-context one.)

## Debugging the parser

```bash
npm run fidelity path/to/resume.pdf        # one résumé
npm run fidelity path/to/dir               # every *.pdf under a directory
npm run fidelity path/to/resume.pdf --strict   # exit 1 if a duplication leak is found
```

`fidelity` runs the full pipeline — `runCascade` → scoring → the **same bullet
grouping the reconstructed-résumé UI uses** — and reports what the UI would
actually render: per-section counts, the bullet pool, the **"Other bullets"**
group (bullets matched to no entry), and any content that renders **twice**
(a bullet that also appears under a section header — the kind of
reconstruction-layer duplication a parser-struct dump misses). It also flags
title-only entries (empty description) that can't attract their bullets.

It reads a path you give it and only prints to the terminal — it writes
nothing and hardcodes no path, so running it against your own (private)
résumés is safe. Use it to reproduce and characterize a parse bug before
filing an issue; pair the finding with a synthetic, PII-free fixture under
`tests/fixtures/pdfs/` (see that directory's README) for a regression test.

## Telemetry

offlinecv ships with no analytics by default. `package.json` declares
`posthog-js` as a dependency, but the import is dynamic and only resolved
when `VITE_POSTHOG_KEY` is set at build time. In an OSS build (no env vars),
the PostHog branch is dead-code-eliminated by Vite/Rollup and the dep does
not appear in the output bundle.

A build with `VITE_POSTHOG_KEY` set — such as the hosted preview at
offlinecv.org — emits events such as `file_accepted`, `parse_completed`, and
`parse_failed`. The payloads are listed in `src/lib/analytics.ts` and contain
only file size, page count, parse duration, score breakdown, layout triggers,
and error name — never PDF bytes, never extracted text, never names or URLs.
Session recording and autocapture are disabled; the distinct ID is in-memory
and reset on tab close.

The one exception is the optional feedback panel (`feedback_submitted`): it
carries a 1–5 `rating` plus, **only when the user chooses to fill them**, a
`category`, free-text `feedback_text`, and an `email`. That email is the single
piece of user-supplied PII any event can carry — it is opt-in (the field is
blank by default and is never sent as an empty string; see `buildFeedbackProps`),
and the whole panel is hidden in builds where `VITE_POSTHOG_KEY` is unset.

`.env` and `.env.example` are gitignored, so the only documented surface
for the env vars is this section. To enable telemetry in a local build,
set `VITE_POSTHOG_KEY` (and optionally `VITE_POSTHOG_HOST`, defaulting to
`https://us.i.posthog.com`) in the environment at build time.

### Browser storage

Beyond PostHog, the app writes a few functional `localStorage` keys to
remember UX state across reloads. These are **first-party**, carry **no PII**,
hold **no tracking or profiling identifier**, and are **not HTTP cookies**
(`document.cookie` is never touched) — they are boolean/counter UX state
scoped to your browser:

| Key | Purpose |
|---|---|
| `ocv_feedback_seen` | counts how many times the feedback ask has rendered; after 2 the panel switches from the full card to a quiet compact star strip |
| `ocv_feedback_submitted` | set after a successful feedback submit so the panel never re-asks in that browser |
| `ocv_star_cta_seen` | one-time flag so the post-feedback GitHub-star prompt shows only once per browser |
| `ocv_gh_stars_cache` | caches the fetched star count (~1h TTL) to avoid re-hitting the GitHub API on every parse |

#### IndexedDB (local-first storage)

For structured/binary data the app uses an IndexedDB database named `offlinecv`
(via the ~1KB [`idb`](https://github.com/jakearchibald/idb) wrapper;
`src/lib/storage/`), separate from the `ocv_*` UI flags above. It has two object
stores — `resumes` (raw PDF bytes as a `Blob` plus a cached parse so a reopened
resume doesn't re-run the cascade) and `jobs` (tracked-job records) — versioned
together under one `onupgradeneeded` migration path. This is **still first-party
and local-only**: nothing here is sent anywhere, and it introduces **no network
calls** — it is the same privacy posture as the `localStorage` keys, just for
larger structured/binary data.

On first write the app calls `navigator.storage.persist()` to ask the browser to
exempt the database from automatic eviction; the grant is best-effort and
queryable so the UI can be honest about it. Browsers can still clear site data
under disk pressure, and Safari clears script-writable storage after 7 days
without a visit — so the module ships a JSON **export/import** backup path (resume
bytes base64-encoded in the export file) as the user's own recovery route.

The **resume library** (save a parsed resume, reload it later without re-uploading,
rename/delete) is the first surface built on this store; it shows the persistence
state and the eviction note inline, with the export backup reachable from there.

### GitHub star count

The footer shows the live repo star count via an unauthenticated call to
`https://api.github.com/repos/offlinecv/OfflineCV` (`src/hooks/useGitHubStars.ts`).
It runs from your browser on app load whenever the ~1h cache
(`ocv_gh_stars_cache`) is stale, and is **fail-silent** — on network error or
rate-limit (GitHub allows 60 req/hr/IP unauthenticated) the count is hidden
and the rest of the UI is unaffected. Because the request originates in your
browser, **your IP address is seen by GitHub** (a US third party) as a result
of loading the app.

### Job-search feeds (Find jobs tab)

The **Find jobs** tab can fetch a sample of live postings from free, keyless,
CORS-open job feeds and rank them against your parsed résumé. These requests
fire **only when you click "Search jobs"** — never on drop, tab open, or query
edit — and carry **only the derived search keywords** (the editable title/skills
in the query block), never your résumé text. Each shipped feed is contacted
directly from your browser, so **your IP address is seen by that third party**
(same class of disclosure as the GitHub star-count call above):

| Provider | Endpoint | Notes |
| --- | --- | --- |
| Remotive | `https://remotive.com/api/remote-jobs?search=<keywords>` | remote-only, tech-skewed; the feed ignores `search=`, so results are keyword-filtered client-side after fetch |
| Arbeitnow | `https://www.arbeitnow.com/api/job-board-api?search=<keywords>` | EU-heavy board; the feed ignores `search=`, so results are keyword-filtered client-side after fetch |
| Jobicy | `https://jobicy.com/api/v2/remote-jobs?tag=<keyword>` | remote-only, tech-skewed; `tag=` filters server-side |

All three verified CORS-open (`Access-Control-Allow-Origin: *`) from a browser
origin. Regardless of what each feed does with its query param, every fetched
posting is keyword-filtered in your browser against the query title/skills
before ranking, so only query-relevant postings are shown. A feed that fails
(network, CORS, malformed response) degrades silently
— its results are simply absent and the UI notes the missing source. Results are
labeled in-app as a remote/tech-heavy **sample, not every job**.

## Theming

Colors are plain CSS custom properties split into two layers:

- **`src/design-system/styles/theme.css`** — the semantic vocabulary
  (`--color-surface-card`, `--color-content-primary`, `--color-accent-primary`, …).
  This is the **stable contract**: it generates the Tailwind classes
  (`bg-surface-card`, `text-content-primary`, …) that the components use. Names
  here don't change.
- **`src/design-system/styles/tokens.css`** — the raw values behind that
  vocabulary, light and dark. The default is a **generic, accessible palette
  (slate neutrals + a blue accent)**, not a specific product brand. This is the
  **swappable layer**.

> **Deprecated names (removed 2026-07, #513):** `--color-brand-amber` was an
> exact duplicate of `--color-accent-primary` (same blue in both themes).
> `--color-brand-amber-light` was a *near*-duplicate of
> `--color-accent-primary-hover`: identical in dark (`#93c5fd`), but in light
> it held `#3b82f6` against the hover token's `#1d4ed8`. Folding them
> deliberately corrects the light-mode hover on `Button variant="primary"` and
> the ConsentDialog licence link from a lighter blue to a darker one. Every
> consumer now points at the `accent-primary` pair, which is canonical.
> `--color-brand-navy`, `--color-brand-navy-dark`, and
> `--color-brand-cream` are gone — they had zero consumers in either theme.
> `--color-accent-forward` (the foreground/text variant) is also gone — only
> its background wash, `--color-accent-forward-bg`, had consumers; wiring a
> foreground use of the forward accent is tracked separately. If your
> override layer still defines any of these names, drop them — they no
> longer resolve to anything.

You can reskin offlinecv to your own brand **without forking this repo**, two
ways:

### 1. Cascade override (no build config)

Import your own stylesheet *after* offlinecv's and redefine the same
`--color-*` properties. The last definition wins in the cascade:

```css
/* your-brand.css — imported after offlinecv's styles */
:root {
  --color-accent-primary: #ff6b35;
  --color-bg-card: #fffaf5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --color-accent-primary: #ffa07a;
    --color-bg-card: #1c1410;
  }
}
```

Only override the properties you want to change; everything else keeps the
default. The contract to implement is the `--color-*` names in
`src/design-system/styles/tokens.css`.

### 2. Full replacement (Vite alias)

`src/styles.css` imports the token *values* through a bare `@design-tokens`
specifier. `vite.config.ts` aliases that to the in-tree
`src/design-system/styles/tokens.css` by default, so the standalone build is
unaffected.
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
`src/design-system/styles/tokens.css` as a starting point) so every semantic
token resolves.

### 3. Swapping the component layer (Vite alias)

The token *values* are not the only swappable layer. The components themselves
— primitives (`Button`, `Chip`, `EditableField`) and shared-composed pieces
(`Card`, `StatusBadge`, `ErrorState`, `ErrorBoundary`, `UpdateBanner`) — live
in one in-tree home, `src/design-system/`, and feature code imports them only
through the bare `@design-system` specifier (never deep paths). That specifier
is the **component seam**.

`vite.config.ts` aliases `@design-system` to the in-tree barrel
(`src/design-system/index.ts`) by default. A downstream productionizer repoints
that alias (in both Vite `resolve.alias` *and* the tsconfig `paths` entry) at
their own module that re-exports the same primitive API:

```ts
// vite.config.ts (downstream)
resolve: {
  alias: {
    "@design-system": fileURLToPath(
      new URL("./src/my-design-system/index.ts", import.meta.url),
    ),
  },
},
```

```jsonc
// tsconfig.app.json (downstream)
"paths": { "@design-system": ["src/my-design-system/index.ts"] }
```

Both layers swap at the one design-system home **without forking**: token
values via `@design-tokens`, components via `@design-system`. The semantic
vocabulary (`theme.css`) is the contract both share.

Your replacement module must export the same component API the features consume:

- **`Button`** — props: `variant?: "primary" | "ghost" | "link" | "icon"`,
  `size?: "sm" | "md"`, plus all native `<button>` attributes (`onClick`,
  `disabled`, `type`, `aria-*`, `className`, `children`).
- **`Card`** — props: `{ children, className?, id? }`. Renders a `<section>`.
- **`EditableField`** — props: `{ value, placeholder?, label, onCommit,
  className?, textWeight?, textSize?, revealOn? }` where `value` is
  `string | undefined`, `onCommit: (newValue: string) => void`,
  `textWeight?: "normal" | "semibold"`, `textSize?: "xs" | "sm" | "base"`,
  `revealOn?: "reserve" | "hover"`.
- **`Chip`** — props: `{ icon?, children, tone?: "neutral" | "success" |
  "warning" }`.
- **`StatusBadge`** — props: `{ tone: "ok" | "limited" | "warning", children }`.
- **`ErrorState`** — props: `{ tone?: "error" | "warning", children,
  className? }`.

## Deploy

`npm run build` emits a self-contained static `dist/` directory — plain
HTML, JS, and CSS with no server runtime. Host it on any static-file host
(GitHub Pages, Netlify, Cloudflare Pages, S3, GCS, …):

```bash
npm run build
# then upload dist/ with your host's CLI, e.g.
npx wrangler pages deploy dist        # Cloudflare Pages
netlify deploy --dir dist --prod      # Netlify
aws s3 sync dist s3://your-bucket     # S3
```

The hosted preview at the top of this README is published from `dist/`
to GitHub Pages by `.github/workflows/deploy-pages.yml` — read that
workflow for a working end-to-end example. The canonical production URL
is the custom domain **<https://offlinecv.org>**; the project-Pages URL
<https://offlinecv.github.io/OfflineCV/> remains as a fallback (built
with `VITE_BASE_PATH=/OfflineCV/`).

The build emits two root pages — `/` (the parser audit) and `/jd-fit`
(JD-match + JD-driven rewrite) — as a multi-entry Vite build, so both ship
in the same self-contained `dist/`.

To bake telemetry into a deployed build, set `VITE_POSTHOG_KEY` (and
optionally `VITE_POSTHOG_HOST`) in the build environment — see the
[Telemetry](#telemetry) section. With it unset, the build ships zero
analytics.

## License

[Apache-2.0](./LICENSE). The patent grant is deliberate — the parser audit
should be safely reusable in commercial LLM-adjacent products. See `NOTICE`
for the attribution string.

## Status

Alpha. The score we surface is our own reference number for iterating on the
parser, not a universal verdict; different applicant tracking systems weigh
things differently and we make no comparative claims about how any one of
them would score a given PDF.
