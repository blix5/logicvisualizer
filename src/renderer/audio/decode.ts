// Reads an audio file from disk and decodes it to per-channel float copies.
// Shared by the peak and transcription queues, which both need the samples
// once and then throw them away.
import { isFailure } from '../../shared/ipc';

export type DecodedAudio = { channels: Float32Array[]; sampleRate: number };

export async function decodeAudioFile(ctx: AudioContext, filePath: string): Promise<DecodedAudio> {
  const result = await window.lv.audio.read(filePath);
  if (isFailure(result)) throw new Error(result.error);

  // decodeAudioData detaches the ArrayBuffer it is given; nothing may use
  // result.bytes after this point.
  const decoded = await ctx.decodeAudioData(result.bytes);
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    // Copies, so the caller can transfer them to a worker; the AudioBuffer is
    // dropped when this returns rather than staying resident alongside them.
    channels.push(decoded.getChannelData(channel).slice());
  }
  return { channels, sampleRate: decoded.sampleRate };
}
