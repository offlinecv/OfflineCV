// eslint.config.js — flat config (ESLint 9+, ESM)
// Architecture/token guard for resumelint. Minimal ruleset: no style
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
const HEX_RE = `#[0-9a-fA-F]{3,6}\\b`;

/** no-restricted-syntax selectors that catch both string literals and
 *  template-literal chunks (so cn()/clsx template strings are covered). */
function restrictedSyntaxRules() {
  return [
    // Raw Tailwind palette colours in class strings
    {
      selector: `Literal[value=/${PALETTE_RE}/]`,
      message:
        "Use semantic tokens (bg-surface-card, text-content-primary, border-border-light, text-brand-amber, …) instead of raw Tailwind palette classes.",
    },
    {
      selector: `TemplateElement[value.raw=/${PALETTE_RE}/]`,
      message:
        "Use semantic tokens (bg-surface-card, text-content-primary, border-border-light, text-brand-amber, …) instead of raw Tailwind palette classes.",
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

  // ── Architecture guard: components + App.tsx ────────────────────────────
  // These rules encode the same checks style_guard.sh runs (non-blocking,
  // advisory). Here they are BLOCKING (error) and run in CI.
  {
    files: ["src/components/**/*.{ts,tsx}", "src/App.tsx"],
    rules: {
      // Raw <button> outside the Button primitive is forbidden in feature code.
      "react/forbid-elements": [
        "error",
        {
          forbid: [
            {
              element: "button",
              message:
                "Use the <Button> primitive from src/components/ui/Button.tsx instead of a raw <button>.",
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
    files: ["src/components/ui/Button.tsx"],
    rules: {
      "react/forbid-elements": "off",
    },
  },
];
