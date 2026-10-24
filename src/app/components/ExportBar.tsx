import { Braces, Copy, Download, Settings2, Terminal, X } from 'lucide-react';
import type { Frame } from '../../engine/index.ts';
import { IMAGE_FORMATS, type Exporter } from '../hooks/useExport.ts';
import { VIDEO_FORMATS } from '../lib/video.ts';
import { Button, Popover, Progress, Row, Select, SliderField, Switch, Tip } from './ui.tsx';

const SIZES = [
  { value: 'source' as const, label: 'Original' },
  { value: '1080p' as const, label: '1080p' },
  { value: '2k' as const, label: '2K' },
  { value: '4k' as const, label: '4K' },
];

export function ExportBar({ exporter, grid, count, selectedOnly = false, isVideo, canExport, frame, text, onExport, onExportAll, onCopyText, onCopyCli, onSaveParams }: {
  exporter: Exporter; grid: boolean; count: number; selectedOnly?: boolean; isVideo: boolean; canExport: boolean; frame: Frame | null; text?: string;
  onExport: () => void; onExportAll: () => void; onCopyText: () => void; onCopyCli: () => void; onSaveParams: () => void;
}) {
  const { settings: s, update, encodable, job } = exporter;
  return (
    <div className="flex gap-2 border-t border-line bg-surface p-3 max-md:sticky max-md:bottom-0 max-md:z-20">
      {job ? (
        <>
          <Progress value={job.value} label={job.label} />
          <Tip label="Cancel export" side="top">
            <Button variant="solid" size="icon" className="size-9" aria-label="Cancel export" onClick={exporter.cancel}><X className="size-4" /></Button>
          </Tip>
        </>
      ) : grid ? (
        <Button variant="primary" className="flex-1" disabled={!count} onClick={onExportAll}>
          <Download className="size-4" />{selectedOnly ? `Export ${count} selected` : `Export all ${count}`}
        </Button>
      ) : (
        <Button variant="primary" className="flex-1" disabled={!canExport} onClick={onExport}>
          <Download className="size-4" />{isVideo ? 'Export video' : 'Export'}
        </Button>
      )}
      <Popover trigger={<Button variant="solid" size="icon" aria-label="Export options"><Settings2 className="size-4" /></Button>}>
        <Row label="Size"><Select label="Export size" value={s.size} options={SIZES} onChange={(size) => update({ size })} /></Row>
        <Row label="Format"><Select label="Format" value={s.format} options={IMAGE_FORMATS} onChange={(format) => update({ format })} /></Row>
        {s.format === 'image/png'
          ? <SliderField label="Compression" hint="Lossless either way: higher is smaller but slower to export. JPEG or WebP are far smaller." value={s.pngLevel} min={0} max={9} step={1} onChange={(pngLevel) => update({ pngLevel })} />
          : <SliderField label="Quality" hint="Lower makes smaller files with more compression artifacts." value={s.quality} min={10} max={100} step={1} onChange={(quality) => update({ quality })} />}
        {exporter.hasVideo && (
          <>
            <Row label="Video" hint="Container and codec for exported videos.">
              <Select label="Video format" value={s.videoFormat} onChange={(videoFormat) => update({ videoFormat })}
                options={VIDEO_FORMATS.map((f) => {
                  const off = !!encodable && !encodable.includes(f.value);
                  return { value: f.value, label: f.label, disabled: off, hint: off ? 'This browser cannot encode it' : undefined };
                })} />
            </Row>
            <SliderField label="Video quality" hint="Lower makes smaller video files with more compression artifacts." value={s.videoQuality} min={1} max={100} step={1} onChange={(videoQuality) => update({ videoQuality })} />
            <Row label="Keep audio" hint="Copy the source audio into exported videos, or leave them silent.">
              <Switch label="Keep audio" checked={s.keepAudio} onChange={(keepAudio) => update({ keepAudio })} />
            </Row>
          </>
        )}
        {frame && <div className="pt-1 pb-2 text-right font-mono text-[11px] text-faint">{frame.width} × {frame.height}px</div>}
        <div className="mt-1 grid gap-1 border-t border-line pt-2">
          {count > 1 && (
            <Button size="sm" className="justify-start" disabled={!!job} onClick={onExportAll}>
              <Download className="size-3.5" />Export all (.zip)
            </Button>
          )}
          <Button size="sm" className="justify-start" disabled={!text} onClick={onCopyText}>
            <Copy className="size-3.5" />Copy ASCII text
          </Button>
          <Button size="sm" className="justify-start" onClick={onCopyCli}>
            <Terminal className="size-3.5" />Copy CLI command
          </Button>
          <Button size="sm" className="justify-start" onClick={onSaveParams}>
            <Braces className="size-3.5" />Save params JSON
          </Button>
        </div>
      </Popover>
    </div>
  );
}
