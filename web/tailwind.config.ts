import type { Config } from 'tailwindcss';

const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: token('bg'), card: token('card'), ink: token('ink'), mute: token('mute'), line: token('line'),
        accent: token('accent'), 'accent-bg': token('accent-bg'),
        ok: token('ok'), 'ok-bg': token('ok-bg'), warn: token('warn'), 'warn-bg': token('warn-bg'), bad: token('bad'), 'bad-bg': token('bad-bg'),
      },
      fontFamily: {
        sans: ['ui-sans-serif', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Inter', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: { card: '0 1px 2px rgb(16 24 40 / 0.04), 0 1px 3px rgb(16 24 40 / 0.06)', lift: '0 8px 24px -8px rgb(16 24 40 / 0.18)' },
    },
  },
  plugins: [],
} satisfies Config;
