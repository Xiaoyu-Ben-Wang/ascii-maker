import type { FImage } from './pixels.ts';

/** LRU of intermediate images, bounded in bytes. Entries are shared, so callers must never mutate them. */
export class RenderCache {
  private entries = new Map<string, FImage>();
  private bytes = 0;
  private maxBytes: number;

  constructor(maxMB = 192) {
    this.maxBytes = maxMB * 1024 * 1024;
  }

  get(key: string, make: () => FImage): FImage {
    let v = this.entries.get(key);
    if (v) {
      this.entries.delete(key);
    } else {
      v = make();
      this.bytes += v.r.byteLength * 3;
      while (this.bytes > this.maxBytes && this.entries.size) {
        const oldest = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(oldest)!.r.byteLength * 3;
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, v);
    return v;
  }
}

export type Memo = (key: string, make: () => FImage) => FImage;

export const scopedMemo = (memo: Memo, prefix: string): Memo => (k, make) => memo(`${prefix}|${k}`, make);
