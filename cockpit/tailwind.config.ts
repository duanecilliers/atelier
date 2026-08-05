import type { Config } from 'tailwindcss';

// Monolith Signal tokens — source of truth mirrored as CSS vars in globals.css.
// Lifted wholesale from FounderOS: a single data-theme flip on <html> re-themes
// every os.* class at once. (Ported verbatim; funnel/brain tokens dropped —
// Atelier has no such views.)
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      screens: {
        wide: '1800px',
        ultra: '2200px',
      },
      colors: {
        os: {
          bg: 'var(--bg)',
          bg2: 'var(--bg-2)',
          surface: 'var(--surface)',
          surface2: 'var(--surface-2)',
          surface3: 'var(--surface-3)',
          border: 'var(--border)',
          hairline: 'var(--hairline)',
          'border-strong': 'var(--border-strong)',
          text: 'var(--text)',
          muted: 'var(--text-2)',
          dim: 'var(--text-3)',
          accent: 'var(--accent)',
          accent2: 'var(--accent-2)',
          ink: 'var(--accent-ink)',
          ok: 'var(--ok)',
          warn: 'var(--warn)',
          err: 'var(--err)',
        },
      },
      fontFamily: {
        sans: ['var(--font-mono)', '"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        mono: ['var(--font-mono)', '"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        // class names stay so no component edits; the values go sharp
        'sm-t': '0px',
        'md-t': '0px',
        'lg-t': '0px',
      },
    },
  },
  plugins: [],
};

export default config;
