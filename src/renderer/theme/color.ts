// Small colour toolkit for themes and track palettes: parse the CSS colour forms
// the app writes (#hex, rgb[a](), hsl[a]() in comma or space syntax), convert
// between RGB and HSL, and measure WCAG contrast. No DOM access, so it runs
// under node for the tests.

export type Rgba = { r: number; g: number; b: number; a: number };
export type Hsl = { h: number; s: number; l: number };

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Channel values from a functional notation's argument list, either syntax. */
function args(inner: string): string[] {
  return inner.replace(/\//g, ' ').replace(/,/g, ' ').trim().split(/\s+/);
}

function alphaOf(token: string | undefined): number {
  if (token === undefined) return 1;
  return token.endsWith('%') ? parseFloat(token) / 100 : parseFloat(token);
}

/** Parses a colour, or returns null for anything it does not understand. */
export function parseColor(input: string): Rgba | null {
  const color = input.trim().toLowerCase();
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full = hex.length === 3 || hex.length === 4
      ? [...hex].map((c) => c + c).join('')
      : hex;
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(full)) return null;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
    };
  }
  const match = /^(rgba?|hsla?)\((.*)\)$/.exec(color);
  if (!match) return null;
  const parts = args(match[2] ?? '');
  if (parts.length < 3) return null;
  if (match[1]!.startsWith('rgb')) {
    const channel = (token: string) => (token.endsWith('%') ? parseFloat(token) * 2.55 : parseFloat(token));
    const [r, g, b] = parts.slice(0, 3).map(channel) as [number, number, number];
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r, g, b, a: alphaOf(parts[3]) };
  }
  const h = parseFloat(parts[0]!);
  const s = parseFloat(parts[1]!);
  const l = parseFloat(parts[2]!);
  if ([h, s, l].some(Number.isNaN)) return null;
  return { ...hslToRgb({ h, s, l }), a: alphaOf(parts[3]) };
}

export function hslToRgb({ h, s, l }: Hsl): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - chroma / 2;
  const [r, g, b] = hue < 60 ? [chroma, x, 0]
    : hue < 120 ? [x, chroma, 0]
      : hue < 180 ? [0, chroma, x]
        : hue < 240 ? [0, x, chroma]
          : hue < 300 ? [x, 0, chroma]
            : [chroma, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l: l * 100 };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  return { h: ((h * 60) + 360) % 360, s: s * 100, l: l * 100 };
}

/** The `hsl(h s% l%)` form track colours use; the renderers append alpha to it. */
export function formatHsl({ h, s, l }: Hsl): string {
  const round = (value: number) => Math.round(value * 10) / 10;
  return `hsl(${round(h)} ${round(clamp(s, 0, 100))}% ${round(clamp(l, 0, 100))}%)`;
}

/** Any colour as hsl(), or null when it cannot be parsed. */
export function toHsl(color: string): Hsl | null {
  const rgba = parseColor(color);
  return rgba ? rgbToHsl(rgba) : null;
}

export function toHex(color: string): string {
  const rgba = parseColor(color);
  if (!rgba) return '#000000';
  const hex = (value: number) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0');
  return `#${hex(rgba.r)}${hex(rgba.g)}${hex(rgba.b)}`;
}

/** "r,g,b" of an opaque colour, for building rgba() strings at other alphas. */
export function rgbTriplet(color: string): string {
  const rgba = parseColor(color) ?? { r: 0, g: 0, b: 0, a: 1 };
  return `${Math.round(rgba.r)},${Math.round(rgba.g)},${Math.round(rgba.b)}`;
}

/** `top` composited over the opaque `bottom`, as it would appear on screen. */
export function over(top: string, bottom: string): Rgba {
  const t = parseColor(top) ?? { r: 0, g: 0, b: 0, a: 1 };
  const b = parseColor(bottom) ?? { r: 0, g: 0, b: 0, a: 1 };
  return {
    r: t.r * t.a + b.r * (1 - t.a),
    g: t.g * t.a + b.g * (1 - t.a),
    b: t.b * t.a + b.b * (1 - t.a),
    a: 1,
  };
}

function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio of `foreground` (alpha honoured) on the opaque `background`. */
export function contrastRatio(foreground: string, background: string): number {
  const fg = luminance(over(foreground, background));
  const bg = luminance(parseColor(background) ?? { r: 0, g: 0, b: 0 });
  const [light, dark] = fg > bg ? [fg, bg] : [bg, fg];
  return (light + 0.05) / (dark + 0.05);
}
