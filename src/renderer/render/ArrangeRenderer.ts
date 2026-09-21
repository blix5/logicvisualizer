// Canvas 2D renderer for the Logic-like arrange view.
//
// The playhead is fixed at horizontal centre and never moves; the content
// translates underneath it. Only the visible time window is drawn — regions and
// notes are both found by binary search and culled against that window.
//
// Stylized mode is the expensive one, so three rules keep it affordable:
//   1. No per-shape shadow blur. Blur forces an offscreen gaussian pass and is
//      costed on the shape's full bounds, which for a region rect can be tens
//      of thousands of pixels wide. The region glow is a cached vertical
//      gradient instead; only the handful of notes under the playhead still
//      blur, and that count is capped.
//   2. Notes are batched by velocity bucket and flushed once per lane, so a
//      lane costs ~8 fillStyle changes instead of one per note. Assigning
//      fillStyle reparses a CSS colour string, which dominated the note loop.
//   3. Blurred and gradient fills are clamped to the viewport plus a margin.
import type { AudioRegionModel, RegionModel } from '../../shared/model';
import type { BarGridEntry } from '../../shared/timebase';
import { levelForPixelsPerSecond, peakCount, type PeakPyramid } from './peaks';
import { RectBuffer } from './rectBuffer';
import {
  NOTE_FIELDS,
  VELOCITY_BUCKETS,
  firstVisibleIndex,
  firstVisibleNote,
  type LaneLayout,
  type NoteBatch,
  type Scene,
} from './scene';

export type RenderMode = 'arrange' | 'stylized' | 'roll';

/** dB per FFT bin for each channel of the bounce, as AnalyserNode reports it. */
export type StereoSpectrum = { left: Float32Array; right: Float32Array; sampleRate: number };

export type ViewState = {
  pixelsPerSecond: number;
  /** Project seconds at the centre line. */
  playheadSeconds: number;
  scrollTop: number;
  mode: RenderMode;
  barGrid: BarGridEntry[];
  /**
   * Waveform peaks by audio file id. A lookup rather than scene data because
   * peaks arrive asynchronously while the scene is built once per project.
   */
  peaks: (audioFileId: string) => PeakPyramid | null;
  /** The bounced mixdown's peaks, once reduced. Only the piano roll draws it. */
  bouncePeaks?: PeakPyramid | null;
  /** Bounce seconds minus project seconds; places the bounce on the timeline. */
  bounceOffset?: number;
  /** Live analyser output per channel, for the piano roll's spectrum lines. */
  spectrum?: StereoSpectrum | null;
};

const LANE_LABEL_WIDTH = 168;
const RULER_HEIGHT = 26;
/** Vertical reach of the stylized region glow, above and below the lane. */
const GLOW_PAD = 22;
const NOTE_BLUR = 18;
/** Past this many notes under the playhead at once, the flash drops its blur. */
const MAX_BLURRED_FLASHES = 48;
/** Clamp margin for fills whose paint spreads beyond the rect. */
const EDGE_MARGIN = GLOW_PAD + 8;

export function withAlpha(color: string, alpha: number): string {
  // Track colours are hsl(...) strings; hsl() accepts a slash-alpha suffix.
  return color.startsWith('hsl(') ? `${color.slice(0, -1)} / ${alpha})` : color;
}

export class ArrangeRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;

  private readonly alphaCache = new Map<string, string>();
  private readonly glowCache = new Map<string, CanvasGradient>();
  private readonly noteBuckets: RectBuffer[] =
    Array.from({ length: VELOCITY_BUCKETS }, () => new RectBuffer());
  private readonly flashes = new RectBuffer();
  private readonly waveform = new RectBuffer();
  private playheadGradient: CanvasGradient | null = null;
  private playheadGradientKey = '';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is unavailable.');
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.playheadGradient = null;
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

  /**
   * The stylized glow, as a gradient rather than a shadow. Defined in a local
   * space of 0..(laneHeight + 2 * GLOW_PAD) so one gradient serves every lane;
   * the caller translates to the lane before filling.
   */
  private glow(color: string, laneHeight: number, active: boolean): CanvasGradient {
    const key = `${color}|${laneHeight}|${active ? 1 : 0}`;
    const cached = this.glowCache.get(key);
    if (cached) return cached;

    const height = laneHeight + GLOW_PAD * 2;
    const edge = GLOW_PAD / height;
    const peak = active ? 0.34 : 0.18;
    const gradient = this.ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, withAlpha(color, 0));
    gradient.addColorStop(edge * 0.55, withAlpha(color, peak * 0.3));
    gradient.addColorStop(edge, withAlpha(color, peak));
    gradient.addColorStop(1 - edge, withAlpha(color, peak));
    gradient.addColorStop(1 - edge * 0.55, withAlpha(color, peak * 0.3));
    gradient.addColorStop(1, withAlpha(color, 0));
    this.glowCache.set(key, gradient);
    return gradient;
  }

  /** Paints the background only. Used before a project is open. */
  clear(mode: RenderMode): void {
    const width = this.canvas.width / this.dpr;
    const height = this.canvas.height / this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.fillStyle = mode === 'arrange' ? '#0b0d12' : '#05060a';
    this.ctx.fillRect(0, 0, width, height);
  }

  draw(scene: Scene, view: ViewState): void {
    const { ctx } = this;
    const width = this.canvas.width / this.dpr;
    const height = this.canvas.height / this.dpr;
    const stylized = view.mode === 'stylized';

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    ctx.fillStyle = stylized ? '#05060a' : '#0b0d12';
    ctx.fillRect(0, 0, width, height);

    const centreX = width / 2;
    const secondsPerPixel = 1 / view.pixelsPerSecond;
    const windowStart = view.playheadSeconds - centreX * secondsPerPixel;
    const windowEnd = view.playheadSeconds + (width - centreX) * secondsPerPixel;
    const toX = (seconds: number) => centreX + (seconds - view.playheadSeconds) * view.pixelsPerSecond;

    this.drawBarGrid(view, toX, width, height, windowStart, windowEnd, stylized);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_HEIGHT, width, height - RULER_HEIGHT);
    ctx.clip();
    ctx.translate(0, RULER_HEIGHT - view.scrollTop);

    for (const lane of scene.lanes) {
      if (lane.top - view.scrollTop > height || lane.top + lane.height - view.scrollTop < 0) continue;
      this.drawLane(lane, view, toX, stylized, width, windowStart, windowEnd);
    }
    ctx.restore();

    this.drawLaneLabels(scene, view, height, stylized);
    this.drawPlayhead(centreX, height, stylized);
  }

  private drawLane(
    lane: LaneLayout,
    view: ViewState,
    toX: (s: number) => number,
    stylized: boolean,
    width: number,
    windowStart: number,
    windowEnd: number,
  ): void {
    const { ctx } = this;
    const laneTop = lane.top;

    if (!stylized) {
      ctx.fillStyle = '#12151d';
      ctx.fillRect(0, laneTop, width, lane.height);
    }

    for (const buffer of this.noteBuckets) buffer.reset();
    this.flashes.reset();
    this.waveform.reset();

    // Pass 1: region blocks, and notes gathered into per-velocity buckets.
    const start = firstVisibleIndex(lane, windowStart);
    for (let i = start; i < lane.regions.length; i += 1) {
      const entry = lane.regions[i];
      if (!entry) continue;
      if (entry.region.startSeconds > windowEnd) break;
      if (entry.region.endSeconds < windowStart) continue;

      this.drawRegionBlock(entry.region, lane, laneTop, toX, view, stylized, width);
      if (entry.notes) {
        this.collectNotes(entry.notes, laneTop, toX, view, stylized, width, windowStart, windowEnd);
      }
    }

    this.flushLane(lane.color, stylized);

    // Pass 2: names last, so notes never cover them.
    if (!stylized) {
      for (let i = start; i < lane.regions.length; i += 1) {
        const entry = lane.regions[i];
        if (!entry) continue;
        if (entry.region.startSeconds > windowEnd) break;
        if (entry.region.endSeconds < windowStart) continue;
        this.drawRegionName(entry.region, laneTop, toX, view);
      }
    }
  }

  private drawBarGrid(
    view: ViewState,
    toX: (s: number) => number,
    width: number,
    height: number,
    windowStart: number,
    windowEnd: number,
    stylized: boolean,
  ): void {
    const { ctx } = this;
    ctx.fillStyle = stylized ? '#07080d' : '#0e1117';
    ctx.fillRect(0, 0, width, RULER_HEIGHT);
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';

    // The grid runs the length of the song; seek into it rather than scanning
    // every bar from the top on each frame.
    const grid = view.barGrid;
    let low = 0;
    let high = grid.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((grid[mid]?.seconds ?? Infinity) < windowStart) low = mid + 1;
      else high = mid;
    }

    for (let i = low; i < grid.length; i += 1) {
      const entry = grid[i];
      if (!entry) continue;
      if (entry.seconds > windowEnd) break;
      const x = toX(entry.seconds);
      const major = (entry.bar - 1) % 4 === 0;
      ctx.strokeStyle = major ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, RULER_HEIGHT);
      ctx.lineTo(Math.round(x) + 0.5, height);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText(String(entry.bar), x + 4, RULER_HEIGHT / 2);
      }
    }
  }

  private drawRegionBlock(
    region: RegionModel,
    lane: LaneLayout,
    laneTop: number,
    toX: (s: number) => number,
    view: ViewState,
    stylized: boolean,
    width: number,
  ): void {
    const { ctx } = this;
    const x = toX(region.startSeconds);
    const w = Math.max(2, (region.endSeconds - region.startSeconds) * view.pixelsPerSecond);
    const active = view.playheadSeconds >= region.startSeconds && view.playheadSeconds <= region.endSeconds;

    // A region is as wide as it is long: at 800 px/s a five-minute region is
    // 240k px. Only the visible slice is ever painted.
    const fillX = Math.max(-EDGE_MARGIN, x);
    const fillW = Math.min(width + EDGE_MARGIN, x + w) - fillX;
    if (fillW <= 0) return;

    if (stylized) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(0, laneTop - GLOW_PAD);
      ctx.fillStyle = this.glow(lane.color, lane.height, active);
      ctx.fillRect(fillX, 0, fillW, lane.height + GLOW_PAD * 2);
      ctx.restore();
    } else {
      ctx.fillStyle = this.shade(lane.color, active ? 0.42 : 0.3);
      ctx.fillRect(fillX, laneTop + 2, fillW, lane.height - 4);
      // Strokes are four clipped line segments, so the true rect is fine here.
      ctx.strokeStyle = this.shade(lane.color, 0.85);
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x) + 0.5, laneTop + 2.5, Math.round(w) - 1, lane.height - 5);
    }

    if (region.kind === 'audio') {
      const pyramid = region.audioFileId ? view.peaks(region.audioFileId) : null;
      if (pyramid) {
        this.collectWaveform(pyramid, region, laneTop, lane.height, toX, view, fillX, fillW);
      } else {
        // Peaks not read yet, or no file to read: the centre line keeps the
        // region legible rather than leaving it empty.
        ctx.fillStyle = this.shade(lane.color, 0.5);
        ctx.fillRect(fillX, laneTop + lane.height / 2 - 1, fillW, 2);
      }
    }
  }

  /**
   * One mirrored min/max column per screen pixel, gathered into the lane's
   * waveform buffer so the whole lane flushes under a single fillStyle.
   */
  private collectWaveform(
    pyramid: PeakPyramid,
    region: AudioRegionModel,
    laneTop: number,
    laneHeight: number,
    toX: (s: number) => number,
    view: ViewState,
    fillX: number,
    fillW: number,
  ): void {
    const level = levelForPixelsPerSecond(pyramid, view.pixelsPerSecond);
    const data = pyramid.levels[level];
    const rate = pyramid.rates[level] ?? 0;
    // Seconds of source audio per timeline second; not to be confused with
    // `rate` above, which is the pyramid's buckets per second.
    const sourceRate = region.sourceRate > 0 ? region.sourceRate : 1;
    const buckets = peakCount(pyramid, level);
    if (!data || rate <= 0 || buckets === 0) return;

    const centre = laneTop + laneHeight / 2;
    const amplitude = (laneHeight - 8) / 2;
    const secondsPerPixel = 1 / view.pixelsPerSecond;
    const startX = toX(region.startSeconds);
    const endX = startX + (region.endSeconds - region.startSeconds) * view.pixelsPerSecond;
    const left = Math.floor(Math.max(fillX, startX));
    const right = Math.min(fillX + fillW, endX);

    for (let x = left; x < right; x += 1) {
      // Timeline seconds map to SOURCE seconds via the trim-in and the flex
      // stretch: a flexed region consumes sourceRate seconds of audio per second
      // of timeline. Ignoring the rate truncates or overruns a stretched
      // region's waveform.
      const from = (x - startX) * secondsPerPixel * sourceRate + region.fileStartSeconds;
      const to = (x + 1 - startX) * secondsPerPixel * sourceRate + region.fileStartSeconds;
      let first = Math.floor(from * rate);
      let last = Math.ceil(to * rate);
      if (last <= first) last = first + 1;
      if (last <= 0 || first >= buckets) continue;
      if (first < 0) first = 0;
      if (last > buckets) last = buckets;

      let low = 127;
      let high = -127;
      for (let bucket = first; bucket < last; bucket += 1) {
        const bucketLow = data[bucket * 2] ?? 0;
        const bucketHigh = data[bucket * 2 + 1] ?? 0;
        if (bucketLow < low) low = bucketLow;
        if (bucketHigh > high) high = bucketHigh;
      }

      const top = centre - (high / 127) * amplitude;
      const height = Math.max(1, centre - (low / 127) * amplitude - top);
      this.waveform.push(x, top, 1, height);
    }
  }

  private drawRegionName(
    region: RegionModel,
    laneTop: number,
    toX: (s: number) => number,
    view: ViewState,
  ): void {
    const { ctx } = this;
    const x = toX(region.startSeconds);
    const w = Math.max(2, (region.endSeconds - region.startSeconds) * view.pixelsPerSecond);
    if (w <= 46) return;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 3, laneTop + 3, w - 6, 12);
    ctx.clip();
    ctx.fillText(region.name, x + 4, laneTop + 4);
    ctx.restore();
  }

  private collectNotes(
    batch: NoteBatch,
    laneTop: number,
    toX: (s: number) => number,
    view: ViewState,
    stylized: boolean,
    width: number,
    windowStart: number,
    windowEnd: number,
  ): void {
    const height = batch.noteHeight;
    const from = firstVisibleNote(batch, windowStart);

    for (let i = from; i < batch.count; i += 1) {
      const offset = i * NOTE_FIELDS;
      const startSeconds = batch.data[offset]!;
      if (startSeconds > windowEnd) break;
      const durSeconds = batch.data[offset + 1]!;
      if (startSeconds + durSeconds < windowStart) continue;

      const x = toX(startSeconds);
      const drawX = Math.max(-EDGE_MARGIN, x);
      const drawW = Math.min(width + EDGE_MARGIN, x + Math.max(1.5, durSeconds * view.pixelsPerSecond)) - drawX;
      if (drawW <= 0) continue;
      const y = laneTop + batch.data[offset + 2]!;

      if (stylized
        && view.playheadSeconds >= startSeconds
        && view.playheadSeconds <= startSeconds + durSeconds) {
        this.flashes.push(drawX, y, drawW, height);
        continue;
      }
      this.noteBuckets[batch.buckets[i]!]!.push(drawX, y, drawW, height);
    }
  }

  private flushLane(laneColor: string, stylized: boolean): void {
    const { ctx } = this;
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = stylized ? 'lighter' : 'source-over';

    if (this.waveform.size > 0) {
      ctx.fillStyle = this.shade(laneColor, stylized ? 0.6 : 0.8);
      this.waveform.fillInto(ctx);
    }

    for (let bucket = 0; bucket < VELOCITY_BUCKETS; bucket += 1) {
      const buffer = this.noteBuckets[bucket]!;
      if (buffer.size === 0) continue;
      ctx.fillStyle = this.shade(laneColor, 0.45 + (bucket / (VELOCITY_BUCKETS - 1)) * 0.55);
      buffer.fillInto(ctx);
    }

    if (this.flashes.size > 0) {
      // A dense chord under the playhead would otherwise mean dozens of blurs
      // in one frame; past the cap the flash stays white but stops glowing.
      if (this.flashes.size <= MAX_BLURRED_FLASHES) {
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = NOTE_BLUR;
      }
      ctx.fillStyle = '#ffffff';
      this.flashes.fillInto(ctx);
    }
    ctx.restore();
  }

  private drawLaneLabels(scene: Scene, view: ViewState, height: number, stylized: boolean): void {
    if (stylized) return;
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_HEIGHT, LANE_LABEL_WIDTH, height - RULER_HEIGHT);
    ctx.clip();
    ctx.fillStyle = 'rgba(8,10,15,0.92)';
    ctx.fillRect(0, RULER_HEIGHT, LANE_LABEL_WIDTH, height - RULER_HEIGHT);
    ctx.translate(0, RULER_HEIGHT - view.scrollTop);
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const lane of scene.lanes) {
      if (lane.top - view.scrollTop > height || lane.top + lane.height - view.scrollTop < 0) continue;
      ctx.fillStyle = lane.color;
      ctx.fillRect(0, lane.top + 2, 3, lane.height - 4);
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillText(lane.name.slice(0, 26), 10, lane.top + lane.height / 2);
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(LANE_LABEL_WIDTH + 0.5, RULER_HEIGHT);
    ctx.lineTo(LANE_LABEL_WIDTH + 0.5, height);
    ctx.stroke();
  }

  private drawPlayhead(centreX: number, height: number, stylized: boolean): void {
    const { ctx } = this;
    if (stylized) {
      const key = `${centreX}|${height}`;
      if (!this.playheadGradient || this.playheadGradientKey !== key) {
        const gradient = ctx.createLinearGradient(centreX - 40, 0, centreX + 40, 0);
        gradient.addColorStop(0, 'rgba(255,255,255,0)');
        gradient.addColorStop(0.5, 'rgba(255,255,255,0.22)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        this.playheadGradient = gradient;
        this.playheadGradientKey = key;
      }
      ctx.fillStyle = this.playheadGradient;
      ctx.fillRect(centreX - 40, 0, 80, height);
    }
    ctx.strokeStyle = stylized ? 'rgba(255,255,255,0.9)' : '#ff5a5f';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(Math.round(centreX) + 0.5, 0);
    ctx.lineTo(Math.round(centreX) + 0.5, height);
    ctx.stroke();
  }
}
