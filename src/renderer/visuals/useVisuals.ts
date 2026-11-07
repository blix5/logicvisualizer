// The visual-layer settings, kept in localStorage, with the edits the Visuals
// panel makes. Any hand edit leaves the applied preset behind ("Custom").
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BUILT_IN_PRESETS } from './presets';
import {
  applyPreset,
  DEFAULT_VISUALS,
  sanitizeVisuals,
  snapshotPreset,
  type LayerSettings,
  type Preset,
  type VisualsSettings,
} from './settings';
import type { ViewKind } from './types';

const STORAGE_KEY = 'lv.visuals';

function readSettings(): VisualsSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeVisuals(JSON.parse(raw)) : DEFAULT_VISUALS;
  } catch {
    return DEFAULT_VISUALS;
  }
}

export type Visuals = ReturnType<typeof useVisuals>;

export function useVisuals() {
  const [settings, setSettings] = useState(readSettings);

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* per-session only */ }
  }, [settings]);

  const presets = useMemo<Preset[]>(() => [...BUILT_IN_PRESETS, ...settings.userPresets], [settings.userPresets]);

  const updateLayer = useCallback((view: ViewKind, id: string, patch: Partial<Omit<LayerSettings, 'id'>>) => {
    setSettings((current) => sanitizeVisuals({
      ...current,
      preset: null,
      [view]: current[view].map((layer) => (layer.id === id
        ? { ...layer, ...patch, params: { ...layer.params, ...(patch.params ?? {}) } }
        : layer)),
    }));
  }, []);

  const choosePreset = useCallback((id: string) => {
    setSettings((current) => {
      const preset = [...BUILT_IN_PRESETS, ...current.userPresets].find((p) => p.id === id);
      return preset ? applyPreset(current, preset) : current;
    });
  }, []);

  const savePreset = useCallback((name: string) => {
    setSettings((current) => {
      const trimmed = name.trim().slice(0, 60) || 'My preset';
      // Saving under an existing name of your own replaces it.
      const existing = current.userPresets.find((p) => p.name === trimmed);
      const id = existing?.id ?? `user:${Date.now().toString(36)}`;
      const preset = snapshotPreset(current, id, trimmed);
      const userPresets = existing
        ? current.userPresets.map((p) => (p.id === id ? preset : p))
        : [...current.userPresets, preset];
      return { ...current, userPresets, preset: id };
    });
  }, []);

  const deletePreset = useCallback((id: string) => {
    setSettings((current) => ({
      ...current,
      userPresets: current.userPresets.filter((p) => p.id !== id),
      preset: current.preset === id ? null : current.preset,
    }));
  }, []);

  /** Everything off; saved presets are kept. */
  const clear = useCallback(() => {
    setSettings((current) => ({ ...DEFAULT_VISUALS, userPresets: current.userPresets }));
  }, []);

  return { settings, presets, updateLayer, choosePreset, savePreset, deletePreset, clear };
}
