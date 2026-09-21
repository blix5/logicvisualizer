import { findAllTags } from './binary';
import type { ByteRange } from './types';

const QSVE_TAG = 'qSvE';
const QSX_TEXT_TAG = 'qSxT';
const QSVE_HEADER_SIZE = 36;
const QSVE_BLOCK_LENGTH_OFFSET = 28;
const QSVE_PAYLOAD_LENGTH_BIAS = 16;
const MARKER_RECORD_SIZE = 48;
const MARKER_STATUS = 0x12;
const MARKER_POSITION_OFFSET = 4;
const MARKER_TEXT_REF_OFFSET = 16;
const MARKER_LENGTH_OFFSET = 28;
const TRACK_MARKER_LENGTH_TICKS = 1;
const QSX_TEXT_HEADER_SIZE = 0x86;
const QSX_TEXT_ID_OFFSET = 10;
const QSX_TEXT_LENGTH_BIAS = 0x62;
const QSX_TEXT_LENGTH_OFFSETS = [28, 36, 56];
const FILE_SIZE_OFFSET = 0x10;
const LOGIC_PPQ = 960;
const LOGIC_TICK_ORIGIN = 38_400;

type Endian = 'LE' | 'BE';

type RawMarkerRecord = {
  recordIndex: number;
  recordOffset: number;
  positionTicks: number;
  textRef: number;
  lengthTicks: number;
};

type MarkerEventList = {
  qSveOffset: number;
  blockLength: number;
  encoding: Endian;
  recordsStart: number;
  records: RawMarkerRecord[];
  kind: 'track' | 'arrangement';
};

type TextObject = {
  id: number;
  tagOffset: number;
  textStart: number;
  textEnd: number;
  extentStart: number;
  extentEnd: number;
  header: Buffer;
  rawText: string;
  name: string;
  isRtf: boolean;
};

type SignatureInfo = {
  numerator: number;
  denominator: number;
  ticksPerBeat: number;
  ticksPerBar: number;
};

type TrackMarker = ListedTrackMarker & {
  textObjectId: number;
  textRef: number;
  recordOffset: number;
  recordIndex: number;
};

export type ListedTrackMarker = {
  number: number;
  name: string;
  positionTicks: number;
  barBeat: string;
};

function readU32(buffer: Buffer, offset: number, encoding: Endian): number {
  return encoding === 'BE' ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset);
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readSignature(metadata: Record<string, unknown> | null | undefined): SignatureInfo {
  const numerator = readPositiveInteger(metadata?.SongSignatureNumerator) ?? 4;
  const denominator = readPositiveInteger(metadata?.SongSignatureDenominator) ?? 4;
  const ticksPerBeat = LOGIC_PPQ * (4 / denominator);
  if (!Number.isFinite(ticksPerBeat) || ticksPerBeat <= 0 || !Number.isInteger(ticksPerBeat)) {
    return {
      numerator: 4,
      denominator: 4,
      ticksPerBeat: LOGIC_PPQ,
      ticksPerBar: LOGIC_PPQ * 4,
    };
  }
  return {
    numerator,
    denominator,
    ticksPerBeat,
    ticksPerBar: numerator * ticksPerBeat,
  };
}

function formatBeatValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1000) / 1000).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

export function formatMarkerBarBeat(
  positionTicks: number,
  metadata: Record<string, unknown> | null | undefined,
): string {
  const signature = readSignature(metadata);
  const relativeTicks = positionTicks - LOGIC_TICK_ORIGIN;
  const barIndex = Math.floor(relativeTicks / signature.ticksPerBar);
  const ticksInBar = relativeTicks - barIndex * signature.ticksPerBar;
  const beat = ticksInBar / signature.ticksPerBeat + 1;
  return `${barIndex + 1}.${formatBeatValue(beat)}`;
}

function readQSveCandidate(buffer: Buffer, qSveOffset: number, encoding: Endian): MarkerEventList | null {
  const lengthOffset = qSveOffset + QSVE_BLOCK_LENGTH_OFFSET;
  if (lengthOffset + 4 > buffer.length) return null;
  const blockLength = readU32(buffer, lengthOffset, encoding);
  const payloadLength = blockLength - QSVE_PAYLOAD_LENGTH_BIAS;
  if (
    blockLength < QSVE_PAYLOAD_LENGTH_BIAS
    || payloadLength <= 0
    || payloadLength % MARKER_RECORD_SIZE !== 0
    || qSveOffset + QSVE_HEADER_SIZE + payloadLength > buffer.length
  ) {
    return null;
  }

  const recordsStart = qSveOffset + QSVE_HEADER_SIZE;
  const records: RawMarkerRecord[] = [];
  for (
    let rel = 0, recordIndex = 0;
    rel + MARKER_RECORD_SIZE <= payloadLength;
    rel += MARKER_RECORD_SIZE, recordIndex += 1
  ) {
    const recordOffset = recordsStart + rel;
    records.push({
      recordIndex,
      recordOffset,
      positionTicks: readU32(buffer, recordOffset + MARKER_POSITION_OFFSET, encoding),
      textRef: readU32(buffer, recordOffset + MARKER_TEXT_REF_OFFSET, encoding),
      lengthTicks: readU32(buffer, recordOffset + MARKER_LENGTH_OFFSET, encoding),
    });
  }
  if (records.length === 0 || !records.every((record) => buffer[record.recordOffset] === MARKER_STATUS)) {
    return null;
  }
  const isTrackList = records.every((record) => record.lengthTicks === TRACK_MARKER_LENGTH_TICKS);
  return {
    qSveOffset,
    blockLength,
    encoding,
    recordsStart,
    records,
    kind: isTrackList ? 'track' : 'arrangement',
  };
}

function findMarkerEventLists(buffer: Buffer): MarkerEventList[] {
  const lists: MarkerEventList[] = [];
  for (const qSveOffset of findAllTags(buffer, QSVE_TAG)) {
    const little = readQSveCandidate(buffer, qSveOffset, 'LE');
    const big = readQSveCandidate(buffer, qSveOffset, 'BE');
    if (little && big) {
      throw new Error(
        `qSvE block at offset ${qSveOffset} validates under both little- and big-endian encoding; refusing to guess.`,
      );
    }
    const selected = little ?? big;
    if (selected) {
      lists.push(selected);
    }
  }
  return lists;
}

function findTrackMarkerList(buffer: Buffer): MarkerEventList {
  const lists = findMarkerEventLists(buffer).filter((list) => list.kind === 'track');
  if (lists.length === 0) {
    throw new Error('No Logic track marker list was found in ProjectData.');
  }
  if (lists.length > 1) {
    throw new Error(`Found ${lists.length} Logic track marker lists; refusing to guess which one to edit.`);
  }
  const first = lists[0];
  if (!first) throw new Error('No marker event list found in ProjectData.');
  return first;
}

function parseRtfTextEnd(raw: Buffer, absoluteStart: number, limit: number): number {
  let depth = 0;
  let escaped = false;
  for (let offset = absoluteStart; offset < limit; offset += 1) {
    const byte = raw[offset];
    if (escaped) {
      if (byte === 0x27) {
        offset += 2;
      }
      escaped = false;
      continue;
    }
    if (byte === 0x5c) {
      escaped = true;
      continue;
    }
    if (byte === 0x7b) {
      depth += 1;
    } else if (byte === 0x7d) {
      depth -= 1;
      if (depth === 0) {
        return offset + 1;
      }
    }
  }
  return limit;
}

function inferTextEnd(buffer: Buffer, textStart: number, limit: number): number {
  if (textStart >= limit) return textStart;
  if (buffer.subarray(textStart, Math.min(limit, textStart + 5)).toString('latin1') === '{\\rtf') {
    return parseRtfTextEnd(buffer, textStart, limit);
  }
  let end = textStart;
  while (end < limit && buffer[end] !== 0) end += 1;
  return end < limit ? end + 1 : end;
}

function parseRtfPlainText(raw: string): string {
  let output = '';
  let ignore = false;
  const stack: boolean[] = [];
  for (let index = 0; index < raw.length;) {
    const char = raw[index];
    if (char === '{') {
      stack.push(ignore);
      index += 1;
      continue;
    }
    if (char === '}') {
      ignore = stack.pop() ?? false;
      index += 1;
      continue;
    }
    if (char !== '\\') {
      if (!ignore) output += char;
      index += 1;
      continue;
    }

    const next = raw[index + 1];
    if (next === '\\' || next === '{' || next === '}') {
      if (!ignore) output += next;
      index += 2;
      continue;
    }
    if (next === "'") {
      const hex = raw.slice(index + 2, index + 4);
      const value = Number.parseInt(hex, 16);
      if (!ignore && Number.isFinite(value)) output += String.fromCharCode(value);
      index += 4;
      continue;
    }
    if (next === '*') {
      ignore = true;
      index += 2;
      continue;
    }

    const match = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(raw.slice(index));
    if (!match) {
      index += 1;
      continue;
    }
    const word = match[1];
    if (word !== undefined && ['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'expandedcolortbl'].includes(word)) {
      ignore = true;
    } else if (!ignore && (word === 'par' || word === 'line')) {
      output += '\n';
    } else if (!ignore && word === 'u' && match[2]) {
      output += String.fromCharCode(Number.parseInt(match[2], 10));
    }
    index += match[0].length;
  }
  return output.replace(/\0/g, '').replace(/\s+/g, ' ').trim();
}

function readPlainText(raw: string): string {
  return raw.replace(/\0.*$/s, '').trim();
}

function readTextObjectName(rawText: string, isRtf: boolean): string {
  return isRtf ? parseRtfPlainText(rawText) : readPlainText(rawText);
}

function findTextObjects(buffer: Buffer): TextObject[] {
  const tagOffsets = findAllTags(buffer, QSX_TEXT_TAG);
  const objects: TextObject[] = [];
  for (let index = 0; index < tagOffsets.length; index += 1) {
    const tagOffset = tagOffsets[index];
    if (tagOffset === undefined) continue;
    const textStart = tagOffset + QSX_TEXT_HEADER_SIZE;
    if (textStart > buffer.length || tagOffset + QSX_TEXT_ID_OFFSET + 4 > buffer.length) {
      continue;
    }
    const nextTag = tagOffsets[index + 1] ?? -1;
    const limit = nextTag >= 0 ? nextTag : buffer.length;
    const textEnd = inferTextEnd(buffer, textStart, limit);
    const rawText = buffer.toString('utf8', textStart, textEnd);
    const isRtf = rawText.startsWith('{\\rtf');
    objects.push({
      id: buffer.readUInt32LE(tagOffset + QSX_TEXT_ID_OFFSET),
      tagOffset,
      textStart,
      textEnd,
      extentStart: tagOffset,
      extentEnd: nextTag >= 0 ? nextTag : textEnd,
      header: Buffer.from(buffer.subarray(tagOffset, textStart)),
      rawText,
      name: readTextObjectName(rawText, isRtf),
      isRtf,
    });
  }
  return objects;
}

function getTextObject(objects: TextObject[], id: number): TextObject {
  const object = objects.find((candidate) => candidate.id === id);
  if (!object) {
    throw new Error(`Missing qSxT text object for marker text reference ${id}.`);
  }
  return object;
}

function listTrackMarkersInternal(
  buffer: Buffer,
  metadata: Record<string, unknown> | null | undefined,
): { list: MarkerEventList; markers: TrackMarker[]; textObjects: TextObject[] } {
  const list = findTrackMarkerList(buffer);
  const textObjects = findTextObjects(buffer);
  const markers = list.records
    .map((record) => {
      const textObject = getTextObject(textObjects, record.textRef);
      return {
        number: 0,
        name: textObject.name,
        positionTicks: record.positionTicks,
        barBeat: formatMarkerBarBeat(record.positionTicks, metadata),
        textObjectId: textObject.id,
        textRef: record.textRef,
        recordOffset: record.recordOffset,
        recordIndex: record.recordIndex,
      };
    })
    .sort((left, right) => (
      left.positionTicks - right.positionTicks
      || left.recordIndex - right.recordIndex
      || left.name.localeCompare(right.name)
    ))
    .map((marker, index) => ({ ...marker, number: index + 1 }));
  return { list, markers, textObjects };
}

export function listTrackMarkers(
  buffer: Buffer,
  metadata: Record<string, unknown> | null | undefined,
): ListedTrackMarker[] {
  return listTrackMarkersInternal(buffer, metadata).markers.map((marker) => ({
    number: marker.number,
    name: marker.name,
    positionTicks: marker.positionTicks,
    barBeat: marker.barBeat,
  }));
}