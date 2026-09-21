// Owns waveform peak data for the open project.
//
// A background queue reads each audio file, decodes it, reduces it to a peak
// pyramid and throws the samples away. Only the pyramid is kept — roughly 1 KB
// per second of audio, against ~350 KB per second for the decoded float samples.
//
// The queue is strictly serial. A five-minute 24-bit stereo file decodes to about
// 105 MB of Float32; running a project's worth of them at once would exhaust
// memory long before it finished.
import type { AudioFileModel } from '../../shared/model';
import { buildPeakPyramid, type PeakPyramid } from '../render/peaks';
import type { PeaksRequest, PeaksResponse } from '../render/peaksProtocol';
import { decodeAudioFile } from './decode';
import PeaksWorker from '../render/peaksWorker?worker&inline';

export type PeakEntry =
  | { state: 'pending' }
  | { state: 'ready'; pyramid: PeakPyramid }
  | { state: 'failed'; reason: string };

export type PeakProgress = { done: number; total: number; failed: number };

/** reset() rejects the in-flight request with this; it is not a worker fault. */
const CANCELLED = 'cancelled';

type Pending = {
  id: string;
  resolve: (pyramid: PeakPyramid) => void;
  reject: (error: Error) => void;
};

export class PeakStore {
  private readonly entries = new Map<string, PeakEntry>();
  private readonly ctx: AudioContext;
  private readonly onChange: () => void;

  private worker: Worker | null = null;
  private workerBroken = false;
  private pending: Pending | null = null;
  private nextRequestId = 0;

  /** Bumped by reset(); results from an older generation are dropped. */
  private generation = 0;
  private queue: AudioFileModel[] = [];
  private running = false;
  private total = 0;
  private done = 0;
  private failed = 0;

  constructor(ctx: AudioContext, onChange: () => void) {
    this.ctx = ctx;
    this.onChange = onChange;
  }

  get progress(): PeakProgress {
    return { done: this.done, total: this.total, failed: this.failed };
  }

  get(audioFileId: string): PeakEntry | undefined {
    return this.entries.get(audioFileId);
  }

  reset(): void {
    this.generation += 1;
    this.entries.clear();
    this.queue = [];
    this.total = 0;
    this.done = 0;
    this.failed = 0;
    this.running = false;
    this.pending?.reject(new Error(CANCELLED));
    this.pending = null;
  }

  /** Queues every file that actually resolved to something on disk. */
  load(files: AudioFileModel[]): void {
    this.reset();
    const generation = this.generation;
    const usable: AudioFileModel[] = [];
    for (const file of files) {
      if (file.exists && file.absolutePath) {
        this.entries.set(file.id, { state: 'pending' });
        usable.push(file);
      } else {
        this.entries.set(file.id, {
          state: 'failed',
          reason: file.absolutePath ? 'file missing on disk' : 'no path in MetaData.plist',
        });
      }
    }
    this.queue = usable;
    this.total = usable.length;
    this.onChange();
    void this.run(generation);
  }

  dispose(): void {
    this.reset();
    this.worker?.terminate();
    this.worker = null;
  }

  private async run(generation: number): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const file of this.queue) {
        if (generation !== this.generation) return;
        await this.process(file, generation);
        if (generation !== this.generation) return;
        this.onChange();
      }
    } finally {
      if (generation === this.generation) this.running = false;
    }
  }

  private async process(file: AudioFileModel, generation: number): Promise<void> {
    const filePath = file.absolutePath;
    if (!filePath) return;
    try {
      const { channels, sampleRate } = await decodeAudioFile(this.ctx, filePath);
      if (generation !== this.generation) return;

      const pyramid = await this.reduce(channels, sampleRate);
      if (generation !== this.generation) return;
      this.entries.set(file.id, { state: 'ready', pyramid });
      this.done += 1;
    } catch (error) {
      if (generation !== this.generation) return;
      this.entries.set(file.id, {
        state: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      this.done += 1;
      this.failed += 1;
    }
  }

  private async reduce(channels: Float32Array[], sampleRate: number): Promise<PeakPyramid> {
    const worker = this.ensureWorker();
    if (!worker) return buildPeakPyramid(channels, sampleRate);
    try {
      return await this.reduceInWorker(worker, channels, sampleRate);
    } catch (error) {
      if (error instanceof Error && error.message === CANCELLED) throw error;
      // A worker that cannot run at all — a blocked Blob URL, say — must not cost
      // the whole feature. Give up on it and reduce in-process from here on.
      this.workerBroken = true;
      this.worker?.terminate();
      this.worker = null;
      this.pending = null;
      // If the channels were already transferred there is nothing left to work
      // from, so this one file is lost; the rest take the fallback path.
      if ((channels[0]?.length ?? 0) === 0) throw error;
      return buildPeakPyramid(channels, sampleRate);
    }
  }

  private reduceInWorker(
    worker: Worker,
    channels: Float32Array[],
    sampleRate: number,
  ): Promise<PeakPyramid> {
    const id = `p${this.nextRequestId}`;
    this.nextRequestId += 1;
    return new Promise<PeakPyramid>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      const request: PeaksRequest = { id, channels, sampleRate };
      worker.postMessage(request, channels.map((channel) => channel.buffer as ArrayBuffer));
    });
  }

  private ensureWorker(): Worker | null {
    if (this.workerBroken) return null;
    if (this.worker) return this.worker;
    try {
      const worker = new PeaksWorker();
      worker.onmessage = (event: MessageEvent<PeaksResponse>) => {
        const data = event.data;
        const pending = this.pending;
        if (!pending || pending.id !== data.id) return;
        this.pending = null;
        if (data.ok) {
          pending.resolve({
            levels: data.levels,
            rates: data.rates,
            durationSeconds: data.durationSeconds,
          });
        } else {
          pending.reject(new Error(data.reason));
        }
      };
      worker.onerror = (event) => {
        const pending = this.pending;
        this.pending = null;
        pending?.reject(new Error(`peaks worker failed: ${event.message || 'unknown error'}`));
      };
      this.worker = worker;
      return worker;
    } catch {
      this.workerBroken = true;
      return null;
    }
  }
}
