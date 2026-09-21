// Display-only audio-to-notes for the piano roll's Audio→MIDI option.
//
// Started lazily, the first time the option is switched on, because it has to
// read and decode every audio file again: PeakStore keeps only peaks. The queue
// is serial for the same memory reason PeakStore's is. Results are kept for the
// open project, so switching the option off and on again costs nothing.
import type { AudioFileModel } from '../../shared/model';
import { decodeAudioFile } from './decode';
import { transcribe } from './transcribe';
import type { TranscribeRequest, TranscribeResponse } from './transcribeWorker';
import TranscribeWorker from './transcribeWorker?worker&inline';

export type TranscriptionProgress = { done: number; total: number };

export class TranscriptionStore {
  private readonly ctx: AudioContext;
  private readonly onChange: () => void;
  private readonly notes = new Map<string, Float32Array>();
  private worker: Worker | null = null;
  private workerBroken = false;
  private pending: { id: string; resolve: (n: Float32Array) => void; reject: (e: Error) => void } | null = null;
  private nextId = 0;

  /** Bumped by reset(); results from an older generation are dropped. */
  private generation = 0;
  private started = false;
  private files: AudioFileModel[] = [];
  private total = 0;
  private done = 0;

  constructor(ctx: AudioContext, onChange: () => void) {
    this.ctx = ctx;
    this.onChange = onChange;
  }

  get progress(): TranscriptionProgress {
    return { done: this.done, total: this.total };
  }

  get(audioFileId: string): Float32Array | null {
    return this.notes.get(audioFileId) ?? null;
  }

  /** Remembers the project's files without reading anything yet. */
  setFiles(files: AudioFileModel[]): void {
    this.generation += 1;
    this.notes.clear();
    this.pending?.reject(new Error('cancelled'));
    this.pending = null;
    this.started = false;
    this.files = files.filter((file) => file.exists && file.absolutePath);
    this.total = 0;
    this.done = 0;
  }

  /** Starts the queue if it has not run for this project yet. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.total = this.files.length;
    this.done = 0;
    this.onChange();
    void this.run(this.generation);
  }

  dispose(): void {
    this.setFiles([]);
    this.worker?.terminate();
    this.worker = null;
  }

  private async run(generation: number): Promise<void> {
    for (const file of this.files) {
      if (generation !== this.generation) return;
      try {
        const { channels, sampleRate } = await decodeAudioFile(this.ctx, file.absolutePath!);
        if (generation !== this.generation) return;
        const notes = await this.transcribe(channels, sampleRate);
        if (generation !== this.generation) return;
        this.notes.set(file.id, notes);
      } catch {
        if (generation !== this.generation) return;
        // An unreadable file just shows no converted notes.
      }
      this.done += 1;
      this.onChange();
    }
  }

  private async transcribe(channels: Float32Array[], sampleRate: number): Promise<Float32Array> {
    const worker = this.ensureWorker();
    if (!worker) return transcribe(channels, sampleRate);
    const id = `t${this.nextId}`;
    this.nextId += 1;
    try {
      return await new Promise<Float32Array>((resolve, reject) => {
        this.pending = { id, resolve, reject };
        const request: TranscribeRequest = { id, channels, sampleRate };
        worker.postMessage(request, channels.map((channel) => channel.buffer as ArrayBuffer));
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'cancelled') throw error;
      // Same policy as PeakStore: a worker that cannot run costs itself, not
      // the feature. The channels were transferred, so this file is lost.
      this.workerBroken = true;
      this.worker?.terminate();
      this.worker = null;
      throw error;
    }
  }

  private ensureWorker(): Worker | null {
    if (this.workerBroken) return null;
    if (this.worker) return this.worker;
    try {
      const worker = new TranscribeWorker();
      worker.onmessage = (event: MessageEvent<TranscribeResponse>) => {
        const pending = this.pending;
        if (!pending || pending.id !== event.data.id) return;
        this.pending = null;
        if (event.data.ok) pending.resolve(event.data.notes);
        else pending.reject(new Error(event.data.reason));
      };
      worker.onerror = (event) => {
        const pending = this.pending;
        this.pending = null;
        pending?.reject(new Error(`transcribe worker failed: ${event.message || 'unknown error'}`));
      };
      this.worker = worker;
      return worker;
    } catch {
      this.workerBroken = true;
      return null;
    }
  }
}
