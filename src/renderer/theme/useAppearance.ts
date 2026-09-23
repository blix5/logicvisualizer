// Appearance settings: which theme, which track palette, and how the
// background image shows. Kept in localStorage (the image itself lives in app
// storage, see src/main/appearance.ts), and resolved here into the active
// Theme, following macOS appearance and Increase Contrast when asked to.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PaletteChoice } from './palettes';
import { PALETTE_CHOICES } from './palettes';
import { toHex } from './color';
import { contrastThemeFor, DEFAULT_THEME_ID, themeById, THEMES, uiCssVariables, type Theme, type ThemeId } from './themes';

export type BackgroundShowIn = 'both' | 'arrange' | 'roll';

export type BackgroundSettings = {
  /** How much of the image shows through the theme's background, 0..1. */
  opacity: number;
  /** Blur radius in CSS px. */
  blur: number;
  showIn: BackgroundShowIn;
};

export type AppearanceSettings = {
  version: 1;
  /** A theme, or 'system' to follow macOS between systemLight and systemDark. */
  theme: ThemeId | 'system';
  systemLight: ThemeId;
  systemDark: ThemeId;
  /** Under 'system', swap to high contrast when macOS asks for more contrast. */
  followContrast: boolean;
  palette: PaletteChoice;
  background: BackgroundSettings;
};

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  version: 1,
  theme: DEFAULT_THEME_ID,
  systemLight: 'daylight',
  systemDark: 'midnight',
  followContrast: true,
  palette: 'theme',
  background: { opacity: 0.35, blur: 0, showIn: 'both' },
};

const STORAGE_KEY = 'lv.appearance';

const isThemeId = (value: unknown): value is ThemeId => THEMES.some((theme) => theme.id === value);

/** Stored settings, with anything missing or no longer valid put back to its default. */
function sanitize(raw: unknown): AppearanceSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_APPEARANCE;
  const value = raw as Partial<AppearanceSettings>;
  const background = (value.background ?? {}) as Partial<BackgroundSettings>;
  const number = (input: unknown, fallback: number, low: number, high: number) =>
    typeof input === 'number' && Number.isFinite(input) ? Math.min(high, Math.max(low, input)) : fallback;
  const defaults = DEFAULT_APPEARANCE;
  return {
    version: 1,
    theme: value.theme === 'system' || isThemeId(value.theme) ? value.theme : defaults.theme,
    systemLight: isThemeId(value.systemLight) ? value.systemLight : defaults.systemLight,
    systemDark: isThemeId(value.systemDark) ? value.systemDark : defaults.systemDark,
    followContrast: typeof value.followContrast === 'boolean' ? value.followContrast : defaults.followContrast,
    palette: PALETTE_CHOICES.some((choice) => choice.id === value.palette) ? value.palette! : defaults.palette,
    background: {
      opacity: number(background.opacity, defaults.background.opacity, 0, 1),
      blur: number(background.blur, defaults.background.blur, 0, 40),
      showIn: background.showIn === 'arrange' || background.showIn === 'roll' ? background.showIn : 'both',
    },
  };
}

function readSettings(): AppearanceSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** A media query's live match. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** The theme the settings resolve to, given the system's appearance. */
export function resolveTheme(settings: AppearanceSettings, systemDark: boolean, systemMoreContrast: boolean): Theme {
  if (settings.theme !== 'system') return themeById(settings.theme);
  const scheme = systemDark ? 'dark' : 'light';
  if (settings.followContrast && systemMoreContrast) return contrastThemeFor(scheme);
  return themeById(systemDark ? settings.systemDark : settings.systemLight);
}

export function useAppearance(): {
  settings: AppearanceSettings;
  theme: Theme;
  update(patch: Partial<Omit<AppearanceSettings, 'background'>> & { background?: Partial<BackgroundSettings> }): void;
  reset(): void;
} {
  const [settings, setSettings] = useState(readSettings);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const moreContrast = useMediaQuery('(prefers-contrast: more)');
  const theme = useMemo(() => resolveTheme(settings, systemDark, moreContrast), [settings, systemDark, moreContrast]);

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* per-session only */ }
  }, [settings]);

  // The chrome follows the theme through CSS custom properties.
  useEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(uiCssVariables(theme.ui))) root.style.setProperty(name, value);
    root.style.colorScheme = theme.scheme;
    root.dataset.theme = theme.id;
    root.dataset.contrast = theme.contrast;
  }, [theme]);

  // Native chrome (window background, dialogs, menus) follows too. Under
  // 'system' the native theme must stay on system, or the media queries above
  // would report the app's own choice back instead of macOS's.
  useEffect(() => {
    void window.lv.appearance.setWindow(toHex(theme.ui.bg), settings.theme === 'system' ? 'system' : theme.scheme);
  }, [theme, settings.theme]);

  const update = useCallback<ReturnType<typeof useAppearance>['update']>((patch) => {
    setSettings((current) => sanitize({
      ...current,
      ...patch,
      background: { ...current.background, ...patch.background },
    }));
  }, []);
  const reset = useCallback(() => setSettings(DEFAULT_APPEARANCE), []);

  return { settings, theme, update, reset };
}
