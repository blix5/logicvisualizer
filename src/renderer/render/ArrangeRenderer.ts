// Canvas 2D renderer for the Logic-like arrange view.
//
// The playhead is fixed at horizontal centre and never moves; the content
// translates underneath it. Only the visible time window is drawn — regions and
// notes are both found by binary search and culled against that window.
//
// Two rules keep a dense arrangement affordable:
//   1. Notes are batched by velocity bucket and flushed once per lane, so a
//      lane costs ~8 fillStyle changes instead of one per note. Assigning
//      fillStyle reparses a CSS colour string, which dominated the note loop.
//   2. Region and note fills are clamped to the viewport plus a margin: a
//      region is as wide as it is long, which at high zoom is enormous.
import { regionLabel, type AudioRegionModel, type RegionModel } from '../../shared/model';
import type { BarGridEntry } from '../../shared/timebase';
import { levelForPixelsPerSecond, peakCount, type PeakPyramid } from './peaks';
import { fadeGain, hasFade } from './fade';
import { volumeGain, type VolumeCurve } from '../../shared/automation';
import { RectBuffer } from './rectBuffer';
import type { SpectrumMode } from './spectrum';
import type { Backdrop } from './backdrop';
import { DEFAULT_CANVAS_THEME, type CanvasTheme } from '../theme/themes';
import {
  NOTE_FIELDS,
  LEVEL_STEPS,
  NOTE_BUFFER_COUNT,
  noteBufferIndex,
  VELOCITY_BUCKETS,
  firstVisibleIndex,
  firstVisibleNote,
  type LaneLayout,
  type NoteBatch,
  type Scene,
} from './scene';

export type RenderMode = 'arrange' | 'roll';

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
  /** Live analyser output per channel, for the piano roll's spectrum views. */
  spectrum?: StereoSpectrum | null;
  /** Which spectrum view the piano roll draws over everything. */
  spectrumMode?: SpectrumMode;
  /** True while audio is playing: the spectrogram trail only records then. */
  spectrumLive?: boolean;
  /**
   * Pixels at the top covered by the floating toolbar. Arrange starts below it
   * so the ruler stays readable; the piano roll draws underneath on purpose.
   */
  topInset?: number;
  /** Piano roll: burst particles where the playhead meets each note. */
  particles?: boolean;
};

const LANE_LABEL_WIDTH = 168;
const RULER_HEIGHT = 26;
/** Clamp margin, so clamped fills never show an edge inside the viewport. */
const EDGE_MARGIN = 8;
/** Opacity of the lane, ruler and label grounds over a background image. */
const BACKDROP_VEIL = 0.55;

export function withAlpha(color: string, alpha: number): string {
  // Track colours are hsl(...) strings; hsl() accepts a slash-alpha suffix.
  return color.startsWith('hsl(') ? `${color.slice(0, -1)} / ${alpha})` : color;
}

export class ArrangeRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;

  private readonly alphaCache = new Map<string, string>();
  private theme: CanvasTheme = DEFAULT_CANVAS_THEME;
  /** The background image, when this view shows one. */
  private backdrop: Backdrop | null = null;
  /** Opacity of the grounds drawn over the backdrop: 1 without one. */
  private veil = 1;
  /** One buffer per (automation level, velocity bucket); see noteBufferIndex. */
  private readonly noteBuckets: RectBuffer[] =
    Array.from({ length: NOTE_BUFFER_COUNT }, () => new RectBuffer());
  private readonly waveform = new RectBuffer();
  /** Muted regions' notes and waveforms, flushed together in grey. */
  private readonly mutedNotes = new RectBuffer();
  private readonly mutedWaveform = new RectBuffer();

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
  }

  setTheme(theme: CanvasTheme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    // Keyed by colour string; the old theme's track colours will not recur.
    this.alphaCache.clear();
  }

  /** The background image to draw under this view, or null for none. */
  setBackdrop(backdrop: Backdrop | null): void {
    this.backdrop = backdrop;
  }

  /** The background: the backdrop layer when there is one, else the theme's colour. */
  private paintBackground(): void {
    const { ctx, canvas } = this;
    const layer = this.backdrop?.layerFor(canvas.width, canvas.height, this.dpr, this.theme.arrangeBg) ?? null;
    this.veil = layer ? BACKDROP_VEIL : 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (layer) {
      ctx.drawImage(layer, 0, 0);
    } else {
      ctx.fillStyle = this.theme.arrangeBg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
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

  /** Paints the background only. Used before a project is open. */
  clear(): void {
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;
    this.paintBackground();
  }

  draw(scene: Scene, view: ViewState): void {
    const { ctx } = this;
    const width = this.canvas.width / this.dpr;
    const inset = view.topInset ?? 0;
    const height = this.canvas.height / this.dpr - inset;

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    this.paintBackground();
    // Everything below is laid out from y = 0 as before, just shifted down.
    ctx.translate(0, inset);

    const centreX = width / 2;
    const secondsPerPixel = 1 / view.pixelsPerSecond;
    const windowStart = view.playheadSeconds - centreX * secondsPerPixel;
    const windowEnd = view.playheadSeconds + (width - centreX) * secondsPerPixel;
    const toX = (seconds: number) => centreX + (seconds - view.playheadSeconds) * view.pixelsPerSecond;

    this.drawBarGrid(view, toX, width, height, windowStart, windowEnd);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_HEIGHT, width, height - RULER_HEIGHT);
    ctx.clip();
    ctx.translate(0, RULER_HEIGHT - view.scrollTop);

    for (const lane of scene.lanes) {
      if (lane.top - view.scrollTop > height || lane.top + lane.height - view.scrollTop < 0) continue;
      this.drawLane(lane, view, toX, width, windowStart, windowEnd);
    }
    ctx.restore();

    this.drawLaneLabels(scene, view, height);
    this.drawPlayhead(centreX, height);
  }

  private drawLane(
    lane: LaneLayout,
    view: ViewState,
    toX: (s: number) => number,
    width: number,
    windowStart: number,
    windowEnd: number,
  ): void {
    const { ctx } = this;
    const laneTop = lane.top;

    ctx.globalAlpha = this.veil;
    ctx.fillStyle = this.theme.laneBg;
    ctx.fillRect(0, laneTop, width, lane.height);
    ctx.globalAlpha = 1;

    for (const buffer of this.noteBuckets) buffer.reset();
    this.waveform.reset();
    this.mutedNotes.reset();
    this.mutedWaveform.reset();

    // Pass 1: region blocks, and notes gathered into per-velocity buckets.
    const start = firstVisibleIndex(lane, windowStart);
    for (let i = start; i < lane.regions.length; i += 1) {
      const entry = lane.regions[i];
      if (!entry) continue;
      if (entry.region.startSeconds > windowEnd) break;
      if (entry.region.endSeconds < windowStart) continue;

      this.drawRegionBlock(entry.region, lane, laneTop, toX, view, width);
      if (entry.notes) {
        this.collectNotes(entry.notes, laneTop, toX, view, width, windowStart, windowEnd, entry.region.muted || lane.muted);
      }
    }

    this.flushLane(lane.color);

    // Pass 2: names last, so notes never cover them.
    for (let i = start; i < lane.regions.length; i += 1) {
      const entry = lane.regions[i];
      if (!entry) continue;
      if (entry.region.startSeconds > windowEnd) break;
      if (entry.region.endSeconds < windowStart) continue;
      this.drawRegionName(entry.region, laneTop, toX, view);
    }
  }

  private drawBarGrid(
    view: ViewState,
    toX: (s: number) => number,
    width: number,
    height: number,
    windowStart: number,
    windowEnd: number,
  ): void {
    const { ctx } = this;
    const { theme } = this;
    ctx.globalAlpha = this.veil;
    ctx.fillStyle = theme.rulerBg;
    ctx.fillRect(0, 0, width, RULER_HEIGHT);
    ctx.globalAlpha = 1;
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
      ctx.strokeStyle = major ? theme.gridMajor : theme.gridMinor;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, RULER_HEIGHT);
      ctx.lineTo(Math.round(x) + 0.5, height);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = theme.rulerText;
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
    width: number,
  ): void {
    const { ctx } = this;
    const x = toX(region.startSeconds);
    const w = Math.max(2, (region.endSeconds - region.startSeconds) * view.pixelsPerSecond);
    // A muted region is never "active": it makes no sound under the playhead.
    // Region mute or track mute: either way the region is silent, and Logic
    // greys both.
    const muted = region.muted || lane.muted;
    const active = !muted
      && view.playheadSeconds >= region.startSeconds && view.playheadSeconds <= region.endSeconds;
    const color = muted ? this.theme.muted : lane.color;

    // A region is as wide as it is long: at 800 px/s a five-minute region is
    // 240k px. Only the visible slice is ever painted.
    const fillX = Math.max(-EDGE_MARGIN, x);
    const fillW = Math.min(width + EDGE_MARGIN, x + w) - fillX;
    if (fillW <= 0) return;

    ctx.fillStyle = this.shade(color, active ? 0.42 : muted ? 0.16 : 0.3);
    ctx.fillRect(fillX, laneTop + 2, fillW, lane.height - 4);
    // Strokes are four clipped line segments, so the true rect is fine here.
    ctx.strokeStyle = this.shade(color, muted ? 0.5 : 0.85);
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, laneTop + 2.5, Math.round(w) - 1, lane.height - 5);

    if (region.kind === 'audio') {
      const pyramid = region.audioFileId ? view.peaks(region.audioFileId) : null;
      if (pyramid) {
        this.collectWaveform(pyramid, region, lane.volume, laneTop, lane.height, toX, view, fillX, fillW, muted);
      } else {
        // Peaks not read yet, or no file to read: the centre line keeps the
        // region legible rather than leaving it empty.
        ctx.fillStyle = this.shade(color, 0.5);
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
    volume: VolumeCurve | null,
    laneTop: number,
    laneHeight: number,
    toX: (s: number) => number,
    view: ViewState,
    fillX: number,
    fillW: number,
    muted: boolean,
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
    const faded = hasFade(region);
    const target = muted ? this.mutedWaveform : this.waveform;

    for (let x = left; x < right; x += 1) {
      // Timeline seconds map to SOURCE seconds via the trim-in and the flex
      // stretch: a flexed region consumes sourceRate seconds of audio per second
      // of timeline. Ignoring the rate truncates or overruns a stretched
      // region's waveform. A reversed region maps back-to-front: the source runs
      // from the trimmed span's end toward its start as x increases, so the drawn
      // waveform mirrors horizontally.
      const dtFrom = (x - startX) * secondsPerPixel * sourceRate;
      const dtTo = (x + 1 - startX) * secondsPerPixel * sourceRate;
      let from: number;
      let to: number;
      if (region.reversed) {
        const sourceSpan = (region.endSeconds - region.startSeconds) * sourceRate;
        from = region.fileStartSeconds + sourceSpan - dtTo;
        to = region.fileStartSeconds + sourceSpan - dtFrom;
      } else {
        from = region.fileStartSeconds + dtFrom;
        to = region.fileStartSeconds + dtTo;
      }
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

      // Fades and the track's volume automation taper the waveform the way
      // they taper the sound. A boost above unity can push a loud file past
      // the lane, so the column is clipped to it.
      const seconds = region.startSeconds + (x + 0.5 - startX) * secondsPerPixel;
      let scale = amplitude;
      if (faded) scale *= fadeGain(region, seconds);
      if (volume) scale *= volumeGain(volume, seconds);
      const top = Math.max(centre - amplitude, centre - (high / 127) * scale);
      const bottom = Math.min(centre + amplitude, centre - (low / 127) * scale);
      target.push(x, top, 1, Math.max(1, bottom - top));
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
    ctx.fillStyle = this.theme.regionText;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 3, laneTop + 3, w - 6, 12);
    ctx.clip();
    ctx.fillText(regionLabel(region), x + 4, laneTop + 4);
    ctx.restore();
  }

  private collectNotes(
    batch: NoteBatch,
    laneTop: number,
    toX: (s: number) => number,
    view: ViewState,
    width: number,
    windowStart: number,
    windowEnd: number,
    muted: boolean,
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

      if (muted) {
        this.mutedNotes.push(drawX, y, drawW, height);
        continue;
      }
      // Automated to silence: nothing sounds, so nothing is drawn.
      const level = batch.levels[i]!;
      if (level === 0) continue;
      this.noteBuckets[noteBufferIndex(level, batch.buckets[i]!)]!.push(drawX, y, drawW, height);
    }
  }

  private flushLane(laneColor: string): void {
    const { ctx } = this;
    if (this.waveform.size > 0) {
      ctx.fillStyle = this.shade(laneColor, 0.8);
      this.waveform.fillInto(ctx);
    }
    if (this.mutedWaveform.size > 0 || this.mutedNotes.size > 0) {
      ctx.fillStyle = this.shade(this.theme.muted, 0.45);
      this.mutedWaveform.fillInto(ctx);
      this.mutedNotes.fillInto(ctx);
    }

    // Opacity is velocity's alpha scaled by the volume automation's level.
    for (let level = 1; level <= LEVEL_STEPS; level += 1) {
      for (let bucket = 0; bucket < VELOCITY_BUCKETS; bucket += 1) {
        const buffer = this.noteBuckets[noteBufferIndex(level, bucket)]!;
        if (buffer.size === 0) continue;
        const velocityAlpha = 0.45 + (bucket / (VELOCITY_BUCKETS - 1)) * 0.55;
        ctx.fillStyle = this.shade(laneColor, velocityAlpha * (level / LEVEL_STEPS));
        buffer.fillInto(ctx);
      }
    }
  }

  private drawLaneLabels(scene: Scene, view: ViewState, height: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_HEIGHT, LANE_LABEL_WIDTH, height - RULER_HEIGHT);
    ctx.clip();
    const { theme } = this;
    ctx.globalAlpha = this.veil;
    ctx.fillStyle = theme.labelBg;
    ctx.fillRect(0, RULER_HEIGHT, LANE_LABEL_WIDTH, height - RULER_HEIGHT);
    ctx.globalAlpha = 1;
    ctx.translate(0, RULER_HEIGHT - view.scrollTop);
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const lane of scene.lanes) {
      if (lane.top - view.scrollTop > height || lane.top + lane.height - view.scrollTop < 0) continue;
      ctx.fillStyle = lane.muted ? theme.muted : lane.color;
      ctx.fillRect(0, lane.top + 2, 3, lane.height - 4);
      ctx.fillStyle = lane.muted ? theme.laneTextMuted : theme.laneText;
      ctx.fillText(lane.name.slice(0, 26), 10, lane.top + lane.height / 2);
    }
    ctx.restore();
    ctx.strokeStyle = theme.laneDivider;
    ctx.beginPath();
    ctx.moveTo(LANE_LABEL_WIDTH + 0.5, RULER_HEIGHT);
    ctx.lineTo(LANE_LABEL_WIDTH + 0.5, height);
    ctx.stroke();
  }

  private drawPlayhead(centreX: number, height: number): void {
    const { ctx } = this;
    ctx.strokeStyle = this.theme.playhead;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(Math.round(centreX) + 0.5, 0);
    ctx.lineTo(Math.round(centreX) + 0.5, height);
    ctx.stroke();
  }
}
