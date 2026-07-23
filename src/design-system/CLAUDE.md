# CLAUDE.md — design system

Primitives + shared-composed behind the `@design-system` barrel (`index.ts`). Feature code
imports via `import { … } from "@design-system"`, never deep paths. Read the root
`CLAUDE.md` "Component architecture" + "Styling & tokens" sections first; this file adds
three things that are easy to get wrong.

## No Toast / Snackbar — confirm in place

The barrel ships **no `Toast` and no `Snackbar`.** The reflex fix for "action completes
with no feedback" is a success toast — but that means adding a *shared* component for a
single callsite, which the reuse rule forbids. House pattern: **confirm in the surface
already mounted**, swap its content rather than dismissing it. Two existing tones carry
"done" with zero new components:

- `InlineResult` — `tone="success"`
- `StatusBadge` — `tone="ok"`

Announce the swap with `aria-live="polite"` (precedent: `JobSearchResults.tsx`,
`shared/UpdateBanner.tsx`). Never let colour alone carry meaning — the word ("Applied")
must be present.

## The default palette is deliberate — rename, never repaint

`styles/tokens.css` is intentionally a generic slate-neutrals-plus-blue palette, **not** a
product brand — its docblock is the swap seam for an outside cloner. Do not repaint the
shared default to make the app "less bland"; that destroys the seam. Audit tokens by
**consumption, not by reading the file**: `rg -o 'token-name' src/ --glob '!**/styles/*' |
sort | uniq -c`. Name/value drift and dead tokens are invisible to reading and obvious to
counting (a token whose name asserts a colour family is the highest-risk kind). Prefer a
rename/merge to a repaint; prefer consuming an existing accent to defining a new one.

## Emoji rule is about presentation, not codepoint

Root `CLAUDE.md` forbids emoji as icons. A codepoint-range grep over-reports ~4x — most
hits are deliberate **text-presentation marks**, not violations. Allowed: monochrome marks
that inherit `currentColor` and carry an `aria-hidden` + `sr-only`/label pair (e.g. `✓ ✗`
decorative toggles, `★ ☆` in `StarRating`, `⚠︎` written `U+26A0 U+FE0E` in `Tabs.tsx`).
Banned: colour pictographs from the OS emoji font. Before flagging a hit, check for an
adjacent `U+FE0E` and an `aria-hidden`/`sr-only` pair.
