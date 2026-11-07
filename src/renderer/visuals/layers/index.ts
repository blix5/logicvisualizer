// Layer painters by catalogue id. Metadata lives in ../catalog.ts.
import type { LayerInstance } from '../types';
import { particlesLayer, spectrumLayer } from './spectrum';
import { kickRingsLayer, noteRipplesLayer, radialRingLayer } from './radial';
import { bokehLayer, dotMatrixLayer, starfieldLayer } from './dots';
import { lissajousLayer, oscilloscopeLayer, ribbonsLayer } from './waves';
import { auroraLayer, flashLayer, flowFieldLayer, hexGridLayer, kaleidoscopeLayer } from './patterns';

export const LAYER_FACTORIES: Record<string, (() => LayerInstance) | undefined> = {
  'spectrum-lines': spectrumLayer('lines'),
  'spectrum-bars': spectrumLayer('bars'),
  'pitch-spectrum': spectrumLayer('pitch'),
  'spectrogram-trail': spectrumLayer('trail'),
  'radial-ring': radialRingLayer,
  'kick-rings': kickRingsLayer,
  'note-ripples': noteRipplesLayer,
  particles: particlesLayer,
  'dot-matrix': dotMatrixLayer,
  starfield: starfieldLayer,
  bokeh: bokehLayer,
  oscilloscope: oscilloscopeLayer,
  lissajous: lissajousLayer,
  ribbons: ribbonsLayer,
  flash: flashLayer,
  kaleidoscope: kaleidoscopeLayer,
  'flow-field': flowFieldLayer,
  aurora: auroraLayer,
  'hex-grid': hexGridLayer,
};
