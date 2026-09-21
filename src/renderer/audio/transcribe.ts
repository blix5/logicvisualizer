// Approximate monophonic audio-to-notes, for display only.
//
// Each frame's spectrum is read at every semitone, and one pitch is chosen per
// frame by harmonic summation: a candidate scores its own energy plus that of
// its overtones, so a note whose fundamental is weaker than its second
// harmonic still lands on the right octave. The per-frame pitch is median
// smoothed, and runs of the same pitch become notes. The piano roll draws each
// note as the region's own waveform shifted to that pitch, Flex Pitch style.
//
// Pure and dependency-free, so the worker, the main-thread fallback and the
// unit tests share it.

/** 4 floats per note: [startSeconds, durationSeconds, pitch, velocity 1..127], source-file time. */
export const TRANSCRIBED_FIELDS = 4;

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
  const mono = new Float32Array(length);
  const scale = 1 / (factor * channels.length);
  for (const channel of channels) {
    for (let i = 0; i < length; i += 1) {
      let sum = 0;
      const base = i * factor;
      for (let k = 0; k < factor; k += 1) sum += channel[base + k] ?? 0;
      mono[i] = mono[i]! + sum * scale;
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

  const frames = length >= FFT_SIZE ? Math.floor((length - FFT_SIZE) / HOP) + 1 : 0;
  if (frames === 0) return new Float32Array(0);

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
  // A frame's energy describes its centre; a note starts half a hop before it.
  const frameStart = (f: number) => (f * HOP + FFT_SIZE / 2) / rate - secondsPerFrame / 2;

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
      out.push(frameStart(runStart), frameCount * secondsPerFrame, PITCH_LOW + p, velocity);
    }
    runStart = f;
  }

  // Runs are emitted in time order, one at a time: already sorted, never overlapping.
  return new Float32Array(out);
}
