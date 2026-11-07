// Onset (hit / kick) detection from per-frame spectral flux.
//
// Each frame the caller hands over the positive change in energy since the
// last frame (spectral flux). A hit is a frame whose flux stands well above the
// recent average, and above an absolute floor so a quiet passage does not set
// off a hit for every small swell. After a hit a short cooldown ignores the
// tail of the same transient, which the analyser's smoothing spreads over a
// few frames. Pure arithmetic, no DOM, so it can be tested in node.

const HISTORY = 48;
/** A hit needs flux this many standard deviations over the recent mean... */
const SENSITIVITY = 1.6;
/** ...and this share over the mean even when the flux is steady, so a constant level never counts. */
const MEAN_MARGIN = 1.4;
/** ...and at least this much flux outright. */
const MIN_FLUX = 0.012;
/** Milliseconds after a hit during which no other can fire. */
export const ONSET_COOLDOWN_MS = 110;
/** Frames of history needed before anything can fire, so starting playback is not a hit. */
const WARM_UP = 4;

export class OnsetDetector {
  private readonly history = new Float64Array(HISTORY);
  private filled = 0;
  private cursor = 0;
  private lastHit = -Infinity;

  reset(): void {
    this.history.fill(0);
    this.filled = 0;
    this.cursor = 0;
    this.lastHit = -Infinity;
  }

  /**
   * Feeds one frame's flux at time `now` (ms). Returns the hit's strength,
   * 0..1, or 0 when this frame is not a hit.
   */
  push(flux: number, now: number): number {
    let mean = 0;
    for (let i = 0; i < this.filled; i += 1) mean += this.history[i]!;
    mean = this.filled > 0 ? mean / this.filled : 0;
    let variance = 0;
    for (let i = 0; i < this.filled; i += 1) {
      const d = this.history[i]! - mean;
      variance += d * d;
    }
    const deviation = this.filled > 1 ? Math.sqrt(variance / this.filled) : 0;

    const warm = this.filled >= WARM_UP;
    this.history[this.cursor] = flux;
    this.cursor = (this.cursor + 1) % HISTORY;
    if (this.filled < HISTORY) this.filled += 1;

    const threshold = Math.max(MIN_FLUX, mean * MEAN_MARGIN + SENSITIVITY * deviation);
    if (!warm || flux <= threshold || now - this.lastHit < ONSET_COOLDOWN_MS) return 0;
    this.lastHit = now;
    // How far over the bar it cleared: just over is a soft hit, many times over a hard one.
    return Math.min(1, 0.3 + 0.7 * (1 - threshold / flux));
  }
}
