/** Reusable x/y/w/h store, so batching notes costs no allocation per frame. */
export class RectBuffer {
  private data = new Float32Array(4 * 256);
  private count = 0;

  reset(): void { this.count = 0; }
  get size(): number { return this.count; }

  x(i: number): number { return this.data[i * 4]!; }
  y(i: number): number { return this.data[i * 4 + 1]!; }
  w(i: number): number { return this.data[i * 4 + 2]!; }
  h(i: number): number { return this.data[i * 4 + 3]!; }

  push(x: number, y: number, w: number, h: number): void {
    const at = this.count * 4;
    if (at + 4 > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[at] = x;
    this.data[at + 1] = y;
    this.data[at + 2] = w;
    this.data[at + 3] = h;
    this.count += 1;
  }

  /**
   * Caller sets fillStyle once; every rect here shares it. `inflate` grows each
   * rect by that many pixels on every side, which is how the piano roll draws a
   * cheap glow pass from the same batch as the notes themselves.
   */
  fillInto(ctx: CanvasRenderingContext2D, inflate = 0): void {
    const grow = inflate * 2;
    for (let i = 0; i < this.count; i += 1) {
      const o = i * 4;
      ctx.fillRect(
        this.data[o]! - inflate,
        this.data[o + 1]! - inflate,
        this.data[o + 2]! + grow,
        this.data[o + 3]! + grow,
      );
    }
  }
}
