// One-shot peak reduction for the bounce.
//
// The bounce is decoded for playback and must stay intact, so its channels are
// copied before being transferred. It gets its own short-lived worker rather
// than going through PeakStore, whose single in-flight slot is busy with the
// project's audio files while a bounce is usually imported.
import { buildPeakPyramid, type PeakPyramid } from '../render/peaks';
import type { PeaksRequest, PeaksResponse } from '../render/peaksProtocol';
import PeaksWorker from '../render/peaksWorker?worker&inline';

export function reduceBufferPeaks(buffer: AudioBuffer): Promise<PeakPyramid> {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    channels.push(buffer.getChannelData(channel).slice());
  }
  const sampleRate = buffer.sampleRate;

  let worker: Worker;
  try {
    worker = new PeaksWorker();
  } catch {
    return Promise.resolve(buildPeakPyramid(channels, sampleRate));
  }

  return new Promise<PeakPyramid>((resolve, reject) => {
    // The copies are transferred, so a failed worker leaves nothing to fall
    // back on; recopy from the buffer, which is still whole.
    const fallback = () => {
      worker.terminate();
      try {
        resolve(buildPeakPyramid(
          Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)),
          sampleRate,
        ));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    worker.onmessage = (event: MessageEvent<PeaksResponse>) => {
      const data = event.data;
      worker.terminate();
      if (data.ok) {
        resolve({ levels: data.levels, rates: data.rates, durationSeconds: data.durationSeconds });
      } else {
        reject(new Error(data.reason));
      }
    };
    worker.onerror = fallback;
    const request: PeaksRequest = { id: 'bounce', channels, sampleRate };
    worker.postMessage(request, channels.map((channel) => channel.buffer as ArrayBuffer));
  });
}
