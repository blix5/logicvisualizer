// Canvas 2D renderer for the piano-roll view.
//
// No lanes and no vertical scroll: one pitch axis fills the top of the view,
// the bounce runs along the bottom, and audio regions glow faintly behind the
// notes. The playhead is fixed at horizontal centre, as in the other modes.
//
// It is the heavily styled view, so a few rules keep it cheap:
//   1. No shadowBlur anywhere. Note glow is the same batch drawn a second time,
//      inflated, at low alpha; the flash under the playhead is a pre-rendered
//      radial sprite blitted with drawImage.
//   2. Everything that does not move horizontally — background, pitch stripes,
//      keyboard, divider — is painted once per resize into an offscreen layer
//      and blitted in a single drawImage per frame.
//   3. Waveforms are one filled path each (top edge out, bottom edge back)
//      rather than a fillRect per pixel column, read from the peak pyramid at
//      the coarsest level that still covers every column.
//   4. Pitch-to-y is a table, rebuilt only when the layout changes.
import { withAlpha, type ViewState } from './ArrangeRenderer';
import type { AudioRegionModel } from '../../shared/model';
import { fadeGain, hasFade } from './fade';
import { levelForPixelsPerSecond, peakCount, type PeakPyramid } from './peaks';
import { RectBuffer } from './rectBuffer';
import {
  firstVisibleRollAudio,
  firstVisibleRollNote,
  type RollScene,
  type RollTrack,
} from './rollScene';
import { VELOCITY_BUCKETS } from './scene';
import { ParticleSystem } from './particles';
import { SpectrumPainter } from './spectrum';

const BACKGROUND = '#04050a';
/** Space above the highest pitch row, on top of whatever the toolbar covers. */
const TOP_ROOM = 16;
/**
 * The bounce shares the roll rather than getting its own strip: the pitch rows
 * stop this far above the bottom, leaving the band below the lowest notes free
 * for it. A share of the height, within these bounds.
 */
const BOUNCE_SHARE = 0.18;
const BOUNCE_MIN = 64;
const BOUNCE_MAX = 150;
/** Gap between the lowest pitch row and the bounce waveform. */
const BOUNCE_GAP = 8;
/**
 * Particles fire for notes the playhead crossed since the last frame, but only
 * on steady forward playback: a backwards move or a bigger jump is a seek or a
 * scrub, and would otherwise set off every note it skipped.
 */
const MAX_EMIT_STEP_SECONDS = 0.25;
const KEY_WIDTH = 14;
/** Pixels the note glow pass spreads past each note. */
const GLOW_SPREAD = 3;
/** CSS px across the flash sprite drawn under the playhead. */
const SPRITE_SIZE = 44;
/** Past this many notes under the playhead, only the first ones get a sprite. */
const MAX_SPRITES = 48;
/**
 * Summed opacity the background audio may reach where regions stack. Drawn
 * additively, forty stacked stems at a fixed alpha would wash the roll out to
 * white, so each region's share shrinks as more of them play at once.
 */
const BACKGROUND_BUDGET = 0.32;
/** Background waveforms sample every other column; nobody can see the difference. */
const BACKGROUND_STEP = 2;
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
/**
 * Half-height of a converted note's waveform at full scale, in pitch rows. A
 * loud passage swells a couple of rows either side of its pitch, as Flex Pitch
 * blobs do; a quiet one stays near the note line.
 */
const WAVE_ROWS = 1.8;
/** Quiet files are scaled up to fill the blob, but only this far. */
const MAX_WAVE_GAIN = 4;

export class PianoRollRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;

  private readonly alphaCache = new Map<string, string>();
  private readonly spriteCache = new Map<string, HTMLCanvasElement>();
  private readonly noteBuckets: RectBuffer[] =
    Array.from({ length: VELOCITY_BUCKETS }, () => new RectBuffer());
  private readonly flashes = new RectBuffer();
  /** Sprites for sounding converted notes: x = track index, y = centre. */
  private readonly waveSprites = new RectBuffer();
  /** Loudest peak per pyramid, for normalising converted waveforms. */
  private readonly peakLevel = new WeakMap<PeakPyramid, number>();
  private flashTrack = new Uint16Array(64);
  private readonly minorBars = new RectBuffer();
  private readonly majorBars = new RectBuffer();
  /** Track index lighting each key this frame, or -1. */
  private readonly litKeys = new Int16Array(128);

  // Layout, recomputed with the static layer.
  private layoutKey = '';
  private staticLayer: HTMLCanvasElement | null = null;
  private rollTop = TOP_ROOM;
  private rollBottom = 0;
  private bounceTop = 0;
  private rowHeight = 1;
  private noteInset = 0;
  private readonly pitchY = new Float32Array(128);

  private pastShade: CanvasGradient | null = null;
  private bounceFill: CanvasGradient | null = null;
  private playheadBand: CanvasGradient | null = null;
  private gradientKey = '';

  private readonly spectrum = new SpectrumPainter();
  private readonly particles = new ParticleSystem();
  private particleScene: RollScene | null = null;
  private lastPlayhead = Number.NaN;
  /** This frame: whether to emit, and the playhead position emission counts from. */
  private emitting = false;
  private emitFrom = 0;

  // Envelope scratch, reused every frame.
  private envHigh = new Float32Array(1024);
  private envLow = new Float32Array(1024);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // Same canvas as the arrange renderer; getContext hands back the one
    // context it already created.
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is unavailable.');
    this.ctx = ctx;
  }

  resize(_width: number, _height: number, dpr: number): void {
    // The arrange renderer owns the canvas size; only the layout is stale here.
    this.dpr = dpr;
    this.layoutKey = '';
  }

  private shade(color: string, alpha: number): string {
    const key = `${color}|${alpha}`;
    let value = this.alphaCache.get(key);
    if (value === undefined) {
      value = withAlpha(color, alpha);
      this.alphaCache.set(key, value);
    }
    return value;
  }

  /** A soft radial halo in one track colour, rendered once and blitted. */
  private sprite(color: string): HTMLCanvasElement {
    const key = `${color}|${this.dpr}`;
    const cached = this.spriteCache.get(key);
    if (cached) return cached;
    const size = Math.ceil(SPRITE_SIZE * this.dpr);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const r = size / 2;
      const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
      gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
      gradient.addColorStop(0.12, withAlpha(color, 0.8));
      gradient.addColorStop(0.4, withAlpha(color, 0.22));
      gradient.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    }
    this.spriteCache.set(key, canvas);
    return canvas;
  }

  /** True while particles are still in flight, so the caller keeps drawing after a pause. */
  get animating(): boolean {
    return this.particles.animating;
  }

  clear(): void {
    const width = this.canvas.width / this.dpr;
    const height = this.canvas.height / this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.fillStyle = BACKGROUND;
    this.ctx.fillRect(0, 0, width, height);
  }

  /** Recomputes layout and repaints the static layer when anything it depends on changed. */
  private ensureLayout(scene: RollScene, width: number, height: number, topInset: number): void {
    const key = `${width}|${height}|${this.dpr}|${scene.pitchLow}|${scene.pitchHigh}|${topInset}`;
    if (key === this.layoutKey && this.staticLayer) return;
    this.layoutKey = key;

    // rollBottom is the bottom of the PITCH rows; the bounce band sits below it
    // inside the same roll.
    const band = Math.round(Math.min(BOUNCE_MAX, Math.max(BOUNCE_MIN, height * BOUNCE_SHARE)));
    this.rollTop = topInset + TOP_ROOM;
    this.rollBottom = Math.max(this.rollTop + 40, height - band);
    this.bounceTop = this.rollBottom + BOUNCE_GAP;
    const span = scene.pitchHigh - scene.pitchLow + 1;
    this.rowHeight = (this.rollBottom - this.rollTop) / span;
    this.noteInset = this.rowHeight > 6 ? 1 : this.rowHeight > 3 ? 0.5 : 0;
    this.pitchY.fill(-1000);
    for (let pitch = scene.pitchLow; pitch <= scene.pitchHigh; pitch += 1) {
      this.pitchY[pitch] = this.rollTop + (scene.pitchHigh - pitch) * this.rowHeight;
    }

    const layer = this.staticLayer ?? document.createElement('canvas');
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const ctx = layer.getContext('2d', { alpha: false });
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);

    // Deep-blue wash rising from the bottom, over the whole roll — the bounce
    // band included, since it is part of the roll rather than a strip of its own.
    const wash = ctx.createLinearGradient(0, 0, 0, height);
    wash.addColorStop(0, 'rgba(40,30,90,0.08)');
    wash.addColorStop(1, 'rgba(30,60,120,0.2)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, width, height);

    // Pitch rows: black-key rows sink slightly, and each C gets a hairline.
    for (let pitch = scene.pitchLow; pitch <= scene.pitchHigh; pitch += 1) {
      const y = this.pitchY[pitch]!;
      if (BLACK_KEYS.has(pitch % 12)) {
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(KEY_WIDTH, y, width - KEY_WIDTH, this.rowHeight);
      }
      if (pitch % 12 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(KEY_WIDTH, Math.round(y + this.rowHeight) - 1, width - KEY_WIDTH, 1);
      }
    }

    // The keyboard strip.
    for (let pitch = scene.pitchLow; pitch <= scene.pitchHigh; pitch += 1) {
      const y = this.pitchY[pitch]!;
      ctx.fillStyle = BLACK_KEYS.has(pitch % 12) ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.09)';
      ctx.fillRect(0, y + 0.5, KEY_WIDTH - 2, Math.max(0.5, this.rowHeight - 1));
    }
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(KEY_WIDTH - 1, this.rollTop, 1, this.rollBottom - this.rollTop);

    // A faint centre line for the bounce, visible when none is loaded.
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(KEY_WIDTH, Math.round((this.bounceTop + height) / 2), width - KEY_WIDTH, 1);

    // Vignette over everything static.
    const vignette = ctx.createRadialGradient(
      width / 2, height / 2, Math.min(width, height) * 0.35,
      width / 2, height / 2, Math.max(width, height) * 0.75,
    );
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);

    this.staticLayer = layer;
  }

  private ensureGradients(width: number, height: number, centreX: number): void {
    const key = `${width}|${height}|${this.bounceTop}`;
    if (key === this.gradientKey && this.pastShade && this.bounceFill && this.playheadBand) return;
    this.gradientKey = key;
    const { ctx } = this;

    // What has already played sinks back; what is coming stays bright.
    const past = ctx.createLinearGradient(KEY_WIDTH, 0, centreX, 0);
    past.addColorStop(0, 'rgba(4,5,10,0.62)');
    past.addColorStop(0.85, 'rgba(4,5,10,0.18)');
    past.addColorStop(1, 'rgba(4,5,10,0)');
    this.pastShade = past;

    // Hard split at the playhead: played audio dim, upcoming audio lit.
    const split = centreX / width;
    const bounce = ctx.createLinearGradient(0, 0, width, 0);
    bounce.addColorStop(0, 'rgba(120,140,200,0.14)');
    bounce.addColorStop(Math.max(0, split - 0.0005), 'rgba(150,170,230,0.32)');
    bounce.addColorStop(split, 'rgba(190,215,255,0.95)');
    bounce.addColorStop(1, 'rgba(120,160,255,0.55)');
    this.bounceFill = bounce;

    const band = ctx.createLinearGradient(centreX - 48, 0, centreX + 48, 0);
    band.addColorStop(0, 'rgba(255,255,255,0)');
    band.addColorStop(0.5, 'rgba(210,225,255,0.3)');
    band.addColorStop(1, 'rgba(255,255,255,0)');
    this.playheadBand = band;
  }

  draw(scene: RollScene, view: ViewState): void {
    const { ctx } = this;
    const width = this.canvas.width / this.dpr;
    const height = this.canvas.height / this.dpr;
    this.ensureLayout(scene, width, height, view.topInset ?? 0);
    const centreX = width / 2;
    this.ensureGradients(width, height, centreX);

    // Static layer, pixel for pixel.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    if (this.staticLayer) ctx.drawImage(this.staticLayer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const pps = view.pixelsPerSecond;
    const spp = 1 / pps;
    const playhead = view.playheadSeconds;
    const windowStart = playhead - (centreX - KEY_WIDTH) * spp;
    const windowEnd = playhead + (width - centreX) * spp;
    const toX = (seconds: number) => centreX + (seconds - playhead) * pps;

    // Particles belong to one scene (their colours index its tracks) and stop
    // when switched off.
    if (!view.particles || scene !== this.particleScene) this.particles.clear();
    this.particleScene = scene;
    const moved = playhead - this.lastPlayhead;
    this.emitting = !!view.particles && moved > 0 && moved <= MAX_EMIT_STEP_SECONDS;
    this.emitFrom = this.lastPlayhead;
    this.lastPlayhead = playhead;
    this.particles.step(performance.now());

    this.drawBars(view, toX, width, height, windowStart, windowEnd);

    // Everything in the roll stays right of the keyboard.
    ctx.save();
    ctx.beginPath();
    ctx.rect(KEY_WIDTH, this.rollTop, width - KEY_WIDTH, this.rollBottom - this.rollTop);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    this.drawBackgroundAudio(scene, view, toX, width, windowStart, windowEnd);
    this.drawNotes(scene, view, toX, pps, width, playhead, windowStart, windowEnd);
    ctx.globalCompositeOperation = 'source-over';
    if (this.pastShade) {
      ctx.fillStyle = this.pastShade;
      ctx.fillRect(KEY_WIDTH, this.rollTop, centreX - KEY_WIDTH, this.rollBottom - this.rollTop);
    }
    this.drawFlashes(scene, centreX);
    ctx.restore();

    this.drawLitKeys(scene);
    const level = this.drawBounce(view, centreX, width, height);
    this.drawPlayhead(centreX, height, level);
    this.particles.draw(ctx, (color) => {
      const track = scene.tracks[color];
      return track ? this.sprite(track.color) : null;
    });
    if (view.spectrumMode && view.spectrumMode !== 'none') {
      this.spectrum.draw(ctx, view.spectrumMode, view.spectrum ?? null, {
        width,
        centreX,
        rollTop: this.rollTop,
        rollBottom: this.rollBottom,
        keyWidth: KEY_WIDTH,
        pitchLow: scene.pitchLow,
        pitchHigh: scene.pitchHigh,
        pitchY: this.pitchY,
        rowHeight: this.rowHeight,
        canvasHeight: height,
        pixelsPerSecond: view.pixelsPerSecond,
        playheadSeconds: view.playheadSeconds,
        live: view.spectrumLive ?? false,
        scene,
      });
    }
  }

  private drawBars(
    view: ViewState,
    toX: (s: number) => number,
    width: number,
    height: number,
    windowStart: number,
    windowEnd: number,
  ): void {
    const { ctx } = this;
    const grid = view.barGrid;
    let low = 0;
    let high = grid.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((grid[mid]?.seconds ?? Infinity) < windowStart) low = mid + 1;
      else high = mid;
    }
    this.minorBars.reset();
    this.majorBars.reset();
    for (let i = low; i < grid.length; i += 1) {
      const entry = grid[i];
      if (!entry) continue;
      if (entry.seconds > windowEnd) break;
      const x = Math.round(toX(entry.seconds));
      if (x < KEY_WIDTH || x > width) continue;
      if ((entry.bar - 1) % 4 === 0) this.majorBars.push(x, 0, 1, height);
      else this.minorBars.push(x, 0, 1, height);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    this.minorBars.fillInto(ctx);
    ctx.fillStyle = 'rgba(150,180,255,0.09)';
    this.majorBars.fillInto(ctx);
  }

  /**
   * Min/max envelope of `pyramid` into the scratch arrays, one entry per
   * `step` columns from `left` to `right`. Source seconds at column x are
   * `(x - originX) * spp * rate + originSource`. Returns the entry count.
   */
  private envelope(
    pyramid: PeakPyramid,
    left: number,
    right: number,
    step: number,
    originX: number,
    spp: number,
    rate: number,
    originSource: number,
    reversed = false,
    sourceSpan = 0,
  ): number {
    const count = Math.max(0, Math.ceil((right - left) / step) + 1);
    if (count > this.envHigh.length) {
      this.envHigh = new Float32Array(count * 2);
      this.envLow = new Float32Array(count * 2);
    }
    const level = levelForPixelsPerSecond(pyramid, 1 / (spp * rate * step));
    const data = pyramid.levels[level];
    const bucketRate = pyramid.rates[level] ?? 0;
    const buckets = peakCount(pyramid, level);
    if (!data || bucketRate <= 0 || buckets === 0) return 0;

    const perColumn = step * spp * rate;
    for (let n = 0; n < count; n += 1) {
      const x = left + n * step;
      // A reversed region maps back-to-front: the source runs from the trimmed
      // span's end toward its start as x increases, mirroring the waveform.
      const offset = (x - originX) * spp * rate;
      const from = reversed
        ? originSource + sourceSpan - offset - perColumn
        : originSource + offset;
      let first = Math.floor(from * bucketRate);
      let last = Math.ceil((from + perColumn) * bucketRate);
      if (last <= first) last = first + 1;
      if (last <= 0 || first >= buckets) {
        this.envHigh[n] = 0;
        this.envLow[n] = 0;
        continue;
      }
      if (first < 0) first = 0;
      if (last > buckets) last = buckets;
      let lowest = 127;
      let highest = -127;
      for (let bucket = first; bucket < last; bucket += 1) {
        const bucketLow = data[bucket * 2]!;
        const bucketHigh = data[bucket * 2 + 1]!;
        if (bucketLow < lowest) lowest = bucketLow;
        if (bucketHigh > highest) highest = bucketHigh;
      }
      this.envHigh[n] = highest / 127;
      this.envLow[n] = lowest / 127;
    }
    return count;
  }

  /**
   * Tapers the envelope in the scratch arrays by the region's fades. Column n
   * sits at `left + n * step`; `startX` is where the region starts on screen.
   */
  private applyFades(
    region: AudioRegionModel,
    count: number,
    left: number,
    step: number,
    startX: number,
    spp: number,
  ): void {
    if (!hasFade(region)) return;
    for (let n = 0; n < count; n += 1) {
      const gain = fadeGain(region, region.startSeconds + (left + n * step - startX) * spp);
      this.envHigh[n] = this.envHigh[n]! * gain;
      this.envLow[n] = this.envLow[n]! * gain;
    }
  }

  /** Fills the envelope in the scratch arrays as one closed path. */
  private fillEnvelope(count: number, left: number, step: number, centre: number, amplitude: number): void {
    if (count === 0) return;
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(left, centre - this.envHigh[0]! * amplitude);
    for (let n = 1; n < count; n += 1) ctx.lineTo(left + n * step, centre - this.envHigh[n]! * amplitude);
    for (let n = count - 1; n >= 0; n -= 1) ctx.lineTo(left + n * step, centre - this.envLow[n]! * amplitude);
    ctx.closePath();
    ctx.fill();
  }

  private drawBackgroundAudio(
    scene: RollScene,
    view: ViewState,
    toX: (s: number) => number,
    width: number,
    windowStart: number,
    windowEnd: number,
  ): void {
    const centre = (this.rollTop + this.rollBottom) / 2;
    const amplitude = (this.rollBottom - this.rollTop) * 0.44;
    const spp = 1 / view.pixelsPerSecond;
    const from = firstVisibleRollAudio(scene, windowStart);

    // How many regions sound at the playhead: the stacking the budget divides.
    let stacked = 0;
    for (let i = from; i < scene.audio.length; i += 1) {
      const { region } = scene.audio[i]!;
      if (region.startSeconds > view.playheadSeconds) break;
      if (region.endSeconds >= view.playheadSeconds) stacked += 1;
    }
    const share = Math.min(0.1, BACKGROUND_BUDGET / Math.max(1, stacked));
    // Quantised so the colour-string cache stays small.
    const idle = Math.max(0.01, Math.round(share * 0.5 * 200) / 200);
    const lit = Math.max(0.02, Math.round(share * 200) / 200);

    for (let i = from; i < scene.audio.length; i += 1) {
      const { region, color } = scene.audio[i]!;
      if (region.startSeconds > windowEnd) break;
      if (region.endSeconds < windowStart) continue;
      const pyramid = region.audioFileId ? view.peaks(region.audioFileId) : null;
      if (!pyramid) continue;

      const startX = toX(region.startSeconds);
      const endX = toX(region.endSeconds);
      const left = Math.floor(Math.max(KEY_WIDTH, startX));
      const right = Math.min(width, endX);
      if (right <= left) continue;
      const bgRate = region.sourceRate > 0 ? region.sourceRate : 1;
      const count = this.envelope(
        pyramid, left, right, BACKGROUND_STEP, startX, spp,
        bgRate, region.fileStartSeconds,
        region.reversed, (region.endSeconds - region.startSeconds) * bgRate,
      );
      this.applyFades(region, count, left, BACKGROUND_STEP, startX, spp);
      const active = view.playheadSeconds >= region.startSeconds && view.playheadSeconds <= region.endSeconds;
      this.ctx.fillStyle = this.shade(color, active ? lit : idle);
      this.fillEnvelope(count, left, BACKGROUND_STEP, centre, amplitude);
    }
  }

  private drawNotes(
    scene: RollScene,
    view: ViewState,
    toX: (s: number) => number,
    pps: number,
    width: number,
    playhead: number,
    windowStart: number,
    windowEnd: number,
  ): void {
    const { ctx } = this;
    const noteHeight = Math.max(1.5, this.rowHeight - this.noteInset * 2);
    this.flashes.reset();
    this.waveSprites.reset();
    this.litKeys.fill(-1);

    for (let t = 0; t < scene.tracks.length; t += 1) {
      const track = scene.tracks[t]!;
      if (track.converted) {
        this.drawConvertedTrack(t, track, view, toX, width, playhead, windowStart, windowEnd);
        continue;
      }
      for (const buffer of this.noteBuckets) buffer.reset();

      for (let i = firstVisibleRollNote(track, windowStart); i < track.count; i += 1) {
        const start = track.start[i]!;
        if (start > windowEnd) break;
        const duration = track.duration[i]!;
        if (start + duration < windowStart) continue;
        const pitch = track.pitch[i]!;
        const y = this.pitchY[pitch]! + this.noteInset;
        const x = toX(start);
        const drawX = Math.max(KEY_WIDTH - GLOW_SPREAD, x);
        const drawW = Math.min(width + GLOW_SPREAD, x + Math.max(2, duration * pps)) - drawX;
        if (drawW <= 0) continue;

        if (this.emitting && start > this.emitFrom && start <= playhead) {
          this.particles.emit(toX(playhead), y + noteHeight / 2, t, track.bucket[i]! / (VELOCITY_BUCKETS - 1), pps);
        }
        if (playhead >= start && playhead <= start + duration) {
          const slot = this.flashes.size;
          if (slot >= this.flashTrack.length) {
            const grown = new Uint16Array(this.flashTrack.length * 2);
            grown.set(this.flashTrack);
            this.flashTrack = grown;
          }
          this.flashTrack[slot] = t;
          this.flashes.push(drawX, y, drawW, noteHeight);
          this.litKeys[pitch] = t;
          continue;
        }
        this.noteBuckets[track.bucket[i]!]!.push(drawX, y, drawW, noteHeight);
      }

      // Glow pass: every bucket under one faint fill, inflated.
      ctx.fillStyle = this.shade(track.color, 0.1);
      for (const buffer of this.noteBuckets) buffer.fillInto(ctx, GLOW_SPREAD);
      // Core pass, brighter with velocity.
      for (let bucket = 0; bucket < VELOCITY_BUCKETS; bucket += 1) {
        const buffer = this.noteBuckets[bucket]!;
        if (buffer.size === 0) continue;
        ctx.fillStyle = this.shade(track.color, 0.4 + (bucket / (VELOCITY_BUCKETS - 1)) * 0.55);
        buffer.fillInto(ctx);
      }
    }
  }

  private waveGain(pyramid: PeakPyramid): number {
    let gain = this.peakLevel.get(pyramid);
    if (gain === undefined) {
      // The coarsest level holds the file's extremes in a handful of buckets.
      const top = pyramid.levels[pyramid.levels.length - 1];
      let peak = 0;
      if (top) for (let i = 0; i < top.length; i += 1) peak = Math.max(peak, Math.abs(top[i]!));
      gain = peak > 0 ? Math.min(MAX_WAVE_GAIN, 127 / peak) : 1;
      this.peakLevel.set(pyramid, gain);
    }
    return gain;
  }

  /**
   * Converted notes, Flex Pitch style: each is the stretch of its region's own
   * waveform that the note covers, centred on the note's pitch row. They get
   * the same treatment as MIDI — a glow (the outline stroked wide and faint), a
   * velocity-scaled body, and full colour plus a halo and a lit key while
   * sounding. A faint note-shaped bar underneath keeps quiet passages legible.
   */
  private drawConvertedTrack(
    t: number,
    track: RollTrack,
    view: ViewState,
    toX: (s: number) => number,
    width: number,
    playhead: number,
    windowStart: number,
    windowEnd: number,
  ): void {
    const { ctx } = this;
    const sources = track.sources;
    const source = track.source;
    if (!sources || !source) return;
    const pps = view.pixelsPerSecond;
    const spp = 1 / pps;
    const noteHeight = Math.max(1.5, this.rowHeight - this.noteInset * 2);
    const amplitude = Math.max(5, this.rowHeight * WAVE_ROWS);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'bevel';
    ctx.lineWidth = GLOW_SPREAD * 2;

    for (let i = firstVisibleRollNote(track, windowStart); i < track.count; i += 1) {
      const start = track.start[i]!;
      if (start > windowEnd) break;
      const duration = track.duration[i]!;
      if (start + duration < windowStart) continue;
      const x = toX(start);
      const left = Math.floor(Math.max(KEY_WIDTH, x));
      const right = Math.min(width, x + duration * pps);
      if (right - left < 1) continue;

      const pitch = track.pitch[i]!;
      const rowTop = this.pitchY[pitch]!;
      const centre = rowTop + this.rowHeight / 2;
      const sounding = playhead >= start && playhead <= start + duration;
      const strength = track.bucket[i]! / (VELOCITY_BUCKETS - 1);
      if (this.emitting && start > this.emitFrom && start <= playhead) {
        this.particles.emit(toX(playhead), centre, t, strength, pps);
      }

      ctx.fillStyle = this.shade(track.color, sounding ? 0.35 : 0.16);
      ctx.fillRect(left, rowTop + this.noteInset, right - left, noteHeight);

      const region = sources[source[i]!]!;
      const pyramid = region.audioFileId ? view.peaks(region.audioFileId) : null;
      const regionX = toX(region.startSeconds);
      const noteRate = region.sourceRate > 0 ? region.sourceRate : 1;
      const count = pyramid
        ? this.envelope(
          pyramid, left, right, 1, regionX, spp,
          noteRate, region.fileStartSeconds,
          region.reversed, (region.endSeconds - region.startSeconds) * noteRate,
        )
        : 0;
      this.applyFades(region, count, left, 1, regionX, spp);
      if (count > 0) {
        const scale = amplitude * this.waveGain(pyramid!);
        const last = Math.min(right, left + count - 1);
        ctx.beginPath();
        for (let n = 0; n < count; n += 1) {
          // At least a pixel either side, so silence inside a note still reads as a line.
          const y = centre - Math.max(1, this.envHigh[n]! * scale);
          if (n === 0) ctx.moveTo(left, y);
          else ctx.lineTo(Math.min(last, left + n), y);
        }
        for (let n = count - 1; n >= 0; n -= 1) {
          ctx.lineTo(Math.min(last, left + n), centre + Math.max(1, -this.envLow[n]! * scale));
        }
        ctx.closePath();
        ctx.strokeStyle = this.shade(track.color, sounding ? 0.3 : 0.12);
        ctx.stroke();
        ctx.fillStyle = this.shade(track.color, sounding ? 1 : Math.round((0.45 + strength * 0.5) * 20) / 20);
        ctx.fill();
      }

      if (sounding) {
        this.litKeys[pitch] = t;
        this.waveSprites.push(t, centre, 0, 0);
      }
    }
  }

  /**
   * Sounding notes: full-strength track colour with a stronger glow, and a
   * white-hot halo where each meets the playhead. The whole note is not turned
   * white — a sustained pad would become a bar of white across the screen.
   * Flashes arrive grouped by track, so fillStyle changes once per track.
   */
  private drawFlashes(scene: RollScene, centreX: number): void {
    const count = this.flashes.size;
    const waves = this.waveSprites.size;
    if (count === 0 && waves === 0) return;
    const { ctx } = this;
    ctx.globalCompositeOperation = 'lighter';
    let current = -1;
    let color = '';
    for (let i = 0; i < count; i += 1) {
      const t = this.flashTrack[i]!;
      if (t !== current) {
        current = t;
        color = scene.tracks[t]?.color ?? '#ffffff';
      }
      const x = this.flashes.x(i);
      const y = this.flashes.y(i);
      const w = this.flashes.w(i);
      const h = this.flashes.h(i);
      ctx.fillStyle = this.shade(color, 0.3);
      ctx.fillRect(x - GLOW_SPREAD, y - GLOW_SPREAD, w + GLOW_SPREAD * 2, h + GLOW_SPREAD * 2);
      ctx.fillStyle = this.shade(color, 1);
      ctx.fillRect(x, y, w, h);
    }

    // A dense chord stacks halos on one column; thin them so it glows, not blows out.
    ctx.globalAlpha = Math.min(1, 6 / Math.max(1, count + waves));
    const half = SPRITE_SIZE / 2;
    for (let i = 0; i < waves && i < MAX_SPRITES; i += 1) {
      const track = scene.tracks[this.waveSprites.x(i)];
      if (!track) continue;
      const y = this.waveSprites.y(i);
      ctx.drawImage(this.sprite(track.color), centreX - half, y - half, SPRITE_SIZE, SPRITE_SIZE);
    }
    const sprites = Math.min(count, MAX_SPRITES);
    for (let i = 0; i < sprites; i += 1) {
      const track = scene.tracks[this.flashTrack[i]!];
      if (!track) continue;
      const y = this.flashes.y(i) + this.flashes.h(i) / 2;
      ctx.drawImage(this.sprite(track.color), centreX - half, y - half, SPRITE_SIZE, SPRITE_SIZE);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawLitKeys(scene: RollScene): void {
    const { ctx } = this;
    ctx.globalCompositeOperation = 'lighter';
    for (let pitch = scene.pitchLow; pitch <= scene.pitchHigh; pitch += 1) {
      const t = this.litKeys[pitch]!;
      if (t < 0) continue;
      const track = scene.tracks[t];
      if (!track) continue;
      const y = this.pitchY[pitch]!;
      ctx.fillStyle = this.shade(track.color, 0.35);
      ctx.fillRect(0, y - 1, KEY_WIDTH + 6, this.rowHeight + 2);
      ctx.fillStyle = this.shade(track.color, 0.95);
      ctx.fillRect(0, y + 0.5, KEY_WIDTH - 2, Math.max(1, this.rowHeight - 1));
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Draws the bounce strip and returns its level at the playhead, 0..1. */
  private drawBounce(view: ViewState, centreX: number, width: number, height: number): number {
    const pyramid = view.bouncePeaks;
    if (!pyramid || !this.bounceFill) return 0;
    const { ctx } = this;
    const top = this.bounceTop;
    const bottom = height - 8;
    const centre = (top + bottom) / 2;
    const amplitude = (bottom - top) / 2;
    // Lined up with the roll's content, right of the keyboard strip.
    const left = KEY_WIDTH;
    const count = this.envelope(
      pyramid, left, width, 1, centreX, 1 / view.pixelsPerSecond, 1,
      view.playheadSeconds + (view.bounceOffset ?? 0),
    );
    if (count === 0) return 0;
    ctx.fillStyle = this.bounceFill;
    this.fillEnvelope(count, left, 1, centre, amplitude);

    const at = Math.min(count - 1, Math.max(0, Math.round(centreX - left)));
    return Math.min(1, Math.max(Math.abs(this.envHigh[at]!), Math.abs(this.envLow[at]!)));
  }

  /** The band breathes with the bounce's level at the playhead. */
  private drawPlayhead(centreX: number, height: number, level: number): void {
    const { ctx } = this;
    if (this.playheadBand) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.45 + level * 0.55;
      ctx.fillStyle = this.playheadBand;
      ctx.fillRect(centreX - 48, 0, 96, height);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillRect(Math.round(centreX) - 0.75, 0, 1.5, height);
  }
}
