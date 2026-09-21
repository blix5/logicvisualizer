// Trimmed from Texture's ops/types.ts. The visualizer is read-only, so the
// operation/agent contracts are gone; only the byte-range type survives, used
// by the vendored read scanners.
export type ByteRange = {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
};
