// Painted highlight masks: a gray canvas per image (128 = untouched) plus a tinted copy shown over the preview.
import type { HighlightMask } from '../engine/index.ts';

export type MaskTool = 'add' | 'remove' | 'erase';

const MAX_EDGE = 1024;
const UNDO_STEPS = 12;
const VALUE: Record<MaskTool, number> = { add: 255, remove: 0, erase: 128 };

export class PaintMask {
  readonly width: number;
  readonly height: number;
  /** Tinted view of the mask (green adds, red removes), sized like the mask; the stage scales it over the image. */
  readonly tint: HTMLCanvasElement;
  private gray: CanvasRenderingContext2D;
  private tintCtx: CanvasRenderingContext2D;
  private undo: ImageData[] = [];

  constructor(sourceWidth: number, sourceHeight: number) {
    const k = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight));
    this.width = Math.max(1, Math.round(sourceWidth * k));
    this.height = Math.max(1, Math.round(sourceHeight * k));
    const g = document.createElement('canvas');
    g.width = this.width; g.height = this.height;
    this.gray = g.getContext('2d', { willReadFrequently: true })!;
    this.tint = document.createElement('canvas');
    this.tint.width = this.width; this.tint.height = this.height;
    this.tintCtx = this.tint.getContext('2d')!;
    this.fill();
  }

  private fill() {
    this.gray.fillStyle = 'rgb(128,128,128)';
    this.gray.fillRect(0, 0, this.width, this.height);
    this.tintCtx.clearRect(0, 0, this.width, this.height);
  }

  get canUndo() { return this.undo.length > 0; }

  /** Call before each stroke (and before clearing) so it can be undone. */
  snapshot() {
    this.undo.push(this.gray.getImageData(0, 0, this.width, this.height));
    if (this.undo.length > UNDO_STEPS) this.undo.shift();
  }

  undoLast() {
    const prev = this.undo.pop();
    if (!prev) return;
    this.gray.putImageData(prev, 0, 0);
    this.retint(0, 0, this.width, this.height);
  }

  clear() {
    this.snapshot();
    this.fill();
  }

  /** A soft round dab at mask pixel (x, y). */
  dab(x: number, y: number, radius: number, tool: MaskTool) {
    const v = VALUE[tool];
    const g = this.gray.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, `rgba(${v},${v},${v},0.9)`);
    g.addColorStop(0.5, `rgba(${v},${v},${v},0.6)`);
    g.addColorStop(1, `rgba(${v},${v},${v},0)`);
    this.gray.fillStyle = g;
    this.gray.beginPath();
    this.gray.arc(x, y, radius, 0, Math.PI * 2);
    this.gray.fill();
    this.retint(x - radius - 1, y - radius - 1, radius * 2 + 2, radius * 2 + 2);
  }

  /** Dabs from (x0, y0) to (x1, y1), spaced so the stroke reads as a continuous line. */
  line(x0: number, y0: number, x1: number, y1: number, radius: number, tool: MaskTool) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(1, radius * 0.3)));
    for (let i = 1; i <= steps; i++) this.dab(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, radius, tool);
  }

  private retint(x: number, y: number, w: number, h: number) {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w)), y1 = Math.min(this.height, Math.ceil(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    const src = this.gray.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const out = this.tintCtx.createImageData(x1 - x0, y1 - y0);
    const d = out.data;
    for (let i = 0; i < src.length; i += 4) {
      const v = src[i] - 128;
      if (v > 2) { d[i] = 90; d[i + 1] = 235; d[i + 2] = 150; d[i + 3] = (v / 127) * 140; }
      else if (v < -2) { d[i] = 255; d[i + 1] = 80; d[i + 2] = 90; d[i + 3] = (-v / 128) * 140; }
    }
    this.tintCtx.putImageData(out, x0, y0);
  }

  /** The mask for rendering, or null when nothing is painted. */
  read(): HighlightMask | null {
    const rgba = this.gray.getImageData(0, 0, this.width, this.height).data;
    const data = new Uint8Array(this.width * this.height);
    let any = false;
    for (let i = 0; i < data.length; i++) {
      data[i] = rgba[i * 4];
      if (Math.abs(data[i] - 128) > 2) any = true;
    }
    return any ? { width: this.width, height: this.height, data } : null;
  }
}
