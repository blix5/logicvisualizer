// Track colour palettes, and how a track's colour is chosen from one.
//
// A choice is either a palette, "theme" (whatever the active theme pairs with)
// or "logic" (the project's own colours once they are decoded, else the
// theme's palette). Whatever the source, adaptForTheme then shifts it so it
// reads on the active theme: deeper on light grounds, punchier at high
// contrast. On an ordinary dark theme colours pass through untouched.
import { fallbackTrackColor } from '../../shared/palette';
import type { TrackModel } from '../../shared/model';
import { formatHsl, toHsl, type Hsl } from './color';
import type { Theme } from './themes';

export type PaletteId =
  | 'vivid'
  | 'pastel'
  | 'strawberry'
  | 'peach'
  | 'blueberry'
  | 'matcha'
  | 'lavender'
  | 'contrast'
  | 'mono';

export type PaletteChoice = PaletteId | 'theme' | 'logic';

type Palette = {
  id: PaletteId;
  name: string;
  /** Colour for the track at `index`, before adaptForTheme. */
  color(index: number, theme: Theme): string;
};

const GOLDEN_ANGLE = 137.508;

/**
 * A fixed list, cycled. Each time round, lightness steps a little so a
 * twelfth track is not mistaken for the fourth.
 */
function list(id: PaletteId, name: string, colors: string[]): Palette {
  const parsed = colors.map((color) => toHsl(color) ?? { h: 0, s: 0, l: 50 });
  return {
    id,
    name,
    color(index) {
      const base = parsed[index % parsed.length]!;
      const lap = Math.floor(index / parsed.length);
      const shift = lap === 0 ? 0 : (lap % 2 === 1 ? -9 : 7) * Math.ceil(lap / 2);
      return formatHsl({ ...base, l: Math.min(90, Math.max(25, base.l + shift)) });
    },
  };
}

export const PALETTES: readonly Palette[] = [
  {
    id: 'vivid',
    name: 'Vivid',
    color: (index) => fallbackTrackColor(index, 'unknown'),
  },
  {
    id: 'pastel',
    name: 'Pastel',
    color: (index) => formatHsl({ h: (index * GOLDEN_ANGLE + 20) % 360, s: 60, l: 78 }),
  },
  list('strawberry', 'Strawberry', [
    'hsl(350 72% 70%)', 'hsl(10 78% 68%)', 'hsl(335 58% 74%)', 'hsl(24 80% 70%)',
    'hsl(140 32% 60%)', 'hsl(46 78% 70%)', 'hsl(310 38% 72%)', 'hsl(0 60% 80%)',
  ]),
  list('peach', 'Peach', [
    'hsl(22 85% 72%)', 'hsl(36 85% 70%)', 'hsl(10 70% 74%)', 'hsl(48 75% 72%)',
    'hsl(350 55% 76%)', 'hsl(90 35% 66%)', 'hsl(28 50% 80%)', 'hsl(190 35% 68%)',
  ]),
  list('blueberry', 'Blueberry', [
    'hsl(228 60% 72%)', 'hsl(262 45% 74%)', 'hsl(205 62% 68%)', 'hsl(245 38% 80%)',
    'hsl(190 45% 66%)', 'hsl(285 35% 72%)', 'hsl(215 30% 82%)', 'hsl(170 35% 64%)',
  ]),
  list('matcha', 'Matcha', [
    'hsl(95 38% 62%)', 'hsl(70 42% 64%)', 'hsl(140 30% 60%)', 'hsl(45 45% 68%)',
    'hsl(165 28% 62%)', 'hsl(30 35% 66%)', 'hsl(110 22% 74%)', 'hsl(200 25% 66%)',
  ]),
  list('lavender', 'Lavender', [
    'hsl(265 55% 78%)', 'hsl(290 42% 76%)', 'hsl(240 45% 78%)', 'hsl(320 45% 78%)',
    'hsl(215 45% 76%)', 'hsl(180 30% 72%)', 'hsl(340 50% 82%)', 'hsl(255 25% 84%)',
  ]),
  list('contrast', 'High contrast', [
    'hsl(48 100% 55%)', 'hsl(190 100% 50%)', 'hsl(320 100% 62%)', 'hsl(110 90% 50%)',
    'hsl(25 100% 58%)', 'hsl(265 100% 72%)', 'hsl(0 100% 62%)', 'hsl(160 100% 45%)',
  ]),
  {
    id: 'mono',
    name: 'Accent shades',
    // Shades of the theme's accent: one colour family, told apart by depth.
    color(index, theme) {
      const accent = toHsl(theme.ui.accent) ?? { h: 0, s: 70, l: 60 };
      const steps = [0, 12, -10, 20, -18, 6, -4, 16];
      const l = Math.min(85, Math.max(30, accent.l + steps[index % steps.length]!));
      return formatHsl({ h: accent.h + (index % 3) * 6 - 6, s: Math.max(35, accent.s - (index % 2) * 15), l });
    },
  },
];

export const PALETTE_CHOICES: readonly { id: PaletteChoice; name: string }[] = [
  { id: 'theme', name: 'Theme colours' },
  { id: 'logic', name: 'From Logic' },
  ...PALETTES.map(({ id, name }) => ({ id, name })),
];

export function paletteById(id: PaletteId): Palette {
  return PALETTES.find((palette) => palette.id === id) ?? PALETTES[0]!;
}

/** Shifts a colour so it reads on `theme`. Identity on ordinary dark themes. */
export function adaptForTheme(color: string, theme: Theme): string {
  if (theme.scheme === 'dark' && theme.contrast === 'normal') return color;
  const hsl: Hsl | null = toHsl(color);
  if (!hsl) return color;
  if (theme.contrast === 'high') {
    const s = Math.max(hsl.s, 85);
    const l = theme.scheme === 'dark' ? Math.min(68, Math.max(55, hsl.l)) : Math.min(40, Math.max(28, hsl.l * 0.55));
    return formatHsl({ h: hsl.h, s, l });
  }
  // Light: pastels become mid-tones so notes and regions keep their weight
  // against paper, where they are multiplied rather than added.
  return formatHsl({
    h: hsl.h,
    s: Math.min(100, hsl.s * 1.1 + 5),
    l: Math.min(50, Math.max(32, hsl.l * 0.62)),
  });
}

/** Whether any track carries a colour read from the project itself. */
export function hasProjectColors(tracks: readonly TrackModel[]): boolean {
  return tracks.some((track) => track.colorSource === 'project');
}

/**
 * Every track's colour under `choice` and `theme`, in `tracks` order. Tracks
 * keep their fallback colour under Vivid, which is the palette it came from,
 * so the default look is exactly what it was before palettes existed.
 */
export function resolveTrackColors(tracks: readonly TrackModel[], choice: PaletteChoice, theme: Theme): string[] {
  return tracks.map((track, index) => {
    let color: string;
    if (choice === 'logic' && track.colorSource === 'project') {
      const hsl = toHsl(track.color);
      color = hsl ? formatHsl(hsl) : track.color;
    } else {
      const id = choice === 'logic' || choice === 'theme' ? theme.palette : choice;
      color = id === 'vivid' && track.colorSource === 'fallback'
        ? track.color
        : paletteById(id).color(index, theme);
    }
    return adaptForTheme(color, theme);
  });
}
