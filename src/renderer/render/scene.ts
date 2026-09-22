// Lane scene model for the Arrange view, built once per (project, layout)
// change. (The piano roll builds its own lane-free scene; see rollScene.ts.)
//
// This is also where per-frame work is bought down. Anything that depends only
// on the project and the lane layout — note times in seconds, note y offsets,
// velocity buckets, sort order — is computed here once rather than recomputed
// for every note on every frame.
import {
  NOTE_STRIDE,
  noteDuration,
  notePitch,
  noteStart,
  noteVelocity,
  type MidiRegionModel,
  type ProjectModel,
  type RegionModel,
} from '../../shared/model';
import { LOGIC_PPQ } from '../../shared/timebase';

/** Velocity is quantised so the renderer can batch notes by fill colour. */
export const VELOCITY_BUCKETS = 8;

/** Floats per note in `NoteBatch.data`: start, duration, y offset from lane top. */
export const NOTE_FIELDS = 3;

export type NoteBatch = {
  /** `NOTE_FIELDS` floats per note, ascending by start: [startSeconds, durationSeconds, y]. */
  data: Float32Array;
  /** Velocity bucket, 0..VELOCITY_BUCKETS-1, parallel to `data`. */
  buckets: Uint8Array;
  count: number;
  /** Longest note here, so a start-sorted search knows how far to back off. */
  maxDurationSeconds: number;
  /** Uniform within a region — derived from its pitch span. */
  noteHeight: number;
};

export type RenderRegion = {
  region: RegionModel;
  /** Precomputed notes for MIDI regions; null for audio. */
  notes: NoteBatch | null;
};

export type LaneLayout = {
  trackId: string;
  name: string;
  color: string;
  /** Track mute: every region on the lane draws as muted. */
  muted: boolean;
  top: number;
  height: number;
  /** Regions on this lane, sorted by startSeconds, for binary-search culling. */
  regions: RenderRegion[];
  /** Longest region here, so a start-sorted search knows how far to back off. */
  maxRegionDurationSeconds: number;
};

export type Scene = {
  lanes: LaneLayout[];
  contentHeight: number;
  endSeconds: number;
};

export type LaneLayoutConfig = {
  laneHeight: number;
  laneGap: number;
};

/**
 * Flattens a region's notes into typed arrays in absolute seconds, sorted by
 * start time. Logic stores notes in file order rather than time order (the
 * parser's pad-chunk walk preserves whatever order the save produced), so the
 * sort has to happen somewhere — doing it here means the frame loop can binary
 * search into a region instead of scanning all of its notes.
 */
function buildNoteBatch(region: MidiRegionModel, laneHeight: number): NoteBatch | null {
  const count = Math.floor(region.notes.length / NOTE_STRIDE);
  if (count === 0) return null;

  const span = Math.max(1, region.pitchMax - region.pitchMin);
  const innerTop = 5;
  const innerHeight = laneHeight - 10;
  const noteHeight = Math.max(1.5, innerHeight / (span + 1));

  // Notes are stored in ticks relative to the region; seconds per tick is taken
  // from the region's own duration so tempo changes inside it are approximated
  // linearly rather than ignored.
  const regionSeconds = region.endSeconds - region.startSeconds;
  const regionTicks = Math.max(1, region.lengthBeats * LOGIC_PPQ);
  const secondsPerTick = regionSeconds / regionTicks;

  const order = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) order[i] = i;
  order.sort((a, b) => noteStart(region.notes, a) - noteStart(region.notes, b));

  const data = new Float32Array(count * NOTE_FIELDS);
  const buckets = new Uint8Array(count);
  let maxDurationSeconds = 0;

  for (let slot = 0; slot < count; slot += 1) {
    const i = order[slot]!;
    const startSeconds = region.startSeconds + noteStart(region.notes, i) * secondsPerTick;
    const durSeconds = Math.max(0.02, noteDuration(region.notes, i) * secondsPerTick);
    const pitch = notePitch(region.notes, i);
    const y = innerTop + (1 - (pitch - region.pitchMin) / span) * (innerHeight - noteHeight);

    const offset = slot * NOTE_FIELDS;
    data[offset] = startSeconds;
    data[offset + 1] = durSeconds;
    data[offset + 2] = y;
    buckets[slot] = Math.min(
      VELOCITY_BUCKETS - 1,
      Math.floor((noteVelocity(region.notes, i) / 127) * VELOCITY_BUCKETS),
    );
    if (durSeconds > maxDurationSeconds) maxDurationSeconds = durSeconds;
  }

  return { data, buckets, count, maxDurationSeconds, noteHeight };
}

export function buildScene(model: ProjectModel, config: LaneLayoutConfig): Scene {
  const byTrack = new Map<string, RegionModel[]>();
  for (const region of model.regions) {
    const list = byTrack.get(region.trackId);
    if (list) list.push(region);
    else byTrack.set(region.trackId, [region]);
  }

  // Only lanes that actually carry something are worth vertical space.
  const tracks = model.tracks
    .filter((track) => (byTrack.get(track.id)?.length ?? 0) > 0)
    .sort((a, b) => a.arrangeIndex - b.arrangeIndex);

  const lanes: LaneLayout[] = [];
  let top = 0;
  for (const track of tracks) {
    const sorted = (byTrack.get(track.id) ?? []).slice().sort((a, b) => a.startSeconds - b.startSeconds);
    let maxRegionDurationSeconds = 0;
    const regions: RenderRegion[] = sorted.map((region) => {
      const duration = region.endSeconds - region.startSeconds;
      if (duration > maxRegionDurationSeconds) maxRegionDurationSeconds = duration;
      return {
        region,
        notes: region.kind === 'midi' ? buildNoteBatch(region, config.laneHeight) : null,
      };
    });
    lanes.push({
      trackId: track.id,
      name: track.name,
      color: track.color,
      muted: track.muted,
      top,
      height: config.laneHeight,
      regions,
      maxRegionDurationSeconds,
    });
    top += config.laneHeight + config.laneGap;
  }
  return { lanes, contentHeight: Math.max(0, top - config.laneGap), endSeconds: model.endSeconds };
}

/**
 * Index of the first entry whose *start* is at or after `seconds`, in an array
 * sorted ascending by the value `startOf` returns.
 */
function lowerBound<T>(items: T[], seconds: number, startOf: (item: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const item = items[mid];
    if (item === undefined) break;
    if (startOf(item) < seconds) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Index of the first region that could still be visible at or after `seconds`.
 *
 * The array is sorted by start, not by end, so a search on `endSeconds` would
 * be searching a non-monotonic key and could skip a long region that is still
 * on screen. Instead: find the first region starting at or after the cut, then
 * back off by the lane's longest region, which is the furthest any earlier
 * region can reach.
 */
export function firstVisibleIndex(lane: LaneLayout, seconds: number): number {
  const from = lowerBound(lane.regions, seconds - lane.maxRegionDurationSeconds, (r) => r.region.startSeconds);
  return from;
}

/** Same idea as `firstVisibleIndex`, for notes inside one region. */
export function firstVisibleNote(batch: NoteBatch, seconds: number): number {
  const cut = seconds - batch.maxDurationSeconds;
  let low = 0;
  let high = batch.count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (batch.data[mid * NOTE_FIELDS]! < cut) low = mid + 1;
    else high = mid;
  }
  return low;
}
