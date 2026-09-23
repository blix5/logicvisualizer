// The background image behind both views. Scaling to cover the canvas and
// blurring are far too slow to do per frame, so the image is rendered once
// into a canvas-sized layer: the theme's background, then the image over it
// at the chosen opacity. A frame then costs one blit. The layer is rebuilt
// only when the canvas size, the background colour, the image or its settings
// change.

export type BackdropOptions = {
  /** How much of the image shows over the theme's background, 0..1. */
  opacity: number;
  /** Blur radius in CSS px. */
  blur: number;
};

export class Backdrop {
  private image: ImageBitmap | null = null;
  private options: BackdropOptions = { opacity: 0.35, blur: 0 };
  private layer: HTMLCanvasElement | null = null;
  private layerKey = '';
  /** Bumped whenever the image or its settings change, for callers' cache keys. */
  version = 0;

  /** The caller keeps ownership of the bitmap, and closes it once replaced. */
  setImage(image: ImageBitmap | null): void {
    if (image === this.image) return;
    this.image = image;
    this.version += 1;
  }

  setOptions(options: BackdropOptions): void {
    if (options.opacity === this.options.opacity && options.blur === this.options.blur) return;
    this.options = { ...options };
    this.version += 1;
  }

  /** How much of the image shows, 0..1: overlays over it fade as this rises. */
  get opacity(): number {
    return this.active ? this.options.opacity : 0;
  }

  get active(): boolean {
    return this.image !== null && this.options.opacity > 0;
  }

  /**
   * The layer for a canvas of `width` x `height` device pixels, or null when
   * there is no image. Draw it at the identity transform.
   */
  layerFor(width: number, height: number, dpr: number, background: string): HTMLCanvasElement | null {
    const image = this.image;
    if (!image || !this.active || width <= 0 || height <= 0) return null;
    const key = `${width}|${height}|${dpr}|${background}|${this.version}`;
    if (key === this.layerKey && this.layer) return this.layer;

    const layer = this.layer ?? document.createElement('canvas');
    layer.width = width;
    layer.height = height;
    const ctx = layer.getContext('2d', { alpha: false });
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    // Cover the canvas. A blurred image fades at its own edges, so it is drawn
    // a blur radius larger all round and the soft rim falls outside the canvas.
    const blur = this.options.blur * dpr;
    const bleed = blur * 2;
    const scale = Math.max((width + bleed * 2) / image.width, (height + bleed * 2) / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    ctx.globalAlpha = this.options.opacity;
    if (blur > 0) ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;

    this.layer = layer;
    this.layerKey = key;
    return layer;
  }
}
