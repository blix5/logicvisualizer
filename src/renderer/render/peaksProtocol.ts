// The peaks worker's message contract, imported by both sides.
export type PeaksRequest = {
  id: string;
  /** Decoded channel data. Transferred, not copied — the sender loses them. */
  channels: Float32Array[];
  sampleRate: number;
};

export type PeaksResponse =
  | { id: string; ok: true; levels: Int8Array[]; rates: Float64Array; durationSeconds: number }
  | { id: string; ok: false; reason: string };
