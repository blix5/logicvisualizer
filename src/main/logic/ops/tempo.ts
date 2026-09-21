import { findAllTags, QSVE_HEADER_SIZE, readQSvePayloadLength } from './binary';
import type { ByteRange } from './types';

const QSVE_TAG = 'qSvE';
const TEMPO_RECORD_SIZE = 32;
const TEMPO_STATUS = 0x60;
const TEMPO_POSITION_OFFSET = 4;
const TEMPO_VALUE_OFFSET = 16;
const TEMPO_SCALE = 10_000;
const LOGIC_BAR1_TICK = 38_400;
const MIN_BPM = 1;
const MAX_BPM = 999;
const BASE_TEMPO_MIRROR_OFFSETS = [0xaa, 0x102, 0x3be];

export type TempoEvent = {
  listIndex: number;
  qSveOffset: number;
  recordIndex: number;
  recordOffset: number;
  positionTicks: number;
  bpm: number;
  tempoRaw: number;
  isStart: boolean;
};

export type TempoList = {
  index: number;
  qSveOffset: number;
  payloadLength: number;
  events: TempoEvent[];
};

export type TempoInventory = {
  baseTempo: number;
  lists: TempoList[];
};

function assertBpm(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_BPM || value > MAX_BPM) {
    throw new Error(`${label} must be a number from ${MIN_BPM} to ${MAX_BPM}.`);
  }
  return value;
}

export function readBaseTempo(metadata: Record<string, unknown> | null | undefined): number {
  if (!metadata) {
    throw new Error('MetaData.plist is missing or unreadable.');
  }
  return assertBpm(metadata.BeatsPerMinute, 'MetaData.plist BeatsPerMinute');
}

function tempoRawFromBpm(bpm: number): number {
  return Math.round(assertBpm(bpm, 'bpm') * TEMPO_SCALE);
}

function bpmFromRaw(raw: number): number {
  return raw / TEMPO_SCALE;
}

function formatBpm(bpm: number): string {
  return String(Math.round(bpm * TEMPO_SCALE) / TEMPO_SCALE);
}

export function findTempoLists(buffer: Buffer): TempoList[] {
  const lists: TempoList[] = [];
  for (const qSveOffset of findAllTags(buffer, QSVE_TAG)) {
    const payloadLength = readQSvePayloadLength(buffer, qSveOffset, {
      minPayloadLength: TEMPO_RECORD_SIZE,
    });
    if (payloadLength === null) {
      continue;
    }
    const recordsStart = qSveOffset + QSVE_HEADER_SIZE;
    const events: TempoEvent[] = [];
    const listIndex = lists.length;
    for (
      let rel = 0, recordIndex = 0;
      rel + TEMPO_RECORD_SIZE <= payloadLength;
      rel += TEMPO_RECORD_SIZE, recordIndex += 1
    ) {
      const recordOffset = recordsStart + rel;
      if (buffer[recordOffset] !== TEMPO_STATUS) {
        continue;
      }
      const tempoRaw = buffer.readUInt32LE(recordOffset + TEMPO_VALUE_OFFSET);
      const bpm = bpmFromRaw(tempoRaw);
      if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) {
        continue;
      }
      const positionTicks = buffer.readUInt32LE(recordOffset + TEMPO_POSITION_OFFSET);
      events.push({
        listIndex,
        qSveOffset,
        recordIndex,
        recordOffset,
        positionTicks,
        bpm,
        tempoRaw,
        isStart: positionTicks === LOGIC_BAR1_TICK,
      });
    }
    if (events.length > 0) {
      lists.push({
        index: listIndex,
        qSveOffset,
        payloadLength,
        events,
      });
    }
  }
  return lists;
}

export function listTempo(buffer: Buffer, metadata: Record<string, unknown> | null | undefined): TempoInventory {
  return {
    baseTempo: readBaseTempo(metadata),
    lists: findTempoLists(buffer),
  };
}

function flattenEvents(lists: TempoList[]): TempoEvent[] {
  return lists.flatMap((list) => list.events);
}

function describeBpmSet(values: number[]): string {
  const unique = [...new Set(values.map(formatBpm))];
  return unique.join(', ');
}

function candidateBaseTempoRaws(oldBaseRaw: number, startEvents: TempoEvent[]): Set<number> {
  return new Set([oldBaseRaw, ...startEvents.map((event) => event.tempoRaw)]);
}
