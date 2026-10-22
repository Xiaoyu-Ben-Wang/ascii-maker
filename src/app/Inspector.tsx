import { Crosshair } from 'lucide-react';
import { memo } from 'react';
import {
  COLOR_MODES, COVERAGES, DEFAULTS, DIAGONAL_MODES, DITHER_ALGOS, HIGHLIGHT_MODES, PALETTE_NAMES, RANGES, STYLES, type Params, type Style,
} from '../engine/index.ts';
import { Button, ColorField, Label, Row, Section, Select, SliderField, Switch, TextField, cx } from './ui.tsx';

type Kind = 'range' | 'select' | 'check' | 'color' | 'text' | 'point';
type Option = { value: string; label: string; hint?: string };
interface Field { key: keyof Params; label: string; hint?: string | ((p: Params) => string); kind?: Kind; options?: readonly Option[]; styles?: readonly Style[]; when?: (p: Params) => boolean;
  /** Extra params to change along with this field. */
  also?: (v: unknown, base: Params) => Partial<Params> }
interface Group { title: string; styles?: readonly Style[]; fields: Field[]; collapsed?: boolean }

const GLYPH: Style[] = ['characters', 'cross', 'diagonal', 'dots', 'lines'];
const SHAPES: Style[] = ['cross', 'diagonal', 'dots', 'lines'];

/** Builds select options from an enum, with a short explanation per value. */
const opts = <T extends string>(values: readonly T[], hints: Partial<Record<T, string>> = {}): Option[] =>
  values.map((v) => ({ value: v, label: v, hint: hints[v] }));

const GROUPS: Group[] = [
  {
    title: 'Glyphs', styles: GLYPH, fields: [
      {
        key: 'coverage', label: 'Coverage', kind: 'select',
        options: opts(COVERAGES, { highlights: 'Glyphs only on bright parts, over the photo', full: 'Every cell becomes a glyph, like classic ASCII art' }),
        // Full coverage hides the photo underneath so only glyphs remain; going back restores it.
        also: (v, base) => ({ bgOpacity: v === 'full' ? 0 : base.coverage === 'full' ? DEFAULTS.bgOpacity : base.bgOpacity }),
      },
      { key: 'cellSize', label: 'Size', hint: 'Height of each glyph cell. Smaller means more, finer glyphs.' },
      { key: 'charset', label: 'Characters', hint: 'Used from dark to bright, left to right.', kind: 'text', styles: ['characters'] },
      {
        key: 'diagonalMode', label: 'Direction', kind: 'select', styles: ['diagonal'],
        options: opts(DIAGONAL_MODES, { edge: 'Strokes follow the contours of the image', forward: 'All "/"', backward: 'All "\\"', mixed: 'Random mix of both' }),
      },
      { key: 'strokeWidth', label: 'Stroke width', hint: 'Line thickness, as a share of the cell size.', styles: ['cross', 'diagonal', 'lines'] },
      { key: 'sizeByBrightness', label: 'Grow with light', hint: 'Brighter cells get bigger marks.', kind: 'check', styles: SHAPES },
    ],
  },
  {
    title: 'Where glyphs appear', styles: GLYPH, fields: [
      {
        key: 'highlightMode', label: 'Bright means', kind: 'select',
        options: opts(HIGHLIGHT_MODES, {
          absolute: 'Brighter than the threshold, the same for every photo',
          relative: 'Among the brightest parts of this photo. Threshold = share of the image left bare',
          local: 'Brighter than its surroundings, so even bright areas like sky stay bare',
        }),
        // Relative thresholds are a share of cells, so the absolute default would cover most of the image.
        also: (v, base) => (v === 'relative' ? { threshold: 0.7 } : { threshold: base.threshold }),
      },
      {
        key: 'threshold', label: 'Threshold', when: (p) => p.coverage !== 'full',
        hint: (p) => ({
          absolute: 'Cells darker than this get no glyph. Raise it to keep glyphs to the highlights.',
          relative: 'Share of the image left without glyphs. 0.7 puts glyphs on the brightest 30%.',
          local: 'How much brighter than its surroundings a cell must be to get a glyph.',
        })[p.highlightMode],
      },
      { key: 'thresholdSoftness', label: 'Fade-in', hint: 'How gradually glyphs appear above the threshold.', when: (p) => p.coverage !== 'full' },
      { key: 'localRadius', label: 'Surroundings', hint: 'How large an area each cell is compared against.', when: (p) => p.highlightMode === 'local' },
    ],
  },
  {
    title: 'Glyph color', styles: GLYPH, fields: [
      { key: 'colorMode', label: 'Color', kind: 'select', options: opts(COLOR_MODES, { source: 'Each glyph takes the photo color under it', mono: 'One color for every glyph' }) },
      { key: 'monoColor', label: 'Mono color', kind: 'color', when: (p) => p.colorMode === 'mono' },
      { key: 'glyphTint', label: 'Whiten', hint: 'Mixes glyph colors toward white.' },
      { key: 'glyphBoost', label: 'Brightness', hint: 'Multiplies glyph brightness.' },
      { key: 'glyphOpacity', label: 'Opacity' },
      { key: 'glyphBlur', label: 'Softness', hint: 'Blurs the glyphs only.' },
    ],
  },
  {
    title: 'Photo underneath', styles: GLYPH, fields: [
      { key: 'bgBlur', label: 'Blur', hint: 'Blurs the photo behind the glyphs. 0 keeps it sharp.' },
      { key: 'bgOpacity', label: 'Visibility', hint: 'How much of the photo shows. 0 leaves only the fill color.' },
      { key: 'bgColor', label: 'Fill color', hint: 'What the photo fades toward as visibility drops.', kind: 'color' },
    ],
  },
  {
    title: 'Dither', styles: ['dither'], fields: [
      { key: 'ditherAlgo', label: 'Algorithm', kind: 'select', options: opts(DITHER_ALGOS) },
      { key: 'palette', label: 'Palette', kind: 'select', options: opts(PALETTE_NAMES, { auto: 'Colors picked from the image', source: 'Image colors, reduced per channel' }) },
      { key: 'ditherLevels', label: 'Colors', hint: 'Palette size for auto, levels per channel for source.' },
      { key: 'pixelSize', label: 'Pixel size' },
      { key: 'ditherSpread', label: 'Strength', hint: 'How far errors spread to neighbors (diffusion algorithms).' },
    ],
  },
  {
    title: 'Glow', fields: [
      { key: 'bloom', label: 'Strength', hint: 'Halo around bright glyphs or pixels.' },
      { key: 'bloomRadius', label: 'Radius', when: (p) => p.bloom > 0 },
      { key: 'bloomThreshold', label: 'Threshold', hint: 'Only parts brighter than this glow.', when: (p) => p.bloom > 0 },
    ],
  },
  {
    title: 'Effects', fields: [
      { key: 'blur', label: 'Overall blur', hint: 'Blurs the finished image.' },
      { key: 'scanlines', label: 'Scanlines' },
      { key: 'scanlineSpacing', label: 'Line spacing', when: (p) => p.scanlines > 0 },
      { key: 'vignette', label: 'Vignette', hint: 'Darkens toward the edges.' },
      { key: 'vignetteX', label: 'Center', kind: 'point', when: (p) => p.vignette > 0 },
      { key: 'chromatic', label: 'Color fringe', hint: 'Chromatic aberration: splits red and blue toward the edges.' },
      { key: 'grain', label: 'Grain' },
    ],
  },
  {
    title: 'Adjust photo', collapsed: true, fields: [
      { key: 'brightness', label: 'Brightness' },
      { key: 'contrast', label: 'Contrast' },
      { key: 'saturation', label: 'Saturation' },
      { key: 'gamma', label: 'Gamma' },
      { key: 'invert', label: 'Invert', kind: 'check' },
    ],
  },
  {
    title: 'Advanced', collapsed: true, fields: [
      { key: 'font', label: 'Font', kind: 'text', styles: ['characters'] },
      { key: 'seed', label: 'Seed', hint: 'Changes the random grain and mixed strokes.' },
      { key: 'unitWidth', label: 'Unit width', hint: 'Sizes are measured on an image this wide and scale with the output. 0 = real pixels.' },
    ],
  },
];

const STYLE_GLYPH: Record<Style, string> = {
  characters: '@#a', cross: '+×+', diagonal: '/\\/', dots: '•●•', lines: '│|│', dither: '▚▞▚',
};

type Set = (patch: Partial<Params>) => void;

const FieldControl = memo(function FieldControl({ f, hint, value, set, base, baseParams }: { f: Field; hint?: string; value: Params[keyof Params]; set: Set; base: Params[keyof Params]; baseParams: Params }) {
  const kind: Kind = f.kind ?? (typeof DEFAULTS[f.key] === 'boolean' ? 'check' : 'range');
  const put = (v: unknown) => set({ ...f.also?.(v, baseParams), [f.key]: v } as Partial<Params>);
  const modified = value !== base;
  const reset = () => put(base);
  if (kind === 'range') {
    const [min, max, step] = RANGES[f.key] ?? [0, 1, 0.01];
    return <SliderField label={f.label} hint={hint} modified={modified} value={value as number} min={min} max={max} step={step} onChange={put} onReset={reset} />;
  }
  const row = { label: f.label, hint, modified, onReset: reset };
  if (kind === 'select') {
    // Keep a value that isn't in the list (e.g. a custom palette) selectable.
    const options = f.options!.some((o) => o.value === value) ? f.options! : [{ value: value as string, label: value as string }, ...f.options!];
    return <Row {...row}><Select label={f.label} value={value as string} options={options} onChange={put} /></Row>;
  }
  if (kind === 'check') return <Row {...row}><Switch label={f.label} checked={value as boolean} onChange={put} /></Row>;
  if (kind === 'color') return <Row {...row}><ColorField label={f.label} value={value as string} onChange={put} /></Row>;
  return (
    <div className="py-1.5">
      <div className="mb-1.5 flex items-center justify-between"><Label text={f.label} hint={hint} modified={modified} onReset={reset} /></div>
      <TextField label={f.label} value={value as string} onChange={put} mono />
    </div>
  );
});

export function StylePicker({ style, onChange }: { style: Style; onChange: (s: Style) => void }) {
  return (
    <div role="radiogroup" aria-label="Style" className="grid grid-cols-3 gap-1.5 px-4 pt-3 pb-4">
      {STYLES.map((s) => (
        <button
          key={s}
          role="radio"
          aria-checked={s === style}
          onClick={() => onChange(s)}
          className={cx(
            'press group flex flex-col items-center gap-1 rounded-lg border py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            s === style ? 'border-accent/50 bg-accent/[0.08] text-accent' : 'border-line bg-white/[0.02] text-muted hover:border-line-strong hover:text-fg',
          )}
        >
          <span className="font-mono text-[15px] leading-none tracking-[0.15em]">{STYLE_GLYPH[s]}</span>
          <span className="text-[11px] capitalize">{s}</span>
        </button>
      ))}
    </div>
  );
}

/** Vignette center: picked by clicking the preview, shown as percentages. */
function PointField({ label, params, base, set, picking, onPicking }: { label: string; params: Params; base: Params; set: Set; picking: boolean; onPicking: (v: boolean) => void }) {
  const moved = params.vignetteX !== base.vignetteX || params.vignetteY !== base.vignetteY;
  return (
    <Row label={label} hint="Where the vignette is centered. Pick, then click the image." modified={moved}>
      <div className="flex items-center gap-1">
        <button
          className="rounded px-1 font-mono text-[11px] text-muted tabular-nums hover:text-fg disabled:hover:text-muted"
          title="Reset to preset" disabled={!moved}
          onClick={() => set({ vignetteX: base.vignetteX, vignetteY: base.vignetteY })}
        >
          {Math.round(params.vignetteX * 100)}, {Math.round(params.vignetteY * 100)}
        </button>
        <Button size="sm" variant="solid" aria-pressed={picking} onClick={() => onPicking(!picking)}
          className={cx(picking && 'border-accent/50 text-accent')}>
          <Crosshair className="size-3.5" />{picking ? 'Click image' : 'Pick'}
        </Button>
      </div>
    </Row>
  );
}

export function Inspector({ params, base, set, picking, onPicking }: { params: Params; base: Params; set: Set; picking: boolean; onPicking: (v: boolean) => void }) {
  return (
    <>
      {GROUPS.filter((g) => !g.styles || g.styles.includes(params.style)).map((g) => (
        <Section key={g.title} title={g.title} defaultOpen={!g.collapsed}>
          {g.fields
            .filter((f) => (!f.styles || f.styles.includes(params.style)) && (!f.when || f.when(params)))
            .map((f) => f.kind === 'point'
              ? <PointField key={f.key} label={f.label} params={params} base={base} set={set} picking={picking} onPicking={onPicking} />
              : <FieldControl key={f.key} f={f} hint={typeof f.hint === 'function' ? f.hint(params) : f.hint} value={params[f.key]} base={base[f.key]} baseParams={base} set={set} />)}
        </Section>
      ))}
    </>
  );
}
