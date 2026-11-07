// Every visual layer's metadata: name, where it can go, what it reads, and the
// knobs the Visuals panel shows. The drawing code lives in layers/, keyed by
// the same ids; this file stays free of it so settings and tests can load it.
import type { LayerCategory, LayerMeta } from './types';

const BOTH: LayerMeta['views'] = ['roll', 'arrange'];

export const LAYER_CATALOG: readonly LayerMeta[] = [
  // ---- spectrum ----------------------------------------------------------
  {
    id: 'spectrum-lines', label: 'Stereo lines', category: 'spectrum', views: BOTH,
    description: 'A log-frequency line per channel: left rises from the bottom, right hangs from the top.',
    defaultPlacement: 'front', defaultOpacity: 1, needs: { spectrum: true }, params: [],
  },
  {
    id: 'spectrum-bars', label: 'Mirrored bars', category: 'spectrum', views: BOTH,
    description: '64 log-spaced bars per channel with falling peak caps.',
    defaultPlacement: 'front', defaultOpacity: 1, needs: { spectrum: true }, params: [],
  },
  {
    id: 'pitch-spectrum', label: 'Pitch spectrum', category: 'spectrum', views: ['roll'],
    description: 'The spectrum folded onto the roll’s pitch rows, growing out from the playhead.',
    defaultPlacement: 'front', defaultOpacity: 1, needs: { spectrum: true }, params: [],
  },
  {
    id: 'spectrogram-trail', label: 'Spectrogram trail', category: 'spectrum', views: ['roll'],
    description: 'A spectrogram of what has played, scrolling with the timeline.',
    defaultPlacement: 'front', defaultOpacity: 1, needs: { spectrum: true }, params: [],
  },

  // ---- radial ------------------------------------------------------------
  {
    id: 'radial-ring', label: 'Radial spectrum', category: 'radial', views: BOTH,
    description: 'Spectrum bars around a ring at the playhead, left channel on one half, right on the other. Punches on hits.',
    defaultPlacement: 'front', defaultOpacity: 0.85, needs: { spectrum: true },
    params: [
      { kind: 'number', key: 'radius', label: 'Radius', min: 0.08, max: 0.45, step: 0.01, default: 0.2 },
      { kind: 'number', key: 'bars', label: 'Bars', min: 24, max: 160, step: 4, default: 96 },
      { kind: 'number', key: 'spin', label: 'Spin', min: 0, max: 1, step: 0.05, default: 0.25 },
    ],
  },
  {
    id: 'kick-rings', label: 'Kick rings', category: 'radial', views: BOTH,
    description: 'Rings burst outward from the playhead on every hit.',
    defaultPlacement: 'back', defaultOpacity: 0.85, needs: { spectrum: true },
    params: [
      { kind: 'number', key: 'speed', label: 'Speed', min: 0.3, max: 3, step: 0.1, default: 1 },
      { kind: 'number', key: 'width', label: 'Thickness', min: 1, max: 20, step: 1, default: 6, unit: 'px' },
    ],
  },
  {
    id: 'note-ripples', label: 'Note ripples', category: 'radial', views: BOTH,
    description: 'A ripple in the track’s colour wherever the playhead meets a note.',
    defaultPlacement: 'front', defaultOpacity: 0.9, needs: { hits: true },
    params: [
      { kind: 'number', key: 'size', label: 'Size', min: 20, max: 300, step: 5, default: 90, unit: 'px' },
      { kind: 'number', key: 'life', label: 'Life', min: 0.2, max: 3, step: 0.1, default: 0.9, unit: 's' },
    ],
  },

  // ---- dots --------------------------------------------------------------
  {
    id: 'particles', label: 'Particles', category: 'dots', views: BOTH,
    description: 'A burst where the playhead meets each note, trailing with the timeline.',
    defaultPlacement: 'front', defaultOpacity: 1, needs: { hits: true }, params: [],
  },
  {
    id: 'dot-matrix', label: 'Dot-matrix EQ', category: 'dots', views: BOTH,
    description: 'A grid of dots: each column a frequency band, lit and swollen by its level.',
    defaultPlacement: 'back', defaultOpacity: 0.8, needs: { spectrum: true },
    params: [
      { kind: 'number', key: 'columns', label: 'Columns', min: 12, max: 96, step: 4, default: 40 },
      { kind: 'number', key: 'rows', label: 'Rows', min: 6, max: 40, step: 1, default: 16 },
      { kind: 'toggle', key: 'mirror', label: 'Mirror from centre', default: true },
    ],
  },
  {
    id: 'starfield', label: 'Starfield warp', category: 'dots', views: BOTH,
    description: 'Stars streaming out from the playhead, faster with loudness, leaping on hits.',
    defaultPlacement: 'back', defaultOpacity: 0.9, needs: { spectrum: true },
    params: [
      { kind: 'number', key: 'count', label: 'Stars', min: 80, max: 1200, step: 20, default: 420 },
      { kind: 'number', key: 'speed', label: 'Speed', min: 0.2, max: 3, step: 0.1, default: 1 },
    ],
  },
  {
    id: 'bokeh', label: 'Bokeh orbs', category: 'dots', views: BOTH,
    description: 'Soft out-of-focus orbs drifting across the view, swelling with the bass.',
    defaultPlacement: 'back', defaultOpacity: 0.75, needs: { spectrum: true },
    params: [
      { kind: 'number', key: 'count', label: 'Orbs', min: 4, max: 60, step: 1, default: 22 },
      { kind: 'number', key: 'size', label: 'Size', min: 20, max: 240, step: 5, default: 90, unit: 'px' },
    ],
  },

  // ---- waves -------------------------------------------------------------
  {
    id: 'oscilloscope', label: 'Oscilloscope', category: 'waves', views: BOTH,
    description: 'The raw waveform of each channel, traced across the view.',
    defaultPlacement: 'front', defaultOpacity: 0.85, needs: { wave: true },
    params: [
      { kind: 'number', key: 'gain', label: 'Gain', min: 0.5, max: 6, step: 0.1, default: 2 },
      { kind: 'choice', key: 'mode', label: 'Channels', default: 'stereo', options: [
        { value: 'stereo', label: 'Left + right' }, { value: 'mid', label: 'Mid' },
      ] },
    ],
  },
  {
    id: 'lissajous', label: 'Lissajous', category: 'waves', views: BOTH,
    description: 'Left against right as an XY trace (a goniometer): wide mixes bloom, mono collapses to a line.',
    defaultPlacement: 'front', defaultOpacity: 0.85, needs: { wave: true },
    params: [
      { kind: 'number', key: 'size', label: 'Size', min: 0.1, max: 0.5, step: 0.01, default: 0.22 },
      { kind: 'number', key: 'gain', label: 'Gain', min: 0.5, max: 6, step: 0.1, default: 2.2 },
      { kind: 'number', key: 'persistence', label: 'Persistence', min: 0, max: 0.95, step: 0.05, default: 0.7 },
    ],
  },
  {
    id: 'ribbons', label: 'Sine ribbons', category: 'waves', views: BOTH,
    description: 'Layered flowing sine ribbons, each driven by a frequency band.',
    defaultPlacement: 'back', defaultOpacity: 0.8, needs: { spectrum: true },
    params: [
      { kind: 'number', key: 'count', label: 'Ribbons', min: 1, max: 8, step: 1, default: 4 },
      { kind: 'number', key: 'amplitude', label: 'Amplitude', min: 0.05, max: 0.5, step: 0.01, default: 0.22 },
    ],
  },

  // ---- patterns ----------------------------------------------------------
  {
    id: 'flash', label: 'Hit flash', category: 'patterns', views: BOTH,
    description: 'A glow that pulses in from the edges, or over the whole view, on every hit.',
    defaultPlacement: 'front', defaultOpacity: 0.7, needs: { spectrum: true },
    params: [
      { kind: 'choice', key: 'style', label: 'Style', default: 'vignette', options: [
        { value: 'vignette', label: 'Edges' }, { value: 'full', label: 'Full screen' }, { value: 'bars', label: 'Side bars' },
      ] },
    ],
  },
  {
    id: 'kaleidoscope', label: 'Kaleidoscope', category: 'patterns', views: BOTH, gl: true,
    description: 'A mirrored mandala of shifting noise; its segments breathe with the bands.',
    defaultPlacement: 'back', defaultOpacity: 0.7, needs: { spectrum: true },
    params: [
      { kind: 'number', key: 'segments', label: 'Segments', min: 3, max: 16, step: 1, default: 8 },
      { kind: 'number', key: 'zoom', label: 'Zoom', min: 0.5, max: 4, step: 0.1, default: 1.5 },
    ],
  },
  {
    id: 'flow-field', label: 'Flow field', category: 'patterns', views: BOTH, gl: true,
    description: 'Streaks of light swept along a slowly turning noise field.',
    defaultPlacement: 'back', defaultOpacity: 0.7, needs: { spectrum: true },
    params: [
      { kind: 'number', key: 'scale', label: 'Scale', min: 0.5, max: 6, step: 0.1, default: 2.2 },
      { kind: 'number', key: 'speed', label: 'Speed', min: 0.1, max: 3, step: 0.1, default: 1 },
    ],
  },
  {
    id: 'aurora', label: 'Aurora', category: 'patterns', views: BOTH, gl: true,
    description: 'Curtains of colour rippling across the top of the view.',
    defaultPlacement: 'back', defaultOpacity: 0.75, needs: { spectrum: true },
    params: [
      { kind: 'number', key: 'height', label: 'Height', min: 0.2, max: 1, step: 0.05, default: 0.6 },
    ],
  },
  {
    id: 'hex-grid', label: 'Hex grid', category: 'patterns', views: BOTH, gl: true,
    description: 'A honeycomb that lights up by frequency and flashes on hits.',
    defaultPlacement: 'back', defaultOpacity: 0.6, needs: { spectrum: true },
    params: [
      { kind: 'number', key: 'size', label: 'Cell size', min: 10, max: 80, step: 2, default: 28, unit: 'px' },
    ],
  },
];

export const CATEGORY_LABELS: Record<LayerCategory, string> = {
  spectrum: 'Spectrum',
  radial: 'Circles',
  dots: 'Dots',
  waves: 'Waves',
  patterns: 'Patterns',
};

const BY_ID = new Map(LAYER_CATALOG.map((meta) => [meta.id, meta]));

export function layerMeta(id: string): LayerMeta | undefined {
  return BY_ID.get(id);
}
