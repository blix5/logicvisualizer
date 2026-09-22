// Scene model for the piano-roll view, built once per project.
//
// Unlike the lane scene there is no vertical layout here: every audible MIDI
// note shares one pitch axis, and the renderer maps pitch to y through a table
// it rebuilds on resize. What is precomputed is everything the frame loop would
// otherwise redo per note — times in seconds, start-sorted order, velocity
// buckets — so a frame is a binary search plus a linear walk of what is visible.
import {
  NOTE_STRIDE,
  noteDuration,
  notePitch,
  noteStart,
  noteVelocity,
  type AudioRegionModel,
  type MidiRegionModel,
  type ProjectModel,
} from '../../shared/model';
import { LOGIC_PPQ } from '../../shared/timebase';
import { TRANSCRIBED_FIELDS } from '../audio/transcribe';
import { VELOCITY_BUCKETS } from './scene';

/** Semitones of headroom above and below the highest and lowest notes. */
const PITCH_PAD = 2;
/** A roll narrower than this makes a two-note bassline fill the screen. */
const MIN_PITCH_SPAN = 24;

/** One track's notes, flattened across its regions and sorted by start. */
export type RollTrack = {
  trackId: string;
  color: string;
  start: Float32Array;
  duration: Float32Array;
  pitch: Uint8Array;
  bucket: Uint8Array;
  count: number;
  /** Longest note here, so a start-sorted search knows how far to back off. */
  maxDurationSeconds: number;
  /**
   * Notes derived from this track's audio. The renderer draws each as the
   * region's own waveform shifted to the note's pitch, Flex Pitch style.
   */
  converted: boolean;
  /** Converted tracks only: the region each note came from, indexing `sources`. */
  source?: Uint32Array;
  sources?: AudioRegionModel[];
};

/** Transcribed notes by audio file id, in source-file seconds; see transcribe.ts. */
export type TranscriptLookup = (audioFileId: string) => Float32Array | null;

export type RollAudio = {
  region: AudioRegionModel;
  color: string;
};

export type RollScene = {
  tracks: RollTrack[];
  /** Audible audio regions across every track, sorted by startSeconds. */
  audio: RollAudio[];
  maxAudioDurationSeconds: number;
  /** Inclusive pitch range the roll spans, padding included. */
  pitchLow: number;
  pitchHigh: number;
};

function velocityBucket(velocity: number): number {
  return Math.max(0, Math.min(VELOCITY_BUCKETS - 1, Math.floor((velocity / 127) * VELOCITY_BUCKETS)));
}

/** Notes in timeline seconds, unsorted, as they are gathered. */
type RawNotes = {
  start: number[];
  duration: number[];
  pitch: number[];
  bucket: number[];
  /** Converted notes only: index into `sources`. */
  source: number[];
  sources: AudioRegionModel[];
};

function rawNotes(): RawNotes {
  return { start: [], duration: [], pitch: [], bucket: [], source: [], sources: [] };
}

function addMidi(raw: RawNotes, region: MidiRegionModel): void {
  const count = Math.floor(region.notes.length / NOTE_STRIDE);
  // Same linear seconds-per-tick approximation as the lane scene, so a note
  // lands at the same x in every mode.
  const secondsPerTick = (region.endSeconds - region.startSeconds)
    / Math.max(1, region.lengthBeats * LOGIC_PPQ);
  for (let i = 0; i < count; i += 1) {
    raw.start.push(region.startSeconds + noteStart(region.notes, i) * secondsPerTick);
    raw.duration.push(Math.max(0.02, noteDuration(region.notes, i) * secondsPerTick));
    raw.pitch.push(Math.max(0, Math.min(127, notePitch(region.notes, i))));
    raw.bucket.push(velocityBucket(noteVelocity(region.notes, i)));
  }
}

/**
 * Maps a file's transcribed notes into one region: source seconds become
 * timeline seconds through the trim-in and the flex rate, and anything outside
 * the region's bounds is clipped away. Pitched notes outside [low, high] are
 * dropped; unpitched hits are clamped into it instead, so a narrow roll still
 * shows kicks along its bottom and hats along its top.
 */
function addTranscript(
  raw: RawNotes,
  region: AudioRegionModel,
  notes: Float32Array,
  low: number,
  high: number,
): void {
  const rate = region.sourceRate > 0 ? region.sourceRate : 1;
  const sourceIndex = raw.sources.length;
  raw.sources.push(region);
  for (let i = 0; i + TRANSCRIBED_FIELDS <= notes.length; i += TRANSCRIBED_FIELDS) {
    const unpitched = notes[i + 4] === 1;
    let pitch = notes[i + 2]!;
    if (unpitched) pitch = Math.max(low, Math.min(high, pitch));
    else if (pitch < low || pitch > high) continue;
    const from = region.startSeconds + (notes[i]! - region.fileStartSeconds) / rate;
    const to = from + notes[i + 1]! / rate;
    const start = Math.max(from, region.startSeconds);
    const end = Math.min(to, region.endSeconds);
    if (end - start < 0.02) continue;
    raw.start.push(start);
    raw.duration.push(end - start);
    raw.pitch.push(pitch);
    raw.bucket.push(velocityBucket(notes[i + 3]!));
    raw.source.push(sourceIndex);
  }
}

function buildTrack(trackId: string, color: string, raw: RawNotes, converted: boolean): RollTrack | null {
  const total = raw.start.length;
  if (total === 0) return null;
  const rawStart = raw.start;
  const rawDuration = raw.duration;
  const rawPitch = raw.pitch;
  const rawBucket = raw.bucket;

  const order = new Uint32Array(total);
  for (let i = 0; i < total; i += 1) order[i] = i;
  order.sort((a, b) => rawStart[a]! - rawStart[b]!);

  const start = new Float32Array(total);
  const duration = new Float32Array(total);
  const pitch = new Uint8Array(total);
  const bucket = new Uint8Array(total);
  const source = converted ? new Uint32Array(total) : undefined;
  let maxDurationSeconds = 0;
  for (let slot = 0; slot < total; slot += 1) {
    const i = order[slot]!;
    start[slot] = rawStart[i]!;
    duration[slot] = rawDuration[i]!;
    pitch[slot] = rawPitch[i]!;
    bucket[slot] = rawBucket[i]!;
    if (source) source[slot] = raw.source[i]!;
    if (duration[slot]! > maxDurationSeconds) maxDurationSeconds = duration[slot]!;
  }
  const track: RollTrack = { trackId, color, start, duration, pitch, bucket, count: total, maxDurationSeconds, converted };
  if (source) {
    track.source = source;
    track.sources = raw.sources;
  }
  return track;
}

export function buildRollScene(model: ProjectModel, transcripts?: TranscriptLookup): RollScene {
  // The roll shows what sounds, so muted tracks are left out entirely.
  const audible = new Map(model.tracks.filter((track) => !track.muted).map((track) => [track.id, track]));

  const midiByTrack = new Map<string, MidiRegionModel[]>();
  const audio: RollAudio[] = [];
  let maxAudioDurationSeconds = 0;
  let pitchMin = Infinity;
  let pitchMax = -Infinity;

  for (const region of model.regions) {
    const track = audible.get(region.trackId);
    // Muted tracks and muted regions alike: the roll shows what sounds.
    if (!track || region.muted) continue;
    if (region.kind === 'midi') {
      if (region.noteCount === 0) continue;
      const list = midiByTrack.get(track.id);
      if (list) list.push(region);
      else midiByTrack.set(track.id, [region]);
      if (region.pitchMin < pitchMin) pitchMin = region.pitchMin;
      if (region.pitchMax > pitchMax) pitchMax = region.pitchMax;
    } else {
      audio.push({ region, color: track.color });
      const duration = region.endSeconds - region.startSeconds;
      if (duration > maxAudioDurationSeconds) maxAudioDurationSeconds = duration;
    }
  }
  audio.sort((a, b) => a.region.startSeconds - b.region.startSeconds);

  // With no MIDI at all, the converted notes are all there is to fit the roll to.
  if (!Number.isFinite(pitchMin) && transcripts) {
    for (const { region } of audio) {
      const notes = region.audioFileId ? transcripts(region.audioFileId) : null;
      if (!notes) continue;
      for (let i = 0; i + TRANSCRIBED_FIELDS <= notes.length; i += TRANSCRIBED_FIELDS) {
        if (notes[i + 4] === 1) continue; // hits are clamped in, not fitted to
        if (notes[i + 2]! < pitchMin) pitchMin = notes[i + 2]!;
        if (notes[i + 2]! > pitchMax) pitchMax = notes[i + 2]!;
      }
    }
  }
  if (!Number.isFinite(pitchMin)) { pitchMin = 48; pitchMax = 72; }
  let low = pitchMin - PITCH_PAD;
  let high = pitchMax + PITCH_PAD;
  const short = MIN_PITCH_SPAN - (high - low + 1);
  if (short > 0) {
    low -= Math.floor(short / 2);
    high += Math.ceil(short / 2);
  }
  // Shift rather than clip, so the padded span survives near either end.
  if (low < 0) { high -= low; low = 0; }
  if (high > 127) { low = Math.max(0, low - (high - 127)); high = 127; }

  const tracks: RollTrack[] = [];
  const ordered = model.tracks.slice().sort((a, b) => a.arrangeIndex - b.arrangeIndex);
  // Converted tracks go first so real MIDI draws over them.
  if (transcripts) {
    const byTrack = new Map<string, RawNotes>();
    for (const { region } of audio) {
      const notes = region.audioFileId ? transcripts(region.audioFileId) : null;
      if (!notes) continue;
      let raw = byTrack.get(region.trackId);
      if (!raw) { raw = rawNotes(); byTrack.set(region.trackId, raw); }
      // Clipped to the roll's range, which real MIDI sets: a drum loop's
      // scattered peaks would otherwise stretch it across the whole keyboard.
      addTranscript(raw, region, notes, low, high);
    }
    for (const track of ordered) {
      const raw = byTrack.get(track.id);
      const built = raw ? buildTrack(track.id, track.color, raw, true) : null;
      if (built) tracks.push(built);
    }
  }
  for (const track of ordered) {
    const regions = midiByTrack.get(track.id);
    if (!regions) continue;
    const raw = rawNotes();
    for (const region of regions) addMidi(raw, region);
    const built = buildTrack(track.id, track.color, raw, false);
    if (built) tracks.push(built);
  }

  return { tracks, audio, maxAudioDurationSeconds, pitchLow: low, pitchHigh: high };
}

/**
 * Index of the first note that could still be visible at or after `seconds`:
 * the first note starting at or after the cut, backed off by the track's longest
 * note, which is the furthest any earlier note can reach.
 */
export function firstVisibleRollNote(track: RollTrack, seconds: number): number {
  const cut = seconds - track.maxDurationSeconds;
  let low = 0;
  let high = track.count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (track.start[mid]! < cut) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Same idea for the background audio regions. */
export function firstVisibleRollAudio(scene: RollScene, seconds: number): number {
  const cut = seconds - scene.maxAudioDurationSeconds;
  let low = 0;
  let high = scene.audio.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (scene.audio[mid]!.region.startSeconds < cut) low = mid + 1;
    else high = mid;
  }
  return low;
}
