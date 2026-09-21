// Runs the display transcription off the main thread: about half a second per
// five minutes of audio, which would otherwise drop frames on every file.
import { transcribe } from './transcribe';

export type TranscribeRequest = { id: string; channels: Float32Array[]; sampleRate: number };
export type TranscribeResponse =
  | { id: string; ok: true; notes: Float32Array }
  | { id: string; ok: false; reason: string };

// See peaksWorker.ts for why the worker scope is typed locally.
type WorkerScope = {
  onmessage: ((event: MessageEvent<TranscribeRequest>) => void) | null;
  postMessage(message: TranscribeResponse, transfer?: Transferable[]): void;
};

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { id, channels, sampleRate } = event.data;
  try {
    const notes = transcribe(channels, sampleRate);
    scope.postMessage({ id, ok: true, notes }, [notes.buffer as ArrayBuffer]);
  } catch (error) {
    scope.postMessage({ id, ok: false, reason: error instanceof Error ? error.message : String(error) });
  }
};
