// Notes the playhead crossed this frame, as the renderers find them while they
// draw notes. A fixed pool: a dense chord costs no allocation, and past the cap
// further hits that frame are dropped (nobody can count them anyway).

const CAPACITY = 256;

export class NoteHitBuffer {
  readonly x = new Float32Array(CAPACITY);
  readonly y = new Float32Array(CAPACITY);
  /** 0..1, from velocity and volume automation. */
  readonly strength = new Float32Array(CAPACITY);
  /** Track colour of each hit. */
  readonly color: string[] = new Array<string>(CAPACITY).fill('');
  count = 0;
  /** Timeline speed when the hits were found, for layers that drift with it. */
  pixelsPerSecond = 0;

  reset(): void {
    this.count = 0;
  }

  push(x: number, y: number, color: string, strength: number): void {
    if (this.count >= CAPACITY) return;
    const i = this.count;
    this.x[i] = x;
    this.y[i] = y;
    this.color[i] = color;
    this.strength[i] = strength < 0 ? 0 : strength > 1 ? 1 : strength;
    this.count = i + 1;
  }

  copyFrom(other: NoteHitBuffer): void {
    const n = other.count;
    this.x.set(other.x.subarray(0, n));
    this.y.set(other.y.subarray(0, n));
    this.strength.set(other.strength.subarray(0, n));
    for (let i = 0; i < n; i += 1) this.color[i] = other.color[i]!;
    this.count = n;
    this.pixelsPerSecond = other.pixelsPerSecond;
  }
}
