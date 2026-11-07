// Dots: a dot-matrix EQ, a warping starfield, and drifting bokeh orbs.
import { paletteFor } from '../palette';
import type { CanvasTheme } from '../../theme/themes';
import type { LayerInstance } from '../types';
import { BandReader, bool, mixTriplet, num } from './util';

// ---- dot-matrix EQ ---------------------------------------------------------

export function dotMatrixLayer(): LayerInstance {
  let reader: BandReader | null = null;
  let peaks = new Float32Array(0);
  let colorKey = '';
  let colors: string[] = [];
  return {
    reset() { peaks.fill(0); },
    get animating() { return false; },
    draw(ctx, frame, layer) {
      const columns = Math.round(num(layer, 'columns', 40));
      const rows = Math.round(num(layer, 'rows', 16));
      const mirror = bool(layer, 'mirror', true);
      if (!reader || reader.count !== columns) {
        reader = new BandReader(columns, 40, 14000);
        peaks = new Float32Array(columns);
      }
      const levels = reader.read(frame.features, frame.dt, 0.7, 0.2);
      const palette = paletteFor(frame.theme);
      const key = `${columns}|${palette.left}|${palette.right}|${palette.accent}`;
      if (key !== colorKey) {
        colorKey = key;
        colors = Array.from({ length: columns }, (_, c) => {
          const t = c / Math.max(1, columns - 1);
          return `rgb(${t < 0.5 ? mixTriplet(palette.left, palette.accent, t * 2) : mixTriplet(palette.accent, palette.right, (t - 0.5) * 2)})`;
        });
      }

      const left = frame.roll?.keyWidth ?? 0;
      const top = frame.top;
      const cellW = (frame.width - left) / columns;
      const cellH = (frame.height - top) / rows;
      const cell = Math.min(cellW, cellH);
      const baseR = Math.max(0.8, cell * 0.12);
      const litR = cell * 0.36 * Math.min(1.4, layer.intensity);
      const fall = frame.dt * 0.6;
      ctx.globalCompositeOperation = frame.theme.blend;

      // Unlit grid, faint, in one path.
      ctx.beginPath();
      for (let c = 0; c < columns; c += 1) {
        const x = left + (c + 0.5) * cellW;
        for (let r = 0; r < rows; r += 1) {
          const y = top + (r + 0.5) * cellH;
          ctx.moveTo(x + baseR, y);
          ctx.arc(x, y, baseR, 0, Math.PI * 2);
        }
      }
      ctx.globalAlpha = layer.opacity * 0.12;
      ctx.fillStyle = `rgb(${palette.left})`;
      ctx.fill();

      for (let c = 0; c < columns; c += 1) {
        const level = Math.min(1, levels[c]! * (0.7 + 0.5 * layer.intensity));
        peaks[c] = Math.max(level, peaks[c]! - fall);
        const x = left + (c + 0.5) * cellW;
        const lit = mirror ? level * rows / 2 : level * rows;
        ctx.beginPath();
        for (let n = 0; n < Math.ceil(lit); n += 1) {
          // The partly lit top dot swells in rather than popping.
          const share = Math.min(1, lit - n);
          const r = baseR + (litR - baseR) * share * (0.55 + 0.45 * level);
          const ys = mirror
            ? [top + (rows / 2 - n - 0.5) * cellH, top + (rows / 2 + n + 0.5) * cellH]
            : [top + (rows - n - 0.5) * cellH];
          for (const y of ys) {
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
          }
        }
        ctx.fillStyle = colors[c]!;
        ctx.globalAlpha = layer.opacity * (0.55 + level * 0.45);
        ctx.fill();
        // Peak dot.
        const peakRow = Math.min(mirror ? rows / 2 - 1 : rows - 1, Math.floor(peaks[c]! * (mirror ? rows / 2 : rows)));
        if (peaks[c]! > 0.05) {
          const py = mirror ? top + (rows / 2 - peakRow - 0.5) * cellH : top + (rows - peakRow - 0.5) * cellH;
          ctx.beginPath();
          ctx.arc(x, py, baseR * 1.6, 0, Math.PI * 2);
          ctx.globalAlpha = layer.opacity * 0.9;
          ctx.fill();
        }
      }
    },
  };
}

// ---- starfield warp ----------------------------------------------------------

const MAX_STARS = 1200;

export function starfieldLayer(): LayerInstance {
  // Polar, around the centre: direction, distance (0..1 of the half-diagonal),
  // and each star's own speed.
  const angle = new Float32Array(MAX_STARS);
  const dist = new Float32Array(MAX_STARS);
  const speed = new Float32Array(MAX_STARS);
  const tint = new Uint8Array(MAX_STARS);
  let seeded = false;
  let boost = 0;
  let lastKicks = -1;
  const spawn = (i: number, anywhere: boolean) => {
    angle[i] = Math.random() * Math.PI * 2;
    dist[i] = anywhere ? Math.random() : 0.01 + Math.random() * 0.06;
    speed[i] = 0.4 + Math.random() * 0.9;
    tint[i] = Math.floor(Math.random() * 3);
  };
  const paths = [new Path2D(), new Path2D(), new Path2D()];
  return {
    reset() { seeded = false; boost = 0; },
    get animating() { return boost > 0.02; },
    draw(ctx, frame, layer) {
      if (!seeded) {
        for (let i = 0; i < MAX_STARS; i += 1) spawn(i, true);
        seeded = true;
      }
      const { features } = frame;
      if (lastKicks < 0) lastKicks = features.kicks;
      if (features.kicks !== lastKicks) {
        lastKicks = features.kicks;
        boost = Math.min(3, boost + features.onset * 2.5);
      }
      boost *= Math.exp(-frame.dt * 3);
      const count = Math.min(MAX_STARS, Math.round(num(layer, 'count', 420)));
      const base = num(layer, 'speed', 1) * (0.05 + features.level * 0.9 + boost) * layer.intensity;
      const cx = frame.centreX;
      const cy = frame.centreY;
      const halfDiag = Math.hypot(frame.width, frame.height) / 2;
      for (let p = 0; p < 3; p += 1) paths[p] = new Path2D();
      for (let i = 0; i < count; i += 1) {
        const before = dist[i]!;
        // Exponential: slow near the centre, streaking at the edges.
        const after = before + (before + 0.02) * speed[i]! * base * frame.dt * 2.2;
        dist[i] = after;
        if (after > 1.05) { spawn(i, false); continue; }
        const cos = Math.cos(angle[i]!);
        const sin = Math.sin(angle[i]!);
        const r0 = before * halfDiag;
        const r1 = Math.max(r0 + 0.8, after * halfDiag);
        const path = paths[tint[i]!]!;
        path.moveTo(cx + cos * r0, cy + sin * r0);
        path.lineTo(cx + cos * r1, cy + sin * r1);
      }
      const palette = paletteFor(frame.theme);
      const tints = [palette.left, palette.right, palette.accent];
      ctx.globalCompositeOperation = frame.theme.blend;
      ctx.lineCap = 'round';
      ctx.lineWidth = 1.4 + features.level * 1.2;
      for (let p = 0; p < 3; p += 1) {
        ctx.strokeStyle = `rgb(${tints[p]})`;
        ctx.globalAlpha = layer.opacity * (0.5 + Math.min(0.5, features.level + boost * 0.2));
        ctx.stroke(paths[p]!);
      }
    },
  };
}

// ---- bokeh orbs --------------------------------------------------------------

const MAX_ORBS = 60;
const ORB_SPRITE = 128;

function orbSprite(rgb: string, light: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ORB_SPRITE;
  canvas.height = ORB_SPRITE;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const r = ORB_SPRITE / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    // A lens's bokeh: a flat disc with a slightly brighter rim and a soft edge.
    g.addColorStop(0, `rgba(${rgb},${light ? 0.35 : 0.45})`);
    g.addColorStop(0.72, `rgba(${rgb},${light ? 0.4 : 0.55})`);
    g.addColorStop(0.86, `rgba(${rgb},${light ? 0.55 : 0.8})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, ORB_SPRITE, ORB_SPRITE);
  }
  return canvas;
}

export function bokehLayer(): LayerInstance {
  const x = new Float32Array(MAX_ORBS);
  const y = new Float32Array(MAX_ORBS);
  const vx = new Float32Array(MAX_ORBS);
  const vy = new Float32Array(MAX_ORBS);
  const size = new Float32Array(MAX_ORBS);
  const band = new Uint8Array(MAX_ORBS);
  const tint = new Uint8Array(MAX_ORBS);
  const phase = new Float32Array(MAX_ORBS);
  let sprites: HTMLCanvasElement[] = [];
  let theme: CanvasTheme | null = null;
  for (let i = 0; i < MAX_ORBS; i += 1) {
    x[i] = Math.random();
    y[i] = Math.random();
    const a = Math.random() * Math.PI * 2;
    const s = 0.01 + Math.random() * 0.03;
    vx[i] = Math.cos(a) * s;
    vy[i] = Math.sin(a) * s;
    size[i] = 0.4 + Math.random() * 0.6;
    band[i] = Math.floor(Math.random() * 3);
    tint[i] = Math.floor(Math.random() * 3);
    phase[i] = Math.random() * Math.PI * 2;
  }
  return {
    get animating() { return false; },
    draw(ctx, frame, layer) {
      if (theme !== frame.theme) {
        theme = frame.theme;
        const palette = paletteFor(theme);
        sprites = [palette.left, palette.right, palette.accent].map((rgb) => orbSprite(rgb, palette.light));
      }
      const { features } = frame;
      const count = Math.min(MAX_ORBS, Math.round(num(layer, 'count', 22)));
      const base = num(layer, 'size', 90);
      const move = frame.dt * (0.3 + features.level * 2.5);
      const top = frame.top;
      const h = frame.height - top;
      ctx.globalCompositeOperation = frame.theme.blend;
      for (let i = 0; i < count; i += 1) {
        x[i] = (x[i]! + vx[i]! * move + 1.2) % 1.2;
        y[i] = (y[i]! + vy[i]! * move + 1.2) % 1.2;
        phase[i] = phase[i]! + frame.dt * 0.7;
        const swell = 1 + features.bands[band[i]!]! * 1.6 * layer.intensity + features.onset * 0.25;
        const r = base * size[i]! * swell * (0.92 + 0.08 * Math.sin(phase[i]!));
        const px = (x[i]! - 0.1) * frame.width;
        const py = top + (y[i]! - 0.1) * h;
        ctx.globalAlpha = layer.opacity * Math.min(1, 0.35 + features.level * 0.9) * (0.6 + 0.4 * size[i]!);
        ctx.drawImage(sprites[tint[i]!]!, px - r, py - r, r * 2, r * 2);
      }
    },
  };
}
