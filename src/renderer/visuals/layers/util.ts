// Small helpers the layers share.
import { normaliseDb, type AudioFeatures } from '../AudioFeatures';
import type { LayerContext } from '../types';

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function num(layer: LayerContext, key: string, fallback: number): number {
  const value = layer.params[key];
  return typeof value === 'number' ? value : fallback;
}

export function str(layer: LayerContext, key: string, fallback: string): string {
  const value = layer.params[key];
  return typeof value === 'string' ? value : fallback;
}

export function bool(layer: LayerContext, key: string, fallback: boolean): boolean {
  const value = layer.params[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** Mixes two "r,g,b" triplets; t = 0 gives a. */
export function mixTriplet(a: string, b: string, t: number): string {
  const [ar = 0, ag = 0, ab = 0] = a.split(',').map(Number);
  const [br = 0, bg = 0, bb = 0] = b.split(',').map(Number);
  return `${Math.round(ar + (br - ar) * t)},${Math.round(ag + (bg - ag) * t)},${Math.round(ab + (bb - ab) * t)}`;
}

const LOW_HZ = 30;
const HIGH_HZ = 16000;

/**
 * Reads `count` log-spaced band levels (0..1, the louder channel's peak) from
 * the frame's spectrum, with optional per-band smoothing. Tables are cached.
 */
export class BandReader {
  private key = '';
  private from = new Int32Array(0);
  private to = new Int32Array(0);
  readonly levels: Float32Array;

  constructor(readonly count: number, private readonly lowHz = LOW_HZ, private readonly highHz = HIGH_HZ) {
    this.levels = new Float32Array(count);
  }

  /**
   * Updates `levels`. `rise` and `fall` are the share of the gap closed per
   * second (1 = instant). Without live data the levels fall toward silence.
   */
  read(features: AudioFeatures, dt: number, rise = 1, fall = 1): Float32Array {
    const { count, levels } = this;
    const up = rise >= 1 ? 1 : 1 - (1 - rise) ** (dt * 60);
    const down = fall >= 1 ? 1 : 1 - (1 - fall) ** (dt * 60);
    if (!features.valid) {
      for (let i = 0; i < count; i += 1) levels[i] = levels[i]! * (1 - Math.max(down, 0.08));
      return levels;
    }
    const bins = features.left.length;
    const key = `${bins}|${features.sampleRate}`;
    if (key !== this.key) {
      this.key = key;
      this.from = new Int32Array(count);
      this.to = new Int32Array(count);
      const hzPerBin = features.sampleRate / 2 / bins;
      const span = Math.log(this.highHz / this.lowHz);
      for (let c = 0; c < count; c += 1) {
        const lowHz = this.lowHz * Math.exp((span * c) / count);
        const highHz = this.lowHz * Math.exp((span * (c + 1)) / count);
        const first = Math.min(bins - 1, Math.floor(lowHz / hzPerBin));
        this.from[c] = first;
        this.to[c] = Math.min(bins - 1, Math.max(first, Math.ceil(highHz / hzPerBin)));
      }
    }
    const { left, right } = features;
    for (let c = 0; c < count; c += 1) {
      let peak = -Infinity;
      for (let b = this.from[c]!; b <= this.to[c]!; b += 1) {
        const db = left[b]! > right[b]! ? left[b]! : right[b]!;
        if (db > peak) peak = db;
      }
      const target = normaliseDb(peak);
      const current = levels[c]!;
      levels[c] = current + (target - current) * (target > current ? up : down);
    }
    return levels;
  }

  /** As read(), but one channel only. */
  readChannel(db: Float32Array, features: AudioFeatures, out: Float32Array): Float32Array {
    if (!features.valid) {
      out.fill(0);
      return out;
    }
    this.read(features, 0); // ensures the tables
    for (let c = 0; c < this.count; c += 1) {
      let peak = -Infinity;
      for (let b = this.from[c]!; b <= this.to[c]!; b += 1) if (db[b]! > peak) peak = db[b]!;
      out[c] = normaliseDb(peak);
    }
    return out;
  }
}
