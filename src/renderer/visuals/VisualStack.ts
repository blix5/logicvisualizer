// One view's stack of visual layers. The renderer calls begin() once per frame
// with where things sit, then drawBack() after its background and drawFront()
// after everything else. The stack keeps a painter per enabled layer, applies
// each layer's opacity and blend, and reports what the enabled layers need so
// the frame loop computes only that.
import { LAYER_FACTORIES } from './layers';
import { layerMeta } from './catalog';
import { NoteHitBuffer } from './NoteHitBuffer';
import { SpriteCache } from './palette';
import { GLHost } from './GLHost';
import type { AudioFeatures } from './AudioFeatures';
import type { LayerSettings } from './settings';
import type { LayerInstance, LayerNeeds, ViewKind, VisualFrame } from './types';
import type { SpectrumLayout } from '../render/spectrum';
import { DEFAULT_CANVAS_THEME, type CanvasTheme } from '../theme/themes';

/** A single step may not exceed this, so a stalled frame does not jump. */
const MAX_DT = 0.05;

/** Where things sit this frame, from the renderer. */
export type FrameBase = {
  width: number;
  height: number;
  dpr: number;
  top: number;
  centreX: number;
  centreY: number;
  playheadSeconds: number;
  pixelsPerSecond: number;
  roll: SpectrumLayout | null;
  /** Identity of the drawn scene; a new one resets every layer's history. */
  scene: object;
};

type Entry = { settings: LayerSettings; instance: LayerInstance; gl: boolean };

export class VisualStack {
  readonly view: ViewKind;
  /** The renderer fills this while it draws notes; layers read it next frame. */
  readonly pendingHits = new NoteHitBuffer();
  private readonly hits = new NoteHitBuffer();
  private readonly instances = new Map<string, LayerInstance>();
  private entries: Entry[] = [];
  private theme: CanvasTheme = DEFAULT_CANVAS_THEME;
  private readonly sprites = new SpriteCache();
  private scene: object | null = null;
  private lastNow = 0;
  private frame: VisualFrame | null = null;
  private needsCache: LayerNeeds = {};
  private hasBackCache = false;

  /** Set by the frame loop each frame. */
  features: AudioFeatures | null = null;
  playing = false;

  constructor(view: ViewKind) {
    this.view = view;
  }

  /** The view's layer list from settings. Painters persist while a layer stays on. */
  setLayers(list: readonly LayerSettings[]): void {
    const next: Entry[] = [];
    const live = new Set<string>();
    const glOk = list.some((layer) => layer.enabled && layerMeta(layer.id)?.gl) ? GLHost.supported : false;
    for (const settings of list) {
      const meta = layerMeta(settings.id);
      if (!settings.enabled || !meta || !meta.views.includes(this.view)) continue;
      if (meta.gl && !glOk) continue;
      const factory = LAYER_FACTORIES[settings.id];
      if (!factory) continue;
      let instance = this.instances.get(settings.id);
      if (!instance) {
        instance = factory();
        instance.setTheme?.(this.theme);
        this.instances.set(settings.id, instance);
      }
      live.add(settings.id);
      next.push({ settings, instance, gl: !!meta.gl });
    }
    // Switched-off layers drop their painters, and with them their history.
    for (const id of [...this.instances.keys()]) if (!live.has(id)) this.instances.delete(id);
    this.entries = next;

    const needs: LayerNeeds = {};
    for (const entry of next) {
      const meta = layerMeta(entry.settings.id)!;
      if (meta.needs.spectrum) needs.spectrum = true;
      if (meta.needs.wave) needs.wave = true;
      if (meta.needs.hits) needs.hits = true;
    }
    this.needsCache = needs;
    this.hasBackCache = next.some((entry) => entry.settings.placement === 'back');
  }

  setTheme(theme: CanvasTheme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    for (const instance of this.instances.values()) instance.setTheme?.(theme);
  }

  get active(): boolean {
    return this.entries.length > 0;
  }

  get needs(): LayerNeeds {
    return this.needsCache;
  }

  get hasBack(): boolean {
    return this.hasBackCache;
  }

  /** True while some layer is still moving on its own. */
  get animating(): boolean {
    for (const entry of this.entries) if (entry.instance.animating) return true;
    return false;
  }

  /** Starts a frame. Returns false when there is nothing to draw. */
  begin(base: FrameBase): boolean {
    if (this.entries.length === 0 || !this.features) {
      this.pendingHits.reset();
      this.frame = null;
      return false;
    }
    if (base.scene !== this.scene) {
      this.scene = base.scene;
      for (const instance of this.instances.values()) instance.reset?.();
    }
    const now = performance.now();
    const dt = this.lastNow > 0 ? Math.min(MAX_DT, (now - this.lastNow) / 1000) : 0;
    this.lastNow = now;
    // Last frame's hits become this frame's, so back layers (drawn before the
    // notes) see them as well as front ones.
    this.hits.copyFrom(this.pendingHits);
    this.pendingHits.reset();
    this.pendingHits.pixelsPerSecond = base.pixelsPerSecond;

    const theme = this.theme;
    const sprites = this.sprites;
    const dpr = base.dpr;
    const needsGl = this.entries.some((entry) => entry.gl);
    this.frame = {
      view: this.view,
      ...base,
      now,
      dt,
      playing: this.playing,
      features: this.features,
      hits: this.hits,
      theme,
      sprite: (color: string) => sprites.get(color, theme, dpr),
      gl: needsGl ? GLHost.get() : null,
    };
    return true;
  }

  drawBack(ctx: CanvasRenderingContext2D): void {
    this.drawPass(ctx, 'back');
  }

  drawFront(ctx: CanvasRenderingContext2D): void {
    this.drawPass(ctx, 'front');
  }

  private drawPass(ctx: CanvasRenderingContext2D, placement: 'back' | 'front'): void {
    const frame = this.frame;
    if (!frame) return;
    for (const entry of this.entries) {
      const { settings } = entry;
      if (settings.placement !== placement || settings.opacity <= 0) continue;
      ctx.save();
      ctx.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.shadowBlur = 0;
      try {
        entry.instance.draw(ctx, frame, {
          opacity: settings.opacity,
          intensity: settings.intensity,
          params: settings.params,
          placement,
        });
      } catch (error) {
        // One broken layer must not take the view down with it.
        console.warn(`[visuals] ${settings.id} failed to draw:`, error);
      }
      ctx.restore();
    }
  }
}
