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

const LEFT_TINT = { line: 'rgba(170,205,255,0.26)', fill: 'rgba(140,180,255,0.035)', bar: 'rgba(150,190,255,0.10)', cap: 'rgba(185,212,255,0.4)' };
const RIGHT_TINT = { line: 'rgba(255,190,215,0.24)', fill: 'rgba(255,160,200,0.03)', bar: 'rgba(255,170,205,0.09)', cap: 'rgba(255,198,222,0.36)' };

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
  private readonly pitchLevelsLeft = new Float32Array(128);
  private readonly pitchLevelsRight = new Float32Array(128);
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
  private trailBandKey = '';
  private trailBands: Bands = { from: new Int32Array(0), to: new Int32Array(0) };
  /** Absolute column held by each ring slot, or -1. */
  private readonly trailStamp = new Float64Array(TRAIL_COLUMNS).fill(-1);
  private trailLast = -Infinity;

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

  // ---- lines ---------------------------------------------------------------

  private drawLines(ctx: CanvasRenderingContext2D, spectrum: StereoSpectrum, layout: SpectrumLayout): void {
    const columns = Math.max(0, Math.floor((layout.width - layout.keyWidth) / LINE_STEP) + 1);
    const key = `${layout.width}|${spectrum.left.length}|${spectrum.sampleRate}`;
    if (key !== this.lineKey) {
      this.lineKey = key;
      this.lineBands = logBands(columns, spectrum.left.length, spectrum.sampleRate);
    }
    const drewLeft = this.drawLine(ctx, spectrum.left, columns, layout, layout.rollBottom, -1, LEFT_TINT);
    const drewRight = this.drawLine(ctx, spectrum.right, columns, layout, layout.rollTop, 1, RIGHT_TINT);
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
    tint: typeof LEFT_TINT,
  ): boolean {
    const reach = (layout.rollBottom - layout.rollTop) * REACH * direction;
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
    // Silence is a flat line along the edge; drawing it adds nothing.
    if (loudest <= 0.01) return false;
    ctx.lineWidth = 1;
    ctx.strokeStyle = tint.line;
    ctx.stroke();
    ctx.lineTo(layout.keyWidth + (columns - 1) * LINE_STEP, baseline);
    ctx.lineTo(layout.keyWidth, baseline);
    ctx.closePath();
    ctx.fillStyle = tint.fill;
    ctx.fill();
    return true;
  }

  private drawChannelLabels(ctx: CanvasRenderingContext2D, layout: SpectrumLayout, left: boolean, right: boolean): void {
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    if (left) {
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(170,205,255,0.35)';
      ctx.fillText('L', layout.width - 6, layout.rollBottom - 3);
    }
    if (right) {
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(255,190,215,0.35)';
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
    const reach = (layout.rollBottom - layout.rollTop) * REACH;
    this.barsLeft.reset(); this.barsRight.reset(); this.capsLeft.reset(); this.capsRight.reset();
    let anything = false;

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
      if (hl > 0.5) this.barsLeft.push(x, layout.rollBottom - hl, barWidth, hl);
      if (hr > 0.5) this.barsRight.push(x, layout.rollTop, barWidth, hr);
      if (cl > 1) this.capsLeft.push(x, layout.rollBottom - cl - 2, barWidth, 2);
      if (cr > 1) this.capsRight.push(x, layout.rollTop + cr, barWidth, 2);
      if (cl > 1 || cr > 1) anything = true;
    }
    if (!anything) return;

    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = LEFT_TINT.bar;
    this.barsLeft.fillInto(ctx);
    ctx.fillStyle = RIGHT_TINT.bar;
    this.barsRight.fillInto(ctx);
    ctx.fillStyle = LEFT_TINT.cap;
    this.capsLeft.fillInto(ctx);
    ctx.fillStyle = RIGHT_TINT.cap;
    this.capsRight.fillInto(ctx);
    ctx.globalCompositeOperation = 'source-over';
    this.drawChannelLabels(ctx, layout, this.capsLeft.size > 0, this.capsRight.size > 0);
  }

  // ---- pitch ---------------------------------------------------------------

  private drawPitch(ctx: CanvasRenderingContext2D, spectrum: StereoSpectrum, layout: SpectrumLayout): void {
    const { pitchLow, pitchHigh } = layout;
    const key = `${spectrum.left.length}|${spectrum.sampleRate}|${pitchLow}|${pitchHigh}`;
    if (key !== this.pitchKey) {
      this.pitchKey = key;
      const centres = new Float32Array(pitchHigh - pitchLow + 1);
      for (let i = 0; i < centres.length; i += 1) centres[i] = pitchLow + i;
      this.pitchBandsTable = pitchBands(centres, 0.5, spectrum.left.length, spectrum.sampleRate);
    }

    const maxLength = layout.width * PITCH_REACH;
    const gradientKey = `${layout.centreX}|${maxLength}`;
    if (gradientKey !== this.pitchGradientKey) {
      this.pitchGradientKey = gradientKey;
      // Fades with distance from the playhead, so bars read as radiating from it.
      const make = (to: number) => {
        const gradient = ctx.createLinearGradient(layout.centreX, 0, to, 0);
        gradient.addColorStop(0, 'rgba(210,225,255,0.3)');
        gradient.addColorStop(0.5, 'rgba(170,195,255,0.12)');
        gradient.addColorStop(1, 'rgba(150,180,255,0)');
        return gradient;
      };
      this.pitchGradientLeft = make(layout.centreX - maxLength);
      this.pitchGradientRight = make(layout.centreX + maxLength);
    }

    let loudest = 0;
    for (let p = pitchLow; p <= pitchHigh; p += 1) {
      const i = p - pitchLow;
      const from = this.pitchBandsTable.from[i]!;
      const to = this.pitchBandsTable.to[i]!;
      const left = normalise(peakOf(spectrum.left, from, to));
      const right = normalise(peakOf(spectrum.right, from, to));
      this.pitchLevelsLeft[p] = left;
      this.pitchLevelsRight[p] = right;
      loudest = Math.max(loudest, left, right);
    }
    if (loudest <= 0.01) return;

    this.pitchLeft.reset(); this.pitchRight.reset(); this.pitchStrongLeft.reset(); this.pitchStrongRight.reset();
    const height = Math.max(1, layout.rowHeight - (layout.rowHeight > 4 ? 1 : 0));
    for (let p = pitchLow; p <= pitchHigh; p += 1) {
      const y = layout.pitchY[p]!;
      const left = this.pitchLevelsLeft[p]!;
      const right = this.pitchLevelsRight[p]!;
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
    ctx.rect(layout.keyWidth, layout.rollTop, layout.width - layout.keyWidth, layout.rollBottom - layout.rollTop);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = this.pitchGradientLeft!;
    this.pitchLeft.fillInto(ctx);
    this.pitchStrongLeft.fillInto(ctx);
    ctx.fillStyle = this.pitchGradientRight!;
    this.pitchRight.fillInto(ctx);
    this.pitchStrongRight.fillInto(ctx);
  }

  // ---- trail ---------------------------------------------------------------

  /** Allocates or clears the ring when the scene or pitch range changes. */
  private ensureTrail(layout: SpectrumLayout): boolean {
    const key = `${layout.pitchLow}|${layout.pitchHigh}`;
    if (this.trailCanvas && key === this.trailKey && this.trailScene === layout.scene) return true;
    this.trailKey = key;
    this.trailScene = layout.scene;
    this.trailRows = (layout.pitchHigh - layout.pitchLow + 1) * TRAIL_ROWS_PER_SEMITONE;
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
        centres[r] = layout.pitchHigh + 0.5 - (r + 0.5) / TRAIL_ROWS_PER_SEMITONE;
      }
      this.trailBands = pitchBands(centres, 0.5 / TRAIL_ROWS_PER_SEMITONE, spectrum.left.length, spectrum.sampleRate);
    }

    const image = this.trailColumn!;
    const pixels = image.data;
    for (let r = 0; r < this.trailRows; r += 1) {
      const from = this.trailBands.from[r]!;
      const to = this.trailBands.to[r]!;
      const n = normalise(Math.max(peakOf(spectrum.left, from, to), peakOf(spectrum.right, from, to)));
      // The bottom of the range is noise floor: cut it, then give what is left
      // the full alpha range so real energy reads clearly.
      const lit = n <= TRAIL_FLOOR ? 0 : (n - TRAIL_FLOOR) / (1 - TRAIL_FLOOR);
      const o = r * 4;
      // Blue at the quiet end, through cyan, to near-white where it is loud.
      pixels[o] = 90 + 165 * lit * lit;
      pixels[o + 1] = 150 + 105 * lit;
      pixels[o + 2] = 255;
      pixels[o + 3] = Math.sqrt(lit) * 255;
    }

    // Fill every column since the last one written, so a slow frame leaves no
    // gap; a seek or a long stall starts a new run instead.
    const first = column > this.trailLast && column - this.trailLast <= TRAIL_MAX_FILL ? this.trailLast + 1 : column;
    for (let c = first; c <= column; c += 1) {
      const slot = c % TRAIL_COLUMNS;
      this.trailCtx!.putImageData(image, slot, 0);
      this.trailStamp[slot] = c;
    }
    this.trailLast = column;
  }

  private drawTrail(ctx: CanvasRenderingContext2D, layout: SpectrumLayout): void {
    if (!this.trailCanvas || this.trailScene !== layout.scene
      || this.trailKey !== `${layout.pitchLow}|${layout.pitchHigh}`) return;
    const pps = layout.pixelsPerSecond;
    const playColumn = Math.floor(layout.playheadSeconds * TRAIL_RATE);
    const leftSeconds = layout.playheadSeconds - (layout.centreX - layout.keyWidth) / pps;
    const start = Math.max(Math.floor(leftSeconds * TRAIL_RATE), playColumn - TRAIL_COLUMNS + 1, 0);
    if (playColumn < start) return;

    ctx.beginPath();
    ctx.rect(layout.keyWidth, layout.rollTop, layout.centreX - layout.keyWidth, layout.rollBottom - layout.rollTop);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.8;
    ctx.imageSmoothingEnabled = true;
    const height = layout.rollBottom - layout.rollTop;
    const toX = (column: number) => layout.centreX + (column / TRAIL_RATE - layout.playheadSeconds) * pps;

    // One drawImage per run of valid, contiguous columns (two where it wraps).
    let runStart = -1;
    for (let c = start; c <= playColumn + 1; c += 1) {
      const valid = c <= playColumn && this.trailStamp[c % TRAIL_COLUMNS] === c;
      if (valid && runStart < 0) runStart = c;
      if (!valid && runStart >= 0) {
        this.blitRun(ctx, runStart, c - 1, toX, layout.rollTop, height);
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
