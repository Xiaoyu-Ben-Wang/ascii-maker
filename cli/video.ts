// Video conversion: ffmpeg decodes raw frames, a worker-thread pool renders them, ffmpeg encodes the result.
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { frameFor, lockPalette, type Params, type SizeName } from '../src/engine/index.ts';
import type { FrameDone, FrameJob } from './video-worker.ts';

export const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.gif'];
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

export interface VideoOptions {
  size: SizeName;
  width?: number;
  fps?: number;
  start?: number;
  duration?: number;
  crf: number;
  threads?: number;
  audio: boolean;
  quiet: boolean;
}

export interface VideoResult { frames: number; width: number; height: number; fps: number; ms: number; renderFps: number }

interface Probe { width: number; height: number; fps: number; duration: number; frames: number | null; audio: boolean }

function probe(input: string): Probe {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', input], { encoding: 'utf8' });
  if (r.error) throw new Error(`ffprobe not found (install ffmpeg, or set FFPROBE_PATH): ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr.trim()}`);
  const info = JSON.parse(r.stdout);
  const v = info.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  if (!v) throw new Error('no video stream found');
  const [n, d] = String(v.r_frame_rate).split('/').map(Number);
  return {
    width: v.width, height: v.height, fps: d ? n / d : n, duration: Number(info.format?.duration) || 0,
    frames: Number(v.nb_frames) || null, audio: info.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'),
  };
}

function encoderArgs(out: string, crf: number): string[] {
  const ext = out.toLowerCase().slice(out.lastIndexOf('.'));
  if (ext === '.webm') return ['-c:v', 'libvpx-vp9', '-crf', String(crf + 14), '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p', '-c:a', 'libopus'];
  if (ext === '.gif') return ['-filter_complex', '[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3'];
  // yuv420p + faststart for files that play everywhere, including browsers and phones.
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '192k'];
}

export async function convertVideo(input: string, out: string, params: Params, o: VideoOptions): Promise<VideoResult> {
  const t0 = performance.now();
  const info = probe(input);
  let { width: w, height: h } = frameFor(info.width, info.height, o.size);
  if (o.width) { h = Math.round((info.height * o.width) / info.width); w = o.width; }
  // H.264 with yuv420p needs even dimensions.
  w -= w % 2; h -= h % 2;
  const fps = o.fps ?? info.fps;
  const span = o.duration ?? Math.max(0, info.duration - (o.start ?? 0));
  const expected = Math.max(1, Math.round(span * fps));
  const frameBytes = w * h * 4;

  const trim = [...(o.start ? ['-ss', String(o.start)] : []), ...(o.duration ? ['-t', String(o.duration)] : [])];
  const decoder = spawn(FFMPEG, ['-v', 'error', ...trim, '-i', input, '-vf', `fps=${fps},scale=${w}:${h}:flags=lanczos`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const withAudio = o.audio && info.audio && !out.toLowerCase().endsWith('.gif');
  const encoder = spawn(FFMPEG, [
    '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(fps), '-i', '-',
    ...(withAudio ? [...trim, '-i', input, '-map', '0:v', '-map', '1:a?', '-shortest'] : []),
    ...encoderArgs(out, o.crf), out,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  const errs: string[] = [];
  encoder.stdin.on('error', (e) => errs.push(`encoder input: ${e.message}`));
  decoder.stderr.on('data', (d) => errs.push(String(d)));
  encoder.stderr.on('data', (d) => errs.push(String(d)));
  decoder.on('error', (e) => errs.push(`ffmpeg not found (install ffmpeg, or set FFMPEG_PATH): ${e.message}`));

  const n = Math.max(1, Math.min(o.threads ?? availableParallelism() - 1, 16));
  const workers = Array.from({ length: n }, () => new Worker(new URL('./video-worker.ts', import.meta.url)));
  const idle = [...workers];
  const done = new Map<number, Uint8Array>();
  let nextOut = 0, submitted = 0, decodingDone = false;
  let locked: Params | null = null;
  let fail: (e: Error) => void = () => {};
  let finish: () => void = () => {};
  const finished = new Promise<void>((res, rej) => { finish = res; fail = rej; });
  const waitingFrames: Uint8Array[] = [];
  let lastLog = 0;

  const progress = () => {
    if (o.quiet) return;
    const now = performance.now();
    if (now - lastLog < 250 && nextOut < expected) return;
    lastLog = now;
    const secs = (now - t0) / 1000, rate = nextOut / Math.max(0.001, secs);
    const eta = rate > 0 ? Math.max(0, (expected - nextOut) / rate) : 0;
    process.stderr.write(`\r  frame ${nextOut}/${expected}  ${rate.toFixed(1)} fps  ${secs.toFixed(0)}s elapsed  ~${eta.toFixed(0)}s left   `);
  };

  // Writes finished frames in order; pauses decoding while the encoder or the pool is backed up.
  const flush = () => {
    while (done.has(nextOut)) {
      const frame = done.get(nextOut)!;
      done.delete(nextOut);
      nextOut++;
      if (!encoder.stdin.write(frame)) { decoder.stdout.pause(); encoder.stdin.once('drain', pump); }
    }
    progress();
    if (decodingDone && nextOut === submitted && !waitingFrames.length) encoder.stdin.end();
  };

  const pump = () => {
    while (idle.length && waitingFrames.length) {
      const data = waitingFrames.shift()!;
      if (!locked) locked = lockPalette({ width: w, height: h, data }, params);
      const job: FrameJob = { index: submitted++, width: w, height: h, data, params: locked, targetWidth: w };
      idle.pop()!.postMessage(job, [data.buffer as ArrayBuffer]);
    }
    const backlog = waitingFrames.length + done.size;
    if (backlog < n * 2 && encoder.stdin.writableLength < frameBytes * 4) decoder.stdout.resume();
    else decoder.stdout.pause();
    flush();
  };

  for (const wk of workers) {
    wk.on('message', (m: FrameDone) => { done.set(m.index, m.data); idle.push(wk); pump(); });
    wk.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))));
  }

  // Chunks are copied straight into a preallocated frame; concatenating 64 KB chunks would be quadratic.
  let frame = new Uint8Array(frameBytes);
  let filled = 0;
  decoder.stdout.on('data', (chunk: Buffer) => {
    let off = 0;
    while (off < chunk.length) {
      const take = Math.min(frameBytes - filled, chunk.length - off);
      frame.set(chunk.subarray(off, off + take), filled);
      filled += take;
      off += take;
      if (filled === frameBytes) {
        waitingFrames.push(frame);
        frame = new Uint8Array(frameBytes);
        filled = 0;
      }
    }
    pump();
  });
  decoder.on('close', (code) => {
    if (code !== 0) return fail(new Error(`ffmpeg decode failed: ${errs.join('').trim()}`));
    decodingDone = true;
    pump();
  });
  encoder.on('close', (code) => (code === 0 ? finish() : fail(new Error(`ffmpeg encode failed: ${errs.join('').trim()}`))));

  try {
    await finished;
  } finally {
    await Promise.all(workers.map((wk) => wk.terminate()));
    decoder.kill();
  }
  if (!o.quiet) process.stderr.write('\n');
  const ms = performance.now() - t0;
  return { frames: nextOut, width: w, height: h, fps, ms, renderFps: nextOut / (ms / 1000) };
}
