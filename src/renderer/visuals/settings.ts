// Visual-layer settings and presets: pure data and functions, no React, so the
// tests can exercise them. useVisuals.ts persists them.
import { LAYER_CATALOG, layerMeta } from './catalog';
import type { ParamValue, Placement, ViewKind } from './types';

export type LayerSettings = {
  id: string;
  enabled: boolean;
  /** 0..1 */
  opacity: number;
  /** 0..2 */
  intensity: number;
  placement: Placement;
  params: Record<string, ParamValue>;
};

/** A preset names only the layers it turns on, with whatever it changes from their defaults. */
export type PresetLayer = { id: string } & Partial<Omit<LayerSettings, 'id' | 'enabled'>>;

export type Preset = {
  id: string;
  name: string;
  builtIn?: boolean;
  roll: PresetLayer[];
  arrange: PresetLayer[];
};

export type VisualsSettings = {
  version: 1;
  roll: LayerSettings[];
  arrange: LayerSettings[];
  /** The preset last applied, or null once anything has been changed by hand. */
  preset: string | null;
  userPresets: Preset[];
};

export function defaultLayer(id: string): LayerSettings {
  const meta = layerMeta(id);
  const params: Record<string, ParamValue> = {};
  for (const spec of meta?.params ?? []) params[spec.key] = spec.default;
  return {
    id,
    enabled: false,
    opacity: meta?.defaultOpacity ?? 1,
    intensity: 1,
    placement: meta?.defaultPlacement ?? 'front',
    params,
  };
}

/** Every layer the view can show, in catalogue order, all off. */
export function defaultLayers(view: ViewKind): LayerSettings[] {
  return LAYER_CATALOG.filter((meta) => meta.views.includes(view)).map((meta) => defaultLayer(meta.id));
}

export const DEFAULT_VISUALS: VisualsSettings = {
  version: 1,
  roll: defaultLayers('roll'),
  arrange: defaultLayers('arrange'),
  preset: null,
  userPresets: [],
};

const clamp = (value: unknown, fallback: number, low: number, high: number): number =>
  (typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback);

function sanitizeLayer(raw: unknown, view: ViewKind): LayerSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<LayerSettings>;
  const meta = typeof value.id === 'string' ? layerMeta(value.id) : undefined;
  if (!meta || !meta.views.includes(view)) return null;
  const base = defaultLayer(meta.id);
  const rawParams = value.params && typeof value.params === 'object' ? value.params : {};
  const params: Record<string, ParamValue> = {};
  for (const spec of meta.params) {
    const input = (rawParams as Record<string, unknown>)[spec.key];
    if (spec.kind === 'number') params[spec.key] = clamp(input, spec.default, spec.min, spec.max);
    else if (spec.kind === 'toggle') params[spec.key] = typeof input === 'boolean' ? input : spec.default;
    else params[spec.key] = spec.options.some((option) => option.value === input) ? input as string : spec.default;
  }
  return {
    id: meta.id,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : false,
    opacity: clamp(value.opacity, base.opacity, 0, 1),
    intensity: clamp(value.intensity, 1, 0, 2),
    placement: value.placement === 'back' || value.placement === 'front' ? value.placement : base.placement,
    params,
  };
}

/** A view's layer list: known layers kept in their stored order, the rest appended off. */
function sanitizeList(raw: unknown, view: ViewKind): LayerSettings[] {
  const seen = new Set<string>();
  const list: LayerSettings[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const layer = sanitizeLayer(entry, view);
      if (!layer || seen.has(layer.id)) continue;
      seen.add(layer.id);
      list.push(layer);
    }
  }
  for (const layer of defaultLayers(view)) if (!seen.has(layer.id)) list.push(layer);
  return list;
}

function sanitizePresetLayers(raw: unknown, view: ViewKind): PresetLayer[] {
  if (!Array.isArray(raw)) return [];
  const out: PresetLayer[] = [];
  for (const entry of raw) {
    const layer = sanitizeLayer({ ...(entry as object), enabled: true }, view);
    if (layer) out.push(stripLayer(layer));
  }
  return out;
}

function stripLayer(layer: LayerSettings): PresetLayer {
  const { enabled: _enabled, ...rest } = layer;
  return rest;
}

/** Stored settings, with anything missing or no longer valid put back to its default. */
export function sanitizeVisuals(raw: unknown): VisualsSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_VISUALS;
  const value = raw as Partial<VisualsSettings>;
  const userPresets: Preset[] = [];
  if (Array.isArray(value.userPresets)) {
    for (const entry of value.userPresets) {
      if (!entry || typeof entry !== 'object') continue;
      const preset = entry as Partial<Preset>;
      if (typeof preset.id !== 'string' || typeof preset.name !== 'string') continue;
      if (userPresets.some((p) => p.id === preset.id)) continue;
      userPresets.push({
        id: preset.id,
        name: preset.name.slice(0, 60),
        roll: sanitizePresetLayers(preset.roll, 'roll'),
        arrange: sanitizePresetLayers(preset.arrange, 'arrange'),
      });
    }
  }
  return {
    version: 1,
    roll: sanitizeList(value.roll, 'roll'),
    arrange: sanitizeList(value.arrange, 'arrange'),
    preset: typeof value.preset === 'string' ? value.preset : null,
    userPresets,
  };
}

/** The view's layers with only the preset's on, in the preset's order first. */
function applyToList(list: PresetLayer[], view: ViewKind): LayerSettings[] {
  const out: LayerSettings[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const meta = layerMeta(entry.id);
    if (!meta || !meta.views.includes(view) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const base = defaultLayer(entry.id);
    out.push({
      ...base,
      ...entry,
      params: { ...base.params, ...(entry.params ?? {}) },
      enabled: true,
    });
  }
  for (const layer of defaultLayers(view)) if (!seen.has(layer.id)) out.push(layer);
  return out;
}

export function applyPreset(settings: VisualsSettings, preset: Preset): VisualsSettings {
  return sanitizeVisuals({
    ...settings,
    roll: applyToList(preset.roll, 'roll'),
    arrange: applyToList(preset.arrange, 'arrange'),
    preset: preset.id,
  });
}

/** The current layers as a preset: what is on, in order. */
export function snapshotPreset(settings: VisualsSettings, id: string, name: string): Preset {
  return {
    id,
    name,
    roll: settings.roll.filter((layer) => layer.enabled).map(stripLayer),
    arrange: settings.arrange.filter((layer) => layer.enabled).map(stripLayer),
  };
}
