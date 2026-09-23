// Waveform peak reduction.
//
// Audio is reduced once, off the frame path, into a mipmap pyramid of min/max
// pairs. The renderer then draws one column per screen pixel by reading the
// coarsest level that still has at least one bucket per pixel, which is what
// keeps a zoomed-out view affordable: without the pyramid, a five-minute region
// at MIN_PPS would scan ~70k buckets every frame.
//
// Pure and dependency-free — no DOM, no AudioBuffer — so the worker, the
// main-thread fallback and the unit tests can all share it.

/** Buckets per second at level 0. At MAX_PPS (3200) a bucket is two pixels wide. */
export const PEAK_BASE_RATE = 1600;
/** Each level is this much coarser than the one below it. */
export const PEAK_LEVEL_STEP = 4;
/** 1600, 400, 100, 25, 6.25, 1.5625 buckets per second. */
export const PEAK_LEVELS = 6;

export type PeakPyramid = {
  /** One entry per level, interleaved [min, max] per bucket — length = buckets * 2. */
  levels: Int8Array[];
  /** Actual buckets per second for each level, for `seconds * rate` indexing. */
  rates: Float64Array;
  durationSeconds: number;
};

/** Samples are ±1 nominally, but float audio can overshoot, hence the clamp. */
function quantize(value: number): number {
  const scaled = Math.round(value * 127);
  if (scaled > 127) return 127;
  if (scaled < -127) return -127;
  return scaled;
}

/**
 * Reduces decoded channel data to a peak pyramid.
 *
 * Channels are combined rather than kept apart — min across all channels, max
 * across all channels. A 44px lane has no room for a stereo split, and a
 * combined envelope is what Logic itself shows on a collapsed region.
 */
export function buildPeakPyramid(channels: Float32Array[], sampleRate: number): PeakPyramid {
  const first = channels[0];
  if (!first || first.length === 0) throw new Error('no audio frames to reduce');
  if (!(sampleRate > 0)) throw new Error(`implausible sample rate: ${sampleRate}`);

  const frames = first.length;
  const durationSeconds = frames / sampleRate;
  const bucketCount = Math.max(1, Math.ceil(durationSeconds * PEAK_BASE_RATE));

  const base = new Int8Array(bucketCount * 2);
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    // Boundaries are derived from the bucket index rather than accumulated, so
    // rounding cannot drift across a long file.
    const start = Math.floor((bucket * frames) / bucketCount);
    const end = bucket + 1 === bucketCount ? frames : Math.floor(((bucket + 1) * frames) / bucketCount);
    let low = 0;
    let high = 0;
    if (end > start) {
      low = Infinity;
      high = -Infinity;
      for (const channel of channels) {
        for (let i = start; i < end; i += 1) {
          const sample = channel[i] ?? 0;
          if (sample < low) low = sample;
          if (sample > high) high = sample;
        }
      }
    }
    base[bucket * 2] = quantize(low);
    base[bucket * 2 + 1] = quantize(high);
  }

  // Higher levels reduce the level below rather than rescanning the audio, so
  // the whole pyramid costs one pass over the samples plus a third as much again.
  const levels: Int8Array[] = [base];
  for (let level = 1; level < PEAK_LEVELS; level += 1) {
    const previous = levels[level - 1]!;
    const previousBuckets = previous.length / 2;
    if (previousBuckets <= 1) break;
    const buckets = Math.max(1, Math.ceil(previousBuckets / PEAK_LEVEL_STEP));
    const reduced = new Int8Array(buckets * 2);
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const start = bucket * PEAK_LEVEL_STEP;
      const end = Math.min(previousBuckets, start + PEAK_LEVEL_STEP);
      let low = 0;
      let high = 0;
      if (end > start) {
        low = 127;
        high = -127;
        for (let i = start; i < end; i += 1) {
          const bucketLow = previous[i * 2] ?? 0;
          const bucketHigh = previous[i * 2 + 1] ?? 0;
          if (bucketLow < low) low = bucketLow;
          if (bucketHigh > high) high = bucketHigh;
        }
      }
      reduced[bucket * 2] = low;
      reduced[bucket * 2 + 1] = high;
    }
    levels.push(reduced);
  }

  const rates = new Float64Array(levels.length);
  for (let level = 0; level < levels.length; level += 1) {
    rates[level] = levels[level]!.length / 2 / durationSeconds;
  }

  return { levels, rates, durationSeconds };
}

/** Buckets at a level. */
export function peakCount(pyramid: PeakPyramid, level: number): number {
  return (pyramid.levels[level]?.length ?? 0) / 2;
}

/**
 * The coarsest level that still carries at least one bucket per screen pixel.
 * Because levels step by 4, the chosen level has at most 4x the pixel rate, so
 * a region costs roughly 4x its visible pixel width to draw at any zoom.
 */
export function levelForPixelsPerSecond(pyramid: PeakPyramid, pixelsPerSecond: number): number {
  let chosen = 0;
  for (let level = 0; level < pyramid.rates.length; level += 1) {
    if ((pyramid.rates[level] ?? 0) >= pixelsPerSecond) chosen = level;
    else break;
  }
  return chosen;
}
