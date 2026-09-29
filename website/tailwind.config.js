/**
 * Landing-page tokens, scoped to `.dash-landing` so nothing here reaches the Infima docs chrome.
 *
 * The palette carries the update lifecycle: amber for work in flight, steel for a settled state,
 * alarm for the crash-loop breaker. Two greys, not one, so panels read as raised rather than
 * outlined.
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
        body: '#1B2027',
        panel: '#232A33',
        raised: '#2B333D',
        line: '#333C47',
        ink: '#E6EAEF',
        muted: '#8C98A6',
        amber: '#E8A33D',
        steel: '#6FA8C7',
        alarm: '#D2544B',
      },
      fontFamily: {
        display: ['Roboto Condensed', 'Inter', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '0.25rem',
        sm: '0.1875rem',
        md: '0.3125rem',
        lg: '0.5rem',
        xl: '0.75rem',
        full: '9999px',
      },
      maxWidth: { content: '1180px' },
      boxShadow: {
        panel: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 24px -12px rgba(0,0,0,0.6)',
      },
    },
  },
  plugins: [],
};
