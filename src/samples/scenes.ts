// Procedural demo scenes drawn with the Canvas 2D API (works with OffscreenCanvas and @napi-rs/canvas).

interface Ctx {
  fillStyle: unknown; strokeStyle: unknown; lineWidth: number; globalCompositeOperation: string; filter?: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; stroke(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void; fill(): void; save(): void; restore(): void; clip(): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): { addColorStop(o: number, c: string): void };
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): { addColorStop(o: number, c: string): void };
}

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function glow(ctx: Ctx, x: number, y: number, r: number, stops: [number, string][]) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

/** A glowing planet limb with swirling bands. */
export function drawPlanet(ctx: Ctx, width: number, height: number) {
  const rand = rng(7);
  ctx.fillStyle = '#05040a';
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.2 + rand() * 0.6})`;
    ctx.fillRect(rand() * width, rand() * height, rand() * 2 + 0.5, rand() * 2 + 0.5);
  }
  const cx = width * -0.05, cy = height * 1.25, r = width * 0.78;
  const halo = ctx.createRadialGradient(cx, cy, r * 0.96, cx, cy, r * 1.12);
  halo.addColorStop(0, 'rgba(120,200,255,0.9)');
  halo.addColorStop(0.35, 'rgba(255,80,170,0.45)');
  halo.addColorStop(1, 'rgba(255,80,170,0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(cx, cy, r * 1.12, 0, Math.PI * 2); ctx.fill();

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
  const body = ctx.createLinearGradient(0, cy - r, width, cy);
  body.addColorStop(0, '#ff3d8b');
  body.addColorStop(0.45, '#5b2bd1');
  body.addColorStop(1, '#0a1a5c');
  ctx.fillStyle = body;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'lighter';
  for (let b = 0; b < 46; b++) {
    const off = (b * 26 + rand() * 12) * (width / 1920);
    ctx.strokeStyle = `rgba(${150 + rand() * 105},${120 + rand() * 80},255,${0.05 + rand() * 0.12})`;
    ctx.lineWidth = (3 + rand() * 14) * (width / 1920);
    ctx.beginPath();
    for (let x = 0; x <= width; x += 16) {
      const u = x / width * 1920;
      const y = cy - r + off + (Math.sin(u / 140 + b) * 22 + Math.sin(u / 47 + b * 3) * 7) * (width / 1920) + x * 0.42;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();

  ctx.globalCompositeOperation = 'lighter';
  const rim = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 1.01);
  rim.addColorStop(0, 'rgba(255,255,255,0)');
  rim.addColorStop(0.85, 'rgba(255,190,230,0.35)');
  rim.addColorStop(1, 'rgba(220,250,255,0.95)');
  ctx.fillStyle = rim;
  ctx.beginPath(); ctx.arc(cx, cy, r * 1.01, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

/** A cumulus cloud at golden hour over a teal-to-orange sky. */
export function drawClouds(ctx: Ctx, width: number, height: number) {
  const rand = rng(11);
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#3e5a63');
  sky.addColorStop(0.45, '#5f8f78');
  sky.addColorStop(0.75, '#c98f62');
  sky.addColorStop(1, '#e0612f');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  const s = width / 1920;
  // Cloud: a dome of overlapping puffs with a flat base, shaded darker below and lit from the right.
  const base = height * 0.74;
  for (let layer = 0; layer < 4; layer++) {
    for (let i = 0; i < 110; i++) {
      const t = rand();
      const x = width * (0.16 + t * 0.7);
      const dome = Math.pow(Math.sin(t * Math.PI), 0.7) * height * (0.36 - layer * 0.03) * (0.75 + rand() * 0.35);
      const y = base - rand() * dome;
      const r = (50 + rand() * 80) * s * (1 - layer * 0.12);
      const up = (base - y) / (height * 0.4); // 0 at the base, ~1 at the top
      const lit = Math.min(1, 0.35 + up * 0.45 + t * 0.3 + layer * 0.06);
      const a = 0.5 + layer * 0.12;
      glow(ctx, x, y, r, [
        [0, `rgba(${Math.round(190 + 65 * lit)},${Math.round(130 + 100 * lit)},${Math.round(135 + 90 * lit)},${a * 0.8})`],
        [0.5, `rgba(${Math.round(170 + 75 * lit)},${Math.round(115 + 90 * lit)},${Math.round(130 + 80 * lit)},${a * 0.6})`],
        [1, 'rgba(190,130,150,0)'],
      ]);
    }
  }
  glow(ctx, width * 0.82, height * 0.9, width * 0.35, [[0, 'rgba(255,170,90,0.45)'], [1, 'rgba(255,120,60,0)']]);
}

/** Soft glowing orbs drifting in deep water (bokeh). */
export function drawOrbs(ctx: Ctx, width: number, height: number) {
  const rand = rng(23);
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#020a2a');
  bg.addColorStop(1, '#03184a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'lighter';
  const s = Math.min(width, height) / 1080;
  for (let i = 0; i < 26; i++) {
    const x = rand() * width, y = rand() * height;
    const near = rand();
    const r = (30 + near * 140) * s;
    const hue = rand() < 0.75 ? [150, 200, 255] : [255, 140, 210];
    glow(ctx, x, y, r, [
      [0, `rgba(255,255,255,${0.5 + near * 0.5})`],
      [0.35, `rgba(${hue[0]},${hue[1]},${hue[2]},${0.35 + near * 0.3})`],
      [1, `rgba(${hue[0]},${hue[1]},${hue[2]},0)`],
    ]);
  }
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(160,200,255,${rand() * 0.5})`;
    ctx.fillRect(rand() * width, rand() * height, 1.5 * s, 1.5 * s);
  }
  ctx.globalCompositeOperation = 'source-over';
}

export const SCENES = { planet: drawPlanet, clouds: drawClouds, orbs: drawOrbs };
