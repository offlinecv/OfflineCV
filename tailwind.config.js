/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        brand: {
          navy: "var(--color-brand-navy)",
          "navy-dark": "var(--color-brand-navy-dark)",
          amber: "var(--color-brand-amber)",
          "amber-light": "var(--color-brand-amber-light)",
          cream: "var(--color-brand-cream)",
        },
        surface: {
          base: "var(--color-bg-base)",
          card: "var(--color-bg-card)",
          "card-warm": "var(--color-bg-card-warm)",
          subtle: "var(--color-bg-subtle)",
          hover: "var(--color-bg-hover)",
        },
        content: {
          primary: "var(--color-text-primary)",
          secondary: "var(--color-text-secondary)",
          tertiary: "var(--color-text-tertiary)",
          muted: "var(--color-text-muted)",
          inverse: "var(--color-text-inverse)",
        },
        border: {
          light: "var(--color-border-light)",
          DEFAULT: "var(--color-border-default)",
          strong: "var(--color-border-strong)",
        },
        accent: {
          primary: "var(--color-accent-primary)",
          "primary-hover": "var(--color-accent-primary-hover)",
          forward: "var(--color-accent-forward)",
          "forward-bg": "var(--color-accent-forward-bg)",
        },
        feedback: {
          error: {
            bg: "var(--color-feedback-error-bg)",
            border: "var(--color-feedback-error-border)",
            text: "var(--color-feedback-error-text)",
            icon: "var(--color-feedback-error-icon)",
          },
          warning: {
            bg: "var(--color-feedback-warning-bg)",
            border: "var(--color-feedback-warning-border)",
            text: "var(--color-feedback-warning-text)",
            icon: "var(--color-feedback-warning-icon)",
          },
          info: {
            bg: "var(--color-feedback-info-bg)",
            border: "var(--color-feedback-info-border)",
            text: "var(--color-feedback-info-text)",
            icon: "var(--color-feedback-info-icon)",
          },
          success: {
            bg: "var(--color-feedback-success-bg)",
            border: "var(--color-feedback-success-border)",
            text: "var(--color-feedback-success-text)",
            icon: "var(--color-feedback-success-icon)",
          },
        },
      },
    },
  },
  plugins: [],
};
