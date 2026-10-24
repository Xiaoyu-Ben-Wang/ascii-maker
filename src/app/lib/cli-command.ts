import { diffParams, paramFlag, type Params, type SizeName } from '../../engine/index.ts';
import type { Img } from '../hooks/useImages.ts';

const quote = (v: unknown) => (typeof v === 'string' && /[^\w#.,-]/.test(v) ? `"${v.replace(/(["\\$`])/g, '\\$1')}"` : String(v));
const inputName = (img: Img | null) => img?.video?.file.name ?? `${img?.name ?? 'input'}.jpg`;

/** The `node cli/ascii-maker.ts` command that reproduces the current look. */
export function cliCommand(params: Params, images: Img[], active: Img | null, size: SizeName, videoFormat: string): string {
  const flags = Object.entries(diffParams(params)).map(([k, v]) => {
    const flag = paramFlag(k);
    return typeof v === 'boolean' ? (v ? `--${flag}` : `--no-${flag}`) : `--${flag}=${quote(v)}`;
  });
  const io = images.length > 1
    ? [...images.map(inputName), '-o', 'out/']
    : [inputName(active), '-o', `${active?.name ?? 'input'}-${params.style}.${active?.video ? videoFormat : 'png'}`];
  return ['node cli/ascii-maker.ts', ...io, ...(size === 'source' ? [] : [`--size ${size}`]), ...flags].join(' ');
}
