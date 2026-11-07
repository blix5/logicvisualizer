// What the visual layers hear, computed once per frame from AudioClock's two
// analysers, and only the parts some enabled layer reads. Buffers are reused,
// so a frame allocates nothing.
import { OnsetDetector } from './onset';
import type { LayerNeeds } from './types';

/** dB range the analysers report; see AudioClock. */
export const FLOOR_DB = -95;
export const CEIL_DB = -15;

/** sub, low, mid, high, in Hz. */
const BAND_EDGES = [20, 90, 300, 2400, 12000] as const;
/** Smoothing per second: rises fast, falls slower, so pulses read as pulses. */
const ATTACK = 0.0005;
const RELEASE = 0.04;
/** The onset reading fades out over about this long. */
const ONSET_DECAY_PER_SECOND = 6;
/** Flux weighting: the low end drives hits, the rest adds snares and claps. */
const LOW_FLUX_WEIGHT = 0.7;
const LOW_FLUX_HZ = 160;

export function normaliseDb(db: number): number {
  const n = (db - FLOOR_DB) / (CEIL_DB - FLOOR_DB);
  return n <= 0 ? 0 : n >= 1 ? 1 : n;
}

export class AudioFeatures {
  /** True when this frame carries live frequency data. */
  valid = false;
  sampleRate = 48000;
  /** dB per FFT bin. */
  left: Float32Array<ArrayBuffer> = new Float32Array(0);
  right: Float32Array<ArrayBuffer> = new Float32Array(0);
  /** Time-domain samples, -1..1, when a layer asked for them. */
  hasWave = false;
  waveLeft: Float32Array<ArrayBuffer> = new Float32Array(0);
  waveRight: Float32Array<ArrayBuffer> = new Float32Array(0);
  /** sub, low, mid, high, each 0..1 and smoothed. */
  readonly bands = new Float32Array(4);
  /** Overall loudness, 0..1, smoothed. */
  level = 0;
  /** Strength of the most recent hit, 0..1, decaying. */
  onset = 0;
  /** True on the frame a hit fires. */
  kick = false;
  /** Counts hits; a layer that compares it with its last value never misses one. */
  kicks = 0;

  private readonly detector = new OnsetDetector();
  private previous = new Float32Array(0);
  private readonly rawBands = new Float32Array(4);
  private lastUpdate = 0;
  private bandKey = '';
  private bandFrom = new Int32Array(4);
  private bandTo = new Int32Array(4);
  private lowFluxBin = 0;

  reset(): void {
    this.valid = false;
    this.hasWave = false;
    this.bands.fill(0);
    this.level = 0;
    this.onset = 0;
    this.kick = false;
    this.detector.reset();
    this.previous.fill(0);
  }

  /** Reads the analysers. `needs` is the union of what the enabled layers read. */
  update(left: AnalyserNode, right: AnalyserNode, needs: LayerNeeds, now: number): void {
    const dt = this.lastUpdate > 0 ? Math.min(0.1, (now - this.lastUpdate) / 1000) : 1 / 60;
    this.lastUpdate = now;
    this.kick = false;
    this.onset = Math.max(0, this.onset - dt * ONSET_DECAY_PER_SECOND * Math.max(0.2, this.onset));

    if (needs.spectrum) {
      const bins = left.frequencyBinCount;
      if (this.left.length !== bins) {
        this.left = new Float32Array(bins);
        this.right = new Float32Array(bins);
        this.previous = new Float32Array(bins);
      }
      left.getFloatFrequencyData(this.left);
      right.getFloatFrequencyData(this.right);
      this.sampleRate = left.context.sampleRate;
      this.valid = true;
      this.analyse(dt, now);
    } else {
      this.valid = false;
    }

    if (needs.wave) {
      const size = left.fftSize;
      if (this.waveLeft.length !== size) {
        this.waveLeft = new Float32Array(size);
        this.waveRight = new Float32Array(size);
      }
      left.getFloatTimeDomainData(this.waveLeft);
      right.getFloatTimeDomainData(this.waveRight);
      this.hasWave = true;
      if (!needs.spectrum) this.levelFromWave(dt);
    } else {
      this.hasWave = false;
    }
  }

  /** Nothing playing: everything eases to rest. */
  silence(now: number): void {
    const dt = this.lastUpdate > 0 ? Math.min(0.1, (now - this.lastUpdate) / 1000) : 1 / 60;
    this.lastUpdate = now;
    this.kick = false;
    this.valid = false;
    this.hasWave = false;
    const fall = 1 - RELEASE ** dt;
    for (let b = 0; b < 4; b += 1) this.bands[b] = this.bands[b]! * (1 - fall);
    this.level *= 1 - fall;
    this.onset = Math.max(0, this.onset - dt * ONSET_DECAY_PER_SECOND);
  }

  private ensureBands(): void {
    const bins = this.left.length;
    const key = `${bins}|${this.sampleRate}`;
    if (key === this.bandKey) return;
    this.bandKey = key;
    const hzPerBin = this.sampleRate / 2 / bins;
    for (let b = 0; b < 4; b += 1) {
      const from = Math.max(1, Math.floor(BAND_EDGES[b]! / hzPerBin));
      this.bandFrom[b] = Math.min(bins - 1, from);
      this.bandTo[b] = Math.min(bins - 1, Math.max(from, Math.ceil(BAND_EDGES[b + 1]! / hzPerBin)));
    }
    this.lowFluxBin = Math.max(2, Math.ceil(LOW_FLUX_HZ / hzPerBin));
  }

  private analyse(dt: number, now: number): void {
    this.ensureBands();
    const { left, right, previous } = this;
    const bins = left.length;
    let lowFlux = 0;
    let fullFlux = 0;
    const top = this.bandTo[3]!;
    for (let i = 1; i <= top && i < bins; i += 1) {
      const n = normaliseDb(Math.max(left[i]!, right[i]!));
      const rise = n - previous[i]!;
      previous[i] = n;
      if (rise > 0) {
        if (i <= this.lowFluxBin) lowFlux += rise;
        fullFlux += rise;
      }
    }
    lowFlux /= this.lowFluxBin;
    fullFlux /= top;

    let loudest = 0;
    for (let b = 0; b < 4; b += 1) {
      let sum = 0;
      const from = this.bandFrom[b]!;
      const to = this.bandTo[b]!;
      for (let i = from; i <= to; i += 1) sum += normaliseDb(Math.max(left[i]!, right[i]!));
      const raw = sum / (to - from + 1);
      this.rawBands[b] = raw;
      loudest = Math.max(loudest, raw);
      const current = this.bands[b]!;
      const k = raw > current ? 1 - ATTACK ** dt : 1 - RELEASE ** dt;
      this.bands[b] = current + (raw - current) * k;
    }
    const k = loudest > this.level ? 1 - ATTACK ** dt : 1 - RELEASE ** dt;
    this.level += (loudest - this.level) * k;

    const hit = this.detector.push(lowFlux * LOW_FLUX_WEIGHT + fullFlux * (1 - LOW_FLUX_WEIGHT), now);
    if (hit > 0) {
      this.kick = true;
      this.kicks += 1;
      this.onset = Math.max(this.onset, hit);
    }
  }

  /** Level from the samples alone, for wave-only stacks. */
  private levelFromWave(dt: number): void {
    let sum = 0;
    const wave = this.waveLeft;
    for (let i = 0; i < wave.length; i += 4) sum += wave[i]! * wave[i]!;
    const rms = Math.sqrt(sum / Math.max(1, wave.length / 4));
    const raw = Math.min(1, rms * 3);
    const k = raw > this.level ? 1 - ATTACK ** dt : 1 - RELEASE ** dt;
    this.level += (raw - this.level) * k;
  }
}
