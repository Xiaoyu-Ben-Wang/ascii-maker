import type { Crop, HighlightMask, Params } from '../engine/index.ts';
import type { VideoFormat } from '../app/lib/video.ts';

export interface RenderJob { reqId: number; sourceId: number; width: number; height: number; crop: Crop; targetWidth: number; params: Params }
export interface ExportJob { reqId: number; sourceId: number; width: number; height: number; crop: Crop; params: Params; mime: string; quality: number; pngLevel: number }

export type RenderRequest =
  | { type: 'source'; sourceId: number; bitmap: ImageBitmap }
  | { type: 'drop'; sourceId: number }
  | { type: 'mask'; sourceId: number; mask: HighlightMask | null }
  | { type: 'gpu'; enabled: boolean }
  | ({ type: 'render' } & RenderJob)
  | ({ type: 'export' } & ExportJob);

export interface Rendered { type: 'rendered'; reqId: number; bitmap: ImageBitmap; text?: string; ms: number; gpu: boolean }
export interface Exported { type: 'exported'; reqId: number; blob: Blob; width: number; height: number; text?: string; ms: number; gpu: boolean }
export type RenderResponse = Rendered | Exported | { type: 'error'; reqId: number; message: string };

export interface VideoJob {
  file: File;
  width: number;
  height: number;
  crop: Crop;
  params: Params;
  mask?: HighlightMask;
  format: VideoFormat;
  audio: boolean;
  gpu: boolean;
  /** Encoder quality, 0 (smallest) to 1 (best). */
  quality: number;
}

export type VideoMessage =
  | { type: 'progress'; progress: number; frame: number }
  | { type: 'done'; blob: Blob; frames: number; ms: number }
  | { type: 'error'; message: string };

/** Errors that only mean a request was overtaken, not that rendering failed. */
export const STALE = 'stale source';
export const CRASHED = 'renderer crashed';
