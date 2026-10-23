// Video sources in the editor: probing, and decoding single frames for scrubbing.
// Mediabunny is loaded on first use, so the editor stays light until a video is opened.
import type { CanvasSink, Input } from 'mediabunny';

export type VideoFormat = 'mp4' | 'webm';
export const VIDEO_FORMATS: { value: VideoFormat; label: string; codec: 'avc' | 'vp9'; mime: string }[] = [
  { value: 'mp4', label: 'MP4 (H.264)', codec: 'avc', mime: 'video/mp4' },
  { value: 'webm', label: 'WebM (VP9)', codec: 'vp9', mime: 'video/webm' },
];

export interface VideoInfo { start: number; duration: number; fps: number; width: number; height: number; audio: boolean }

export const isVideo = (f: File) => f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv)$/i.test(f.name);

/** The containers the editor reads. */
export const inputFormats = (mb: typeof import('mediabunny')) => [mb.MP4, mb.QTFF, mb.WEBM, mb.MATROSKA];

/** H.264 and yuv420 want even dimensions. */
export const evenSize = (w: number, h: number) => ({ width: Math.max(2, w - (w % 2)), height: Math.max(2, h - (h % 2)) });

/** The output formats this browser can encode at the given size. */
export async function encodableFormats(width: number, height: number): Promise<VideoFormat[]> {
  const { canEncodeVideo } = await import('mediabunny');
  const ok = await Promise.all(VIDEO_FORMATS.map((f) => canEncodeVideo(f.codec, { ...evenSize(width, height) }).catch(() => false)));
  return VIDEO_FORMATS.filter((_, i) => ok[i]).map((f) => f.value);
}

export class VideoSource {
  readonly file: File;
  readonly info: VideoInfo;
  private input: Input;
  private sink: CanvasSink;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(file: File, input: Input, sink: CanvasSink, info: VideoInfo) {
    this.file = file;
    this.input = input;
    this.info = info;
    this.sink = sink;
  }

  static async open(file: File): Promise<VideoSource> {
    const mb = await import('mediabunny');
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: inputFormats(mb) });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('no video track');
      if (!(await track.canDecode())) throw new Error('this browser cannot decode the video');
      const [start, end, stats, audio, width, height] = await Promise.all([
        track.getFirstTimestamp(), input.computeDuration(), track.computePacketStats(120),
        input.getPrimaryAudioTrack(), track.getDisplayWidth(), track.getDisplayHeight(),
      ]);
      const info = { start, duration: Math.max(0, end - start), fps: stats.averagePacketRate || 30, width, height, audio: !!audio };
      return new VideoSource(file, input, new mb.CanvasSink(track), info);
    } catch (e) {
      input.dispose();
      throw e;
    }
  }

  /** The frame shown at `time` (seconds from the start of the video). Calls run one at a time, in order. */
  frameAt(time: number): Promise<ImageBitmap> {
    const run = async () => {
      const t = this.info.start + Math.min(Math.max(0, time), this.info.duration);
      const c = (await this.sink.getCanvas(t)) ?? (await this.sink.getCanvas(this.info.start));
      if (!c) throw new Error('no frame at this time');
      return createImageBitmap(c.canvas);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  dispose() {
    this.input.dispose();
  }
}

export function formatTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
