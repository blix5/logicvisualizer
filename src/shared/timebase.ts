// Beat <-> second conversion over a tempo map. Pure and dependency-free: the
// main process uses it to precompute region times, the renderer uses it for the
// ruler and for scrubbing. Nothing here may import node: or electron.

export const LOGIC_PPQ = 960;
/** Logic writes bar 1 at tick 38400 in absolute-origin structures. */
export const LOGIC_BAR1_TICK_ORIGIN = 38400;

export type TempoEvent = { beat: number; bpm: number };
export type TimeSignature = { beat: number; numerator: number; denominator: number };

export type TempoSegment = {
  startBeat: number;
  startSeconds: number;
  bpm: number;
  secondsPerBeat: number;
};

export type TempoMap = {
  segments: TempoSegment[];
  baseBpm: number;
};

/**
 * Region cells store bar-1-relative ticks while notes, tempo and marker records
 * carry the +38400 origin. Callers must say which encoding they hold rather
 * than relying on a magnitude guess, which breaks for content past bar 11.
 */
export function ticksToBeats(ticks: number, origin: 'bar1' | 'absolute'): number {
  const base = origin === 'absolute' ? ticks - LOGIC_BAR1_TICK_ORIGIN : ticks;
  return base / LOGIC_PPQ;
}

export function buildTempoMap(events: TempoEvent[], baseBpm: number): TempoMap {
  const usable = events
    .filter((e) => Number.isFinite(e.beat) && Number.isFinite(e.bpm) && e.bpm >= 1 && e.bpm <= 999)
    .sort((a, b) => a.beat - b.beat);

  // Logic writes mirrored tempo records; the last write at a beat wins.
  const deduped: TempoEvent[] = [];
  for (const event of usable) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.beat === event.beat) deduped[deduped.length - 1] = event;
    else deduped.push(event);
  }

  const first = deduped[0];
  if (!first || first.beat > 0) {
    deduped.unshift({ beat: 0, bpm: baseBpm });
  }

  const segments: TempoSegment[] = [];
  let seconds = 0;
  for (let i = 0; i < deduped.length; i += 1) {
    const event = deduped[i];
    if (!event) continue;
    const previous = segments[segments.length - 1];
    if (previous) {
      seconds = previous.startSeconds + (event.beat - previous.startBeat) * previous.secondsPerBeat;
    }
    segments.push({
      startBeat: event.beat,
      startSeconds: seconds,
      bpm: event.bpm,
      secondsPerBeat: 60 / event.bpm,
    });
  }
  return { segments, baseBpm };
}

function segmentIndexByBeat(map: TempoMap, beat: number): number {
  const { segments } = map;
  let low = 0;
  let high = segments.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (!segment) break;
    if (segment.startBeat <= beat) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  return found;
}

function segmentIndexBySeconds(map: TempoMap, seconds: number): number {
  const { segments } = map;
  let low = 0;
  let high = segments.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (!segment) break;
    if (segment.startSeconds <= seconds) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  return found;
}

/** Beats before the first segment extrapolate at segment 0's tempo (pickup bars). */
export function beatsToSeconds(map: TempoMap, beat: number): number {
  const segment = map.segments[segmentIndexByBeat(map, beat)];
  if (!segment) return 0;
  return segment.startSeconds + (beat - segment.startBeat) * segment.secondsPerBeat;
}

export function secondsToBeats(map: TempoMap, seconds: number): number {
  const segment = map.segments[segmentIndexBySeconds(map, seconds)];
  if (!segment) return 0;
  return segment.startBeat + (seconds - segment.startSeconds) / segment.secondsPerBeat;
}

export function bpmAtBeat(map: TempoMap, beat: number): number {
  return map.segments[segmentIndexByBeat(map, beat)]?.bpm ?? map.baseBpm;
}

export type BarGridEntry = {
  bar: number;
  beat: number;
  seconds: number;
  /** Bar length in quarter-note beats: 3 for 6/8. */
  beatsInBar: number;
  /** The bar's time signature, for counting its beats as Logic does (six in 6/8). */
  numerator: number;
  denominator: number;
};

/**
 * Walks the signature map rather than assuming 4/4 — several real projects
 * (e.g. sixeight.logicx) are not in four.
 */
export function buildBarGrid(
  tempo: TempoMap,
  signatures: TimeSignature[],
  untilSeconds: number,
): BarGridEntry[] {
  const sorted = [...signatures].sort((a, b) => a.beat - b.beat);
  if (!sorted[0] || sorted[0].beat > 0) {
    sorted.unshift({ beat: 0, numerator: 4, denominator: 4 });
  }
  const grid: BarGridEntry[] = [];
  let beat = 0;
  let bar = 1;
  let sigIndex = 0;
  for (let guard = 0; guard < 100_000; guard += 1) {
    while (sigIndex + 1 < sorted.length && (sorted[sigIndex + 1]?.beat ?? Infinity) <= beat) {
      sigIndex += 1;
    }
    const sig = sorted[sigIndex] ?? { beat: 0, numerator: 4, denominator: 4 };
    const beatsInBar = sig.numerator * (4 / sig.denominator);
    const seconds = beatsToSeconds(tempo, beat);
    if (seconds > untilSeconds) break;
    grid.push({ bar, beat, seconds, beatsInBar, numerator: sig.numerator, denominator: sig.denominator });
    beat += beatsInBar;
    bar += 1;
  }
  return grid;
}
