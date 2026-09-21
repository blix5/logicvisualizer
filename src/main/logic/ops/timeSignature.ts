import { findAllTags, QSVE_HEADER_SIZE, readQSvePayloadLength } from './binary';
import type { ByteRange } from './types';

const QSVE_TAG = 'qSvE';
const SIGNATURE_RECORD_SIZE = 16;
const TIME_SIGNATURE_STATUS = 0x30;
const KEY_SIGNATURE_STATUS = 0x32;
const DENOMINATOR_LOG2_OFFSET = 11;
const NUMERATOR_OFFSET = 12;
const SONG_START_BAR_OFFSET = 8;
const SONG_START_TICKS_OFFSET = 12;
const VALID_DENOMINATORS = [1, 2, 4, 8, 16, 32] as const;
const MIN_NUMERATOR = 1;
const MAX_NUMERATOR = 32;

export type TimeSignatureRecord = {
  listIndex: number;
  qSveOffset: number;
  recordIndex: number;
  recordOffset: number;
  numerator: number;
  denominator: number;
  denominatorLog2: number;
};

export type SongStartRecord = {
  listIndex: number;
  qSveOffset: number;
  recordIndex: number;
  recordOffset: number;
  barNumber: number;
  preRollTicks: number;
};

export type KeySignatureRecord = {
  listIndex: number;
  qSveOffset: number;
  recordIndex: number;
  recordOffset: number;
  keyValue: number;
};

export type SignatureList = {
  index: number;
  qSveOffset: number;
  payloadLength: number;
  meterRecords: TimeSignatureRecord[];
  songStartRecords: SongStartRecord[];
  keyRecords: KeySignatureRecord[];
};

export type TimeSignatureInventory = {
  numerator: number;
  denominator: number;
  lists: SignatureList[];
  meterRecords: TimeSignatureRecord[];
};

function assertInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function denominatorLog2(denominator: number): number {
  if (!VALID_DENOMINATORS.includes(denominator as typeof VALID_DENOMINATORS[number])) {
    throw new Error(`denominator must be one of ${VALID_DENOMINATORS.join(', ')}.`);
  }
  return Math.log2(denominator);
}

function denominatorFromLog2(log2Value: number): number | null {
  const denominator = 2 ** log2Value;
  return VALID_DENOMINATORS.includes(denominator as typeof VALID_DENOMINATORS[number])
    ? denominator
    : null;
}

export function readTimeSignature(metadata: Record<string, unknown> | null | undefined): {
  numerator: number;
  denominator: number;
} {
  if (!metadata) {
    throw new Error('MetaData.plist is missing or unreadable.');
  }
  const numerator = assertInteger(
    metadata.SongSignatureNumerator,
    'MetaData.plist SongSignatureNumerator',
    1,
    32,
  );
  const denominator = assertInteger(
    metadata.SongSignatureDenominator,
    'MetaData.plist SongSignatureDenominator',
    1,
    32,
  );
  denominatorLog2(denominator);
  return { numerator, denominator };
}

export function findSignatureLists(buffer: Buffer): SignatureList[] {
  const lists: SignatureList[] = [];
  for (const qSveOffset of findAllTags(buffer, QSVE_TAG)) {
    const payloadLength = readQSvePayloadLength(buffer, qSveOffset, {
      minPayloadLength: SIGNATURE_RECORD_SIZE,
      payloadMultiple: SIGNATURE_RECORD_SIZE,
    });
    if (payloadLength === null) {
      continue;
    }
    const listIndex = lists.length;
    const recordsStart = qSveOffset + QSVE_HEADER_SIZE;
    const meterRecords: TimeSignatureRecord[] = [];
    const songStartRecords: SongStartRecord[] = [];
    const keyRecords: KeySignatureRecord[] = [];
    for (
      let rel = 0, recordIndex = 0;
      rel + SIGNATURE_RECORD_SIZE <= payloadLength;
      rel += SIGNATURE_RECORD_SIZE, recordIndex += 1
    ) {
      const recordOffset = recordsStart + rel;
      const status = buffer[recordOffset];
      if (status === TIME_SIGNATURE_STATUS) {
        if (buffer[recordOffset + NUMERATOR_OFFSET] === 0) {
          const preRollTicks = buffer.readUInt32LE(recordOffset + SONG_START_TICKS_OFFSET);
          if (preRollTicks <= 0) {
            continue;
          }
          songStartRecords.push({
            listIndex,
            qSveOffset,
            recordIndex,
            recordOffset,
            barNumber: buffer.readInt16LE(recordOffset + SONG_START_BAR_OFFSET),
            preRollTicks,
          });
          continue;
        }
        const numerator = buffer[recordOffset + NUMERATOR_OFFSET];
        if (numerator === undefined || numerator < MIN_NUMERATOR || numerator > MAX_NUMERATOR) {
          continue;
        }
        const denominatorLog = buffer[recordOffset + DENOMINATOR_LOG2_OFFSET];
        if (denominatorLog === undefined) {
          continue;
        }
        const denominator = denominatorFromLog2(denominatorLog);
        if (denominator === null) {
          continue;
        }
        meterRecords.push({
          listIndex,
          qSveOffset,
          recordIndex,
          recordOffset,
          numerator,
          denominator,
          denominatorLog2: denominatorLog,
        });
      } else if (status === KEY_SIGNATURE_STATUS) {
        keyRecords.push({
          listIndex,
          qSveOffset,
          recordIndex,
          recordOffset,
          keyValue: buffer[recordOffset + NUMERATOR_OFFSET] ?? 0,
        });
      }
    }
    if (meterRecords.length > 0 && (songStartRecords.length > 0 || keyRecords.length > 0)) {
      lists.push({
        index: listIndex,
        qSveOffset,
        payloadLength,
        meterRecords,
        songStartRecords,
        keyRecords,
      });
    }
  }
  return lists;
}

function flattenMeterRecords(lists: SignatureList[]): TimeSignatureRecord[] {
  return lists.flatMap((list) => list.meterRecords);
}

function flattenSongStartRecords(lists: SignatureList[]): SongStartRecord[] {
  return lists.flatMap((list) => list.songStartRecords);
}

function flattenKeyRecords(lists: SignatureList[]): KeySignatureRecord[] {
  return lists.flatMap((list) => list.keyRecords);
}

function formatSignature(numerator: number, denominator: number): string {
  return `${numerator}/${denominator}`;
}

function assertSameRecordLocation(
  before: { qSveOffset: number; recordIndex: number; recordOffset: number },
  after: { qSveOffset: number; recordIndex: number; recordOffset: number },
  label: string,
): void {
  if (
    after.qSveOffset !== before.qSveOffset
    || after.recordIndex !== before.recordIndex
    || after.recordOffset !== before.recordOffset
  ) {
    throw new Error(`Semantic proof failed: ${label} structure changed.`);
  }
}

function assertRecordBytesIdentical(
  original: Buffer,
  edited: Buffer,
  recordOffset: number,
  label: string,
): void {
  const before = original.subarray(recordOffset, recordOffset + SIGNATURE_RECORD_SIZE);
  const after = edited.subarray(recordOffset, recordOffset + SIGNATURE_RECORD_SIZE);
  if (!before.equals(after)) {
    throw new Error(`Semantic proof failed: ${label} record changed.`);
  }
}

function assertMeterRecordOnlySignatureBytesChanged(
  original: Buffer,
  edited: Buffer,
  recordOffset: number,
): void {
  for (let rel = 0; rel < SIGNATURE_RECORD_SIZE; rel += 1) {
    if (rel === DENOMINATOR_LOG2_OFFSET || rel === NUMERATOR_OFFSET) {
      continue;
    }
    if (original[recordOffset + rel] !== edited[recordOffset + rel]) {
      throw new Error('Semantic proof failed: a non-meter byte changed inside a time-signature record.');
    }
  }
}

export function listTimeSignature(
  buffer: Buffer,
  metadata: Record<string, unknown> | null | undefined,
): TimeSignatureInventory {
  const metadataSignature = readTimeSignature(metadata);
  const lists = findSignatureLists(buffer);
  return {
    numerator: metadataSignature.numerator,
    denominator: metadataSignature.denominator,
    lists,
    meterRecords: flattenMeterRecords(lists),
  };
}
