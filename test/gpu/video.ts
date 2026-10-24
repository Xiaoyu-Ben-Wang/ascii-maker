// Browser-side video export checks, run by test/gpu/run.ts: the export worker on the GPU against the same worker on
// the CPU, decoded frame by frame.
import * as mb from 'mediabunny';
import { PRESETS, resolveParams, type HighlightMask, type Params } from '../../src/engine/index.ts';
import type { VideoJob, VideoMessage } from '../../src/workers/protocol.ts';
import { report, type Case } from './harness.ts';

const W = 480, H = 270, N = 24;

/** A short clip with motion and an asymmetric layout, so a flipped or shifted frame can't pass. */
async function clip(): Promise<File> {
  const c = new OffscreenCanvas(W, H);
  const x = c.getContext('2d')!;
  const target = new mb.BufferTarget();
  const out = new mb.Output({ format: new mb.WebMOutputFormat(), target });
  const src = new mb.CanvasSource(c, { codec: 'vp9', bitrate: 4e6 });
  out.addVideoTrack(src, { frameRate: 24 });
  await out.start();
  for (let i = 0; i < N; i++) {
    const g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#0a1430'); g.addColorStop(1, `hsl(${i * 12}, 80%, 60%)`);
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.fillStyle = '#fff'; x.fillRect(20, 20, 120, 60);
    x.beginPath(); x.arc(80 + i * 12, 190, 50, 0, 7); x.fill();
    await src.add(i / 24, 1 / 24);
  }
  await out.finalize();
  return new File([target.buffer!], 'clip.webm', { type: 'video/webm' });
}

async function exportVideo(job: VideoJob): Promise<{ blob: Blob; frames: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../../src/workers/video.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<VideoMessage>) => {
      if (e.data.type === 'done') { w.terminate(); resolve(e.data); }
      else if (e.data.type === 'error') { w.terminate(); reject(new Error(e.data.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message)); };
    w.postMessage(job);
  });
}

async function frames(blob: Blob, times: number[]) {
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: [mb.WEBM, mb.MP4] });
  try {
    const track = (await input.getPrimaryVideoTrack())!;
    const sink = new mb.CanvasSink(track);
    const out: ImageData[] = [];
    for (const t of times) {
      const c = (await sink.getCanvas(t))!.canvas as OffscreenCanvas;
      out.push(c.getContext('2d')!.getImageData(0, 0, c.width, c.height));
    }
    return { frames: out, count: (await track.computePacketStats()).packetCount, width: await track.getDisplayWidth(), height: await track.getDisplayHeight() };
  } finally {
    input.dispose();
  }
}

const meanDiff = (a: ImageData, b: ImageData) => {
  let s = 0;
  for (let i = 0; i < a.data.length; i++) s += Math.abs(a.data[i] - b.data[i]);
  return s / a.data.length;
};

const file = await clip();
const cases: Case[] = [];
const mask: HighlightMask = { width: 48, height: 27, data: new Uint8Array(48 * 27).fill(128) };
for (let i = 0; i < mask.data.length; i++) mask.data[i] = i % 48 < 16 ? 255 : 128;

const variants: { name: string; params: Partial<Params>; crop?: VideoJob['crop']; size?: [number, number]; mask?: HighlightMask; tol: number }[] = [
  { name: 'soft-ascii', params: PRESETS['soft-ascii'].params, tol: 3 },
  { name: 'full-cross, colored background', params: { ...PRESETS['full-cross'].params, bgColor: '#f4ecd8' }, tol: 3 },
  { name: 'dots with painted mask', params: PRESETS.dots.params, mask, tol: 3 },
  { name: 'cropped and downscaled', params: PRESETS['sharp-ascii'].params, crop: { x: 100, y: 40, w: 300, h: 200 }, size: [240, 160], tol: 3 },
  // Ordered, so it can be compared closely; error diffusion turns sub-level differences into different patterns.
  { name: 'dither, auto palette locked on the first frame', params: { ...PRESETS.dither.params, ditherAlgo: 'bayer4' }, tol: 3 },
];
for (const v of variants) {
  cases.push({
    name: `video ${v.name}: GPU export matches CPU export`,
    run: async () => {
      const [w, h] = v.size ?? [W, H];
      const job = (gpu: boolean): VideoJob => ({
        file, width: w, height: h, crop: v.crop ?? { x: 0, y: 0, w: W, h: H }, params: resolveParams(v.params, { grain: 0 }),
        mask: v.mask, format: 'webm', audio: false, gpu, quality: 1,
      });
      const [g, c] = await Promise.all([exportVideo(job(true)), exportVideo(job(false))]);
      if (g.frames !== N || c.frames !== N) throw new Error(`rendered ${g.frames} / ${c.frames} frames, expected ${N}`);
      const times = [0, 0.25, 0.5, 0.9];
      const [gf, cf] = await Promise.all([frames(g.blob, times), frames(c.blob, times)]);
      if (gf.width !== w || gf.height !== h) throw new Error(`output is ${gf.width}x${gf.height}, expected ${w}x${h}`);
      if (gf.count !== N) throw new Error(`file has ${gf.count} frames`);
      const diffs = gf.frames.map((f, i) => meanDiff(f, cf.frames[i]));
      // A flipped frame would differ by tens of levels on this clip; also make sure frames actually change over time.
      if (diffs.some((d) => d > v.tol)) throw new Error(`mean difference per frame ${diffs.map((d) => d.toFixed(2)).join(', ')}`);
      if (meanDiff(gf.frames[0], gf.frames[3]) < 2) throw new Error('frames do not change over time');
      return `mean difference per frame ${diffs.map((d) => d.toFixed(2)).join(', ')}`;
    },
  });
}
cases.push({
  name: 'video: MP4 (H.264) export on the GPU, where the browser can encode it',
  run: async () => {
    if (!(await mb.canEncodeVideo('avc', { width: W, height: H }))) return 'skipped: no H.264 encoder in this browser';
    const r = await exportVideo({ file, width: W, height: H, crop: { x: 0, y: 0, w: W, h: H }, params: resolveParams(PRESETS['soft-ascii'].params), format: 'mp4', audio: false, gpu: true, quality: 0.5 });
    if (r.frames !== N) throw new Error(`rendered ${r.frames} frames`);
    const f = await frames(r.blob, [0.5]);
    if (f.width !== W || f.height !== H) throw new Error('wrong size');
  },
});

await report(cases);
