// Fallback track colours, used until the palette index is decoded out of
// ProjectData, and the renderer's "Vivid" palette. A golden-angle hue walk
// gives maximally separated hues for any track count without a hand-tuned
// list; audio and MIDI read as two families.
import type { TrackKind } from './model';

const GOLDEN_ANGLE = 137.508;

export function fallbackTrackColor(index: number, kind: TrackKind): string {
  const hue = (index * GOLDEN_ANGLE) % 360;
  const saturation = kind === 'audio' ? 42 : 62;
  const lightness = kind === 'audio' ? 52 : 58;
  return `hsl(${hue.toFixed(1)} ${saturation}% ${lightness}%)`;
}
