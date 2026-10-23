import { Crosshair } from 'lucide-react';
import { memo, useRef, useState } from 'react';
import {
  CHARSETS, COLOR_MODES, COVERAGES, DEFAULTS, DIAGONAL_MODES, DITHER_ALGOS, HIGHLIGHT_MODES, PALETTE_NAMES, RANGES, STYLES, type Params, type Style,
} from '../engine/index.ts';
import { Button, ColorField, Label, RangeField, Row, Section, Select, SliderField, Switch, TextField, Tip, cx } from './ui.tsx';

type Kind = 'range' | 'select' | 'check' | 'color' | 'text' | 'point' | 'band';
type Option = { value: string; label: string; hint?: string };
interface Field { key: keyof Params; label: string;
  /** For a slider whose range spans 0: fill from 0 rather than from the minimum. */
  centered?: boolean;
  /** For a "band": the param holding the upper end (`key` holds the lower end). */
  key2?: keyof Params;
  /** Named values offered in a dropdown above a text field. */
  library?: Record<string, { chars: string; description: string }>; hint?: string | ((p: Params) => string); kind?: Kind; options?: readonly Option[]; styles?: readonly Style[]; when?: (p: Params) => boolean;
  /** Less-used: tucked behind the section's "More" button unless changed from the preset. */
  more?: boolean;
  /** Extra params to change along with this field. */
  also?: (v: unknown, base: Params) => Partial<Params> }
/** An on/off effect inside the Effects section: off sets `key` to 0, on restores its last value (or `on`). */
interface Effect { label: string; hint?: string; key: keyof Params; on: number; fields: Field[] }
/**
 * `switch` puts an on/off switch in the header for a numeric effect: off sets it to 0, on restores its last value
 * (or `on`). The section starts collapsed while the effect is off. `effects` lists switchable effects as rows.
 */
interface Group {
  title: string; styles?: readonly Style[]; fields: Field[]; collapsed?: boolean; switch?: { key: keyof Params; on: number }; styling?: boolean;
  /** Shows the section only when this holds. */
  when?: (p: Params) => boolean;
  /** Opens the section initially when this holds (instead of `collapsed`). */
  openWhen?: (p: Params) => boolean;
  effects?: Effect[];
}

const GLYPH: Style[] = ['characters', 'cross', 'diagonal', 'dots', 'lines'];
const SHAPES: Style[] = ['cross', 'diagonal', 'dots', 'lines'];

/** Builds select options from an enum, with a short explanation per value. */
const opts = <T extends string>(values: readonly T[], hints: Partial<Record<T, string>> = {}): Option[] =>
  values.map((v) => ({ value: v, label: v, hint: hints[v] }));

const EFFECTS: Effect[] = [
  { label: 'Scanlines', key: 'scanlines', on: 0.4, fields: [{ key: 'scanlines', label: 'Strength' }, { key: 'scanlineSpacing', label: 'Line spacing' }] },
  { label: 'Color fringe', hint: 'Chromatic aberration: splits red and blue toward the edges.', key: 'chromatic', on: 1.5, fields: [{ key: 'chromatic', label: 'Strength' }] },
  { label: 'Grain', key: 'grain', on: 0.05, fields: [{ key: 'grain', label: 'Strength' }] },
  { label: 'Final blur', hint: 'Blurs the finished image, glyphs and all.', key: 'blur', on: 1.5, fields: [{ key: 'blur', label: 'Strength' }] },
];

const GROUPS: Group[] = [
  {
    title: 'Glyphs', styling: true, fields: [
      {
        key: 'coverage', label: 'Coverage', kind: 'select', styles: GLYPH,
        options: opts(COVERAGES, { highlights: 'Glyphs only on bright parts, over the photo', full: 'Every cell becomes a glyph, like classic ASCII art' }),
        // Full coverage hides the photo underneath so only glyphs remain; going back restores it.
        also: (v, base) => ({ bgOpacity: v === 'full' ? 0 : base.coverage === 'full' ? DEFAULTS.bgOpacity : base.bgOpacity }),
      },
      // With full coverage the photo is hidden, so the color behind the glyphs belongs up here with the look itself.
      { key: 'bgColor', label: 'Background color', hint: 'Shows between and behind the glyphs.', kind: 'color', styles: GLYPH, when: (p) => p.coverage === 'full' },
      { key: 'cellSize', label: 'Size', styles: GLYPH, hint: 'Height of each glyph cell. Smaller means more, finer glyphs.' },
      { key: 'charset', label: 'Characters', hint: 'Used from dark to bright, left to right. Pick a set or type your own.', kind: 'text', styles: ['characters'], library: CHARSETS },
      {
        key: 'diagonalMode', label: 'Direction', kind: 'select', styles: ['diagonal'],
        options: opts(DIAGONAL_MODES, { edge: 'Strokes follow the contours of the image', forward: 'All "/"', backward: 'All "\\"', mixed: 'Random mix of both' }),
      },
      { key: 'strokeWidth', label: 'Stroke width', hint: 'Line thickness, as a share of the cell size.', styles: ['cross', 'diagonal', 'lines'] },
      { key: 'sizeByBrightness', label: 'Grow with light', hint: 'Brighter cells get bigger marks.', kind: 'check', styles: SHAPES },
      {
        key: 'threshold', key2: 'thresholdHigh', kind: 'band', label: 'Threshold', styles: GLYPH, when: (p) => p.coverage !== 'full',
        hint: (p) => ({
          absolute: 'Cells darker than the lower end get no glyph. Raise it to keep glyphs to the highlights. Lower the upper end to leave the brightest parts bare too, e.g. glyphs around a bright subject.',
          relative: 'Shares of the image by brightness. 0.7 – 1 puts glyphs on the brightest 30%; 0 – 0.8 on everything but the brightest 20%.',
          local: 'How much brighter than its surroundings a cell must be to get a glyph. Lower the upper end to leave spots that stand out most bare.',
        })[p.highlightMode],
      },
      {
        key: 'highlightMode', label: 'Bright means', kind: 'select', styles: GLYPH, more: true, when: (p) => p.coverage !== 'full',
        options: opts(HIGHLIGHT_MODES, {
          absolute: 'Brighter than the threshold, the same for every photo',
          relative: 'Among the brightest parts of this photo. Threshold = share of the image left bare',
          local: 'Brighter than its surroundings, so even bright areas like sky stay bare',
        }),
        // Relative thresholds are a share of cells, so the absolute default would cover most of the image.
        also: (v, base) => (v === 'relative' ? { threshold: 0.7 } : { threshold: base.threshold }),
      },
      { key: 'localRadius', label: 'Surroundings', styles: GLYPH, more: true, hint: 'How large an area each cell is compared against.', when: (p) => p.coverage !== 'full' && p.highlightMode === 'local' },
      { key: 'thresholdSoftness', label: 'Fade', styles: GLYPH, more: true, hint: 'How gradually glyphs appear above the lower end of the threshold (and fade out above the upper end).', when: (p) => p.coverage !== 'full' },
      { key: 'ditherAlgo', label: 'Algorithm', kind: 'select', options: opts(DITHER_ALGOS), styles: ['dither'] },
      { key: 'palette', label: 'Palette', kind: 'select', options: opts(PALETTE_NAMES, { auto: 'Colors picked from the image', source: 'Image colors, reduced per channel' }), styles: ['dither'] },
      { key: 'ditherLevels', label: 'Colors', hint: 'Palette size for auto, levels per channel for source.', styles: ['dither'] },
      { key: 'pixelSize', label: 'Pixel size', styles: ['dither'] },
      { key: 'ditherSpread', label: 'Strength', more: true, hint: 'How far errors spread to neighbors (diffusion algorithms).', styles: ['dither'] },
    ],
  },
  {
    title: 'Glyph color', styles: GLYPH, collapsed: true, fields: [
      { key: 'colorMode', label: 'Color', kind: 'select', options: opts(COLOR_MODES, { source: 'Each glyph takes the photo color under it', mono: 'One color for every glyph' }) },
      { key: 'monoColor', label: 'Mono color', kind: 'color', when: (p) => p.colorMode === 'mono' },
      { key: 'glyphTint', label: 'Whiten', hint: 'Mixes glyph colors toward white.' },
      { key: 'glyphBoost', label: 'Brightness', hint: 'Multiplies glyph brightness.' },
      { key: 'glyphOpacity', label: 'Opacity' },
      { key: 'glyphBlur', label: 'Glyph softness', hint: 'Blurs the glyphs only.' },
    ],
  },
  {
    title: 'Background', styles: [...GLYPH, 'photo'], fields: [
      { key: 'bgColor', label: 'Background color', hint: 'What the photo fades into as opacity drops. At opacity 0 it is the whole background.', kind: 'color', when: (p) => p.style === 'photo' || p.coverage !== 'full' },
      { key: 'bgOpacity', label: 'Photo opacity', hint: 'How much of the photo shows behind the glyphs. 0 leaves only the background color.' },
      { key: 'bgBlur', label: 'Photo blur', hint: 'Blurs the photo. 0 keeps it sharp.' },
    ],
  },
  {
    title: 'Around glyphs', styles: GLYPH, when: (p) => p.coverage !== 'full', openWhen: (p) => p.haloTone !== 0 || p.haloBlur > 0, fields: [
      { key: 'haloTone', label: 'Darken / brighten', centered: true, hint: 'Changes the photo only around the glyphs. Left of 0 darkens it toward the background color, so the glyphs stand out; right of 0 brightens it in its own colors.' },
      { key: 'haloBlur', label: 'Blur', hint: 'Softens the photo only around the glyphs. Pair with Photo blur at 0 for a sharp photo with soft glyph areas.' },
      { key: 'haloRadius', label: 'Spread', more: true, hint: 'How far around the glyphs the darkening or brightening and the blur reach, in cells.', when: (p) => p.haloTone !== 0 || p.haloBlur > 0 },
    ],
  },
  {
    title: 'Bloom', switch: { key: 'bloom', on: 0.6 }, fields: [
      { key: 'bloom', label: 'Strength', hint: 'Light bleeding around bright glyphs or pixels.' },
      { key: 'bloomRadius', label: 'Radius' },
      { key: 'bloomThreshold', label: 'Bloom from', hint: 'Only parts brighter than this bloom.' },
    ],
  },
  {
    title: 'Vignette', switch: { key: 'vignette', on: 0.1 }, fields: [
      { key: 'vignette', label: 'Strength', hint: 'Darkens toward the edges.' },
      { key: 'vignetteSize', label: 'Size', hint: 'How far the undarkened center reaches. Larger keeps more of the image clear.' },
      { key: 'vignetteX', label: 'Center', kind: 'point' },
    ],
  },
  { title: 'Effects', fields: [], effects: EFFECTS, openWhen: (p) => EFFECTS.some((e) => (p[e.key] as number) > 0) },
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
  characters: '@#a', cross: '+×+', diagonal: '/\\/', dots: '•●•', lines: '│|│', dither: '▚▞▚', photo: '▢▢▢',
};

type Set = (patch: Partial<Params>) => void;

const FieldControl = memo(function FieldControl({ f, hint, value, set, base, baseParams }: { f: Field; hint?: string; value: Params[keyof Params]; set: Set; base: Params[keyof Params]; baseParams: Params }) {
  const kind: Kind = f.kind ?? (typeof DEFAULTS[f.key] === 'boolean' ? 'check' : 'range');
  const put = (v: unknown) => set({ ...f.also?.(v, baseParams), [f.key]: v } as Partial<Params>);
  const modified = value !== base;
  const reset = () => put(base);
  if (kind === 'range') {
    const [min, max, step] = RANGES[f.key] ?? [0, 1, 0.01];
    return <SliderField label={f.label} hint={hint} modified={modified} value={value as number} min={min} max={max} step={step} origin={f.centered ? 0 : undefined} onChange={put} onReset={reset} />;
  }
  const row = { label: f.label, hint, modified, onReset: reset };
  if (kind === 'select') {
    // Keep a value that isn't in the list (e.g. a custom palette) selectable.
    const options = f.options!.some((o) => o.value === value) ? f.options! : [{ value: value as string, label: value as string }, ...f.options!];
    return <Row {...row}><Select label={f.label} value={value as string} options={options} onChange={put} /></Row>;
  }
  if (kind === 'check') return <Row {...row}><Switch label={f.label} checked={value as boolean} onChange={put} /></Row>;
  if (kind === 'color') return <Row {...row}><ColorField label={f.label} value={value as string} onChange={put} /></Row>;
  if (f.library) {
    const named = Object.entries(f.library).find(([, item]) => item.chars === value)?.[0] ?? 'custom';
    const options = [
      ...Object.entries(f.library).map(([name, item]) => ({ value: name, label: name, hint: `${item.chars.trim().slice(0, 24)} · ${item.description}` })),
      { value: 'custom', label: 'custom', hint: 'Your own characters, typed below' },
    ];
    return (
      <div className="py-1.5">
        <Row {...row}>
          <Select label={`${f.label} set`} value={named} options={options} onChange={(name) => { if (name !== 'custom') put(f.library![name].chars); }} />
        </Row>
        <TextField label={f.label} value={value as string} onChange={put} mono />
      </div>
    );
  }
  return (
    <div className="py-1.5">
      <div className="mb-1.5 flex items-center justify-between"><Label text={f.label} hint={hint} modified={modified} onReset={reset} /></div>
      <TextField label={f.label} value={value as string} onChange={put} mono />
    </div>
  );
});

function StylePicker({ style, onChange }: { style: Style; onChange: (s: Style) => void }) {
  return (
    <div role="radiogroup" aria-label="Style" className="grid grid-cols-3 gap-1.5 pt-1 pb-2">
      {STYLES.filter((s) => s !== 'photo').map((s) => (
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
          <span className="text-[11px] capitalize">{s === 'characters' ? 'ASCII' : s}</span>
        </button>
      ))}
    </div>
  );
}

/** A low..high pair of params on one two-thumb slider. */
function BandField({ f, hint, params, base, set }: { f: Field; hint?: string; params: Params; base: Params; set: Set }) {
  const lo = f.key, hi = f.key2!;
  const [min, max, step] = RANGES[lo] ?? [0, 1, 0.01];
  const value: [number, number] = [params[lo] as number, params[hi] as number];
  const modified = value[0] !== base[lo] || value[1] !== base[hi];
  return (
    <RangeField label={f.label} hint={hint} modified={modified} value={value} min={min} max={max} step={step} ends={['low', 'high']}
      onChange={([a, b]) => set({ [lo]: a, [hi]: b } as Partial<Params>)} onReset={() => set({ [lo]: base[lo], [hi]: base[hi] } as Partial<Params>)} />
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

/** One switchable effect: its name and switch, and its settings while it's on. */
function EffectRow({ e, params, base, set, toggle }: { e: Effect; params: Params; base: Params; set: Set; toggle: (v: boolean) => void }) {
  const on = (params[e.key] as number) > 0;
  return (
    <div>
      <Row label={e.label} hint={e.hint}><Switch label={e.label} checked={on} onChange={toggle} /></Row>
      {on && (
        <div className="mb-1 ml-1 border-l border-line pl-3">
          {e.fields.map((f) => <FieldControl key={f.key} f={f} hint={typeof f.hint === 'function' ? f.hint(params) : f.hint} value={params[f.key]} base={base[f.key]} baseParams={base} set={set} />)}
        </div>
      )}
    </div>
  );
}

export function Inspector({ params, base, set, picking, onPicking, resetKey }: {
  params: Params; base: Params; set: Set; picking: boolean; onPicking: (v: boolean) => void;
  /** Changes when a preset is applied, so sections re-open or collapse to match it. */
  resetKey: string;
}) {
  // Values from before a switch was turned off, restored when it's turned back on.
  const last = useRef<Partial<Record<keyof Params, unknown>>>({});
  // Sections showing their less-used settings.
  const [more, setMore] = useState<Record<string, boolean>>({});
  const switchFor = (key: keyof Params, on: number) => (v: boolean) => {
    if (!v) last.current[key] = params[key];
    set({ [key]: v ? (last.current[key] as number) || (base[key] as number) || on : 0 });
  };
  const control = (f: Field) => f.kind === 'point'
    ? <PointField key={f.key} label={f.label} params={params} base={base} set={set} picking={picking} onPicking={onPicking} />
    : f.kind === 'band'
    ? <BandField key={f.key} f={f} hint={typeof f.hint === 'function' ? f.hint(params) : f.hint} params={params} base={base} set={set} />
    : <FieldControl key={f.key} f={f} hint={typeof f.hint === 'function' ? f.hint(params) : f.hint} value={params[f.key]} base={base[f.key]} baseParams={base} set={set} />;
  const changed = (f: Field) => params[f.key] !== base[f.key] || (!!f.key2 && params[f.key2] !== base[f.key2]);
  const fieldsOf = (g: Group) => {
    const shown = g.fields.filter((f) => (!f.styles || f.styles.includes(params.style)) && (!f.when || f.when(params)));
    // Less-used settings stay hidden unless asked for, or changed from the preset so nothing changed is ever hidden.
    const hidden = more[g.title] ? [] : shown.filter((f) => f.more && !changed(f));
    const extra = shown.filter((f) => f.more).length;
    return (
      <>
        {shown.filter((f) => !hidden.includes(f)).map(control)}
        {extra > 0 && (hidden.length > 0 || more[g.title]) && (
          <button
            className="mt-0.5 rounded px-1 py-0.5 text-[11px] text-faint outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-expanded={!!more[g.title]} onClick={() => setMore((m) => ({ ...m, [g.title]: !m[g.title] }))}
          >
            {more[g.title] ? 'Fewer options' : `More options (${hidden.length})`}
          </button>
        )}
      </>
    );
  };
  return (
    <>
      {GROUPS.filter((g) => (!g.styles || g.styles.includes(params.style)) && (!g.when || g.when(params))).map((g) => {
        let toggle: { on: boolean; onChange: (v: boolean) => void } | undefined;
        if (g.styling) {
          toggle = {
            on: params.style !== 'photo',
            onChange: (v) => {
              if (!v) last.current.style = params.style;
              set({ style: v ? (last.current.style as Style | undefined) ?? (base.style !== 'photo' ? base.style : 'characters') : 'photo' });
            },
          };
        } else if (g.switch) {
          toggle = { on: (params[g.switch.key] as number) > 0, onChange: switchFor(g.switch.key, g.switch.on) };
        }
        const open = toggle ? toggle.on : g.openWhen ? g.openWhen(params) : !g.collapsed;
        return (
          <Section key={`${g.title}|${resetKey}`} title={g.title} defaultOpen={open} toggle={toggle}>
            {g.styling && <StylePicker style={params.style} onChange={(st) => set({ style: st })} />}
            {fieldsOf(g)}
            {g.effects?.map((e) => <EffectRow key={e.key} e={e} params={params} base={base} set={set} toggle={switchFor(e.key, e.on)} />)}
          </Section>
        );
      })}
    </>
  );
}
