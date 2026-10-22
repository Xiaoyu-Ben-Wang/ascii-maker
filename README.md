# ascii-maker

Turn photos into ASCII, cross-stitch, hatching, halftone and dithered art, with bloom, scanlines and film effects. Everything is algorithmic image processing: no AI or generative models. One engine (`src/engine/`) powers a browser editor and a Node CLI.

**[Open the editor →](https://xiaoyu-ben-wang.github.io/ascii-maker/)** (runs entirely in your browser; images never leave your machine)

| Original | `soft-ascii` |
| --- | --- |
| ![Jellyfish photo](public/examples/jellyfish.jpg) | ![Jellyfish rendered as glowing ASCII](public/examples/jellyfish-soft-ascii.jpg) |

| `cross` | `diagonal` | `dither-scanline` |
| --- | --- | --- |
| ![cross](public/examples/jellyfish-cross.jpg) | ![diagonal](public/examples/jellyfish-diagonal.jpg) | ![dither-scanline](public/examples/jellyfish-dither-scanline.jpg) |
| ![planet, cross](public/examples/planet-cross.jpg) | ![clouds, diagonal](public/examples/clouds-diagonal.jpg) | ![orbs, gameboy-dither](public/examples/orbs-gameboy-dither.jpg) |
| `cross` | `diagonal` | `gameboy-dither` |

The planet, clouds and orbs scenes are procedural (`src/samples/scenes.ts`). Regenerate every example with `node scripts/examples.ts --photo your-photo.jpg`.

## Browser editor

```bash
pnpm install
pnpm dev
```

- Open, drop or paste (`Ctrl+V`) one image or many. All loaded images share the same settings: switch between **Single** and **All** (`G`) to see one image large or the whole batch rendered side by side, and jump between images with the filmstrip or `←` / `→`.
- Rendering runs in Web Workers: a half-resolution draft while you drag, then the full preview once you stop. Grid thumbnails render in parallel, only when visible, at the size they're shown.
- Export one image or the whole batch as a `.zip` (PNG, JPEG or WebP) at the original resolution, or with the long edge at 1080p (1920), 2K (2560) or 4K (3840).
- The export options menu has **Copy CLI command** and **Save params JSON**, which carry the current look over to the CLI.

Hover a control's label for what it does; a dot and a reset arrow mark values changed from the preset.

Shortcuts: `Ctrl+O` open, `Ctrl+S` export, `Ctrl+Shift+S` export all, `Ctrl+Z` / `Ctrl+Shift+Z` undo / redo, `\` before/after split, hold `B` to see the original, `G` grid. Double-click a slider label to reset it to the preset value.

Built with React, [Radix UI](https://www.radix-ui.com/) primitives and Tailwind CSS. Deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`.

## CLI

```bash
node cli/ascii-maker.ts photo.jpg -p soft-ascii -o out.png
node cli/ascii-maker.ts photo.jpg -p dither-scanline --dither-algo atkinson --palette pico8 -o out.png
node cli/ascii-maker.ts photo.jpg --style cross --cell-size 18 --bloom 0.8 --size 4k -o out.jpg
node cli/ascii-maker.ts photos/*.jpg -p diagonal --size 1080p -o out/     # batch into a folder
node cli/ascii-maker.ts clip.mp4 -p soft-ascii --size 1080p -o clip-ascii.mp4
node cli/ascii-maker.ts photo.jpg -c params.json --text out.txt -o out.png --json
node cli/ascii-maker.ts --list        # presets, styles, dither algorithms, palettes
node cli/ascii-maker.ts --help        # every param flag with its range and default
```

Requires Node 23.6+ (it runs the TypeScript directly). Settings apply in this order: defaults → `--preset` → `--config` JSON → individual flags. `--json` prints a machine-readable summary per image, and `--dump-params` prints the resolved params without rendering. Out-of-range or unknown values fail with a clear error, which makes it easy for scripts and agents to drive.

### Video

Video inputs (`.mp4 .mov .mkv .webm .avi .m4v .gif`) are decoded with ffmpeg (on `PATH` or `FFMPEG_PATH`), rendered on all CPU cores, and encoded to mp4 (H.264), webm (VP9) or gif, keeping the audio. Flags: `--fps`, `--start`, `-t/--duration`, `--crf`, `--threads`, `--no-audio`. Film grain animates per frame, and the `auto` dither palette is locked from the first frame so colors don't flicker.

A 30 s 1080p clip (900 frames) takes about 32 s for `soft-ascii` and 34 s for `dither-scanline` on a Ryzen 7 9800X3D. The browser engine renders the same frames at 43–50 frames/s with 14 workers (about 20 s for 30 s of video) or 25–29 frames/s with 6. The editor doesn't decode or encode video yet.

## Styles

| Style | What it draws |
| --- | --- |
| `characters` | Character ramp (`--charset`) by brightness. Pick a ready-made set by name (`standard`, `classic`, `detailed`, `letters`, `blocks`, `braille`, `dots`, `binary`; see `--list`) or pass your own characters, dark to bright |
| `cross` | `+` on bright cells, small `×` on faint ones, sized by brightness |
| `diagonal` | `/` `\` strokes. `edge` follows contours, `forward` / `backward` hatch in parallel, `mixed` is random |
| `dots` | Halftone circles |
| `lines` | Vertical strokes |
| `dither` | Palette quantization: Floyd–Steinberg, Atkinson, Jarvis, Stucki, Burkes, Sierra (3 variants), Bayer 2/4/8/16, clustered-dot halftone, interleaved-gradient noise, line patterns, random noise |
| `photo` | No glyphs: just the background image (`--bg-opacity`, `--bg-blur`, `--bg-color` apply) with the adjustments and post effects (e.g. the `scanlines` preset) |

Glyph styles draw over a softened copy of the source (`--bg-blur`, and `--bg-opacity` to fade it toward `--bg-color`) and only on cells brighter than `--threshold`. On bright photos an absolute threshold can put glyphs everywhere, so `--highlight-mode` changes what counts as bright: `absolute` (default) compares luminance with the threshold, `relative` ranks cells within the image so the threshold is the share left bare (`0.7` = glyphs on the brightest 30%), and `local` compares each cell with its surroundings (`--local-radius`), so flat bright areas like sky stay bare. None of them darken the image. Set `--coverage full` to convert the whole image instead (every cell gets a glyph, threshold ignored); pair it with `--bg-opacity 0` for classic ASCII art, as the `full-ascii` and `full-cross` presets do. Palettes: `auto` (k-means colors picked from the image, count = `--dither-levels`), `source` (per-channel levels), named retro palettes, or a list like `--palette "#000,#f0f,#0ff"`.

Blur has three levels: `--bg-blur` (the background under the glyphs), `--glyph-blur` (the glyphs only) and `--blur` (the finished image, any style).

Post effects, in order: overall blur, bloom (glyph-layer glow for glyph styles, highlight glow for dither), chromatic aberration, scanlines, vignette, grain.

Pixel-sized params (cell size, blur, bloom radius, scanline spacing, …) are measured on a 1920 px-wide image and scale with the output, so a 4K export looks like the preview, only sharper. Set `--unit-width 0` to use absolute pixels.

## Development

```bash
pnpm test        # node:test suite (engine, zip, CLI)
pnpm typecheck
pnpm bench out/photo.jpg   # preview-size render timings per preset
pnpm build       # static site in dist/
```
