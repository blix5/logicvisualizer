// Reduces decoded audio to a peak pyramid off the main thread.
//
// decodeAudioData already decodes on a browser-internal thread, so the hitch
// this avoids is the reduction itself — roughly 26M float comparisons for a
// five-minute stereo file, which would otherwise drop frames on every import.
import { buildPeakPyramid } from './peaks';
import type { PeaksRequest, PeaksResponse } from './peaksProtocol';

// tsconfig's lib is ["ES2022", "DOM", "DOM.Iterable"], and "WebWorker" cannot be
// added alongside "DOM" — the two redeclare the same globals. A local structural
// type for the bit of the worker scope this file touches avoids the collision.
type WorkerScope = {
  onmessage: ((event: MessageEvent<PeaksRequest>) => void) | null;
  postMessage(message: PeaksResponse, transfer?: Transferable[]): void;
};

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { id, channels, sampleRate } = event.data;
  try {
    const pyramid = buildPeakPyramid(channels, sampleRate);
    // Transfer the results back rather than copying them.
    const transfer: Transferable[] = pyramid.levels.map((level) => level.buffer as ArrayBuffer);
    transfer.push(pyramid.rates.buffer as ArrayBuffer);
    scope.postMessage(
      {
        id,
        ok: true,
        levels: pyramid.levels,
        rates: pyramid.rates,
        durationSeconds: pyramid.durationSeconds,
      },
      transfer,
    );
  } catch (error) {
    scope.postMessage({ id, ok: false, reason: error instanceof Error ? error.message : String(error) });
  }
};
