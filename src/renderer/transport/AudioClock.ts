// The transport clock. Position is derived from AudioContext.currentTime, never
// from wall clock or from an accumulator, so it cannot drift against the audio.
//
// AudioContext.currentTime advances in 128-sample render quanta (~2.7ms), which
// is visible as playhead stutter at high zoom. A one-pole filter driven by
// performance.now() smooths between quanta while the audio clock supplies
// drift-free truth: performance.now() interpolates, currentTime corrects.

const PULL_PER_FRAME = 0.08;

export type ClockState = {
  playing: boolean;
  /** Bounce-local seconds. */
  position: number;
  rate: number;
};

export class AudioClock {
  private readonly ctx: AudioContext;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private anchorCtxTime = 0;
  private anchorMediaTime = 0;
  private playing = false;
  private pausedAt = 0;
  private rate = 1;
  private smoothed = 0;
  private lastPerfNow = 0;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  setBuffer(buffer: AudioBuffer | null): void {
    const wasPlaying = this.playing;
    this.stopSource();
    this.buffer = buffer;
    if (wasPlaying) this.play();
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  private stopSource(): void {
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
  }

  play(): void {
    if (this.playing) return;
    const from = this.pausedAt;
    const when = this.ctx.currentTime + 0.03;
    if (this.buffer) {
      const source = this.ctx.createBufferSource();
      source.buffer = this.buffer;
      source.playbackRate.value = this.rate;
      source.connect(this.ctx.destination);
      source.start(when, Math.max(0, from));
      this.source = source;
    }
    this.anchorCtxTime = when;
    this.anchorMediaTime = from;
    this.playing = true;
    this.resetFilter(from);
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.rawNow();
    this.stopSource();
    this.playing = false;
    this.resetFilter(this.pausedAt);
  }

  toggle(): void {
    if (this.playing) this.pause(); else this.play();
  }

  seek(seconds: number): void {
    const target = Math.max(0, seconds);
    const wasPlaying = this.playing;
    if (wasPlaying) { this.stopSource(); this.playing = false; }
    this.pausedAt = target;
    this.resetFilter(target);
    if (wasPlaying) this.play();
  }

  setRate(rate: number): void {
    const current = this.rawNow();
    this.rate = rate;
    if (this.source) this.source.playbackRate.value = rate;
    // Re-anchor at the moment of the change or the clock jumps.
    this.anchorCtxTime = this.ctx.currentTime;
    this.anchorMediaTime = current;
    if (!this.playing) this.pausedAt = current;
  }

  get playbackRate(): number {
    return this.rate;
  }

  private resetFilter(position: number): void {
    this.smoothed = position;
    this.lastPerfNow = performance.now();
  }

  /** Unsmoothed position straight off the audio clock. */
  private rawNow(): number {
    if (!this.playing) return this.pausedAt;
    const elapsed = (this.ctx.currentTime - this.anchorCtxTime) * this.rate;
    // Before `when` arrives, currentTime is behind the anchor; clamp so the
    // playhead does not run backwards during the scheduling margin.
    return Math.max(this.anchorMediaTime, this.anchorMediaTime + elapsed);
  }

  /** Call once per animation frame. */
  now(): number {
    const perfNow = performance.now();
    if (!this.playing) {
      this.lastPerfNow = perfNow;
      this.smoothed = this.pausedAt;
      return this.pausedAt;
    }
    const deltaSeconds = Math.max(0, (perfNow - this.lastPerfNow) / 1000) * this.rate;
    this.lastPerfNow = perfNow;
    const predicted = this.smoothed + deltaSeconds;
    const truth = this.rawNow();
    this.smoothed = predicted + (truth - predicted) * PULL_PER_FRAME;
    return this.smoothed;
  }
}
