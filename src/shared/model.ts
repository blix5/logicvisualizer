// The renderer-facing project model. Everything here must survive structured
// clone across IPC: no Buffer, no class instances, no functions. Typed arrays
// are fine and are used for note data. Nothing here may import node: or electron.
import type { TempoEvent, TimeSignature } from './timebase';

export type TrackKind = 'midi' | 'audio' | 'unknown';

export type TrackModel = {
  /** Stable across reloads (byte offsets are not — they shift on every save). */
  id: string;
  arrangeIndex: number;
  name: string;
  kind: TrackKind;
  color: string;
  colorSource: 'project' | 'fallback' | 'user';
  trackRef: number;
  /** Track mute, read from its mixer channel. */
  muted: boolean;
};

type RegionBase = {
  id: string;
  trackId: string;
  name: string;
  startBeat: number;
  lengthBeats: number;
  startSeconds: number;
  endSeconds: number;
};

/** 4 ints per note: [startTicksRelativeToRegion, durationTicks, pitch, velocity]. */
export const NOTE_STRIDE = 4;
export function noteStart(n: Int32Array, i: number): number { return n[i * NOTE_STRIDE] ?? 0; }
export function noteDuration(n: Int32Array, i: number): number { return n[i * NOTE_STRIDE + 1] ?? 0; }
export function notePitch(n: Int32Array, i: number): number { return n[i * NOTE_STRIDE + 2] ?? 0; }
export function noteVelocity(n: Int32Array, i: number): number { return n[i * NOTE_STRIDE + 3] ?? 0; }

export type MidiRegionModel = RegionBase & {
  kind: 'midi';
  notes: Int32Array;
  noteCount: number;
  pitchMin: number;
  pitchMax: number;
};

export type AudioRegionModel = RegionBase & {
  kind: 'audio';
  audioFileId: string | null;
  /** Where in the source file this region starts (trim-in). */
  fileStartSeconds: number;
  /** Clip gain in decibels, from the region inspector. */
  gainDb: number;
  /**
   * Position and track are decoded from the arrangement sequence. The region's
   * LENGTH is not: see logicAudio.ts. When true, endSeconds is an estimate from
   * the gap to the next region on the same lane and must be shown as such.
   */
  lengthApproximate: boolean;
};

export type RegionModel = MidiRegionModel | AudioRegionModel;

export type AudioFileModel = {
  id: string;
  fileName: string;
  relativePath: string | null;
  absolutePath: string | null;
  exists: boolean;
};

export type MarkerModel = {
  id: string;
  name: string;
  startBeat: number;
  startSeconds: number;
};

/**
 * What this parse was actually able to resolve. The UI reads these rather than
 * guessing from empty arrays, so degradation is explicit instead of silent.
 */
export type ProjectCapabilities = {
  midiRegions: boolean;
  audioRegions: boolean;
  audioRegionTracks: boolean;
  trackColors: boolean;
  tempoMap: boolean;
  timeSignatureMap: boolean;
};

export type ProjectModel = {
  schemaVersion: 1;
  projectPath: string;
  projectName: string;
  alternativeId: string;
  projectDataPath: string;
  windowImagePath: string | null;
  parsedAt: number;
  sourceMtimeMs: number;

  baseBpm: number;
  sampleRate: number;
  songKey: string | null;
  tempoEvents: TempoEvent[];
  timeSignatures: TimeSignature[];

  tracks: TrackModel[];
  regions: RegionModel[];
  audioFiles: AudioFileModel[];
  markers: MarkerModel[];

  endSeconds: number;
  capabilities: ProjectCapabilities;
  warnings: string[];
};
