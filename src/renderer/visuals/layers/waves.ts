// Waves: an oscilloscope, a Lissajous goniometer, and flowing sine ribbons.
import { paletteFor } from '../palette';
import type { LayerInstance, VisualFrame } from '../types';
import { num, str } from './util';

/** Samples drawn across the view; the rest of the analyser window is trigger room. */
const SCOPE_SAMPLES = 2048;

/**
 * First rising zero crossing in the first half of the window, so a steady tone
 * stands still on screen instead of sliding.
 */
function trigger(wave: Float32Array): number {
  const limit = Math.max(1, wave.length - SCOPE_SAMPLES);
  for (let i = 1; i < limit; i += 1) if (wave[i - 1]! < 0 && wave[i]! >= 0) return i;
  return 0;
}

// ---- oscilloscope ------------------------------------------------------------

export function oscilloscopeLayer(): LayerInstance {
  return {
    draw(ctx, frame, layer) {
      const { features } = frame;
      if (!features.hasWave) return;
      const palette = paletteFor(frame.theme);
      const left = frame.roll?.keyWidth ?? 0;
      const width = frame.width - left;
      const amplitude = (frame.height - frame.top) * 0.22 * num(layer, 'gain', 2) * layer.intensity;
      const mid = str(layer, 'mode', 'stereo') === 'mid';
      const traces = mid
        ? [{ wave: null, rgb: palette.accent }]
        : [{ wave: features.waveLeft, rgb: palette.left }, { wave: features.waveRight, rgb: palette.right }];
      const start = trigger(features.waveLeft);
      const count = Math.min(SCOPE_SAMPLES, features.waveLeft.length - start);
      const step = Math.max(1, Math.floor(count / Math.max(1, width)));
      ctx.globalCompositeOperation = frame.theme.blend;
      ctx.lineJoin = 'round';
      for (const trace of traces) {
        ctx.beginPath();
        for (let i = 0; i < count; i += step) {
          const s = trace.wave
            ? trace.wave[start + i]!
            : (features.waveLeft[start + i]! + features.waveRight[start + i]!) * 0.5;
          const x = left + (i / count) * width;
          const y = frame.centreY - Math.max(-1, Math.min(1, s)) * amplitude;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgb(${trace.rgb})`;
        ctx.globalAlpha = layer.opacity * 0.18;
        ctx.lineWidth = 7;
        ctx.stroke();
        ctx.globalAlpha = layer.opacity * 0.95;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    },
  };
}

// ---- Lissajous ---------------------------------------------------------------

export function lissajousLayer(): LayerInstance {
  let trail: HTMLCanvasElement | null = null;
  let trailCtx: CanvasRenderingContext2D | null = null;
  let size = 0;
  let energy = 0;
  const ensure = (frame: VisualFrame, px: number) => {
    if (trail && size === px) return;
    size = px;
    trail = trail ?? document.createElement('canvas');
    trail.width = px;
    trail.height = px;
    trailCtx = trail.getContext('2d');
  };
  return {
    reset() { if (trailCtx && trail) trailCtx.clearRect(0, 0, trail.width, trail.height); energy = 0; },
    // The persistence keeps fading after the sound stops.
    get animating() { return energy > 0.01; },
    draw(ctx, frame, layer) {
      const { features } = frame;
      const minDim = Math.min(frame.width, frame.height - frame.top);
      const half = num(layer, 'size', 0.22) * minDim;
      const px = Math.max(16, Math.round(half * 2 * frame.dpr));
      ensure(frame, px);
      if (!trail || !trailCtx) return;
      const t = trailCtx;
      const persistence = num(layer, 'persistence', 0.7);
      // Fade what is there, framerate-independently.
      t.globalCompositeOperation = 'destination-out';
      t.globalAlpha = 1 - persistence ** (frame.dt * 60);
      t.fillStyle = '#000';
      t.fillRect(0, 0, px, px);
      energy *= persistence ** (frame.dt * 60);

      if (features.hasWave) {
        const palette = paletteFor(frame.theme);
        const gain = num(layer, 'gain', 2.2) * layer.intensity;
        const c = px / 2;
        const scale = c * 0.7 * gain;
        const left = features.waveLeft;
        const right = features.waveRight;
        const n = Math.min(left.length, 2048);
        t.globalCompositeOperation = frame.theme.blend === 'lighter' ? 'lighter' : 'source-over';
        t.globalAlpha = 0.85;
        t.lineWidth = 1.2 * frame.dpr;
        t.strokeStyle = `rgb(${palette.accent})`;
        t.beginPath();
        let loud = 0;
        for (let i = 0; i < n; i += 2) {
          const l = left[i]!;
          const r = right[i]!;
          loud = Math.max(loud, Math.abs(l), Math.abs(r));
          // Goniometer orientation: mono is vertical, out-of-phase horizontal.
          const x = c + (l - r) * 0.7071 * scale;
          const y = c - (l + r) * 0.7071 * scale;
          if (i === 0) t.moveTo(x, y);
          else t.lineTo(x, y);
        }
        t.stroke();
        energy = Math.max(energy, loud);
      }

      ctx.globalCompositeOperation = frame.theme.blend;
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(trail, frame.centreX - half, frame.centreY - half, half * 2, half * 2);
    },
  };
}

// ---- sine ribbons ------------------------------------------------------------

export function ribbonsLayer(): LayerInstance {
  const phases = new Float32Array(8);
  let gradient: CanvasGradient | null = null;
  let gradientKey = '';
  return {
    get animating() { return false; },
    draw(ctx, frame, layer) {
      const { features } = frame;
      const palette = paletteFor(frame.theme);
      const count = Math.round(num(layer, 'count', 4));
      const amp = num(layer, 'amplitude', 0.22) * (frame.height - frame.top) * layer.intensity;
      const left = frame.roll?.keyWidth ?? 0;
      const width = frame.width - left;
      const key = `${left}|${width}|${palette.left}|${palette.right}|${palette.accent}`;
      if (key !== gradientKey || !gradient) {
        gradientKey = key;
        gradient = ctx.createLinearGradient(left, 0, frame.width, 0);
        gradient.addColorStop(0, `rgba(${palette.left},0)`);
        gradient.addColorStop(0.15, `rgb(${palette.left})`);
        gradient.addColorStop(0.5, `rgb(${palette.accent})`);
        gradient.addColorStop(0.85, `rgb(${palette.right})`);
        gradient.addColorStop(1, `rgba(${palette.right},0)`);
      }
      ctx.globalCompositeOperation = frame.theme.blend;
      const step = 6;
      for (let k = 0; k < count; k += 1) {
        const band = features.bands[k % 4]!;
        phases[k] = phases[k]! + frame.dt * (0.5 + k * 0.23) * (0.4 + features.level * 2.4);
        const phase = phases[k]!;
        const cycles = 1 + k * 0.55;
        const a = amp * (0.12 + band * 1.1 + features.onset * 0.2);
        const cy = frame.centreY + (k - (count - 1) / 2) * 6;
        const twist = 0.5 + k * 0.17;
        ctx.beginPath();
        for (let x = 0; x <= width; x += step) {
          const u = (x / width) * Math.PI * 2 * cycles;
          // Tapered toward the ends so ribbons dissolve into the edges.
          const env = Math.sin((x / width) * Math.PI);
          const y = cy + Math.sin(u + phase) * a * env;
          if (x === 0) ctx.moveTo(left + x, y);
          else ctx.lineTo(left + x, y);
        }
        for (let x = width; x >= 0; x -= step) {
          const u = (x / width) * Math.PI * 2 * cycles;
          const env = Math.sin((x / width) * Math.PI);
          ctx.lineTo(left + x, cy + Math.sin(u + phase + twist) * a * 0.85 * env);
        }
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.globalAlpha = layer.opacity * (0.1 + band * 0.25);
        ctx.fill();
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 1.2;
        ctx.globalAlpha = layer.opacity * (0.35 + band * 0.6);
        ctx.stroke();
      }
    },
  };
}
