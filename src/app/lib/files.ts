import { zipSync } from 'fflate';

export const extensionOf = (mime: string) => mime.split('/')[1].replace('jpeg', 'jpg');

export const stem = (name: string) => name.replace(/\.[^.]+$/, '');

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Store-only: exported images and videos are already compressed. */
export async function zip(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.name] = new Uint8Array(await f.blob.arrayBuffer());
  return new Blob([zipSync(entries, { level: 0 }) as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}

/** Appends -2, -3… to names already taken. */
export function uniqueName(name: string, taken: Set<string>): string {
  let out = name;
  for (let k = 2; taken.has(out); k++) out = name.replace(/(\.\w+)$/, `-${k}$1`);
  taken.add(out);
  return out;
}
