// Reads an audio file's native tempo, for regions with Flex enabled.
//
// Why this reads the AUDIO FILE rather than ProjectData: a flexed region's
// stretched length is not stored in the project. Diffing flex-on against
// flex-off regions of the same sample in djpubichair.logicx, the placement
// record differs only in the flex flag, and the region record only in a
// modification timestamp and a UUID. Logic works the length out at playback
// from the audio's own tempo, which it writes into the file.
//
// Only the chunk HEADERS are read; the sample data is skipped with a seek, so
// this costs a few small reads per file however large the audio is.
import fs from 'node:fs';

const MAX_CHUNKS = 64;
const TEXT_LIMIT = 4096;

function readAt(fd: number, position: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  const read = fs.readSync(fd, out, 0, length, position);
  return read === length ? out : out.subarray(0, read);
}

/** "Tempo: 110.0" in a LIST/adtl label, as Logic writes it. */
function tempoFromText(text: string): number | null {
  const match = /Tempo:\s*([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  if (!match?.[1]) return null;
  const tempo = Number(match[1]);
  return tempo >= 20 && tempo <= 400 ? tempo : null;
}

/**
 * Returns the file's tempo in BPM, or null when it carries none. Handles RIFF
 * WAVE: the ACID chunk's float tempo, and Logic's "Tempo: N" label in LIST/adtl.
 */
export function readFileTempo(filePath: string): number | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const header = readAt(fd, 0, 12);
    if (header.length < 12 || header.toString('latin1', 0, 4) !== 'RIFF' || header.toString('latin1', 8, 12) !== 'WAVE') {
      return null;
    }
    let position = 12;
    for (let i = 0; i < MAX_CHUNKS && position + 8 <= size; i += 1) {
      const chunk = readAt(fd, position, 8);
      if (chunk.length < 8) break;
      const id = chunk.toString('latin1', 0, 4);
      const length = chunk.readUInt32LE(4);
      const body = position + 8;

      if (id === 'acid' && length >= 24) {
        const acid = readAt(fd, body, 24);
        const tempo = acid.readFloatLE(20);
        if (tempo >= 20 && tempo <= 400) return tempo;
      }
      if (id === 'LIST' && length > 4) {
        const text = readAt(fd, body, Math.min(length, TEXT_LIMIT)).toString('latin1');
        const tempo = tempoFromText(text);
        if (tempo !== null) return tempo;
      }
      position = body + length + (length & 1);
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A flexed loop plays as a whole number of beats at project tempo. The file's
 * labelled tempo is rounded (key3.wav says 110.0 where its length implies
 * 110.86), so it only tells us ROUGHLY how many beats the audio holds; rounding
 * recovers the exact count Logic uses.
 */
export function flexedBeats(durationSeconds: number, fileTempo: number): number | null {
  const beats = (durationSeconds * fileTempo) / 60;
  if (!(beats > 0)) return null;
  const whole = Math.round(beats);
  // Far from a whole number means the label does not describe this audio;
  // better to leave the region unstretched than to guess.
  if (whole < 1 || Math.abs(beats - whole) > 0.25) return null;
  return whole;
}
