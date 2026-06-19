/**
 * Tailwind — Stitch "Linear-style" dark landing token system, ported verbatim from the
 * dash-ota Stitch export (screen 256325…). Scoped to `.dash-landing`.
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  important: '.dash-landing',
  darkMode: ['selector', '[data-theme="dark"]'],
  corePlugins: { preflight: false, container: false },
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#4254f0',
        'background-light': '#f6f6f8',
        'background-dark': '#09090b',
        surface: '#121214',
        muted: '#8F8F99',
        border: '#27272A',
        accent: '#45D09E',
      },
      fontFamily: {
        display: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '0.25rem',
        sm: '0.25rem',
        md: '0.375rem',
        lg: '0.5rem',
        xl: '0.75rem',
        full: '9999px',
      },
      maxWidth: {
        content: '1200px',
      },
    },
  },
  plugins: [],
};
