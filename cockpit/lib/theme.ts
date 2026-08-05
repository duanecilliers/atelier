/**
 * UI themes. Mono (Monolith Signal — white on black, color = status only) is the
 * default identity; the others are full re-skins. The active theme lives as
 * `data-theme` on <html>, persisted to localStorage. Adapted from FounderOS —
 * trimmed to the three skins Atelier ships and re-keyed to the atelier namespace.
 */
export const THEMES = ['mono', 'mono-light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = 'mono';

/** Picker metadata: display name, one-line feel, [bg, accent, text] swatch. */
export const THEME_META: Record<Theme, { name: string; blurb: string; swatch: [string, string, string] }> = {
  mono: { name: 'Monolith', blurb: 'white on black, color = status only', swatch: ['#0a0a0a', '#f2f2f2', '#2fd36f'] },
  'mono-light': { name: 'Daylight', blurb: 'soft grey on white, easy on the eyes', swatch: ['#f5f6f8', '#1b1e23', '#2b8fd8'] },
  dark: { name: 'Terminal', blurb: 'phosphor green on near-black', swatch: ['#050807', '#3df08c', '#e4efe6'] },
};

export const THEME_STORAGE_KEY = 'atelier-theme';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function resolveInitialTheme(stored: string | null): Theme {
  return isTheme(stored) ? stored : DEFAULT_THEME;
}

export function nextTheme(current: Theme): Theme {
  const i = THEMES.indexOf(current);
  return THEMES[(i + 1) % THEMES.length];
}

/**
 * Inline-able script (string) that applies the persisted theme before first
 * paint, so there is no theme flash. Generated from the registry so the two
 * never drift. Injected in <head> via layout.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k=${JSON.stringify([...THEMES])};var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(k.indexOf(t)<0)t=${JSON.stringify(DEFAULT_THEME)};document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme',${JSON.stringify(DEFAULT_THEME)});}})();`;
