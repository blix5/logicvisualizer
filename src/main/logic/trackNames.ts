// Track-name resolution, extracted from Texture's logicProject.ts (read path only).
// Three independent strategies, combined by resolveTrackLabels():
//   1. ivnE track strips          -> resolveTrackNamesByRef
//   2. OCuA mixer channel names   -> resolveTrackChannelNamesByRef
//   3. bounded printable-run scan -> resolveTrackDisplayLabels
// See VENDORED.md. This file must never gain a write path.

const LOGIC_INTERNAL_TAGS = new Set(['ivnE', 'AivnE', 'karT', 'qSvE', 'qeSM', 'lqeSM', 'kcrT', 'PtnI', 'TUOA']);
const LOGIC_NON_TRACK_PREFIXES = ['Master', 'Aux', 'Bus', 'Output', 'Input', 'Stereo Out', 'Surround', 'Prelisten', 'Click'];
const LOGIC_GM_BANK_MARKER = 'Grand Piano';
const LOGIC_TRACK_REF_MIN = 0x50;
const LOGIC_TRACK_REF_MAX = 0xffff;

function printableRuns(buffer: Buffer, start: number, end: number, minLength: number): string[] {
  const runs: string[] = [];
  let run = '';
  for (let index = Math.max(0, start); index < Math.min(buffer.length, end); index += 1) {
    const value = buffer[index];
    if (value !== undefined && value >= 32 && value < 127) {
      run += String.fromCharCode(value);
    } else {
      if (run.length >= minLength) {
        runs.push(run);
      }
      run = '';
    }
  }
  if (run.length >= minLength) {
    runs.push(run);
  }
  return runs;
}

function isLogicInternalToken(value: string): boolean {
  return LOGIC_INTERNAL_TAGS.has(value) || value.endsWith('ivnE');
}

function sanitizeTrackDisplayName(value: string): string {
  return value.replace(/\d+$/, '').trim();
}

function isLikelyUserTrackName(value: string): boolean {
  if (LOGIC_NON_TRACK_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix} `))) {
    return false;
  }
  if (isLogicInternalToken(value)) {
    return false;
  }
  if (/[\./%\\]/.test(value) || !/^[a-zA-Z0-9]/.test(value)) {
    return false;
  }
  return true;
}

function isLogicTrackRef(ref: number): boolean {
  return ref >= LOGIC_TRACK_REF_MIN && ref <= LOGIC_TRACK_REF_MAX;
}

function isLikelyDrumMachineChildName(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return /^(kick|snare|hi-?hat|hat|rim|clap|crash|ride|tom|perc|shaker|clave|cowbell|metal hit)\b/.test(normalized)
    || normalized.includes(' - drum synth kit')
    || normalized.includes(' - shockwave');
}

function isLikelyLogicUuid(value: Buffer): boolean {
  if (value.length !== 16) return false;
  let nonZero = 0;
  for (const byte of value) {
    if (byte !== 0) nonZero += 1;
  }
  return nonZero >= 8;
}

function findChannelUuid(buffer: Buffer, start: number, end: number): string | null {
  let found: Buffer | null = null;
  for (let offset = start; offset + 17 <= end; offset += 1) {
    if (buffer[offset] !== 0xff) continue;
    const candidate = buffer.subarray(offset + 1, offset + 17);
    if (isLikelyLogicUuid(candidate)) {
      found = Buffer.from(candidate);
    }
  }
  return found ? found.toString('hex') : null;
}

type LogicTrackStrip = {
  offset: number;
  ref: number;
  refKey: string;
  name: string | null;
};

function getTrackListBounds(buffer: Buffer): { start: number; end: number } | null {
  const anchorCandidates = [
    buffer.indexOf(Buffer.from('Track Automation Root Folder', 'utf-8')),
    buffer.indexOf(Buffer.from('Track Alternatives', 'utf-8')),
  ].filter((value) => value >= 0);
  const anchor = anchorCandidates[0];
  if (anchor === undefined) {
    return null;
  }
  const master = buffer.lastIndexOf(Buffer.from('Master', 'utf-8'), anchor);
  if (master < 0) {
    return null;
  }
  let stop = anchor;
  for (const tag of ['karT', 'qSvE', 'qeSM']) {
    const index = buffer.indexOf(Buffer.from(tag, 'ascii'), master);
    if (index >= 0 && index < stop) {
      stop = index;
    }
  }
  const gmBankStart = buffer.indexOf(Buffer.from(LOGIC_GM_BANK_MARKER, 'utf-8'), master);
  if (gmBankStart >= 0 && gmBankStart < stop) {
    stop = gmBankStart;
  }
  return { start: master, end: stop };
}

function readNullTerminatedAscii(buffer: Buffer, offset: number): string | null {
  if (offset < 0 || offset >= buffer.length) {
    return null;
  }
  let end = offset;
  while (end < buffer.length && (buffer[end] ?? 0) !== 0 && (buffer[end] ?? 0) >= 32 && (buffer[end] ?? 0) < 127) {
    end += 1;
  }
  const raw = buffer.toString('utf-8', offset, end).trim();
  return raw || null;
}

const LOGIC_TRACK_NAME_OFFSETS = [196, 194, 198, 190, 200, 180, 170];

function readTrackNameNearIvnE(section: Buffer, ivnEOffset: number): string | null {
  for (const delta of LOGIC_TRACK_NAME_OFFSETS) {
    const candidate = readNullTerminatedAscii(section, ivnEOffset + delta);
    if (candidate && isLikelyUserTrackName(candidate)) {
      return candidate;
    }
  }

  let best: string | null = null;
  for (let scan = ivnEOffset + 16; scan < Math.min(ivnEOffset + 260, section.length); scan += 1) {
    if (section[scan] === 0) {
      continue;
    }
    const candidate = readNullTerminatedAscii(section, scan);
    if (!candidate || !isLikelyUserTrackName(candidate)) {
      continue;
    }
    if (!best || candidate.length > best.length) {
      best = candidate;
    }
    scan += candidate.length;
  }
  return best;
}

function findTrackStrips(buffer: Buffer): LogicTrackStrip[] {
  const strips: LogicTrackStrip[] = [];
  let pos = 0;
  while (pos < buffer.length - 20) {
    const ivnEOffset = buffer.indexOf('ivnE', pos);
    if (ivnEOffset < 0) {
      break;
    }
    const ref = buffer.readUInt32LE(ivnEOffset + 10);
    if (isLogicTrackRef(ref)) {
      const name = readTrackNameNearIvnE(buffer, ivnEOffset);
      strips.push({
        offset: ivnEOffset,
        ref,
        refKey: `0x${ref.toString(16)}`,
        name: name ? sanitizeTrackDisplayName(name) : null,
      });
    }
    pos = ivnEOffset + 4;
  }
  return strips;
}

export type TrackStrip = {
  offset: number;
  ref: number;
  refKey: string;
  name: string | null;
};

/**
 * Every ivnE track strip in buffer order. More tolerant than the object-registry
 * walk in ops/trackObjects.ts, which refuses whole projects when the registry
 * does not match its expected shape — so this is the primary track source and
 * listLogicTracks only supplies arrange ordinals when it succeeds.
 */
export function listTrackStrips(buffer: Buffer): TrackStrip[] {
  return findTrackStrips(buffer);
}

export function resolveTrackNamesByRef(buffer: Buffer): Map<string, string> {
  const map = new Map<string, string>();
  for (const strip of findTrackStrips(buffer)) {
    if (strip.name && isLikelyUserTrackName(strip.name)) {
      map.set(strip.refKey, strip.name);
    }
  }
  return map;
}

/**
 * Byte offset of the mute flag inside a mixer channel (OCuA), 1 when muted.
 *
 * Established with re_probe8, which mutes exactly tracks 2 and 3: this offset
 * is 1 on Audio 2 and Audio 3 there and 0 on every channel of re_probe6 and
 * re_probe7, which mute nothing. A rival candidate at +117 bit 3 was rejected
 * because it fires on the unmuted probes too.
 */
const CHANNEL_MUTE_OFFSET = 126;

type ChannelInfo = { name: string; muted: boolean };

/** Channel name and mute state per track ref, matched via the strip's UUID. */
export function resolveTrackChannelsByRef(buffer: Buffer): Map<string, ChannelInfo> {
  const channelsByUuid = new Map<string, ChannelInfo>();
  const channelOffsets: number[] = [];
  let channelSearchOffset = 0;
  while (channelSearchOffset < buffer.length) {
    const channelOffset = buffer.indexOf('OCuA', channelSearchOffset);
    if (channelOffset < 0) break;
    channelOffsets.push(channelOffset);
    channelSearchOffset = channelOffset + 4;
  }

  for (let i = 0; i < channelOffsets.length; i += 1) {
    const channelOffset = channelOffsets[i];
    if (channelOffset === undefined) continue;
    const nextChannelOffset = channelOffsets[i + 1] ?? buffer.length;
    const channelName = readNullTerminatedAscii(buffer, channelOffset + 0x60)?.trim();
    if (!channelName) continue;
    const firstPluginOffset = buffer.indexOf('UCuA', channelOffset + 4);
    const end = firstPluginOffset >= 0 && firstPluginOffset < nextChannelOffset
      ? firstPluginOffset
      : nextChannelOffset;
    const uuid = findChannelUuid(buffer, channelOffset + 4, end);
    if (!uuid) continue;
    const muteAt = channelOffset + CHANNEL_MUTE_OFFSET;
    channelsByUuid.set(uuid, {
      name: channelName,
      muted: muteAt < buffer.length && buffer[muteAt] === 1,
    });
  }

  const map = new Map<string, ChannelInfo>();
  for (const strip of findTrackStrips(buffer)) {
    const scanEnd = Math.min(buffer.length, strip.offset + 0x300);
    for (const [uuid, info] of channelsByUuid) {
      const matchOffset = buffer.indexOf(Buffer.from(uuid, 'hex'), strip.offset);
      if (matchOffset >= 0 && matchOffset < scanEnd) { map.set(strip.refKey, info); break; }
    }
  }
  return map;
}

export function resolveTrackChannelNamesByRef(buffer: Buffer): Map<string, string> {
  const channelsByUuid = new Map<string, string>();
  const channelOffsets: number[] = [];
  let channelSearchOffset = 0;
  while (channelSearchOffset < buffer.length) {
    const channelOffset = buffer.indexOf('OCuA', channelSearchOffset);
    if (channelOffset < 0) break;
    channelOffsets.push(channelOffset);
    channelSearchOffset = channelOffset + 4;
  }

  for (let i = 0; i < channelOffsets.length; i += 1) {
    const channelOffset = channelOffsets[i];
    if (channelOffset === undefined) continue;
    const nextChannelOffset = channelOffsets[i + 1] ?? buffer.length;
    const channelName = readNullTerminatedAscii(buffer, channelOffset + 0x60)?.trim();
    if (!channelName) continue;
    const firstPluginOffset = buffer.indexOf('UCuA', channelOffset + 4);
    const end = firstPluginOffset >= 0 && firstPluginOffset < nextChannelOffset
      ? firstPluginOffset
      : nextChannelOffset;
    const uuid = findChannelUuid(buffer, channelOffset + 4, end);
    if (uuid) {
      channelsByUuid.set(uuid, channelName);
    }
  }

  const map = new Map<string, string>();
  const strips = findTrackStrips(buffer);
  for (const strip of strips) {
    const scanEnd = Math.min(buffer.length, strip.offset + 0x300);
    for (const [uuid, channelName] of channelsByUuid) {
      const matchOffset = buffer.indexOf(Buffer.from(uuid, 'hex'), strip.offset);
      if (matchOffset >= 0 && matchOffset < scanEnd) {
        map.set(strip.refKey, channelName);
        break;
      }
    }
  }

  for (let index = 0; index < strips.length; index += 1) {
    const strip = strips[index];
    if (strip === undefined) continue;
    if (map.has(strip.refKey)) {
      continue;
    }
    const nextStrip = strips[index + 1];
    if (!nextStrip || !isLikelyDrumMachineChildName(nextStrip.name)) {
      continue;
    }
    const childChannel = map.get(nextStrip.refKey);
    if (childChannel) {
      map.set(strip.refKey, childChannel);
    }
  }
  return map;
}

function resolveTrackNames(buffer: Buffer): string[] {
  const bounds = getTrackListBounds(buffer);
  if (!bounds) {
    return [];
  }
  const runs = printableRuns(buffer, bounds.start, bounds.end, 4);
  const names: string[] = [];
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (run === undefined || !isLogicInternalToken(run)) {
      continue;
    }
    for (let nextIndex = index + 1; nextIndex < runs.length; nextIndex += 1) {
      const candidate = runs[nextIndex];
      if (candidate !== undefined && isLikelyUserTrackName(candidate)) {
        names.push(candidate.trim());
        break;
      }
    }
  }
  if (names.length > 0) {
    return names;
  }
  for (const value of runs) {
    if (isLikelyUserTrackName(value)) {
      names.push(value.trim());
    }
  }
  return names;
}

export function resolveTrackDisplayLabels(buffer: Buffer): string[] {
  return resolveTrackNames(buffer);
}
