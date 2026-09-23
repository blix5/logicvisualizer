// The renderer-facing project model. Everything here must survive structured
// clone across IPC: no Buffer, no class instances, no functions. Typed arrays
// are fine and are used for note data. Nothing here may import node: or electron.
import type { TempoEvent, TimeSignature } from './timebase';
import type { VolumeCurve } from './automation';

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
  /**
   * Whether the track is heard: true when its own channel is muted OR any
   * channel its output passes through is (a muted summing stack silences its
   * members). See mutedBy.
   */
  muted: boolean;
  /**
   * The track whose mute silences this one: itself, a stack's main track or an
   * aux track. null when unmuted, or when the muted channel has no arrange track.
   */
  mutedBy: string | null;
  /**
   * The volume automation the track is heard at: its own fader combined with
   * every channel its output passes through (a summing stack's fader scales all
   * its members). null when none of them is automated.
   */
  volume: VolumeCurve | null;
  /** The track's own volume automation, as drawn on its own lane. */
  ownVolume: VolumeCurve | null;
  /**
   * Logic's track number as its track header shows it, or null when the
   * arrange list was not found and arrangeIndex is only file order.
   */
  number: number | null;
  /** Track-stack nesting: 0 at top level, 1 inside a stack, 2 in a nested stack. */
  depth: number;
  /** id of the stack's main track when this track sits inside a stack. */
  parentId: string | null;
  /** Set when this track is a stack's main track. */
  stack: StackModel | null;
  /** The track's mixer channel, when it could be matched. */
  channel: ChannelModel | null;
};

export type StackModel = {
  /**
   * A summing stack: the main track is an Aux, and its members' outputs are
   * summed into it. False for a stack whose main track is an ordinary channel.
   */
  summing: boolean;
  /** Logic shows the members (the disclosure triangle is open). */
  expanded: boolean;
};

export type ChannelModel = {
  /** Logic's channel name: "Aux 4", "Inst 15", "Audio 24". */
  name: string;
  kind: 'audio' | 'instrument' | 'aux' | 'other';
  /** The bus this channel outputs to, or null for Stereo Out. */
  outputBus: number | null;
  /** The bus an Aux listens to; null on anything that is not an Aux. */
  inputBus: number | null;
};

type RegionBase = {
  id: string;
  trackId: string;
  name: string;
  startBeat: number;
  lengthBeats: number;
  startSeconds: number;
  endSeconds: number;
  /** Region mute (not track mute): the region is on the timeline but silent. */
  muted: boolean;
  /** Region Transpose in semitones, from the region inspector. 0 when untouched. */
  transposeSemitones: number;
};

/**
 * 4 ints per note: [startTicksRelativeToRegion, durationTicks, pitch, velocity].
 * The start can be negative: a note played just ahead of its region still sounds.
 */
export const NOTE_STRIDE = 4;
export function noteStart(n: Int32Array, i: number): number { return n[i * NOTE_STRIDE] ?? 0; }
export function noteDuration(n: Int32Array, i: number): number { return n[i * NOTE_STRIDE + 1] ?? 0; }
export function notePitch(n: Int32Array, i: number): number { return n[i * NOTE_STRIDE + 2] ?? 0; }
export function noteVelocity(n: Int32Array, i: number): number { return n[i * NOTE_STRIDE + 3] ?? 0; }

export type MidiRegionModel = RegionBase & {
  kind: 'midi';
  /** Pitches here are what Logic SOUNDS: the region's transpose is already applied. */
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
  /** Flex on in Logic. */
  flex: boolean;
  /** Reverse on in Logic: the region plays back-to-front, so its waveform is mirrored. */
  reversed: boolean;
  /** Fade lengths, from the region's start and to its end. 0 when there is none. */
  fadeInSeconds: number;
  fadeOutSeconds: number;
  /**
   * Fade curve, -1..1 with 0 linear, as Logic's -99..99 scaled. Positive eases
   * (slow near the silent end: "ease in" on a fade-in, "ease out" on a
   * fade-out); negative is the opposite bow.
   */
  fadeInCurve: number;
  fadeOutCurve: number;
  /**
   * Seconds of SOURCE audio consumed per second of timeline. 1 for an
   * unstretched region; below 1 when Flex slows a loop down to fit, above 1
   * when it speeds one up. The waveform must be scaled by this or a stretched
   * region's waveform stops short of (or overruns) the region.
   */
  sourceRate: number;
  /**
   * Position and track are decoded from the arrangement sequence. The region's
   * LENGTH is not: see logicAudio.ts. When true, endSeconds is an estimate from
   * the gap to the next region on the same lane and must be shown as such.
   */
  lengthApproximate: boolean;
};

export type RegionModel = MidiRegionModel | AudioRegionModel;

/**
 * The name Logic shows on a region: a transposed MIDI region reads
 * "Deluxe Classic (-7)" (re_probe15's WindowImage), so this does too.
 */
export function regionLabel(region: RegionModel): string {
  const t = region.transposeSemitones;
  if (region.kind !== 'midi' || t === 0) return region.name;
  return `${region.name} (${t > 0 ? '+' : ''}${t})`;
}

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
  /** 'major' or 'minor', from MetaData.plist SongGenderKey. */
  songScale: 'major' | 'minor' | null;
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
