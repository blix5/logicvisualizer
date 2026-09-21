// Low-level scanning helpers for Logic ProjectData chunk tags. Tags are stored
// byte-reversed in the file ('AuCU' object appears as 'UCuA', etc.); callers
// pass the on-disk byte order.

export const QSVE_HEADER_SIZE = 36;

const QSVE_BLOCK_LENGTH_OFFSET = 28;
const QSVE_PAYLOAD_LENGTH_BIAS = 16;

type QSvePayloadLengthOptions = {
  minPayloadLength?: number;
  payloadMultiple?: number;
};

export function findAllTags(buffer: Buffer, tag: string): number[] {
  const needle = Buffer.from(tag, 'ascii');
  const offsets: number[] = [];
  let from = 0;
  while (from >= 0 && from < buffer.length) {
    const offset = buffer.indexOf(needle, from);
    if (offset < 0) break;
    offsets.push(offset);
    from = offset + 1;
  }
  return offsets;
}

export function findLastTagBefore(buffer: Buffer, tag: string, before: number): number {
  return buffer.lastIndexOf(Buffer.from(tag, 'ascii'), Math.max(0, before - 1));
}

export function readQSvePayloadLength(
  buffer: Buffer,
  qSveOffset: number,
  options: QSvePayloadLengthOptions = {},
): number | null {
  const lengthOffset = qSveOffset + QSVE_BLOCK_LENGTH_OFFSET;
  if (lengthOffset + 4 > buffer.length) {
    return null;
  }
  const minPayloadLength = options.minPayloadLength ?? 0;
  const candidates = [buffer.readUInt32LE(lengthOffset), buffer.readUInt32BE(lengthOffset)];
  for (const blockLength of candidates) {
    const payloadLength = blockLength - QSVE_PAYLOAD_LENGTH_BIAS;
    if (
      blockLength >= QSVE_PAYLOAD_LENGTH_BIAS
      && payloadLength >= minPayloadLength
      && (options.payloadMultiple === undefined || payloadLength % options.payloadMultiple === 0)
      && qSveOffset + QSVE_HEADER_SIZE + payloadLength <= buffer.length
    ) {
      return payloadLength;
    }
  }
  return null;
}

export function readCString(buffer: Buffer, offset: number, maxLength: number): string {
  if (offset < 0 || offset >= buffer.length) return '';
  const end = Math.min(buffer.length, offset + maxLength);
  let stop = offset;
  while (stop < end && buffer[stop] !== 0) stop += 1;
  return buffer.toString('utf-8', offset, stop);
}

export function reverse4cc(value: string): string {
  return [...value].reverse().join('');
}

export function isPrintableAscii(byte: number): boolean {
  return byte >= 0x20 && byte < 0x7f;
}
