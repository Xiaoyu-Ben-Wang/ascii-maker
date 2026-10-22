// Output sizing shared by the editor and CLI: the original size, or a standard long-edge size that keeps the aspect ratio.

export const SIZE_PRESETS = { '1080p': 1920, '2k': 2560, '4k': 3840 } as const;
export type SizePreset = keyof typeof SIZE_PRESETS;
export type SizeName = 'source' | SizePreset;
export const SIZE_NAMES = ['source', ...Object.keys(SIZE_PRESETS)] as SizeName[];

export interface Frame {
  /** Region of the source to use, in source pixels (currently always the whole image). */
  crop: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
}

export function frameFor(srcW: number, srcH: number, size: SizeName): Frame {
  const crop = { x: 0, y: 0, w: srcW, h: srcH };
  if (size === 'source') return { crop, width: srcW, height: srcH };
  const k = SIZE_PRESETS[size] / Math.max(srcW, srcH);
  return { crop, width: Math.max(1, Math.round(srcW * k)), height: Math.max(1, Math.round(srcH * k)) };
}
