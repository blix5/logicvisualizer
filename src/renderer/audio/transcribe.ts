// Approximate monophonic audio-to-notes, for display only.
//
// Each frame's spectrum is read at every semitone, and one pitch is chosen per
// frame by harmonic summation: a candidate scores its own energy plus that of
// its overtones, so a note whose fundamental is weaker than its second
// harmonic still lands on the right octave. The per-frame pitch is median
// smoothed, and runs of the same pitch become notes. The piano roll draws each
// note as the region's own waveform shifted to that pitch, Flex Pitch style.
//
// Unpitched sounds (drums, mostly) have no harmonic series for that to find, so
// they get a second pass: onsets are detected in three frequency bands of the
// full-rate signal, and each hit is placed at its band's FIXED pitch — kicks
// low, snares and claps in the middle, hats and cymbals high — as a note
// flagged unpitched. A band's hits are dropped where a pitched note in the
// same band is already sounding, so a bassline does not double as kicks.
//
// Pure and dependency-free, so the worker, the main-thread fallback and the
// unit tests share it.

/**
 * 5 floats per note, source-file time:
 * [startSeconds, durationSeconds, pitch, velocity 1..127, unpitched 0|1].
 */
export const TRANSCRIBED_FIELDS = 5;

/**
 * Where unpitched hits sit, as MIDI pitches at each band's typical frequency:
 * ~62 Hz for kicks, ~220 Hz for snare bodies and claps, ~8.4 kHz for hats.
 * The roll clamps them into its range, so a narrow roll still shows low hits
 * at its bottom and high ones at its top.
 */
export const UNPITCHED_PITCH = { low: 35, mid: 57, high: 120 } as const;

/** Working sample rate after decimation. Pitch 100 (~2.6 kHz) is well inside it. */
const TARGET_RATE = 11025;
const FFT_SIZE = 4096;
const HOP = 512;
export const PITCH_LOW = 36;
export const PITCH_HIGH = 100;
/** Frames quieter than this, relative to the file's loudest, are unvoiced. */
const FILE_RANGE_DB = 45;
/** Nor anything under this, relative to a full-scale sine. */
const ABSOLUTE_FLOOR_DB = -70;
/** Overtone offsets in semitones (harmonics 1-5) and their weights in the summation. */
const HARMONICS = [0, 12, 19, 24, 28];
const HARMONIC_WEIGHTS = [1, 0.8, 0.64, 0.5, 0.4];
const MIN_FRAMES = 2;

/** Onset detection: energy blocks of 10 ms at the file's own rate. */
const BLOCK_SECONDS = 0.01;
/** A rise this far above the quietest of the previous few blocks is an onset. */
const ONSET_RISE_DB = 9;
const ONSET_LOOKBACK = 3;
/** Hits quieter than this below the band's loudest are ignored. */
const ONSET_RANGE_DB = 35;
const ONSET_FLOOR_DB = -60;
/** One band cannot retrigger faster than this (a 1/32 at 180 BPM is ~42 ms). */
const ONSET_REFRACTORY_BLOCKS = 5;
/** A hit lasts until it decays this far below its peak, within these bounds. */
const HIT_DECAY_DB = 15;
const HIT_MIN_BLOCKS = 5;
const HIT_MAX_BLOCKS = 30;

/** In-place iterative radix-2 FFT over separate real and imaginary arrays. */
function fft(re: Float64Array, im: Float64Array, cos: Float64Array, sin: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]!; re[i] = re[j]!; re[j] = t;
      t = im[i]!; im[i] = im[j]!; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k += 1) {
        const wr = cos[k * step]!;
        const wi = -sin[k * step]!;
        const a = start + k;
        const b = a + half;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

export function transcribe(channels: Float32Array[], sampleRate: number): Float32Array {
  const first = channels[0];
  if (!first || first.length === 0 || !(sampleRate > 0)) return new Float32Array(0);

  // Mono, decimated by block averaging. The average is a crude low-pass, but
  // nothing above pitch 100 is read, so aliasing up there does not matter.
  const factor = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const rate = sampleRate / factor;
  const length = Math.floor(first.length / factor);
  // Half a window of silence either side, so frame centres run from the
  // file's first sample to its last. Unpadded, the first centre sat ~186 ms
  // in and a note at time zero lost that much of its start, or all of itself
  // if it was shorter: the first note of every untrimmed region.
  const pad = FFT_SIZE / 2;
  const mono = new Float32Array(length + pad * 2);
  const scale = 1 / (factor * channels.length);
  for (const channel of channels) {
    for (let i = 0; i < length; i += 1) {
      let sum = 0;
      const base = i * factor;
      for (let k = 0; k < factor; k += 1) sum += channel[base + k] ?? 0;
      mono[pad + i] = mono[pad + i]! + sum * scale;
    }
  }

  const window = new Float64Array(FFT_SIZE);
  const cos = new Float64Array(FFT_SIZE / 2);
  const sin = new Float64Array(FFT_SIZE / 2);
  for (let i = 0; i < FFT_SIZE; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
  for (let i = 0; i < FFT_SIZE / 2; i += 1) {
    cos[i] = Math.cos((2 * Math.PI * i) / FFT_SIZE);
    sin[i] = Math.sin((2 * Math.PI * i) / FFT_SIZE);
  }

  // Each pitch reads the bins within half a semitone of its frequency.
  const pitches = PITCH_HIGH - PITCH_LOW + 1;
  const binLow = new Int32Array(pitches);
  const binHigh = new Int32Array(pitches);
  for (let p = 0; p < pitches; p += 1) {
    const freq = 440 * 2 ** ((PITCH_LOW + p - 69) / 12);
    binLow[p] = Math.max(1, Math.floor((freq * 2 ** (-1 / 24) * FFT_SIZE) / rate));
    binHigh[p] = Math.min(FFT_SIZE / 2 - 1, Math.max(binLow[p]!, Math.ceil((freq * 2 ** (1 / 24) * FFT_SIZE) / rate)));
  }

  const frames = length >= FFT_SIZE ? Math.floor(length / HOP) + 1 : 0;
  // Too short for one pitch window, which a one-shot kick or hat often is:
  // the hit pass works at 10 ms blocks and can still place it.
  if (frames === 0) return Float32Array.from(detectHits(channels, sampleRate));

  // Pass 1: energy per (frame, pitch) in dB relative to a full-scale sine.
  // Kept whole so pass 2 can judge each frame against the file's loudest.
  const energy = new Float32Array(frames * pitches);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const fullScale = FFT_SIZE / 4;
  let fileMax = -Infinity;
  for (let f = 0; f < frames; f += 1) {
    const offset = f * HOP;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      re[i] = mono[offset + i]! * window[i]!;
      im[i] = 0;
    }
    fft(re, im, cos, sin);
    for (let p = 0; p < pitches; p += 1) {
      let peak = 0;
      for (let bin = binLow[p]!; bin <= binHigh[p]!; bin += 1) {
        const magnitude = re[bin]! * re[bin]! + im[bin]! * im[bin]!;
        if (magnitude > peak) peak = magnitude;
      }
      const db = 10 * Math.log10(peak / (fullScale * fullScale) + 1e-20);
      energy[f * pitches + p] = db;
      if (db > fileMax) fileMax = db;
    }
  }

  const floor = Math.max(ABSOLUTE_FLOOR_DB, fileMax - FILE_RANGE_DB);
  const secondsPerFrame = HOP / rate;
  const fileSeconds = length / rate;
  // A frame's energy describes its centre, which the padding puts at f * HOP;
  // a note starts half a hop before it.
  const frameStart = (f: number) => (f * HOP) / rate - secondsPerFrame / 2;

  // Pass 2: one pitch per frame, or -1 where the frame is unvoiced.
  const raw = new Int16Array(frames).fill(-1);
  const loudness = new Float32Array(frames);
  const power = new Float64Array(pitches);
  for (let f = 0; f < frames; f += 1) {
    const row = f * pitches;
    let frameMax = -Infinity;
    for (let p = 0; p < pitches; p += 1) {
      const e = energy[row + p]!;
      power[p] = 10 ** (e / 10);
      if (e > frameMax) frameMax = e;
    }
    loudness[f] = frameMax;
    if (frameMax < floor) continue;

    let best = -1;
    let bestScore = 0;
    for (let p = 0; p < pitches; p += 1) {
      let score = 0;
      for (let h = 0; h < HARMONICS.length; h += 1) {
        const at = p + HARMONICS[h]!;
        if (at >= pitches) break;
        score += HARMONIC_WEIGHTS[h]! * power[at]!;
      }
      if (score > bestScore) { bestScore = score; best = p; }
    }
    raw[f] = best;
  }

  // Median of three removes single-frame octave flips and dropouts.
  const pitchAt = new Int16Array(frames);
  for (let f = 0; f < frames; f += 1) {
    const a = raw[Math.max(0, f - 1)]!;
    const b = raw[f]!;
    const c = raw[Math.min(frames - 1, f + 1)]!;
    pitchAt[f] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }

  const out: number[] = [];
  let runStart = 0;
  for (let f = 1; f <= frames; f += 1) {
    if (f < frames && pitchAt[f] === pitchAt[runStart]) continue;
    const p = pitchAt[runStart]!;
    const frameCount = f - runStart;
    if (p >= 0 && frameCount >= MIN_FRAMES) {
      let sum = 0;
      for (let k = runStart; k < f; k += 1) sum += loudness[k]!;
      const mean = sum / frameCount;
      const velocity = Math.max(1, Math.min(127, Math.round(127 * (1 + (mean - fileMax) / FILE_RANGE_DB))));
      // Clamped to the file: the first and last frames reach half a hop past it.
      const start = Math.max(0, frameStart(runStart));
      const end = Math.min(fileSeconds, frameStart(runStart) + frameCount * secondsPerFrame);
      out.push(start, end - start, PITCH_LOW + p, velocity, 0);
    }
    runStart = f;
  }

  // Pitched runs come out in time order, one at a time: sorted and disjoint.
  const hits = detectHits(channels, sampleRate);
  const pitched = dropDrumSmear(out, hits);

  // Merge the two start-sorted lists.
  const result = new Float32Array(pitched.length + hits.length);
  let a = 0;
  let b = 0;
  let at = 0;
  while (a < pitched.length || b < hits.length) {
    const takePitched = b >= hits.length || (a < pitched.length && pitched[a]! <= hits[b]!);
    const from = takePitched ? pitched : hits;
    const index = takePitched ? a : b;
    for (let k = 0; k < TRANSCRIBED_FIELDS; k += 1) result[at + k] = from[index + k]!;
    at += TRANSCRIBED_FIELDS;
    if (takePitched) a += TRANSCRIBED_FIELDS; else b += TRANSCRIBED_FIELDS;
  }
  return result;
}

/** RBJ-cookbook biquad, direct form I, run one sample at a time. */
class Biquad {
  private b0 = 0; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;

  constructor(kind: 'lowpass' | 'highpass', hz: number, sampleRate: number) {
    const w = (2 * Math.PI * Math.min(hz, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    const edge = kind === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2;
    this.b0 = edge / a0;
    this.b1 = (kind === 'lowpass' ? 1 - cos : -(1 + cos)) / a0;
    this.b2 = edge / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

type BandName = keyof typeof UNPITCHED_PITCH;
const BAND_NAMES: BandName[] = ['low', 'mid', 'high'];
/** A band's hit is leakage if another band is this much louder at the same instant. */
const DOMINANCE_DB = 15;
/**
 * Onsets in different bands this close together are one sound: a single
 * drum's attack is broadband, so a kick also trips the mid band and a hat's
 * stick click trips it too. Only the dominant band keeps the hit.
 */
const COINCIDENT_BLOCKS = 2;
/**
 * Added to each band's peak when picking the dominant one. A hat puts far less
 * energy above 6 kHz than its click puts into the mid band, yet it is a hat.
 */
const BAND_BIAS_DB = [0, 0, 10];
/** Pitched notes below this, starting around a low hit, are the drum's smear. */
const SMEAR_MAX_PITCH = 51;
const SMEAR_MAX_SECONDS = 0.8;
/** The pitch pass's window is ~370 ms, so its notes can start up to half that early. */
const SMEAR_LEAD_SECONDS = 0.25;

type Hit = { band: number; block: number; end: number; peak: number };

/**
 * Percussive onsets per band, as unpitched notes. Band energies come from
 * biquads over the full-rate mono signal — full rate matters, since hats live
 * above the ~5.5 kHz the pitch pass keeps. A hit must decay quickly, which is
 * what separates a drum from the start of a sustained note in the same band.
 */
function detectHits(channels: Float32Array[], sampleRate: number): number[] {
  const frames = channels[0]!.length;
  const block = Math.max(1, Math.round(sampleRate * BLOCK_SECONDS));
  const blocks = Math.floor(frames / block);
  if (blocks === 0) return [];

  const low = [new Biquad('lowpass', 150, sampleRate), new Biquad('lowpass', 150, sampleRate)];
  const mid = [new Biquad('highpass', 250, sampleRate), new Biquad('lowpass', 2500, sampleRate)];
  const high = [new Biquad('highpass', 6000, sampleRate), new Biquad('highpass', 6000, sampleRate)];

  const energy = BAND_NAMES.map(() => new Float32Array(blocks));
  const scale = 1 / channels.length;
  for (let k = 0; k < blocks; k += 1) {
    let sumLow = 0; let sumMid = 0; let sumHigh = 0;
    const base = k * block;
    for (let i = 0; i < block; i += 1) {
      let x = 0;
      for (const channel of channels) x += channel[base + i]!;
      x *= scale;
      const l = low[1]!.step(low[0]!.step(x));
      const m = mid[1]!.step(mid[0]!.step(x));
      const h = high[1]!.step(high[0]!.step(x));
      sumLow += l * l; sumMid += m * m; sumHigh += h * h;
    }
    // dB relative to a full-scale sine's mean square (0.5).
    energy[0]![k] = 10 * Math.log10(sumLow / block / 0.5 + 1e-20);
    energy[1]![k] = 10 * Math.log10(sumMid / block / 0.5 + 1e-20);
    energy[2]![k] = 10 * Math.log10(sumHigh / block / 0.5 + 1e-20);
  }

  const bandMax = energy.map((e) => e.reduce((m, v) => (v > m ? v : m), -Infinity));
  const candidates: Hit[] = [];
  for (let b = 0; b < BAND_NAMES.length; b += 1) {
    const e = energy[b]!;
    const floor = Math.max(ONSET_FLOOR_DB, bandMax[b]! - ONSET_RANGE_DB);
    let last = -Infinity;
    // Silence is assumed before the file starts: a one-shot sample's attack is
    // in its first few milliseconds, with no earlier blocks to rise from.
    for (let k = 0; k < blocks; k += 1) {
      if (e[k]! < floor || k - last < ONSET_REFRACTORY_BLOCKS) continue;
      let before = k < ONSET_LOOKBACK ? -Infinity : Infinity;
      for (let j = 1; j <= Math.min(k, ONSET_LOOKBACK); j += 1) before = Math.min(before, e[k - j]!);
      if (e[k]! - before < ONSET_RISE_DB) continue;
      last = k;

      // Ride up to the peak, then out to where it has decayed. No decay within
      // the window means a sustained sound starting, not a hit.
      let peakAt = k;
      while (peakAt + 1 < blocks && peakAt - k < 3 && e[peakAt + 1]! > e[peakAt]!) peakAt += 1;
      const peak = e[peakAt]!;
      let end = peakAt + 1;
      while (end < blocks && end - k < HIT_MAX_BLOCKS && e[end]! > peak - HIT_DECAY_DB) end += 1;
      if (end < blocks && e[end]! > peak - HIT_DECAY_DB) continue;
      if (end >= blocks) continue;
      candidates.push({ band: b, block: k, end: Math.max(end, k + HIT_MIN_BLOCKS), peak });
    }
  }

  candidates.sort((x, y) => x.block - y.block);
  // Leakage: some other band is far louder right here.
  const kept = candidates.filter((hit) => {
    let loudest = -Infinity;
    for (let b = 0; b < BAND_NAMES.length; b += 1) {
      if (b === hit.band) continue;
      for (let k = Math.max(0, hit.block - 1); k <= Math.min(blocks - 1, hit.block + 3); k += 1) {
        if (energy[b]![k]! > loudest) loudest = energy[b]![k]!;
      }
    }
    return loudest - hit.peak <= DOMINANCE_DB;
  });

  // One sound, several bands: only the band that dominates it keeps the hit.
  const weighted = (hit: Hit) => hit.peak + BAND_BIAS_DB[hit.band]!;
  const outranks = (other: Hit, hit: Hit) => other.band !== hit.band
    && Math.abs(other.block - hit.block) <= COINCIDENT_BLOCKS
    && weighted(other) > weighted(hit);
  const hits: number[] = [];
  for (let c = 0; c < kept.length; c += 1) {
    const hit = kept[c]!;
    let outranked = false;
    for (let o = c - 1; o >= 0 && hit.block - kept[o]!.block <= COINCIDENT_BLOCKS && !outranked; o -= 1) outranked = outranks(kept[o]!, hit);
    for (let o = c + 1; o < kept.length && kept[o]!.block - hit.block <= COINCIDENT_BLOCKS && !outranked; o += 1) outranked = outranks(kept[o]!, hit);
    if (outranked) continue;
    const name = BAND_NAMES[hit.band]!;
    const velocity = Math.max(1, Math.min(127, Math.round(127 * (1 + (hit.peak - bandMax[hit.band]!) / ONSET_RANGE_DB))));
    hits.push((hit.block * block) / sampleRate, ((hit.end - hit.block) * block) / sampleRate, UNPITCHED_PITCH[name], velocity, 1);
  }
  return hits;
}

/**
 * Drops short, low pitched notes that start around a low percussive hit: a
 * kick's tail has enough low tone to read as a brief bass note, smeared early
 * by the pitch pass's long window.
 */
function dropDrumSmear(pitched: number[], hits: number[]): number[] {
  const kicks: number[] = [];
  for (let i = 0; i < hits.length; i += TRANSCRIBED_FIELDS) {
    if (hits[i + 2] === UNPITCHED_PITCH.low) kicks.push(hits[i]!);
  }
  if (kicks.length === 0) return pitched;
  const kept: number[] = [];
  for (let i = 0; i < pitched.length; i += TRANSCRIBED_FIELDS) {
    const start = pitched[i]!;
    const smear = pitched[i + 2]! <= SMEAR_MAX_PITCH
      && pitched[i + 1]! <= SMEAR_MAX_SECONDS
      && kicks.some((k) => start >= k - SMEAR_LEAD_SECONDS && start <= k + 0.05);
    if (smear) continue;
    for (let k = 0; k < TRANSCRIBED_FIELDS; k += 1) kept.push(pitched[i + k]!);
  }
  return kept;
}
