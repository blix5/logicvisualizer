// Live spectrum views, drawn faintly over everything in the piano roll.
//
// All four read the same thing — AudioClock's left and right analysers, dB per
// FFT bin — and differ only in how they lay it out:
//   lines  a stroked log-frequency line per channel, left rising from the
//          bottom of the roll and right hanging from its top
//   bars   the same layout as 64 log-spaced bars with falling peak caps
//   pitch  the spectrum folded onto the roll's own pitch axis: each pitch row
//          grows a bar out from the playhead, left channel leftward and right
//          rightward, so it lines up with the notes and the keyboard
//   trail  a spectrogram of what has played, recorded into a ring canvas and
//          painted behind the playhead so it scrolls with the timeline
//
// The rules the rest of the renderer follows apply here too: lookup tables are
// cached and rebuilt only when their inputs change, nothing is allocated per
// frame, and nothing blurs.
import type { StereoSpectrum } from './ArrangeRenderer';
import { RectBuffer } from './rectBuffer';
import { DEFAULT_CANVAS_THEME, type CanvasTheme } from '../theme/themes';

export type SpectrumMode = 'none' | 'lines' | 'bars' | 'pitch' | 'trail';

export const SPECTRUM_MODES: { value: SpectrumMode; label: string }[] = [
  { value: 'none', label: 'No spectrum' },
  { value: 'lines', label: 'Stereo lines' },
  { value: 'bars', label: 'Mirrored bars' },
  { value: 'pitch', label: 'Pitch spectrum' },
  { value: 'trail', label: 'Spectrogram trail' },
];

/** Where the roll sits, as the piano-roll renderer has laid it out this frame. */
export type SpectrumLayout = {
  width: number;
  centreX: number;
  rollTop: number;
  rollBottom: number;
  /** Left edge of the roll proper; the keyboard strip sits before it. */
  keyWidth: number;
  pitchLow: number;
  pitchHigh: number;
  /** Top of each pitch row, indexed by MIDI pitch. */
  pitchY: Float32Array;
  rowHeight: number;
  /**
   * The whole canvas. Every view spans it — under the toolbar and through the
   * bounce band — rather than stopping at the pitch rows; the pitch-aligned
   * views extend the roll's pitch axis past both ends to do so.
   */
  canvasHeight: number;
  pixelsPerSecond: number;
  playheadSeconds: number;
  /** True while audio plays; the trail records only then. */
  live: boolean;
  /** Identity of the roll scene; a new one clears the trail. */
  scene: object;
};

const LOW_HZ = 30;
const HIGH_HZ = 16000;
/** dB range the views span, matching the analysers' min/max decibels. */
const FLOOR_DB = -95;
const CEIL_DB = -15;
/** Share of the roll's height each channel may reach in the lines and bars views. */
const REACH = 0.42;
const LINE_STEP = 2;
const BAR_COUNT = 64;
const BAR_GAP = 2;
/** Peak caps fall this fast, in dB per second of wall time. */
const CAP_FALL_DB_PER_SECOND = 24;
/** Share of the width each pitch-spectrum bar may reach from the playhead. */
const PITCH_REACH = 0.22;
/** Rows within this much of the loudest pitch get a second, stronger pass. */
const PITCH_STRONG = 0.9;
/** Spectrogram trail: columns per second of timeline, and ring length. */
const TRAIL_RATE = 50;
const TRAIL_COLUMNS = 4096;
const TRAIL_ROWS_PER_SEMITONE = 3;
/** Normalised level below which the trail stays transparent: the noise floor. */
const TRAIL_FLOOR = 0.3;
/** A jump larger than this starts a new run rather than smearing one column. */
const TRAIL_MAX_FILL = TRAIL_RATE;

/**
 * Channel colours as RGB plus an alpha per element, so edge-fade gradients can
 * be built from them. The RGB comes from the theme; the alphas are fixed.
 */
type Tint = { rgb: string; line: number; fill: number; bar: number; cap: number };
const LEFT_ALPHAS = { line: 0.26, fill: 0.035, bar: 0.1, cap: 0.4 };
const RIGHT_ALPHAS = { line: 0.24, fill: 0.03, bar: 0.09, cap: 0.36 };

/**
 * Soft edges. Every view fades out over this many pixels at the top and bottom
 * of the canvas, and toward both ends of the usable frequency range, so it
 * dissolves where there is nothing to read rather than stopping on a line.
 */
const EDGE_FADE_PX = 40;
/** Frequencies below the first and above the second fade in and out. */
const FADE_LOW_HZ = [30, 60] as const;
const FADE_HIGH_HZ = [12000, 16000] as const;
/** Share of the width, at each end of the frequency axis, over which lines and bars fade. */
const AXIS_FADE = 0.06;
/** Whole-view fade with overall loudness: invisible at the first, full at the second. */
const LOUDNESS_FADE = [0.03, 0.3] as const;
/** The pitch-aligned views never read outside this range (≈25 Hz to 18 kHz). */
const PITCH_MIN = 19;
const PITCH_MAX = 134;
/** Where the trail starts recording, it fades in over this many columns (0.5 s). */
const TRAIL_RUN_FADE = 25;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Fade for a row at canvas y whose centre frequency is `hz`. */
function rowFade(y: number, canvasHeight: number, hz: number): number {
  const edge = Math.min(1, y / EDGE_FADE_PX, (canvasHeight - y) / EDGE_FADE_PX);
  if (edge <= 0) return 0;
  const low = smoothstep(FADE_LOW_HZ[0], FADE_LOW_HZ[1], hz);
  const high = 1 - smoothstep(FADE_HIGH_HZ[0], FADE_HIGH_HZ[1], hz);
  return edge * low * high;
}

/**
 * The roll's pitch axis, carried past the pitch rows. Row p spans axis values
 * [p, p + 1) — its top edge is p + 1 — so a row's own pitch sits at p + 0.5.
 */
function pitchAtY(layout: SpectrumLayout, y: number): number {
  return layout.pitchHigh + 1 - (y - layout.rollTop) / layout.rowHeight;
}

function yOfPitch(layout: SpectrumLayout, pitch: number): number {
  return layout.rollTop + (layout.pitchHigh + 1 - pitch) * layout.rowHeight;
}

function normalise(db: number): number {
  const n = (db - FLOOR_DB) / (CEIL_DB - FLOOR_DB);
  return n <= 0 ? 0 : n >= 1 ? 1 : n;
}

function pitchToHz(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}

/** Loudest bin in [from, to]. */
function peakOf(db: Float32Array, from: number, to: number): number {
  let peak = -Infinity;
  for (let bin = from; bin <= to; bin += 1) if (db[bin]! > peak) peak = db[bin]!;
  return peak;
}

/** Inclusive FFT bin range per slice. */
type Bands = { from: Int32Array; to: Int32Array };

/** Bin ranges for `count` equal slices of a log-frequency axis. */
function logBands(count: number, bins: number, sampleRate: number): Bands {
  const from = new Int32Array(count);
  const to = new Int32Array(count);
  const hzPerBin = sampleRate / 2 / bins;
  const span = Math.log(HIGH_HZ / LOW_HZ);
  for (let c = 0; c < count; c += 1) {
    const lowHz = LOW_HZ * Math.exp((span * c) / count);
    const highHz = LOW_HZ * Math.exp((span * (c + 1)) / count);
    const first = Math.min(bins - 1, Math.floor(lowHz / hzPerBin));
    from[c] = first;
    to[c] = Math.min(bins - 1, Math.max(first, Math.ceil(highHz / hzPerBin)));
  }
  return { from, to };
}

/** Bin ranges for pitch slices ±`halfWidth` semitones around each of `centres`. */
function pitchBands(centres: Float32Array, halfWidth: number, bins: number, sampleRate: number): Bands {
  const from = new Int32Array(centres.length);
  const to = new Int32Array(centres.length);
  const hzPerBin = sampleRate / 2 / bins;
  for (let i = 0; i < centres.length; i += 1) {
    const low = pitchToHz(centres[i]! - halfWidth) / hzPerBin;
    const high = pitchToHz(centres[i]! + halfWidth) / hzPerBin;
    // A slice narrower than a bin still reads the bin it falls in.
    const first = Math.max(0, Math.min(bins - 1, Math.floor(low)));
    from[i] = first;
    to[i] = Math.max(first, Math.min(bins - 1, Math.floor(high)));
  }
  return { from, to };
}

export class SpectrumPainter {
  private theme: CanvasTheme = DEFAULT_CANVAS_THEME;
  private leftTint: Tint = { rgb: DEFAULT_CANVAS_THEME.spectrum.left, ...LEFT_ALPHAS };
  private rightTint: Tint = { rgb: DEFAULT_CANVAS_THEME.spectrum.right, ...RIGHT_ALPHAS };

  // shared: horizontal edge fades per tint element, keyed on width
  private axisKey = '';
  private readonly axisGradients = new Map<string, CanvasGradient>();

  // lines
  private lineKey = '';
  private lineBands: Bands = { from: new Int32Array(0), to: new Int32Array(0) };

  // bars
  private barKey = '';
  private barBands: Bands = { from: new Int32Array(0), to: new Int32Array(0) };
  private readonly capLeft = new Float32Array(BAR_COUNT).fill(FLOOR_DB);
  private readonly capRight = new Float32Array(BAR_COUNT).fill(FLOOR_DB);
  private capTime = 0;
  private readonly barsLeft = new RectBuffer();
  private readonly barsRight = new RectBuffer();
  private readonly capsLeft = new RectBuffer();
  private readonly capsRight = new RectBuffer();

  // pitch
  private pitchKey = '';
  private pitchBandsTable: Bands = { from: new Int32Array(0), to: new Int32Array(0) };
  /** Pitch rows across the whole canvas, bottom to top, and each one's fade. */
  private pitchFirst = 0;
  private pitchCount = 0;
  private pitchFade = new Float32Array(0);
  private readonly pitchLevelsLeft = new Float32Array(PITCH_MAX + 1);
  private readonly pitchLevelsRight = new Float32Array(PITCH_MAX + 1);
  private readonly pitchLeft = new RectBuffer();
  private readonly pitchRight = new RectBuffer();
  private readonly pitchStrongLeft = new RectBuffer();
  private readonly pitchStrongRight = new RectBuffer();
  private pitchGradientKey = '';
  private pitchGradientLeft: CanvasGradient | null = null;
  private pitchGradientRight: CanvasGradient | null = null;

  // trail
  private trailKey = '';
  private trailScene: object | null = null;
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;
  private trailColumn: ImageData | null = null;
  private trailRows = 0;
  /** Pitch at the trail canvas's top and bottom edges. */
  private trailTopPitch = 0;
  private trailBottomPitch = 0;
  private trailRowFade = new Float32Array(0);
  private trailAlpha = new Uint8Array(0);
  private trailRunStart = 0;
  private trailBandKey = '';
  private trailBands: Bands = { from: new Int32Array(0), to: new Int32Array(0) };
  /** Absolute column held by each ring slot, or -1. */
  private readonly trailStamp = new Float64Array(TRAIL_COLUMNS).fill(-1);
  private trailLast = -Infinity;

  setTheme(theme: CanvasTheme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.leftTint = { rgb: theme.spectrum.left, ...LEFT_ALPHAS };
    this.rightTint = { rgb: theme.spectrum.right, ...RIGHT_ALPHAS };
    // Gradients and the trail's recorded pixels carry the old colours.
    this.axisGradients.clear();
    this.pitchGradientKey = '';
    this.trailKey = '';
  }

  draw(
    ctx: CanvasRenderingContext2D,
    mode: SpectrumMode,
    spectrum: StereoSpectrum | null,
    layout: SpectrumLayout,
  ): void {
    if (mode === 'none') return;
    const valid = spectrum !== null && spectrum.left.length > 0 && spectrum.right.length === spectrum.left.length;
    ctx.save();
    if (mode === 'trail') {
      // The trail is history: it draws while paused, from what was recorded.
      if (valid && layout.live) this.recordTrail(spectrum, layout);
      this.drawTrail(ctx, layout);
    } else if (valid) {
      if (mode === 'lines') this.drawLines(ctx, spectrum, layout);
      else if (mode === 'bars') this.drawBars(ctx, spectrum, layout);
      else if (mode === 'pitch') this.drawPitch(ctx, spectrum, layout);
    }
    ctx.restore();
  }

  /**
   * A horizontal gradient in `tint` at `alpha`, transparent at both ends of the
   * frequency axis: lines and bars fade into the keyboard edge and the far
   * right rather than ending square.
   */
  private axisGradient(ctx: CanvasRenderingContext2D, layout: SpectrumLayout, tint: Tint, alpha: number): CanvasGradient {
    const key = `${layout.width}|${layout.keyWidth}`;
    if (key !== this.axisKey) {
      this.axisKey = key;
      this.axisGradients.clear();
    }
    const id = `${tint.rgb}|${alpha}`;
    let gradient = this.axisGradients.get(id);
    if (!gradient) {
      gradient = ctx.createLinearGradient(layout.keyWidth, 0, layout.width, 0);
      gradient.addColorStop(0, `rgba(${tint.rgb},0)`);
      gradient.addColorStop(AXIS_FADE, `rgba(${tint.rgb},${alpha})`);
      gradient.addColorStop(1 - AXIS_FADE * 1.5, `rgba(${tint.rgb},${alpha})`);
      gradient.addColorStop(1, `rgba(${tint.rgb},0)`);
      this.axisGradients.set(id, gradient);
    }
    return gradient;
  }

  // ---- lines ---------------------------------------------------------------

  private drawLines(ctx: CanvasRenderingContext2D, spectrum: StereoSpectrum, layout: SpectrumLayout): void {
    const columns = Math.max(0, Math.floor((layout.width - layout.keyWidth) / LINE_STEP) + 1);
    const key = `${layout.width}|${spectrum.left.length}|${spectrum.sampleRate}`;
    if (key !== this.lineKey) {
      this.lineKey = key;
      this.lineBands = logBands(columns, spectrum.left.length, spectrum.sampleRate);
    }
    // From the canvas edges, not the pitch rows: nothing cuts them off.
    const drewLeft = this.drawLine(ctx, spectrum.left, columns, layout, layout.canvasHeight, -1, this.leftTint);
    const drewRight = this.drawLine(ctx, spectrum.right, columns, layout, 0, 1, this.rightTint);
    ctx.globalAlpha = 1;
    this.drawChannelLabels(ctx, layout, drewLeft, drewRight);
  }

  /** One channel's line from `baseline` in `direction` (-1 up, +1 down); false when silent. */
  private drawLine(
    ctx: CanvasRenderingContext2D,
    db: Float32Array,
    columns: number,
    layout: SpectrumLayout,
    baseline: number,
    direction: number,
    tint: Tint,
  ): boolean {
    const reach = layout.canvasHeight * REACH * direction;
    let loudest = 0;
    ctx.beginPath();
    for (let c = 0; c < columns; c += 1) {
      const n = normalise(peakOf(db, this.lineBands.from[c]!, this.lineBands.to[c]!));
      if (n > loudest) loudest = n;
      const x = layout.keyWidth + c * LINE_STEP;
      const y = baseline + n * reach;
      if (c === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    // Fades with loudness as a whole, so silence dissolves it rather than
    // dropping it on a threshold.
    const presence = smoothstep(LOUDNESS_FADE[0], LOUDNESS_FADE[1], loudest);
    if (presence <= 0) return false;
    ctx.globalAlpha = presence;
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.axisGradient(ctx, layout, tint, tint.line);
    ctx.stroke();
    ctx.lineTo(layout.keyWidth + (columns - 1) * LINE_STEP, baseline);
    ctx.lineTo(layout.keyWidth, baseline);
    ctx.closePath();
    ctx.fillStyle = this.axisGradient(ctx, layout, tint, tint.fill);
    ctx.fill();
    return presence > 0.3;
  }

  private drawChannelLabels(ctx: CanvasRenderingContext2D, layout: SpectrumLayout, left: boolean, right: boolean): void {
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    // Just inside the soft edges, clear of the toolbar and the status bar.
    if (left) {
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = `rgba(${this.leftTint.rgb},0.35)`;
      ctx.fillText('L', layout.width - 6, layout.canvasHeight - EDGE_FADE_PX / 2);
    }
    if (right) {
      ctx.textBaseline = 'top';
      ctx.fillStyle = `rgba(${this.rightTint.rgb},0.35)`;
      ctx.fillText('R', layout.width - 6, layout.rollTop + 3);
    }
  }

  // ---- bars ----------------------------------------------------------------

  private drawBars(ctx: CanvasRenderingContext2D, spectrum: StereoSpectrum, layout: SpectrumLayout): void {
    const key = `${spectrum.left.length}|${spectrum.sampleRate}`;
    if (key !== this.barKey) {
      this.barKey = key;
      this.barBands = logBands(BAR_COUNT, spectrum.left.length, spectrum.sampleRate);
    }
    // Caps fall against wall time, so they look the same at any frame rate.
    const now = performance.now();
    const fall = this.capTime > 0 ? Math.min(1, (now - this.capTime) / 1000) * CAP_FALL_DB_PER_SECOND : 0;
    this.capTime = now;

    const slot = (layout.width - layout.keyWidth) / BAR_COUNT;
    const barWidth = Math.max(1, slot - BAR_GAP);
    const reach = layout.canvasHeight * REACH;
    const bottom = layout.canvasHeight;
    this.barsLeft.reset(); this.barsRight.reset(); this.capsLeft.reset(); this.capsRight.reset();
    let loudest = 0;

    for (let b = 0; b < BAR_COUNT; b += 1) {
      const x = layout.keyWidth + b * slot + BAR_GAP / 2;
      const from = this.barBands.from[b]!;
      const to = this.barBands.to[b]!;
      const left = Math.max(FLOOR_DB, peakOf(spectrum.left, from, to));
      const right = Math.max(FLOOR_DB, peakOf(spectrum.right, from, to));
      this.capLeft[b] = Math.max(left, this.capLeft[b]! - fall);
      this.capRight[b] = Math.max(right, this.capRight[b]! - fall);

      const hl = normalise(left) * reach;
      const hr = normalise(right) * reach;
      const cl = normalise(this.capLeft[b]!) * reach;
      const cr = normalise(this.capRight[b]!) * reach;
      if (hl > 0.5) this.barsLeft.push(x, bottom - hl, barWidth, hl);
      if (hr > 0.5) this.barsRight.push(x, 0, barWidth, hr);
      if (cl > 1) this.capsLeft.push(x, bottom - cl - 2, barWidth, 2);
      if (cr > 1) this.capsRight.push(x, cr, barWidth, 2);
      loudest = Math.max(loudest, cl / reach, cr / reach);
    }
    // Caps hold the recent peak, so the view fades out as they fall rather
    // than vanishing the moment the music stops.
    const presence = smoothstep(LOUDNESS_FADE[0], LOUDNESS_FADE[1], loudest);
    if (presence <= 0) return;

    ctx.globalAlpha = presence;
    ctx.globalCompositeOperation = this.theme.blend;
    const left = this.leftTint;
    const right = this.rightTint;
    ctx.fillStyle = this.axisGradient(ctx, layout, left, left.bar);
    this.barsLeft.fillInto(ctx);
    ctx.fillStyle = this.axisGradient(ctx, layout, right, right.bar);
    this.barsRight.fillInto(ctx);
    ctx.fillStyle = this.axisGradient(ctx, layout, left, left.cap);
    this.capsLeft.fillInto(ctx);
    ctx.fillStyle = this.axisGradient(ctx, layout, right, right.cap);
    this.capsRight.fillInto(ctx);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    this.drawChannelLabels(ctx, layout, presence > 0.3 && this.capsLeft.size > 0, presence > 0.3 && this.capsRight.size > 0);
  }

  // ---- pitch ---------------------------------------------------------------

  private drawPitch(ctx: CanvasRenderingContext2D, spectrum: StereoSpectrum, layout: SpectrumLayout): void {
    // Rows run the whole canvas: the roll's own pitch rows, plus the pitch axis
    // carried up under the toolbar and down through the bounce band.
    const top = Math.min(PITCH_MAX, Math.floor(pitchAtY(layout, 0)));
    const bottom = Math.max(PITCH_MIN, Math.ceil(pitchAtY(layout, layout.canvasHeight)) - 1);
    const key = `${spectrum.left.length}|${spectrum.sampleRate}|${bottom}|${top}|${layout.rollTop}|${layout.rowHeight}|${layout.canvasHeight}`;
    if (key !== this.pitchKey) {
      this.pitchKey = key;
      this.pitchFirst = bottom;
      this.pitchCount = Math.max(0, top - bottom + 1);
      const centres = new Float32Array(this.pitchCount);
      this.pitchFade = new Float32Array(this.pitchCount);
      for (let i = 0; i < this.pitchCount; i += 1) {
        const pitch = bottom + i;
        centres[i] = pitch;
        this.pitchFade[i] = rowFade(yOfPitch(layout, pitch + 0.5), layout.canvasHeight, pitchToHz(pitch));
      }
      this.pitchBandsTable = pitchBands(centres, 0.5, spectrum.left.length, spectrum.sampleRate);
    }

    const maxLength = layout.width * PITCH_REACH;
    const gradientKey = `${layout.centreX}|${maxLength}`;
    if (gradientKey !== this.pitchGradientKey) {
      this.pitchGradientKey = gradientKey;
      // Fades with distance from the playhead, so bars read as radiating from it.
      const make = (to: number) => {
        const gradient = ctx.createLinearGradient(layout.centreX, 0, to, 0);
        const stops = this.theme.spectrum.pitch;
        gradient.addColorStop(0, stops[0]);
        gradient.addColorStop(0.5, stops[1]);
        gradient.addColorStop(1, stops[2]);
        return gradient;
      };
      this.pitchGradientLeft = make(layout.centreX - maxLength);
      this.pitchGradientRight = make(layout.centreX + maxLength);
    }

    let loudest = 0;
    for (let i = 0; i < this.pitchCount; i += 1) {
      const pitch = this.pitchFirst + i;
      const from = this.pitchBandsTable.from[i]!;
      const to = this.pitchBandsTable.to[i]!;
      const fade = this.pitchFade[i]!;
      const left = normalise(peakOf(spectrum.left, from, to)) * fade;
      const right = normalise(peakOf(spectrum.right, from, to)) * fade;
      this.pitchLevelsLeft[pitch] = left;
      this.pitchLevelsRight[pitch] = right;
      loudest = Math.max(loudest, left, right);
    }
    const presence = smoothstep(LOUDNESS_FADE[0], LOUDNESS_FADE[1], loudest);
    if (presence <= 0) return;

    this.pitchLeft.reset(); this.pitchRight.reset(); this.pitchStrongLeft.reset(); this.pitchStrongRight.reset();
    const height = Math.max(1, layout.rowHeight - (layout.rowHeight > 4 ? 1 : 0));
    for (let i = 0; i < this.pitchCount; i += 1) {
      const pitch = this.pitchFirst + i;
      const y = yOfPitch(layout, pitch + 1);
      const left = this.pitchLevelsLeft[pitch]!;
      const right = this.pitchLevelsRight[pitch]!;
      // Squared, so quiet pitches stay short and the loud ones stand out.
      const leftLength = left * left * maxLength;
      const rightLength = right * right * maxLength;
      if (leftLength > 0.5) {
        this.pitchLeft.push(layout.centreX - leftLength, y, leftLength, height);
        if (left >= loudest * PITCH_STRONG) this.pitchStrongLeft.push(layout.centreX - leftLength, y, leftLength, height);
      }
      if (rightLength > 0.5) {
        this.pitchRight.push(layout.centreX, y, rightLength, height);
        if (right >= loudest * PITCH_STRONG) this.pitchStrongRight.push(layout.centreX, y, rightLength, height);
      }
    }

    ctx.beginPath();
    ctx.rect(layout.keyWidth, 0, layout.width - layout.keyWidth, layout.canvasHeight);
    ctx.clip();
    ctx.globalAlpha = presence;
    ctx.globalCompositeOperation = this.theme.blend;
    ctx.fillStyle = this.pitchGradientLeft!;
    this.pitchLeft.fillInto(ctx);
    this.pitchStrongLeft.fillInto(ctx);
    ctx.fillStyle = this.pitchGradientRight!;
    this.pitchRight.fillInto(ctx);
    this.pitchStrongRight.fillInto(ctx);
  }

  // ---- trail ---------------------------------------------------------------

  /** Allocates or clears the ring when the scene or pitch range changes. */
  private trailLayoutKey(layout: SpectrumLayout): string {
    return `${layout.pitchLow}|${layout.pitchHigh}|${layout.rollTop}|${layout.rowHeight}|${layout.canvasHeight}`;
  }

  private ensureTrail(layout: SpectrumLayout): boolean {
    // Keyed on the whole vertical layout: the trail spans the canvas along the
    // roll's pitch axis, so a new height or row size re-maps every row.
    const key = this.trailLayoutKey(layout);
    if (this.trailCanvas && key === this.trailKey && this.trailScene === layout.scene) return true;
    this.trailKey = key;
    this.trailScene = layout.scene;
    this.trailTopPitch = Math.min(PITCH_MAX, pitchAtY(layout, 0));
    this.trailBottomPitch = Math.max(PITCH_MIN, pitchAtY(layout, layout.canvasHeight));
    this.trailRows = Math.max(1, Math.ceil((this.trailTopPitch - this.trailBottomPitch) * TRAIL_ROWS_PER_SEMITONE));
    this.trailRowFade = new Float32Array(this.trailRows);
    this.trailAlpha = new Uint8Array(this.trailRows);
    for (let r = 0; r < this.trailRows; r += 1) {
      const axis = this.trailTopPitch - (r + 0.5) / TRAIL_ROWS_PER_SEMITONE;
      this.trailRowFade[r] = rowFade(yOfPitch(layout, axis), layout.canvasHeight, pitchToHz(axis - 0.5));
    }
    const canvas = this.trailCanvas ?? document.createElement('canvas');
    canvas.width = TRAIL_COLUMNS;
    canvas.height = this.trailRows; // also clears it
    this.trailCanvas = canvas;
    this.trailCtx = canvas.getContext('2d');
    this.trailColumn = this.trailCtx ? this.trailCtx.createImageData(1, this.trailRows) : null;
    this.trailStamp.fill(-1);
    this.trailLast = -Infinity;
    this.trailBandKey = '';
    return this.trailCtx !== null;
  }

  private recordTrail(spectrum: StereoSpectrum, layout: SpectrumLayout): void {
    if (!this.ensureTrail(layout)) return;
    const column = Math.floor(layout.playheadSeconds * TRAIL_RATE);
    if (column === this.trailLast || column < 0) return;

    const bandKey = `${spectrum.left.length}|${spectrum.sampleRate}|${this.trailKey}`;
    if (bandKey !== this.trailBandKey) {
      this.trailBandKey = bandKey;
      // Row 0 is the top: the highest pitch, as in the roll.
      const centres = new Float32Array(this.trailRows);
      for (let r = 0; r < this.trailRows; r += 1) {
        // Axis value to pitch: a row's pitch sits half a semitone below its top.
        centres[r] = this.trailTopPitch - (r + 0.5) / TRAIL_ROWS_PER_SEMITONE - 0.5;
      }
      this.trailBands = pitchBands(centres, 0.5 / TRAIL_ROWS_PER_SEMITONE, spectrum.left.length, spectrum.sampleRate);
    }

    const image = this.trailColumn!;
    const pixels = image.data;
    const quiet = this.theme.spectrum.trailQuiet;
    const loud = this.theme.spectrum.trailLoud;
    for (let r = 0; r < this.trailRows; r += 1) {
      const from = this.trailBands.from[r]!;
      const to = this.trailBands.to[r]!;
      const n = normalise(Math.max(peakOf(spectrum.left, from, to), peakOf(spectrum.right, from, to)));
      // The bottom of the range is noise floor: cut it, then give what is left
      // the full alpha range so real energy reads clearly.
      const lit = n <= TRAIL_FLOOR ? 0 : (n - TRAIL_FLOOR) / (1 - TRAIL_FLOOR);
      const o = r * 4;
      // Quiet to loud in the theme's colours (on Midnight: blue, through cyan,
      // to near-white). Red comes in late, which is what passes through cyan.
      pixels[o] = quiet[0] + (loud[0] - quiet[0]) * lit * lit;
      pixels[o + 1] = quiet[1] + (loud[1] - quiet[1]) * lit;
      pixels[o + 2] = quiet[2] + (loud[2] - quiet[2]) * lit;
      // Soft at the canvas edges and the ends of the frequency range.
      this.trailAlpha[r] = Math.sqrt(lit) * 255 * this.trailRowFade[r]!;
    }

    // Fill every column since the last one written, so a slow frame leaves no
    // gap; a seek or a long stall starts a new run instead.
    const continues = column > this.trailLast && column - this.trailLast <= TRAIL_MAX_FILL;
    const first = continues ? this.trailLast + 1 : column;
    if (!continues) this.trailRunStart = column;
    for (let c = first; c <= column; c += 1) {
      // A run fades in from where recording started instead of beginning on a
      // hard vertical edge.
      const ramp = Math.min(1, (c - this.trailRunStart + 1) / TRAIL_RUN_FADE);
      for (let r = 0; r < this.trailRows; r += 1) pixels[r * 4 + 3] = this.trailAlpha[r]! * ramp;
      const slot = c % TRAIL_COLUMNS;
      this.trailCtx!.putImageData(image, slot, 0);
      this.trailStamp[slot] = c;
    }
    this.trailLast = column;
  }

  private drawTrail(ctx: CanvasRenderingContext2D, layout: SpectrumLayout): void {
    if (!this.trailCanvas || this.trailScene !== layout.scene
      || this.trailKey !== this.trailLayoutKey(layout)) return;
    const pps = layout.pixelsPerSecond;
    const playColumn = Math.floor(layout.playheadSeconds * TRAIL_RATE);
    const leftSeconds = layout.playheadSeconds - (layout.centreX - layout.keyWidth) / pps;
    const start = Math.max(Math.floor(leftSeconds * TRAIL_RATE), playColumn - TRAIL_COLUMNS + 1, 0);
    if (playColumn < start) return;

    ctx.beginPath();
    ctx.rect(layout.keyWidth, 0, layout.centreX - layout.keyWidth, layout.canvasHeight);
    ctx.clip();
    ctx.globalCompositeOperation = this.theme.blend;
    ctx.globalAlpha = 0.8;
    ctx.imageSmoothingEnabled = true;
    const top = yOfPitch(layout, this.trailTopPitch);
    const height = yOfPitch(layout, this.trailBottomPitch) - top;
    const toX = (column: number) => layout.centreX + (column / TRAIL_RATE - layout.playheadSeconds) * pps;

    // One drawImage per run of valid, contiguous columns (two where it wraps).
    let runStart = -1;
    for (let c = start; c <= playColumn + 1; c += 1) {
      const valid = c <= playColumn && this.trailStamp[c % TRAIL_COLUMNS] === c;
      if (valid && runStart < 0) runStart = c;
      if (!valid && runStart >= 0) {
        this.blitRun(ctx, runStart, c - 1, toX, top, height);
        runStart = -1;
      }
    }
  }

  private blitRun(
    ctx: CanvasRenderingContext2D,
    first: number,
    last: number,
    toX: (column: number) => number,
    top: number,
    height: number,
  ): void {
    const canvas = this.trailCanvas!;
    let c = first;
    while (c <= last) {
      const slot = c % TRAIL_COLUMNS;
      const count = Math.min(last - c + 1, TRAIL_COLUMNS - slot);
      const x = toX(c);
      ctx.drawImage(canvas, slot, 0, count, this.trailRows, x, top, toX(c + count) - x, height);
      c += count;
    }
  }
}
