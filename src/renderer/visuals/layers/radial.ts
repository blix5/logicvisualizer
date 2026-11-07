// Circles: a radial spectrum ring, rings bursting on hits, and ripples where
// notes meet the playhead.
import { paletteFor } from '../palette';
import type { LayerInstance } from '../types';
import { BandReader, num } from './util';

// ---- radial spectrum ring --------------------------------------------------

export function radialRingLayer(): LayerInstance {
  let readers: { left: BandReader; right: BandReader; both: BandReader } | null = null;
  let leftLevels = new Float32Array(0);
  let rightLevels = new Float32Array(0);
  let angle = 0;
  let punch = 0;
  let lastKicks = 0;
  return {
    reset() { angle = 0; punch = 0; },
    get animating() { return punch > 0.01; },
    draw(ctx, frame, layer) {
      const { features } = frame;
      const half = Math.max(8, Math.round(num(layer, 'bars', 96) / 2));
      if (!readers || readers.both.count !== half) {
        readers = { left: new BandReader(half), right: new BandReader(half), both: new BandReader(half) };
        leftLevels = new Float32Array(half);
        rightLevels = new Float32Array(half);
      }
      const both = readers.both.read(features, frame.dt, 0.6, 0.18);
      readers.left.readChannel(features.left, features, leftLevels);
      readers.right.readChannel(features.right, features, rightLevels);
      // Each channel gets the smoothed shape scaled by its own share, so the
      // halves differ where the mix is wide without flickering.
      if (features.kicks !== lastKicks) {
        lastKicks = features.kicks;
        punch = Math.max(punch, features.onset);
      }
      punch *= Math.exp(-frame.dt * 7);
      angle += frame.dt * num(layer, 'spin', 0.25) * (0.4 + features.level * 2);

      const minDim = Math.min(frame.width, frame.height - frame.top);
      const intensity = layer.intensity;
      const radius = num(layer, 'radius', 0.2) * minDim * (1 + punch * 0.18 * intensity);
      const reach = minDim * 0.28 * intensity;
      const cx = frame.centreX;
      const cy = frame.centreY;
      const palette = paletteFor(frame.theme);
      const step = Math.PI / half;
      const barWidth = Math.max(1.5, ((2 * Math.PI * radius) / (half * 2)) * 0.55);

      ctx.globalCompositeOperation = frame.theme.blend;
      ctx.lineCap = 'round';
      for (let side = 0; side < 2; side += 1) {
        const channel = side === 0 ? leftLevels : rightLevels;
        ctx.beginPath();
        for (let i = 0; i < half; i += 1) {
          const shape = both[i]!;
          const own = features.valid ? channel[i]! : shape;
          const level = Math.min(1, shape * 0.6 + own * 0.4);
          const length = 2 + level ** 1.6 * reach;
          // Left runs clockwise from the top, right counter-clockwise: mirrored.
          const a = angle - Math.PI / 2 + (side === 0 ? 1 : -1) * (i + 0.5) * step;
          const cos = Math.cos(a);
          const sin = Math.sin(a);
          ctx.moveTo(cx + cos * radius, cy + sin * radius);
          ctx.lineTo(cx + cos * (radius + length), cy + sin * (radius + length));
        }
        const rgb = side === 0 ? palette.left : palette.right;
        // Glow, then core.
        ctx.globalAlpha = layer.opacity * 0.25;
        ctx.lineWidth = barWidth * 2.6;
        ctx.strokeStyle = `rgb(${rgb})`;
        ctx.stroke();
        ctx.globalAlpha = layer.opacity * 0.9;
        ctx.lineWidth = barWidth;
        ctx.stroke();
      }
      // The inner circle flares on hits.
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2, radius - 6), 0, Math.PI * 2);
      ctx.globalAlpha = layer.opacity * (0.25 + punch * 0.7);
      ctx.lineWidth = 1.5 + punch * 6 * intensity;
      ctx.strokeStyle = `rgb(${palette.accent})`;
      ctx.stroke();
    },
  };
}

// ---- kick rings ------------------------------------------------------------

const MAX_RINGS = 24;

export function kickRingsLayer(): LayerInstance {
  const born = new Float64Array(MAX_RINGS);
  const strength = new Float32Array(MAX_RINGS);
  const hue = new Uint8Array(MAX_RINGS);
  let count = 0;
  let next = 0;
  let lastKicks = -1;
  return {
    reset() { count = 0; },
    get animating() { return count > 0; },
    draw(ctx, frame, layer) {
      const { features } = frame;
      if (lastKicks < 0) lastKicks = features.kicks;
      if (features.kicks !== lastKicks) {
        lastKicks = features.kicks;
        born[next] = frame.now;
        strength[next] = Math.max(0.3, features.onset);
        hue[next] = next % 3;
        next = (next + 1) % MAX_RINGS;
        count = Math.min(MAX_RINGS, count + 1);
      }
      const speed = num(layer, 'speed', 1);
      const life = 1.4 / speed;
      const maxRadius = Math.hypot(frame.width, frame.height) * 0.6;
      const thickness = num(layer, 'width', 6);
      const palette = paletteFor(frame.theme);
      const colors = [palette.accent, palette.left, palette.right];
      ctx.globalCompositeOperation = frame.theme.blend;
      let live = 0;
      for (let i = 0; i < MAX_RINGS; i += 1) {
        if (strength[i]! <= 0) continue;
        const age = (frame.now - born[i]!) / 1000;
        if (age >= life) { strength[i] = 0; continue; }
        live += 1;
        const t = age / life;
        // Fast out, easing as it spreads.
        const r = 20 + (1 - (1 - t) ** 3) * maxRadius;
        const fade = (1 - t) ** 2 * strength[i]!;
        ctx.beginPath();
        ctx.arc(frame.centreX, frame.centreY, r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgb(${colors[hue[i]!]})`;
        ctx.globalAlpha = layer.opacity * fade * 0.3;
        ctx.lineWidth = (thickness * 3 * (1 - t) + 2) * layer.intensity;
        ctx.stroke();
        ctx.globalAlpha = layer.opacity * fade;
        ctx.lineWidth = Math.max(1, thickness * (1 - t) * layer.intensity);
        ctx.stroke();
      }
      count = live;
    },
  };
}

// ---- note ripples ----------------------------------------------------------

const MAX_RIPPLES = 192;

export function noteRipplesLayer(): LayerInstance {
  const x = new Float32Array(MAX_RIPPLES);
  const y = new Float32Array(MAX_RIPPLES);
  const born = new Float64Array(MAX_RIPPLES);
  const strength = new Float32Array(MAX_RIPPLES);
  const drift = new Float32Array(MAX_RIPPLES);
  const color: string[] = new Array<string>(MAX_RIPPLES).fill('');
  let next = 0;
  let live = 0;
  return {
    reset() { strength.fill(0); live = 0; },
    get animating() { return live > 0; },
    draw(ctx, frame, layer) {
      const { hits } = frame;
      for (let i = 0; i < hits.count; i += 1) {
        x[next] = hits.x[i]!;
        y[next] = hits.y[i]!;
        born[next] = frame.now;
        strength[next] = 0.35 + hits.strength[i]! * 0.65;
        // Ripples drift left with the timeline, as the note that made them does.
        drift[next] = Math.min(600, hits.pixelsPerSecond);
        color[next] = hits.color[i]!;
        next = (next + 1) % MAX_RIPPLES;
      }
      const life = num(layer, 'life', 0.9);
      const size = num(layer, 'size', 90) * layer.intensity;
      ctx.globalCompositeOperation = frame.theme.blend;
      live = 0;
      for (let i = 0; i < MAX_RIPPLES; i += 1) {
        if (strength[i]! <= 0) continue;
        const age = (frame.now - born[i]!) / 1000;
        if (age >= life) { strength[i] = 0; continue; }
        live += 1;
        const t = age / life;
        const cx = x[i]! - drift[i]! * age;
        const s = strength[i]!;
        const eased = 1 - (1 - t) ** 3;
        ctx.strokeStyle = color[i]!;
        ctx.globalAlpha = layer.opacity * (1 - t) ** 1.5 * s;
        ctx.lineWidth = 1 + 3 * (1 - t) * layer.intensity;
        ctx.beginPath();
        ctx.arc(cx, y[i]!, 3 + eased * size * s, 0, Math.PI * 2);
        ctx.stroke();
        // A second, later ring, for depth.
        if (t > 0.18) {
          const t2 = (t - 0.18) / 0.82;
          ctx.globalAlpha = layer.opacity * (1 - t2) ** 2 * s * 0.6;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(cx, y[i]!, 2 + (1 - (1 - t2) ** 3) * size * s * 0.6, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    },
  };
}
