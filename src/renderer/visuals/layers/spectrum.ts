// The original spectrum views and playhead particles, as layers. They wrap the
// existing painters unchanged; only where they read their input moved.
import { SpectrumPainter, type SpectrumLayout, type SpectrumMode } from '../../render/spectrum';
import { ParticleSystem } from '../../render/particles';
import type { StereoSpectrum } from '../../render/ArrangeRenderer';
import type { LayerInstance, VisualFrame } from '../types';

/** A stand-in roll layout for arrange: the whole canvas, no keyboard, no pitch rows. */
function arrangeLayout(frame: VisualFrame, into: SpectrumLayout): SpectrumLayout {
  into.width = frame.width;
  into.centreX = frame.centreX;
  into.rollTop = frame.top;
  into.rollBottom = frame.height;
  into.keyWidth = 0;
  into.canvasHeight = frame.height;
  into.pixelsPerSecond = frame.pixelsPerSecond;
  into.playheadSeconds = frame.playheadSeconds;
  into.live = frame.playing;
  into.scene = frame.scene;
  return into;
}

export function spectrumLayer(mode: Exclude<SpectrumMode, 'none'>): () => LayerInstance {
  return () => {
    const painter = new SpectrumPainter();
    const spectrum: StereoSpectrum = { left: new Float32Array(0), right: new Float32Array(0), sampleRate: 48000 };
    const layout: SpectrumLayout = {
      width: 0, centreX: 0, rollTop: 0, rollBottom: 0, keyWidth: 0, pitchLow: 0, pitchHigh: 127,
      pitchY: new Float32Array(128), rowHeight: 1, canvasHeight: 0, pixelsPerSecond: 1,
      playheadSeconds: 0, live: false, scene: {},
    };
    return {
      setTheme: (theme) => painter.setTheme(theme),
      draw(ctx, frame, layer) {
        painter.alpha = layer.opacity;
        const features = frame.features;
        let input: StereoSpectrum | null = null;
        if (features.valid) {
          spectrum.left = features.left;
          spectrum.right = features.right;
          spectrum.sampleRate = features.sampleRate;
          input = spectrum;
        }
        painter.draw(ctx, mode, input, frame.roll ?? arrangeLayout(frame, layout));
      },
    };
  };
}

export function particlesLayer(): LayerInstance {
  const system = new ParticleSystem();
  return {
    get animating() { return system.animating; },
    reset: () => system.clear(),
    draw(ctx, frame, layer) {
      const { hits } = frame;
      for (let i = 0; i < hits.count; i += 1) {
        system.emit(hits.x[i]!, hits.y[i]!, hits.color[i]!, hits.strength[i]!, hits.pixelsPerSecond, layer.intensity);
      }
      system.step(frame.now);
      system.draw(ctx, frame.theme.blend, frame.sprite, layer.opacity);
    },
  };
}
