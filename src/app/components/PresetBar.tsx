import { BookmarkPlus, ClipboardPaste, Copy, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { PRESETS } from '../../engine/index.ts';
import { CUSTOM, userPresetName, type Look } from '../hooks/useLook.ts';
import { keyFor } from '../lib/shortcuts.ts';
import { Button, Kbd, Popover, Select, TextField, Tip } from './ui.tsx';

export function PresetBar({ look, onCopy, onPaste }: { look: Look; onCopy?: () => void; onPaste?: () => void }) {
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState('');
  const user = userPresetName(look.preset);
  const description = PRESETS[look.preset]?.description;
  const trimmed = name.trim();

  return (
    <>
      <div className="flex items-center gap-2 px-4 pt-3">
        <Select label="Preset" value={look.preset} options={look.options} onChange={look.apply} className="min-w-0 flex-1" />
        <Popover
          open={saveOpen}
          onOpenChange={(v) => { setSaveOpen(v); if (v) setName(user ?? ''); }}
          trigger={<Button size="icon" aria-label="Save as preset"><BookmarkPlus className="size-3.5" /></Button>}
        >
          <form className="grid gap-2" onSubmit={(e) => {
            e.preventDefault();
            if (!trimmed) return;
            look.savePreset(trimmed);
            setSaveOpen(false);
          }}>
            <div className="text-[12px] text-fg">Save current settings as a preset</div>
            <TextField label="Preset name" value={name} onChange={setName} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-faint">{trimmed in look.userPresets ? 'Overwrites the saved preset' : 'Stored in this browser'}</span>
              <Button type="submit" variant="primary" size="sm" disabled={!trimmed}>Save</Button>
            </div>
          </form>
        </Popover>
        {user !== null && (
          <Tip label="Delete this saved preset">
            <Button size="icon" aria-label="Delete preset" onClick={look.deletePreset}><Trash2 className="size-3.5" /></Button>
          </Tip>
        )}
        <Tip label={<>Copy settings<Kbd>{keyFor('copySettings')}</Kbd></>}>
          <Button size="icon" aria-label="Copy settings" disabled={!onCopy} onClick={onCopy}><Copy className="size-3.5" /></Button>
        </Tip>
        <Tip label={<>Paste settings<Kbd>{keyFor('pasteSettings')}</Kbd></>}>
          <Button size="icon" aria-label="Paste settings" disabled={!onPaste} onClick={onPaste}><ClipboardPaste className="size-3.5" /></Button>
        </Tip>
        <Tip label={look.preset === CUSTOM ? 'Reset everything to defaults' : 'Undo all changes to this preset'}>
          <Button size="icon" aria-label="Reset to preset" disabled={!look.edits} onClick={look.reset}><RotateCcw className="size-3.5" /></Button>
        </Tip>
      </div>
      <p className="line-clamp-2 px-4 pt-1.5 text-[11px] text-faint empty:hidden" title={description}>
        {look.edits > 0 && <span className="text-accent">{look.edits} change{look.edits > 1 ? 's' : ''}</span>}
        {look.edits > 0 && description && ' · '}
        {description}
      </p>
    </>
  );
}
