// App themes. A theme is two sets of tokens: `ui` for the chrome (written to
// CSS custom properties on :root by useAppearance) and `canvas` for the
// arrange and piano-roll renderers, which cannot read CSS. Midnight is the
// original look, value for value; the rest are built from a hue and a
// saturation by the dark() and light() builders, with overrides where a theme
// needs them (the high-contrast pair overrides most).
import { formatHsl, rgbTriplet } from './color';
import type { PaletteId } from './palettes';

export type ThemeId =
  | 'midnight'
  | 'daylight'
  | 'contrast-dark'
  | 'contrast-light'
  | 'strawberry'
  | 'peach'
  | 'blueberry'
  | 'matcha'
  | 'lavender';

export type UiTheme = {
  bg: string;
  panel: string;
  /** Menus and popovers, a step above the panel. */
  raised: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  accent: string;
  /** Text on an accent fill. */
  onAccent: string;
  warn: string;
  control: string;
  controlHover: string;
  controlActive: string;
  /** Faint fills: segmented controls, thumbnails, menu rows. */
  wash: string;
  washHover: string;
  /** Text inputs. */
  field: string;
  /** Badges over thumbnails. */
  overlay: string;
  shadow: string;
  /** Keeps text over the canvas legible. */
  textShadow: string;
};

export type SpectrumTheme = {
  /** "r,g,b" per channel; the painter adds its own alphas. */
  left: string;
  right: string;
  /** Pitch-view bar gradient, from the playhead outward. */
  pitch: [string, string, string];
  /** Spectrogram trail colours at the quiet and loud ends. */
  trailQuiet: [number, number, number];
  trailLoud: [number, number, number];
};

export type CanvasTheme = {
  /**
   * How glows, flashes, particles and stacked waveforms combine. Additive light
   * works on a dark ground and blows out to white on a light one, where
   * multiply darkens instead.
   */
  blend: GlobalCompositeOperation;

  // Arrange view.
  arrangeBg: string;
  laneBg: string;
  rulerBg: string;
  gridMajor: string;
  gridMinor: string;
  rulerText: string;
  regionText: string;
  labelBg: string;
  laneText: string;
  laneTextMuted: string;
  laneDivider: string;
  playhead: string;
  /** Muted regions and tracks. Must be an hsl() colour, like a track colour. */
  muted: string;

  // Piano roll.
  rollBg: string;
  /** Wash over the whole roll, top to bottom. */
  rollWash: [string, string];
  blackKeyRow: string;
  octaveLine: string;
  whiteKey: string;
  blackKey: string;
  keyDivider: string;
  bounceCentre: string;
  /** Radial vignette, centre then edge. */
  vignette: [string, string];
  barMinor: string;
  barMajor: string;
  /** Bounce waveform: played start, played end, upcoming start, upcoming end. */
  bounce: [string, string, string, string];
  /** Soft band under the playhead: edge, middle. */
  playheadBand: [string, string];
  playheadLine: string;
  /** Centre of a note's halo sprite; null uses the track colour itself. */
  spriteCore: string | null;

  spectrum: SpectrumTheme;
};

export type Theme = {
  id: ThemeId;
  name: string;
  scheme: 'dark' | 'light';
  contrast: 'normal' | 'high';
  /** The track palette "Theme colours" resolves to. */
  palette: PaletteId;
  ui: UiTheme;
  canvas: CanvasTheme;
};

const triplet = (h: number, s: number, l: number) => rgbTriplet(formatHsl({ h, s, l }));
const rgbOf = (h: number, s: number, l: number): [number, number, number] =>
  triplet(h, s, l).split(',').map(Number) as [number, number, number];

/** The original look, lifted value for value from before themes existed. */
const MIDNIGHT: Theme = {
  id: 'midnight',
  name: 'Midnight',
  scheme: 'dark',
  contrast: 'normal',
  palette: 'vivid',
  ui: {
    bg: '#0b0d12',
    panel: '#12151d',
    raised: '#1a1d24',
    border: 'rgba(255, 255, 255, 0.08)',
    borderStrong: 'rgba(255, 255, 255, 0.22)',
    text: 'rgba(255, 255, 255, 0.88)',
    muted: 'rgba(255, 255, 255, 0.5)',
    accent: '#ff5a5f',
    onAccent: '#fff',
    warn: '#ffb86b',
    control: 'rgba(255, 255, 255, 0.07)',
    controlHover: 'rgba(255, 255, 255, 0.12)',
    controlActive: 'rgba(255, 255, 255, 0.18)',
    wash: 'rgba(255, 255, 255, 0.05)',
    washHover: 'rgba(255, 255, 255, 0.08)',
    field: 'rgba(0, 0, 0, 0.35)',
    overlay: 'rgba(0, 0, 0, 0.6)',
    shadow: '0 12px 30px rgba(0, 0, 0, 0.45)',
    textShadow: '0 1px 3px rgba(0, 0, 0, 0.8)',
  },
  canvas: {
    blend: 'lighter',
    arrangeBg: '#0b0d12',
    laneBg: '#12151d',
    rulerBg: '#0e1117',
    gridMajor: 'rgba(255,255,255,0.14)',
    gridMinor: 'rgba(255,255,255,0.05)',
    rulerText: 'rgba(255,255,255,0.55)',
    regionText: 'rgba(255,255,255,0.7)',
    labelBg: 'rgba(8,10,15,0.92)',
    laneText: 'rgba(255,255,255,0.72)',
    laneTextMuted: 'rgba(255,255,255,0.35)',
    laneDivider: 'rgba(255,255,255,0.08)',
    playhead: '#ff5a5f',
    muted: 'hsl(220 8% 52%)',
    rollBg: '#04050a',
    rollWash: ['rgba(40,30,90,0.08)', 'rgba(30,60,120,0.2)'],
    blackKeyRow: 'rgba(0,0,0,0.28)',
    octaveLine: 'rgba(255,255,255,0.05)',
    whiteKey: 'rgba(255,255,255,0.09)',
    blackKey: 'rgba(255,255,255,0.03)',
    keyDivider: 'rgba(255,255,255,0.06)',
    bounceCentre: 'rgba(255,255,255,0.04)',
    vignette: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.55)'],
    barMinor: 'rgba(255,255,255,0.035)',
    barMajor: 'rgba(150,180,255,0.09)',
    bounce: ['rgba(120,140,200,0.14)', 'rgba(150,170,230,0.32)', 'rgba(190,215,255,0.95)', 'rgba(120,160,255,0.55)'],
    playheadBand: ['rgba(255,255,255,0)', 'rgba(210,225,255,0.3)'],
    playheadLine: 'rgba(255,255,255,0.92)',
    spriteCore: 'rgba(255,255,255,0.95)',
    spectrum: {
      left: '170,205,255',
      right: '255,190,215',
      pitch: ['rgba(210,225,255,0.3)', 'rgba(170,195,255,0.12)', 'rgba(150,180,255,0)'],
      trailQuiet: [90, 150, 255],
      trailLoud: [255, 255, 255],
    },
  },
};

type Spec = {
  id: ThemeId;
  name: string;
  /** Hue and saturation of the grounds. */
  hue: number;
  sat: number;
  accent: string;
  onAccent?: string;
  palette: PaletteId;
  /** Hues of the roll's wash, top and bottom; default both `hue`. */
  wash?: [number, number];
  /** Spectrum channel hues, left and right. */
  spectrum?: [number, number];
};

/** A dark theme tinted toward `hue`, built to the same proportions as Midnight. */
function dark(spec: Spec): Theme {
  const { hue: h, sat: s } = spec;
  const [washTop, washBottom] = spec.wash ?? [h, h];
  const [left, right] = spec.spectrum ?? [h - 10, h + 120];
  const bg = `hsl(${h} ${s}% 6%)`;
  const panel = `hsl(${h} ${s}% 9.5%)`;
  return {
    id: spec.id,
    name: spec.name,
    scheme: 'dark',
    contrast: 'normal',
    palette: spec.palette,
    ui: {
      ...MIDNIGHT.ui,
      bg,
      panel,
      raised: `hsl(${h} ${s}% 13%)`,
      text: `hsl(${h} 40% 97% / 0.88)`,
      muted: `hsl(${h} 25% 92% / 0.52)`,
      accent: spec.accent,
      onAccent: spec.onAccent ?? '#fff',
    },
    canvas: {
      ...MIDNIGHT.canvas,
      arrangeBg: bg,
      laneBg: panel,
      rulerBg: `hsl(${h} ${s}% 7.5%)`,
      gridMajor: `hsl(${h} 40% 90% / 0.14)`,
      gridMinor: `hsl(${h} 40% 90% / 0.05)`,
      rulerText: `hsl(${h} 30% 95% / 0.55)`,
      labelBg: `hsl(${h} ${s}% 4% / 0.92)`,
      laneText: `hsl(${h} 30% 97% / 0.72)`,
      laneTextMuted: `hsl(${h} 30% 97% / 0.35)`,
      playhead: spec.accent,
      muted: `hsl(${h} 8% 52%)`,
      rollBg: `hsl(${h} ${s}% 3%)`,
      rollWash: [`hsl(${washTop} 50% 24% / 0.08)`, `hsl(${washBottom} 60% 30% / 0.2)`],
      barMajor: `hsl(${h} 70% 80% / 0.09)`,
      bounce: [
        `hsl(${h} 40% 63% / 0.14)`,
        `hsl(${h} 55% 75% / 0.32)`,
        `hsl(${h} 90% 87% / 0.95)`,
        `hsl(${h} 100% 73% / 0.55)`,
      ],
      playheadBand: ['rgba(255,255,255,0)', `hsl(${h} 70% 90% / 0.3)`],
      spectrum: {
        left: triplet(left, 100, 83),
        right: triplet(right, 100, 87),
        pitch: [`hsl(${h} 70% 90% / 0.3)`, `hsl(${h} 80% 83% / 0.12)`, `hsl(${h} 90% 79% / 0)`],
        trailQuiet: rgbOf(h, 100, 68),
        trailLoud: [255, 255, 255],
      },
    },
  };
}

/** A light theme tinted toward `hue`: ink on paper, blending by multiply. */
function light(spec: Spec): Theme {
  const { hue: h, sat: s } = spec;
  const ink = (alpha: number) => `hsl(${h} 30% 12% / ${alpha})`;
  const [washTop, washBottom] = spec.wash ?? [h, h];
  const [left, right] = spec.spectrum ?? [h - 10, h + 120];
  return {
    id: spec.id,
    name: spec.name,
    scheme: 'light',
    contrast: 'normal',
    palette: spec.palette,
    ui: {
      bg: `hsl(${h} ${s}% 96%)`,
      panel: `hsl(${h} ${s}% 98.5%)`,
      raised: '#ffffff',
      border: ink(0.12),
      borderStrong: ink(0.3),
      text: `hsl(${h} 30% 10% / 0.9)`,
      muted: `hsl(${h} 20% 12% / 0.6)`,
      accent: spec.accent,
      onAccent: spec.onAccent ?? '#fff',
      warn: '#a85a00',
      control: ink(0.05),
      controlHover: ink(0.09),
      controlActive: ink(0.15),
      wash: ink(0.04),
      washHover: ink(0.08),
      field: 'rgba(255, 255, 255, 0.75)',
      overlay: 'rgba(255, 255, 255, 0.82)',
      shadow: `0 12px 30px ${ink(0.18)}`,
      textShadow: '0 1px 2px rgba(255, 255, 255, 0.7)',
    },
    canvas: {
      blend: 'multiply',
      arrangeBg: `hsl(${h} ${s}% 94%)`,
      laneBg: `hsl(${h} ${s}% 98.5%)`,
      rulerBg: `hsl(${h} ${s}% 91%)`,
      gridMajor: ink(0.16),
      gridMinor: ink(0.06),
      rulerText: ink(0.6),
      regionText: ink(0.8),
      labelBg: `hsl(${h} ${s}% 96% / 0.94)`,
      laneText: ink(0.82),
      laneTextMuted: ink(0.4),
      laneDivider: ink(0.12),
      playhead: spec.accent,
      muted: `hsl(${h} 8% 64%)`,
      rollBg: `hsl(${h} ${s}% 97.5%)`,
      rollWash: [`hsl(${washTop} 60% 60% / 0.04)`, `hsl(${washBottom} 60% 55% / 0.1)`],
      blackKeyRow: ink(0.045),
      octaveLine: ink(0.08),
      whiteKey: ink(0.04),
      blackKey: ink(0.28),
      keyDivider: ink(0.12),
      bounceCentre: ink(0.08),
      vignette: [`hsl(${h} 30% 30% / 0)`, `hsl(${h} 30% 30% / 0.1)`],
      barMinor: ink(0.05),
      barMajor: `hsl(${h} 50% 40% / 0.12)`,
      bounce: [
        `hsl(${h} 35% 45% / 0.16)`,
        `hsl(${h} 40% 45% / 0.3)`,
        `hsl(${h} 60% 35% / 0.9)`,
        `hsl(${h} 60% 45% / 0.5)`,
      ],
      playheadBand: [`hsl(${h} 50% 50% / 0)`, `hsl(${h} 50% 50% / 0.22)`],
      playheadLine: ink(0.85),
      spriteCore: null,
      spectrum: {
        left: triplet(left, 70, 45),
        right: triplet(right, 65, 50),
        pitch: [`hsl(${h} 50% 45% / 0.3)`, `hsl(${h} 50% 45% / 0.12)`, `hsl(${h} 50% 45% / 0)`],
        trailQuiet: rgbOf(h, 70, 60),
        trailLoud: rgbOf(h, 60, 22),
      },
    },
  };
}

const DAYLIGHT = light({ id: 'daylight', name: 'Daylight', hue: 225, sat: 20, accent: '#e5484d', palette: 'vivid' });

/** Pure black, white text, a yellow playhead and no decorative washes. */
const CONTRAST_DARK: Theme = (() => {
  const base = dark({ id: 'contrast-dark', name: 'High Contrast Dark', hue: 0, sat: 0, accent: '#ffd400', onAccent: '#000', palette: 'contrast' });
  return {
    ...base,
    contrast: 'high',
    ui: {
      ...base.ui,
      bg: '#000000',
      panel: '#0a0a0a',
      raised: '#141414',
      border: 'rgba(255, 255, 255, 0.45)',
      borderStrong: 'rgba(255, 255, 255, 0.8)',
      text: '#ffffff',
      muted: 'rgba(255, 255, 255, 0.8)',
      warn: '#ffb000',
      control: 'rgba(255, 255, 255, 0.12)',
      controlHover: 'rgba(255, 255, 255, 0.22)',
      controlActive: 'rgba(255, 255, 255, 0.34)',
      textShadow: '0 1px 2px #000, 0 0 4px #000',
    },
    canvas: {
      ...base.canvas,
      arrangeBg: '#000000',
      laneBg: '#0c0c0c',
      rulerBg: '#000000',
      gridMajor: 'rgba(255,255,255,0.4)',
      gridMinor: 'rgba(255,255,255,0.15)',
      rulerText: '#ffffff',
      regionText: '#ffffff',
      labelBg: 'rgba(0,0,0,0.96)',
      laneText: '#ffffff',
      laneTextMuted: 'rgba(255,255,255,0.6)',
      laneDivider: 'rgba(255,255,255,0.45)',
      muted: 'hsl(0 0% 55%)',
      rollBg: '#101010',
      rollWash: ['rgba(0,0,0,0)', 'rgba(0,0,0,0)'],
      blackKeyRow: 'rgba(0,0,0,0.8)',
      octaveLine: 'rgba(255,255,255,0.3)',
      whiteKey: 'rgba(255,255,255,0.65)',
      blackKey: 'rgba(255,255,255,0.15)',
      keyDivider: 'rgba(255,255,255,0.4)',
      bounceCentre: 'rgba(255,255,255,0.2)',
      vignette: ['rgba(0,0,0,0)', 'rgba(0,0,0,0)'],
      barMinor: 'rgba(255,255,255,0.12)',
      barMajor: 'rgba(255,255,255,0.32)',
      bounce: ['rgba(255,255,255,0.3)', 'rgba(255,255,255,0.45)', 'rgba(255,255,255,1)', 'rgba(255,255,255,0.8)'],
      playheadBand: ['rgba(255,212,0,0)', 'rgba(255,212,0,0.2)'],
      playheadLine: '#ffd400',
    },
  };
})();

const CONTRAST_LIGHT: Theme = (() => {
  const base = light({ id: 'contrast-light', name: 'High Contrast Light', hue: 0, sat: 0, accent: '#0033cc', palette: 'contrast' });
  return {
    ...base,
    contrast: 'high',
    ui: {
      ...base.ui,
      bg: '#ffffff',
      panel: '#ffffff',
      border: 'rgba(0, 0, 0, 0.55)',
      borderStrong: 'rgba(0, 0, 0, 0.85)',
      text: '#000000',
      muted: 'rgba(0, 0, 0, 0.78)',
      warn: '#8a3f00',
      control: 'rgba(0, 0, 0, 0.06)',
      controlHover: 'rgba(0, 0, 0, 0.14)',
      controlActive: 'rgba(0, 0, 0, 0.24)',
      field: '#ffffff',
      overlay: 'rgba(255, 255, 255, 0.95)',
      textShadow: '0 0 3px #fff, 0 0 3px #fff',
    },
    canvas: {
      ...base.canvas,
      arrangeBg: '#ffffff',
      laneBg: '#ffffff',
      rulerBg: '#f0f0f0',
      gridMajor: 'rgba(0,0,0,0.45)',
      gridMinor: 'rgba(0,0,0,0.16)',
      rulerText: '#000000',
      regionText: '#000000',
      labelBg: 'rgba(255,255,255,0.97)',
      laneText: '#000000',
      laneTextMuted: 'rgba(0,0,0,0.55)',
      laneDivider: 'rgba(0,0,0,0.5)',
      playhead: '#d0002a',
      muted: 'hsl(0 0% 58%)',
      rollBg: '#ffffff',
      rollWash: ['rgba(0,0,0,0)', 'rgba(0,0,0,0)'],
      blackKeyRow: 'rgba(0,0,0,0.07)',
      octaveLine: 'rgba(0,0,0,0.3)',
      whiteKey: 'rgba(0,0,0,0.03)',
      blackKey: 'rgba(0,0,0,0.75)',
      keyDivider: 'rgba(0,0,0,0.5)',
      bounceCentre: 'rgba(0,0,0,0.25)',
      vignette: ['rgba(0,0,0,0)', 'rgba(0,0,0,0)'],
      barMinor: 'rgba(0,0,0,0.12)',
      barMajor: 'rgba(0,0,0,0.35)',
      bounce: ['rgba(0,0,0,0.25)', 'rgba(0,0,0,0.4)', 'rgba(0,0,0,0.95)', 'rgba(0,0,0,0.7)'],
      playheadBand: ['rgba(208,0,42,0)', 'rgba(208,0,42,0.15)'],
      playheadLine: '#d0002a',
    },
  };
})();

export const THEMES: readonly Theme[] = [
  MIDNIGHT,
  DAYLIGHT,
  CONTRAST_DARK,
  CONTRAST_LIGHT,
  // Strawberry milk: soft pink paper, rose accent.
  light({ id: 'strawberry', name: 'Strawberry', hue: 345, sat: 45, accent: '#e0457b', palette: 'strawberry', wash: [340, 10], spectrum: [340, 150] }),
  light({ id: 'peach', name: 'Peach', hue: 25, sat: 55, accent: '#e8702f', palette: 'peach', wash: [30, 10], spectrum: [20, 200] }),
  dark({ id: 'blueberry', name: 'Blueberry', hue: 232, sat: 35, accent: '#8a98ff', palette: 'blueberry', wash: [255, 225], spectrum: [215, 300] }),
  dark({ id: 'matcha', name: 'Matcha', hue: 100, sat: 18, accent: '#a5d46a', onAccent: '#11160b', palette: 'matcha', wash: [90, 150], spectrum: [95, 40] }),
  dark({ id: 'lavender', name: 'Lavender', hue: 268, sat: 28, accent: '#c4a8ff', onAccent: '#1a1026', palette: 'lavender', wash: [280, 240], spectrum: [255, 320] }),
];

export const DEFAULT_THEME_ID: ThemeId = 'midnight';

export function themeById(id: string): Theme {
  return THEMES.find((theme) => theme.id === id) ?? MIDNIGHT;
}

/** The high-contrast theme for a colour scheme. */
export function contrastThemeFor(scheme: 'dark' | 'light'): Theme {
  return scheme === 'dark' ? CONTRAST_DARK : CONTRAST_LIGHT;
}

/** CSS custom property per UI token: `controlHover` -> `--control-hover`. */
export function uiCssVariables(ui: UiTheme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(ui)) {
    vars[`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = value;
  }
  return vars;
}

/** What the renderers draw with before App hands them a theme. */
export const DEFAULT_CANVAS_THEME: CanvasTheme = MIDNIGHT.canvas;
