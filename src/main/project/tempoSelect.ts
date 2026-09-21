// Picks the real tempo list out of a ProjectData image.
//
// findTempoLists() locates candidates by scanning for the 0x60 status byte,
// which produces false positives: 5 of the 50 projects in ~/Music/Logic carry
// extra "lists" full of nonsense (positions near 2^31, tempi around 1.6 BPM).
// sixeight.logicx is the worst case — 5 lists, 11 events, only 1 of them real.
//
// In every affected project exactly one list contains the song-start event
// (isStart, at tick 38400), so that is the selector; the plausibility filter is
// the backstop for a project whose list somehow lacks one.
import type { TempoEvent as RawTempoEvent, TempoList } from '../logic/ops/tempo';
import { LOGIC_BAR1_TICK_ORIGIN, type TempoEvent } from '../../shared/timebase';

/** ~13000 bars at 4/4 — beyond any real song, but rejects 2^31-ish garbage. */
const MAX_PLAUSIBLE_TICK = LOGIC_BAR1_TICK_ORIGIN + 50_000_000;
const MIN_MUSICAL_BPM = 10;
const MAX_MUSICAL_BPM = 400;

function isPlausible(event: RawTempoEvent): boolean {
  return event.positionTicks >= LOGIC_BAR1_TICK_ORIGIN
    && event.positionTicks <= MAX_PLAUSIBLE_TICK
    && event.bpm >= MIN_MUSICAL_BPM
    && event.bpm <= MAX_MUSICAL_BPM;
}

export type TempoSelection = {
  events: TempoEvent[];
  /** Events thrown away as implausible, so the UI can say so. */
  rejected: number;
};

export function selectTempoEvents(lists: TempoList[]): TempoSelection {
  let rejected = 0;
  for (const list of lists) {
    for (const event of list.events) if (!isPlausible(event)) rejected += 1;
  }

  const withStart = lists.filter((list) => list.events.some((event) => event.isStart));
  const candidates = withStart.length > 0 ? withStart : lists;

  let best: RawTempoEvent[] = [];
  for (const list of candidates) {
    const usable = list.events.filter(isPlausible);
    if (usable.length > best.length) best = usable;
  }

  return {
    events: best.map((event) => ({
      // Tempo records carry the 38400 origin, unlike the arrangement sequence.
      beat: (event.positionTicks - LOGIC_BAR1_TICK_ORIGIN) / 960,
      bpm: event.bpm,
    })),
    rejected,
  };
}
