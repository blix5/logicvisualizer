// The visual-layer contract. A layer is a small painter that draws one effect
// (a ring, a dot grid, a shader) from what the frame hands it: the live audio
// features, the notes the playhead just crossed, and where things sit on the
// canvas. Layers stack: each view keeps an ordered list, any number on at once,
// each placed behind the notes or over everything.
import type { CanvasTheme } from '../theme/themes';
import type { SpectrumLayout } from '../render/spectrum';
import type { AudioFeatures } from './AudioFeatures';
import type { NoteHitBuffer } from './NoteHitBuffer';
import type { GLHost } from './GLHost';

export type ViewKind = 'roll' | 'arrange';
/** back: over the background, under the notes. front: over everything. */
export type Placement = 'back' | 'front';
export type LayerCategory = 'spectrum' | 'radial' | 'dots' | 'waves' | 'patterns';

export type ParamValue = number | boolean | string;

export type ParamSpec =
  | { kind: 'number'; key: string; label: string; min: number; max: number; step: number; default: number; unit?: string }
  | { kind: 'toggle'; key: string; label: string; default: boolean }
  | { kind: 'choice'; key: string; label: string; options: { value: string; label: string }[]; default: string };

/** What a layer reads, so the frame loop only computes what someone uses. */
export type LayerNeeds = {
  /** Frequency data, bands, level and onsets. */
  spectrum?: boolean;
  /** Time-domain samples per channel. */
  wave?: boolean;
  /** Notes crossing the playhead. */
  hits?: boolean;
};

/** Metadata only: no drawing code, so settings and tests can load it anywhere. */
export type LayerMeta = {
  id: string;
  label: string;
  description: string;
  category: LayerCategory;
  views: ViewKind[];
  defaultPlacement: Placement;
  defaultOpacity: number;
  needs: LayerNeeds;
  params: ParamSpec[];
  /** Drawn by a WebGL2 shader; unavailable without WebGL2. */
  gl?: boolean;
};

/** Per-layer settings as the painter sees them. */
export type LayerContext = {
  /** 0..1; the layer multiplies every alpha it sets by this. */
  opacity: number;
  /** 0..2, 1 by default: scales size, motion and brightness. */
  intensity: number;
  params: Record<string, ParamValue>;
  placement: Placement;
};

/** Everything a layer may read for one frame. Coordinates are CSS px on the whole canvas. */
export type VisualFrame = {
  view: ViewKind;
  width: number;
  height: number;
  dpr: number;
  /** Top of the content: the toolbar covers what is above it in arrange. */
  top: number;
  centreX: number;
  /** Visual centre for radial layers: the playhead, halfway down the content. */
  centreY: number;
  /** performance.now() in ms. */
  now: number;
  /** Seconds since the last frame this stack drew, clamped so a stall does not jump. */
  dt: number;
  playheadSeconds: number;
  pixelsPerSecond: number;
  playing: boolean;
  features: AudioFeatures;
  /** Notes that crossed the playhead since the last frame. */
  hits: NoteHitBuffer;
  theme: CanvasTheme;
  /** A soft radial halo in `color`, pre-rendered. */
  sprite(color: string): CanvasImageSource;
  /** The piano roll's layout; null in arrange. */
  roll: SpectrumLayout | null;
  gl: GLHost | null;
  /** Identity of the drawn scene. */
  scene: object;
};

export interface LayerInstance {
  draw(ctx: CanvasRenderingContext2D, frame: VisualFrame, layer: LayerContext): void;
  /** Forget history: a new project, or the layer switched off. */
  reset?(): void;
  setTheme?(theme: CanvasTheme): void;
  /** Still moving with no new input (rings expanding, particles in flight). */
  readonly animating?: boolean;
}
