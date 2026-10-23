// Render parameters, defaults and presets shared by the browser editor and the CLI.

/** "photo" draws only the background image (its blur and opacity apply), plus the adjustments and effects. */
export const STYLES = ['characters', 'cross', 'diagonal', 'dots', 'lines', 'dither', 'photo'] as const;
export type Style = (typeof STYLES)[number];

export const DITHER_ALGOS = [
  // error diffusion
  'floyd-steinberg', 'atkinson', 'jarvis', 'stucki', 'burkes', 'sierra', 'sierra-2row', 'sierra-lite',
  // ordered / threshold maps
  'bayer2', 'bayer4', 'bayer8', 'bayer16', 'halftone', 'ign', 'lines-h', 'lines-v', 'lines-diag', 'noise',
  'none',
] as const;
export type DitherAlgo = (typeof DITHER_ALGOS)[number];

export const DIAGONAL_MODES = ['edge', 'forward', 'backward', 'mixed'] as const;
export type DiagonalMode = (typeof DIAGONAL_MODES)[number];

export const COLOR_MODES = ['source', 'mono'] as const;
/** "highlights" draws glyphs only where the image is bright; "full" converts every cell, like classic ASCII art. */
export const COVERAGES = ['highlights', 'full'] as const;
export type Coverage = (typeof COVERAGES)[number];
/**
 * How a cell's brightness is measured against the threshold. "absolute" uses its luminance as is; "relative" uses its
 * rank among the image's cells, so the threshold is the share of cells left bare; "local" compares it with its
 * surroundings, so only spots brighter than their neighborhood count as highlights.
 */
export const HIGHLIGHT_MODES = ['absolute', 'relative', 'local'] as const;
export type HighlightMode = (typeof HIGHLIGHT_MODES)[number];
export type ColorMode = (typeof COLOR_MODES)[number];

/** Ready-made character ramps for the "characters" style, each ordered dark → bright. */
export const CHARSETS: Record<string, { chars: string; description: string }> = {
  standard: { chars: ' .:-=+xX0S8#@', description: 'Balanced default ramp' },
  classic: { chars: ' .:-=+*#%@', description: 'The 10-step ramp from classic ASCII art' },
  mixed: { chars: ' .:-=+*xX0S8#%@', description: 'Standard and classic merged, keeping both orders' },
  detailed: {
    chars: ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
    description: '70 characters, the finest tonal steps',
  },
  letters: { chars: ' .,:;irsXA253hMHGS#9B&@', description: 'Letters and digits, looks like text' },
  blocks: { chars: ' ░▒▓█', description: 'Shaded blocks, chunky and solid' },
  braille: { chars: ' ⠁⠃⠇⠏⠟⠿⡿⣿', description: 'Braille dots that fill in with brightness' },
  dots: { chars: ' .·•●', description: 'Small to large dots' },
  binary: { chars: ' 01', description: 'Zeros and ones' },
};

export interface Params {
  style: Style;

  // Source adjustments
  brightness: number; // -1..1
  contrast: number; // 0..3
  saturation: number; // 0..3
  gamma: number; // 0.2..3
  invert: boolean;

  /** Pixel-sized params are measured on an image this wide and scale with the output; 0 = absolute pixels. */
  unitWidth: number;

  // Glyph grid
  cellSize: number;
  coverage: Coverage;
  charset: string; // dark → bright, used by "characters"
  font: string;
  highlightMode: HighlightMode;
  threshold: number; // 0..1 luminance below which a cell gets no glyph
  thresholdSoftness: number; // 0..1 fade-in range above the threshold
  localRadius: number; // px, neighborhood size for the "local" highlight mode
  sizeByBrightness: boolean; // scale cross/dots/diagonal/lines with luminance
  strokeWidth: number; // fraction of cell size, for cross/diagonal/lines
  diagonalMode: DiagonalMode;
  colorMode: ColorMode;
  monoColor: string;
  glyphTint: number; // 0..1 mix of glyph color toward white
  glyphBoost: number; // brightness multiplier for glyph color
  glyphOpacity: number; // 0..1

  // Background under the glyphs
  bgBlur: number; // px; 0 = sharp source. Glyph styles and "photo".
  glyphBlur: number; // px softening of the glyph layer only
  bgOpacity: number; // 0..1 opacity of the background image over bgColor
  bgColor: string;

  // Dither style
  ditherAlgo: DitherAlgo;
  palette: string; // palette name, or comma-separated hex list
  pixelSize: number;
  ditherLevels: number; // colors for "auto", per-channel levels for "source"
  ditherSpread: number; // 0..1 error diffusion strength

  // Post effects
  blur: number; // px softening of the finished image
  bloom: number; // 0..2
  bloomRadius: number; // px
  bloomThreshold: number; // 0..1
  scanlines: number; // 0..1
  scanlineSpacing: number; // px
  vignette: number; // 0..1
  vignetteX: number; // 0..1 vignette center, fraction of width
  vignetteY: number; // 0..1 fraction of height
  chromatic: number; // px
  grain: number; // 0..1
  seed: number;
}

export const DEFAULTS: Params = {
  style: 'characters',
  brightness: 0,
  contrast: 1,
  saturation: 1,
  gamma: 1,
  invert: false,

  unitWidth: 1920,
  cellSize: 14,
  coverage: 'highlights',
  charset: ' .:-=+xX0S8#@',
  font: 'Consolas, "Cascadia Mono", "DejaVu Sans Mono", "Courier New", monospace',
  highlightMode: 'absolute',
  threshold: 0.3,
  thresholdSoftness: 0.25,
  localRadius: 120,
  sizeByBrightness: true,
  strokeWidth: 0.1,
  diagonalMode: 'edge',
  colorMode: 'source',
  monoColor: '#ffffff',
  glyphTint: 0.35,
  glyphBoost: 1.35,
  glyphOpacity: 1,

  bgBlur: 6,
  glyphBlur: 0,
  bgOpacity: 0.85,
  bgColor: '#000000',

  ditherAlgo: 'floyd-steinberg',
  palette: 'auto',
  pixelSize: 3,
  ditherLevels: 6,
  ditherSpread: 1,

  blur: 0,
  bloom: 0.6,
  bloomRadius: 8,
  bloomThreshold: 0.4,
  scanlines: 0,
  scanlineSpacing: 4,
  vignette: 0.2,
  vignetteX: 0.5,
  vignetteY: 0.5,
  chromatic: 0,
  grain: 0.04,
  seed: 1,
};

export const PRESETS: Record<string, { description: string; params: Partial<Params> }> = {
  'soft-ascii': {
    description: 'Glowing ASCII on the highlights, over a softened copy of the photo',
    params: { style: 'characters', cellSize: 14, threshold: 0.32, bgBlur: 3, bgOpacity: 0.85, bloom: 0.6, vignette: 0.2 },
  },
  'sharp-ascii': {
    description: 'Glowing ASCII on the highlights of the unblurred photo',
    params: { style: 'characters', cellSize: 14, threshold: 0.32, bgBlur: 0, bgOpacity: 0.85, bloom: 0.6, vignette: 0.2 },
  },
  cross: {
    description: 'Cross-stitch "+" and "×" marks that grow with brightness',
    params: { style: 'cross', cellSize: 16, threshold: 0.28, strokeWidth: 0.1, bgBlur: 3, bgOpacity: 0.55, glyphTint: 0.3, glyphBoost: 1.5, bloom: 0.6 },
  },
  diagonal: {
    description: 'Hatched slashes that follow the image edges, warm film look',
    params: {
      style: 'diagonal', cellSize: 12, threshold: 0.25, strokeWidth: 0.09, diagonalMode: 'edge', bgBlur: 5,
      bgOpacity: 0.65, glyphTint: 0.35, glyphBoost: 1.5, bloom: 0.4, vignette: 0.25, grain: 0.06,
    },
  },
  dots: {
    description: 'Halftone dots that scale with brightness',
    params: { style: 'dots', cellSize: 12, threshold: 0.12, bgBlur: 5, bgOpacity: 0.35, glyphTint: 0.2, bloom: 0.3 },
  },
  'full-ascii': {
    description: 'Classic ASCII art: every cell becomes a character, in the source colors on black',
    params: {
      style: 'characters', coverage: 'full', cellSize: 10, bgOpacity: 0, glyphTint: 0, glyphBoost: 1.15, bloom: 0.25, vignette: 0.15, grain: 0,
    },
  },
  'full-cross': {
    description: 'Whole image rebuilt from "+" and "×" marks sized by brightness',
    params: {
      style: 'cross', coverage: 'full', cellSize: 10, strokeWidth: 0.12, bgOpacity: 0, glyphTint: 0.1, glyphBoost: 1.3, bloom: 0.3, vignette: 0.15, grain: 0,
    },
  },
  'dither-scanline': {
    description: 'Chunky Floyd–Steinberg dither with CRT scanlines and bloom',
    params: {
      style: 'dither', ditherAlgo: 'floyd-steinberg', palette: 'auto', ditherLevels: 4, pixelSize: 4, scanlines: 0.55,
      scanlineSpacing: 4, bloom: 0.45, bloomThreshold: 0.55, vignette: 0.25, chromatic: 1.5, grain: 0.05,
    },
  },
  'gameboy-dither': {
    description: 'Ordered Bayer dither in the 4-tone Game Boy palette with scanlines',
    params: { style: 'dither', ditherAlgo: 'bayer4', palette: 'gameboy', pixelSize: 4, scanlines: 0.35, bloom: 0.2, vignette: 0.2 },
  },
  dither: {
    description: 'Plain Floyd–Steinberg dither in colors picked from the image, no other effects',
    params: { style: 'dither', ditherAlgo: 'floyd-steinberg', palette: 'auto', ditherLevels: 6, pixelSize: 3, bloom: 0, vignette: 0, grain: 0 },
  },
  scanlines: {
    description: 'The photo itself with CRT scanlines, no other effects',
    params: { style: 'photo', bgBlur: 0, bgOpacity: 1, scanlines: 0.5, scanlineSpacing: 4, bloom: 0, vignette: 0, grain: 0 },
  },
  matrix: {
    description: 'Green mono ASCII on black with scanlines',
    params: {
      style: 'characters', colorMode: 'mono', monoColor: '#33ff66', glyphTint: 0, glyphBoost: 1, charset: ' .:01', bgOpacity: 0.12, bgBlur: 12,
      threshold: 0.15, scanlines: 0.4, scanlineSpacing: 3, bloom: 0.7, vignette: 0.3,
    },
  },
};

export function resolveParams(...layers: (Partial<Params> | undefined)[]): Params {
  return Object.assign({}, DEFAULTS, ...layers.filter(Boolean));
}

/** Numeric ranges used by the UI sliders and CLI validation. */
export const RANGES: Partial<Record<keyof Params, [min: number, max: number, step: number]>> = {
  brightness: [-1, 1, 0.01],
  contrast: [0, 3, 0.01],
  saturation: [0, 3, 0.01],
  gamma: [0.2, 3, 0.01],
  unitWidth: [0, 7680, 1],
  cellSize: [4, 64, 1],
  threshold: [0, 1, 0.01],
  thresholdSoftness: [0, 1, 0.01],
  localRadius: [10, 600, 1],
  strokeWidth: [0.02, 0.4, 0.01],
  glyphTint: [0, 1, 0.01],
  glyphBoost: [0.2, 3, 0.01],
  glyphOpacity: [0, 1, 0.01],
  bgBlur: [0, 60, 0.5],
  glyphBlur: [0, 8, 0.1],
  blur: [0, 30, 0.1],
  bgOpacity: [0, 1, 0.01],
  pixelSize: [1, 32, 1],
  ditherLevels: [2, 32, 1],
  ditherSpread: [0, 1, 0.01],
  bloom: [0, 2, 0.01],
  bloomRadius: [1, 60, 0.5],
  bloomThreshold: [0, 1, 0.01],
  scanlines: [0, 1, 0.01],
  scanlineSpacing: [2, 16, 0.5],
  vignette: [0, 1, 0.01],
  vignetteX: [0, 1, 0.01],
  vignetteY: [0, 1, 0.01],
  chromatic: [0, 12, 0.1],
  grain: [0, 0.5, 0.01],
  seed: [0, 9999, 1],
};
