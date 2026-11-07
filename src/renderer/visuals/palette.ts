// Theme colours as the visual layers use them, worked out once per theme, and
// the soft halo sprites note-driven layers stamp in track colours.
import { withAlpha } from '../render/ArrangeRenderer';
import { parseColor } from '../theme/color';
import type { CanvasTheme } from '../theme/themes';

export type Rgb = readonly [number, number, number];

export type VisualPalette = {
  /** "r,g,b" strings, for building rgba() fills. */
  left: string;
  right: string;
  accent: string;
  /** 0..1 components, for shaders. */
  leftGl: Rgb;
  rightGl: Rgb;
  accentGl: Rgb;
  /** True on light themes: layers draw darker and lean on alpha, not addition. */
  light: boolean;
};

const cache = new WeakMap<CanvasTheme, VisualPalette>();

function tripletOf(color: string, fallback: string): string {
  const parsed = parseColor(color);
  return parsed ? `${Math.round(parsed.r)},${Math.round(parsed.g)},${Math.round(parsed.b)}` : fallback;
}

function gl(triplet: string): Rgb {
  const [r = 255, g = 255, b = 255] = triplet.split(',').map(Number);
  return [r / 255, g / 255, b / 255];
}

export function paletteFor(theme: CanvasTheme): VisualPalette {
  let palette = cache.get(theme);
  if (!palette) {
    const accent = tripletOf(theme.playhead, '255,90,95');
    palette = {
      left: theme.spectrum.left,
      right: theme.spectrum.right,
      accent,
      leftGl: gl(theme.spectrum.left),
      rightGl: gl(theme.spectrum.right),
      accentGl: gl(accent),
      light: theme.blend !== 'lighter',
    };
    cache.set(theme, palette);
  }
  return palette;
}

/** CSS px across a halo sprite. */
const SPRITE_SIZE = 44;

/** Halo sprites per colour, rebuilt when the theme or pixel ratio changes. */
export class SpriteCache {
  private readonly sprites = new Map<string, HTMLCanvasElement>();
  private key = '';

  get(color: string, theme: CanvasTheme, dpr: number): HTMLCanvasElement {
    const key = `${dpr}|${theme.spriteCore ?? ''}`;
    if (key !== this.key) {
      this.key = key;
      this.sprites.clear();
    }
    const cached = this.sprites.get(color);
    if (cached) return cached;
    const size = Math.ceil(SPRITE_SIZE * dpr);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const r = size / 2;
      const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
      gradient.addColorStop(0, theme.spriteCore ?? withAlpha(color, 0.95));
      gradient.addColorStop(0.12, withAlpha(color, 0.8));
      gradient.addColorStop(0.4, withAlpha(color, 0.22));
      gradient.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    }
    this.sprites.set(color, canvas);
    return canvas;
  }
}
