// eslint.config.js — flat config (ESLint 9+, ESM)
// Architecture/token guard for offlinecv. Minimal ruleset: no style
// bikeshedding, just the structural rules that style_guard.sh checked.
// These same checks run (blocking) in CI via `npm run lint`.

import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import globals from "globals";

/** Palette colour segments guarded by the token rules. */
const PALETTE_COLOURS =
  "red|green|emerald|slate|amber|blue|gray|zinc|stone|orange|yellow|lime|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose";

/** Tailwind property prefixes that may carry raw palette colours. */
const PALETTE_PROPS = "bg|text|border|ring|shadow|fill|stroke";

const PALETTE_RE = `(${PALETTE_PROPS})-(${PALETTE_COLOURS})-[0-9]`;
const DARK_RE = `dark:[a-z]+-[a-z]+-[0-9]`;
/** Hardcoded hex colours, e.g. #ef4444, #fff, bg-[#f00], #334155cc.
 *
 *  `#638` is simultaneously a valid 3-digit hex colour and a valid GitHub issue
 *  reference, and this rule matches `Literal`/`TemplateElement` VALUES — so an
 *  unanchored `#[0-9a-fA-F]{3,6}` reported every `describe("… (#638)")` in the
 *  suite as a hardcoded colour. (Comments are neither node type, which is why
 *  the contrast-ratio docblocks in `CountBadge.tsx`/`Tabs.tsx` were never hit
 *  and the trap only ever bites test/UI STRINGS.) Same unanchored-substring
 *  defect as ARBITRARY_TEXT_SIZE_RE below — fixed the same way, positionally.
 *
 *  The two hex shapes live in different positions, and that is what separates
 *  them from an issue number:
 *   - 6- or 8-digit form is unambiguous at any length, so it matches anywhere;
 *   - 3- or 4-digit form only where a colour can actually START — at the
 *     beginning of the string value (`"#fff"`, `color: "#f00"` as a whole
 *     value) or straight after Tailwind's arbitrary-value `[` (`bg-[#f00]`).
 *  An issue reference is always preceded by a space or `(`, so it matches
 *  neither branch. A string whose ENTIRE value is `#638` is still reported:
 *  genuinely ambiguous, and a false positive there is cheaper than letting
 *  `"#fff"` through. */
const HEX_RE = `(?:(?:^|\\[)#[0-9a-fA-F]{3,4}\\b|#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\\b)`;
/** Arbitrary Tailwind font-size values, e.g. text-[11px], text-[0.6875rem],
 *  text-[10pt], text-[2vw] or the explicit `text-[length:12px]` form.
 *
 *  Left boundary is load-bearing (#640 review): without it the pattern is a
 *  bare substring match, so ANY class ending in "text-" fires it — `context-`,
 *  `subtext-`, a data attribute — and the rule reports a violation on a line
 *  that has no arbitrary font size at all.
 *
 *  The unit alternation covers every CSS length unit Tailwind will accept here,
 *  not just the two the #640 sweep happened to use. Arbitrary values that are
 *  NOT sizes stay legal — `text-[color:var(--x)]` and `text-[#abc]` are colour
 *  values, governed by the palette/hex rules above, and neither matches. */
const ARBITRARY_TEXT_SIZE_RE = `(^|[\\s:'"\`])text-\\[(length:)?[0-9.]+(px|rem|em|pt|vw|vh|ch|ex|%)\\]`;

/** no-restricted-syntax selectors that catch both string literals and
 *  template-literal chunks (so cn()/clsx template strings are covered). */
function restrictedSyntaxRules() {
  return [
    // Raw Tailwind palette colours in class strings
    {
      selector: `Literal[value=/${PALETTE_RE}/]`,
      message:
        "Use semantic tokens (bg-surface-card, text-content-primary, border-border-light, text-accent-primary, …) instead of raw Tailwind palette classes.",
    },
    {
      selector: `TemplateElement[value.raw=/${PALETTE_RE}/]`,
      message:
        "Use semantic tokens (bg-surface-card, text-content-primary, border-border-light, text-accent-primary, …) instead of raw Tailwind palette classes.",
    },
    // Manual dark: colour variants
    {
      selector: `Literal[value=/${DARK_RE}/]`,
      message:
        "Semantic tokens handle dark mode automatically — drop manual dark: colour variants.",
    },
    {
      selector: `TemplateElement[value.raw=/${DARK_RE}/]`,
      message:
        "Semantic tokens handle dark mode automatically — drop manual dark: colour variants.",
    },
    // Hardcoded hex colours
    {
      selector: `Literal[value=/${HEX_RE}/]`,
      message:
        "No hardcoded hex colours in feature code — use semantic tokens.",
    },
    {
      selector: `TemplateElement[value.raw=/${HEX_RE}/]`,
      message:
        "No hardcoded hex colours in feature code — use semantic tokens.",
    },
    // Arbitrary font-size values
    {
      selector: `Literal[value=/${ARBITRARY_TEXT_SIZE_RE}/]`,
      message:
        "Use a named type-ramp step (text-4xs, text-3xs, text-2xs, text-xs, text-sm, …) instead of an arbitrary font size.",
    },
    {
      selector: `TemplateElement[value.raw=/${ARBITRARY_TEXT_SIZE_RE}/]`,
      message:
        "Use a named type-ramp step (text-4xs, text-3xs, text-2xs, text-xs, text-sm, …) instead of an arbitrary font size.",
    },
  ];
}

export default [
  // ── Global ignores ──────────────────────────────────────────────────────
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "*.config.js",
      "*.config.ts",
      "scripts/**",
      "coverage/**",
      ".claude/**",
    ],
  },

  // ── Base block: all src TypeScript ──────────────────────────────────────
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      react: reactPlugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      globals: {
        ...globals.browser,
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    // No broad recommended rulesets — keep minimal to protect the green
    // baseline. Only the architecture/token rules below apply.
    rules: {},
  },

  // ── Architecture guard: components + the three lane roots ───────────────
  // These rules encode the same checks style_guard.sh runs (non-blocking,
  // advisory). Here they are BLOCKING (error) and run in CI.
  //
  // The scope is every surface that WRITES markup: the component tiers, plus
  // the ROOT of each of the three HTML entries the build ships (vite.config.ts
  // `rollupOptions.input`). `src/App.tsx` was listed alone, which left its two
  // peers — `JobsApp` (`/jobs/`) and `JdFitApp` (`/jd-fit/`) — writing JSX
  // outside every token rule (#640 review). Listed as the three files rather
  // than as `src/jobs/**`+`src/jd-fit/**` so the scope stays "the entry roots",
  // matching how `src/App.tsx` is named; `main.tsx` and the lane hooks/tests
  // hold no markup. `src/lib/**` and `src/hooks/**` stay out for the same
  // reason.
  {
    files: [
      "src/components/**/*.{ts,tsx}",
      "src/design-system/**/*.{ts,tsx}",
      "src/App.tsx",
      "src/jobs/JobsApp.tsx",
      "src/jd-fit/JdFitApp.tsx",
    ],
    rules: {
      // Raw <button> outside the Button primitive is forbidden in feature code.
      "react/forbid-elements": [
        "error",
        {
          forbid: [
            {
              element: "button",
              message:
                "Use the <Button> primitive from @design-system instead of a raw <button>.",
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...restrictedSyntaxRules()],
    },
  },

  // ── Allow raw <button> inside the Button primitive itself ────────────────
  // Flat config: later blocks win, so this override is applied last.
  {
    files: ["src/design-system/primitives/Button.tsx"],
    rules: {
      "react/forbid-elements": "off",
    },
  },
];
