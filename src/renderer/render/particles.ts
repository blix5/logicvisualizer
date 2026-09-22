// Playhead particles: a burst where the playhead meets each note.
//
// A fixed pool in typed arrays, so a dense passage costs no allocation and no
// garbage. When the pool is full the oldest particle is recycled — at that
// density nobody can tell. Motion runs on wall-clock time rather than frame
// count, so bursts look the same at any frame rate, and each particle drifts
// left with the timeline so a burst trails behind the note that made it.

const POOL = 1024;
const MIN_BURST = 6;
const MAX_BURST = 16;
const MIN_LIFE = 0.4;
const MAX_LIFE = 0.9;
/** Random spread on top of the drift, in px/s. */
const JITTER = 120;
/** Drift is this share of the timeline speed, so particles move with the notes... */
const DRIFT_MIN = 0.2;
const DRIFT_MAX = 0.8;
/** ...but never faster than this, at extreme zoom. */
const MAX_DRIFT = 400;
const GRAVITY = 60;
/** Velocity kept per second: a gentle drag. */
const DRAG = 0.35;
const MIN_SIZE = 7;
const MAX_SIZE = 16;
/** A single step may not exceed this, so a stalled tab does not teleport particles. */
const MAX_STEP = 0.05;

export class ParticleSystem {
  private readonly x = new Float32Array(POOL);
  private readonly y = new Float32Array(POOL);
  private readonly vx = new Float32Array(POOL);
  private readonly vy = new Float32Array(POOL);
  private readonly life = new Float32Array(POOL);
  private readonly maxLife = new Float32Array(POOL);
  private readonly size = new Float32Array(POOL);
  private readonly color = new Uint16Array(POOL);
  /** Next slot to write; wraps, which is what recycles the oldest. */
  private next = 0;
  private live = 0;
  private lastStep = 0;

  /** True while anything is still in flight, so the caller keeps redrawing. */
  get animating(): boolean {
    return this.live > 0;
  }

  clear(): void {
    this.life.fill(0);
    this.live = 0;
  }

  /**
   * A burst at (x, y) in colour `color` (an index the caller resolves at draw
   * time). `strength` is 0..1, from the note's velocity.
   */
  emit(x: number, y: number, color: number, strength: number, pixelsPerSecond: number): void {
    const count = Math.round(MIN_BURST + (MAX_BURST - MIN_BURST) * Math.max(0, Math.min(1, strength)));
    for (let n = 0; n < count; n += 1) {
      const i = this.next;
      this.next = (this.next + 1) % POOL;
      if (this.life[i]! <= 0) this.live += 1;
      const drift = Math.min(MAX_DRIFT, pixelsPerSecond * (DRIFT_MIN + Math.random() * (DRIFT_MAX - DRIFT_MIN)));
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * JITTER;
      this.x[i] = x;
      this.y[i] = y;
      this.vx[i] = -drift + Math.cos(angle) * speed;
      this.vy[i] = Math.sin(angle) * speed;
      const life = MIN_LIFE + Math.random() * (MAX_LIFE - MIN_LIFE);
      this.life[i] = life;
      this.maxLife[i] = life;
      this.size[i] = MIN_SIZE + Math.random() * (MAX_SIZE - MIN_SIZE) * (0.5 + strength * 0.5);
      this.color[i] = color;
    }
  }

  /** Advances by the wall time since the last call. */
  step(now: number): void {
    const dt = this.lastStep > 0 ? Math.min(MAX_STEP, (now - this.lastStep) / 1000) : 0;
    this.lastStep = now;
    if (dt <= 0 || this.live === 0) return;
    const keep = DRAG ** dt;
    let live = 0;
    for (let i = 0; i < POOL; i += 1) {
      if (this.life[i]! <= 0) continue;
      const life = this.life[i]! - dt;
      this.life[i] = life;
      if (life <= 0) continue;
      live += 1;
      this.vx[i] = this.vx[i]! * keep;
      this.vy[i] = this.vy[i]! * keep + GRAVITY * dt;
      this.x[i] = this.x[i]! + this.vx[i]! * dt;
      this.y[i] = this.y[i]! + this.vy[i]! * dt;
    }
    this.live = live;
  }

  /** Draws each live particle as `sprite(color)`, fading and shrinking with age. */
  draw(ctx: CanvasRenderingContext2D, sprite: (color: number) => CanvasImageSource | null): void {
    if (this.live === 0) return;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < POOL; i += 1) {
      const life = this.life[i]!;
      if (life <= 0) continue;
      const image = sprite(this.color[i]!);
      if (!image) continue;
      const t = life / this.maxLife[i]!;
      const size = this.size[i]! * (0.4 + 0.6 * t);
      // Linear fade: bright for most of the life, gone at the end.
      ctx.globalAlpha = t;
      ctx.drawImage(image, this.x[i]! - size / 2, this.y[i]! - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
