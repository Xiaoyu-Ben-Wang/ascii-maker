import { memo } from 'react';
import {
  COLOR_MODES, COVERAGES, DEFAULTS, DIAGONAL_MODES, DITHER_ALGOS, PALETTE_NAMES, RANGES, STYLES, type Params, type Style,
} from '../engine/index.ts';
import { ColorField, Row, Section, Select, SliderField, Switch, TextField, cx } from './ui.tsx';

type Kind = 'range' | 'select' | 'check' | 'color' | 'text';
interface Field { key: keyof Params; label: string; kind?: Kind; options?: readonly string[]; styles?: readonly Style[]; when?: (p: Params) => boolean;
  /** Extra params to change along with this field. */
  also?: (v: unknown, base: Params) => Partial<Params> }
interface Group { title: string; styles?: readonly Style[]; fields: Field[]; collapsed?: boolean }

const GLYPH: Style[] = ['characters', 'cross', 'diagonal', 'dots', 'lines'];
const SHAPES: Style[] = ['cross', 'diagonal', 'dots', 'lines'];

const GROUPS: Group[] = [
  {
    title: 'Glyphs', styles: GLYPH, fields: [
      {
        key: 'coverage', label: 'Coverage', kind: 'select', options: COVERAGES,
        // Full coverage hides the photo underneath so only glyphs remain; going back restores it.
        also: (v, base) => ({ bgOpacity: v === 'full' ? 0 : base.coverage === 'full' ? DEFAULTS.bgOpacity : base.bgOpacity }),
      },
      { key: 'cellSize', label: 'Cell size' },
      { key: 'charset', label: 'Characters', kind: 'text', styles: ['characters'] },
      { key: 'diagonalMode', label: 'Direction', kind: 'select', options: DIAGONAL_MODES, styles: ['diagonal'] },
      { key: 'strokeWidth', label: 'Stroke width', styles: ['cross', 'diagonal', 'lines'] },
      { key: 'sizeByBrightness', label: 'Scale by light', kind: 'check', styles: SHAPES },
      { key: 'threshold', label: 'Threshold', when: (p) => p.coverage !== 'full' },
      { key: 'thresholdSoftness', label: 'Fade-in', when: (p) => p.coverage !== 'full' },
      { key: 'colorMode', label: 'Color', kind: 'select', options: COLOR_MODES },
      { key: 'monoColor', label: 'Mono color', kind: 'color', when: (p) => p.colorMode === 'mono' },
      { key: 'glyphTint', label: 'Whiten' },
      { key: 'glyphBoost', label: 'Brightness' },
      { key: 'glyphOpacity', label: 'Opacity' },
      { key: 'glyphBlur', label: 'Glyph blur' },
    ],
  },
  {
    title: 'Background', styles: GLYPH, fields: [
      { key: 'bgBlur', label: 'Background blur' },
      { key: 'bgOpacity', label: 'Visibility' },
      { key: 'bgColor', label: 'Base color', kind: 'color' },
    ],
  },
  {
    title: 'Dither', styles: ['dither'], fields: [
      { key: 'ditherAlgo', label: 'Algorithm', kind: 'select', options: DITHER_ALGOS },
      { key: 'palette', label: 'Palette', kind: 'select', options: PALETTE_NAMES },
      { key: 'ditherLevels', label: 'Colors' },
      { key: 'pixelSize', label: 'Pixel size' },
      { key: 'ditherSpread', label: 'Strength' },
    ],
  },
  {
    title: 'Bloom', fields: [
      { key: 'bloom', label: 'Strength' },
      { key: 'bloomRadius', label: 'Radius' },
      { key: 'bloomThreshold', label: 'Threshold' },
    ],
  },
  {
    title: 'Effects', fields: [
      { key: 'blur', label: 'Overall blur' },
      { key: 'scanlines', label: 'Scanlines' },
      { key: 'scanlineSpacing', label: 'Line spacing', when: (p) => p.scanlines > 0 },
      { key: 'vignette', label: 'Vignette' },
      { key: 'chromatic', label: 'Chromatic' },
      { key: 'grain', label: 'Grain' },
    ],
  },
  {
    title: 'Image', collapsed: true, fields: [
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
      { key: 'seed', label: 'Seed' },
      { key: 'unitWidth', label: 'Unit width' },
    ],
  },
];

const STYLE_GLYPH: Record<Style, string> = {
  characters: '@#a', cross: '+×+', diagonal: '/\\/', dots: '•●•', lines: '│|│', dither: '▚▞▚',
};

type Set = (patch: Partial<Params>) => void;

const FieldControl = memo(function FieldControl({ f, value, set, base, baseParams }: { f: Field; value: Params[keyof Params]; set: Set; base: Params[keyof Params]; baseParams: Params }) {
  const kind: Kind = f.kind ?? (typeof DEFAULTS[f.key] === 'boolean' ? 'check' : 'range');
  const put = (v: unknown) => set({ ...f.also?.(v, baseParams), [f.key]: v } as Partial<Params>);
  if (kind === 'range') {
    const [min, max, step] = RANGES[f.key] ?? [0, 1, 0.01];
    return <SliderField label={f.label} value={value as number} min={min} max={max} step={step} onChange={put} onReset={() => put(base)} />;
  }
  if (kind === 'select') return <Row label={f.label}><Select label={f.label} value={value as string} options={f.options!} onChange={put} /></Row>;
  if (kind === 'check') return <Row label={f.label}><Switch label={f.label} checked={value as boolean} onChange={put} /></Row>;
  if (kind === 'color') return <Row label={f.label}><ColorField label={f.label} value={value as string} onChange={put} /></Row>;
  return (
    <div className="py-1.5">
      <div className="mb-1.5 text-[12px] text-muted">{f.label}</div>
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

export function Inspector({ params, base, set }: { params: Params; base: Params; set: Set }) {
  return (
    <>
      {GROUPS.filter((g) => !g.styles || g.styles.includes(params.style)).map((g) => (
        <Section key={g.title} title={g.title} defaultOpen={!g.collapsed}>
          {g.fields
            .filter((f) => (!f.styles || f.styles.includes(params.style)) && (!f.when || f.when(params)))
            .map((f) => <FieldControl key={f.key} f={f} value={params[f.key]} base={base[f.key]} baseParams={base} set={set} />)}
        </Section>
      ))}
    </>
  );
}
