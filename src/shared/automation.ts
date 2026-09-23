// Track volume automation as the renderer consumes it. Shared by main (which
// builds the curves) and renderer (which samples them), so nothing here may
// import node: or electron.

/** Logic's fader reading for unity gain (0 dB). */
export const FADER_UNITY = 90;

/**
 * A track's volume automation in timeline seconds, ascending. Logic writes it
 * densely (one point every ~26 ticks along a ramp), so linear interpolation
 * between points reproduces its curve.
 */
export type VolumeCurve = {
  seconds: Float64Array;
  /** Fader units: 90 is 0 dB, 0 is -inf. */
  fader: Float32Array;
};

/** Fader value at `seconds`; before the first point and after the last it holds. */
export function faderAt(curve: VolumeCurve, seconds: number): number {
  const { seconds: times, fader } = curve;
  const count = times.length;
  if (count === 0) return FADER_UNITY;
  if (seconds <= times[0]!) return fader[0]!;
  if (seconds >= times[count - 1]!) return fader[count - 1]!;
  let low = 0;
  let high = count - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (times[mid]! <= seconds) low = mid;
    else high = mid;
  }
  const t0 = times[low]!;
  const t1 = times[high]!;
  const f0 = fader[low]!;
  return t1 > t0 ? f0 + (fader[high]! - f0) * ((seconds - t0) / (t1 - t0)) : f0;
}

/**
 * Linear amplitude for a fader value, for scaling a waveform. Logic follows the
 * MIDI volume law, 40·log10(v/90) dB, i.e. amplitude (v/90)²: exact at unity
 * and -inf, it gives the fader's +6 dB ceiling at 127, and bassthing's Aux 3
 * stores 58.8 where Logic displays -7.4 dB, which is what the law gives.
 */
export function faderToAmplitude(fader: number): number {
  if (fader <= 0) return 0;
  const ratio = fader / FADER_UNITY;
  return ratio * ratio;
}

/**
 * Loudness 0..1 for a fader value, for note opacity. Fader units are already a
 * perceptual scale, like velocity, so this is linear in them and capped at
 * unity: a boost cannot make a note more opaque than full velocity already is.
 */
export function faderToLevel(fader: number): number {
  return Math.max(0, Math.min(1, fader / FADER_UNITY));
}

/**
 * Several faders in series as one curve: a channel feeding a summing stack is
 * heard through both faders. Gains multiply, so under the (v/90)² law the
 * combined fader is 90 · Π(v/90), sampled at every point of every curve.
 */
export function combineVolumeCurves(curves: VolumeCurve[]): VolumeCurve | null {
  if (curves.length === 0) return null;
  if (curves.length === 1) return curves[0]!;
  const all: number[] = [];
  for (const curve of curves) for (const t of curve.seconds) all.push(t);
  all.sort((a, b) => a - b);
  const times: number[] = [];
  for (const t of all) if (times.length === 0 || t !== times[times.length - 1]) times.push(t);
  const seconds = Float64Array.from(times);
  const fader = new Float32Array(times.length);
  times.forEach((t, i) => {
    let value = FADER_UNITY;
    for (const curve of curves) value *= faderAt(curve, t) / FADER_UNITY;
    fader[i] = value;
  });
  return { seconds, fader };
}

/** Amplitude multiplier at `seconds`, or 1 when the track has no automation. */
export function volumeGain(curve: VolumeCurve | null, seconds: number): number {
  return curve ? faderToAmplitude(faderAt(curve, seconds)) : 1;
}

/** Opacity multiplier at `seconds`, or 1 when the track has no automation. */
export function volumeLevel(curve: VolumeCurve | null, seconds: number): number {
  return curve ? faderToLevel(faderAt(curve, seconds)) : 1;
}
