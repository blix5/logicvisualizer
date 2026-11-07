// Built-in presets: curated stacks to start from. Each names the layers it
// turns on, in drawing order, with anything it changes from their defaults.
import type { Preset } from './settings';

export const BUILT_IN_PRESETS: readonly Preset[] = [
  {
    id: 'builtin:classic',
    name: 'Classic',
    builtIn: true,
    roll: [{ id: 'spectrum-bars' }, { id: 'particles' }],
    arrange: [{ id: 'spectrum-bars', opacity: 0.8 }],
  },
  {
    id: 'builtin:club',
    name: 'Club',
    builtIn: true,
    roll: [
      { id: 'starfield', placement: 'back', intensity: 1.3 },
      { id: 'dot-matrix', placement: 'back' },
      { id: 'kick-rings', placement: 'back', intensity: 1.4 },
      { id: 'particles' },
      { id: 'flash', params: { style: 'vignette' } },
    ],
    arrange: [
      { id: 'starfield', placement: 'back' },
      { id: 'kick-rings', placement: 'back' },
      { id: 'flash', params: { style: 'bars' } },
    ],
  },
  {
    id: 'builtin:nebula',
    name: 'Nebula',
    builtIn: true,
    roll: [
      { id: 'aurora', placement: 'back' },
      { id: 'bokeh', placement: 'back' },
      { id: 'note-ripples' },
    ],
    arrange: [
      { id: 'aurora', placement: 'back', opacity: 0.6 },
      { id: 'bokeh', placement: 'back', opacity: 0.6 },
    ],
  },
  {
    id: 'builtin:scope',
    name: 'Scope',
    builtIn: true,
    roll: [
      { id: 'oscilloscope', placement: 'front' },
      { id: 'lissajous', placement: 'front' },
    ],
    arrange: [{ id: 'oscilloscope', placement: 'front', opacity: 0.7 }],
  },
  {
    id: 'builtin:mandala',
    name: 'Mandala',
    builtIn: true,
    roll: [
      { id: 'kaleidoscope', placement: 'back' },
      { id: 'radial-ring', placement: 'front' },
      { id: 'note-ripples' },
    ],
    arrange: [
      { id: 'kaleidoscope', placement: 'back', opacity: 0.5 },
      { id: 'radial-ring', placement: 'front' },
    ],
  },
  {
    id: 'builtin:flow',
    name: 'Flow',
    builtIn: true,
    roll: [
      { id: 'flow-field', placement: 'back' },
      { id: 'ribbons', placement: 'back' },
      { id: 'particles' },
    ],
    arrange: [
      { id: 'flow-field', placement: 'back', opacity: 0.55 },
      { id: 'ribbons', placement: 'back' },
    ],
  },
  {
    id: 'builtin:hive',
    name: 'Hive',
    builtIn: true,
    roll: [
      { id: 'hex-grid', placement: 'back' },
      { id: 'pitch-spectrum' },
      { id: 'flash', params: { style: 'vignette' } },
    ],
    arrange: [{ id: 'hex-grid', placement: 'back', opacity: 0.45 }],
  },
  {
    id: 'builtin:minimal',
    name: 'Minimal',
    builtIn: true,
    roll: [{ id: 'spectrum-lines', opacity: 0.6 }],
    arrange: [{ id: 'spectrum-lines', opacity: 0.5 }],
  },
];
