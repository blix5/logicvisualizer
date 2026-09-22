// Region fade gain, shared by every view that draws audio.
import type { AudioRegionModel } from '../../shared/model';

/**
 * Exponent for a fade of curve `c` (-1..1). Applied to progress measured from
 * the fade's SILENT end, so one rule covers both directions: positive curves
 * start (fade-in) or finish (fade-out) gently — Logic's "ease in" and "ease
 * out" — and negative curves bow the other way. Logic's exact taper is not
 * decoded; this matches its shape, not its numbers.
 */
function exponent(curve: number): number {
  return curve >= 0 ? 1 + curve * 2 : 1 / (1 - curve * 2);
}

/** Gain 0..1 that the region's fades apply at timeline `seconds`. */
export function fadeGain(region: AudioRegionModel, seconds: number): number {
  let gain = 1;
  const fadeIn = region.fadeInSeconds;
  if (fadeIn > 0) {
    const progress = (seconds - region.startSeconds) / fadeIn;
    if (progress < 1) gain = progress <= 0 ? 0 : progress ** exponent(region.fadeInCurve);
  }
  const fadeOut = region.fadeOutSeconds;
  if (fadeOut > 0) {
    const progress = (region.endSeconds - seconds) / fadeOut;
    if (progress < 1) gain *= progress <= 0 ? 0 : progress ** exponent(region.fadeOutCurve);
  }
  return gain;
}

/** Whether any part of the region is faded; lets callers skip the per-column work. */
export function hasFade(region: AudioRegionModel): boolean {
  return region.fadeInSeconds > 0 || region.fadeOutSeconds > 0;
}
