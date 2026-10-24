import { createCanvas } from '@napi-rs/canvas';
import { parentPort } from 'node:worker_threads';
import { render, type Params } from '../src/engine/index.ts';

export interface FrameJob { index: number; width: number; height: number; data: Uint8Array; params: Params; targetWidth: number }
export interface FrameDone { index: number; data: Uint8Array }

parentPort!.on('message', (job: FrameJob) => {
  const src = { width: job.width, height: job.height, data: job.data };
  const r = render(src, job.params, { createCanvas: (w, h) => createCanvas(w, h), targetWidth: job.targetWidth, frame: job.index });
  const out = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  parentPort!.postMessage({ index: job.index, data: out } satisfies FrameDone, [out.buffer as ArrayBuffer]);
});
