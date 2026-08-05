'use client';

import { useEffect, useState } from 'react';
import { Palette } from 'lucide-react';
import {
  DEFAULT_THEME,
  THEME_META,
  THEME_STORAGE_KEY,
  nextTheme,
  resolveInitialTheme,
  type Theme,
} from '@/lib/theme';

/**
 * Cycles the Monolith skins. Reads the theme the pre-paint script already set on
 * <html>, so there's no flash; clicking advances and persists.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    const attr = document.documentElement.getAttribute('data-theme');
    setTheme(resolveInitialTheme(attr ?? localStorage.getItem(THEME_STORAGE_KEY)));
  }, []);

  function cycle() {
    const next = nextTheme(theme);
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* private mode — theme just won't persist */
    }
  }

  return (
    <button
      onClick={cycle}
      title={`Theme: ${THEME_META[theme].name} — click to cycle`}
      aria-label="Cycle theme"
      className="grid h-[30px] w-[30px] place-items-center rounded-sm-t border border-os-border bg-os-surface text-os-muted transition-colors hover:border-os-border-strong hover:text-os-text"
    >
      <Palette className="h-3.5 w-3.5" />
    </button>
  );
}
