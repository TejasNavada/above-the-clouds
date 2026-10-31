#!/usr/bin/env node
/*
 * Builds the static app icons from a small procedural scene.
 *
 *   node scripts/build-icons.mjs
 *
 * The icons are pure PNGs written with zlib, so there are no image libraries
 * or native dependencies to install.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const iconDir = path.join(root, "public", "icons");
fs.mkdirSync(iconDir, { recursive: true });

const BASE = 2048;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

function mix(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// ---------------------------------------------------------------------------
// PNG writer
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const body = Buffer.concat([name, data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

function renderBase() {
  const size = BASE;
  const px = new Uint8ClampedArray(size * size * 4);

  function blendAt(x, y, color, alpha) {
    if (alpha <= 0 || x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const a = clamp(alpha, 0, 1);
    px[i] = lerp(px[i], color[0], a);
    px[i + 1] = lerp(px[i + 1], color[1], a);
    px[i + 2] = lerp(px[i + 2], color[2], a);
    px[i + 3] = 255;
  }

  // Sky gradient.
  const top = [5, 9, 20];
  const mid = [12, 23, 47];
  const bottom = [25, 43, 81];
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const color = t < 0.62 ? mix(top, mid, t / 0.62) : mix(mid, bottom, (t - 0.62) / 0.38);
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      px[i] = color[0];
      px[i + 1] = color[1];
      px[i + 2] = color[2];
      px[i + 3] = 255;
    }
  }

  // Sun and its halo.
  const sunX = 0.635;
  const sunY = 0.255;
  const sunR = 0.076;
  for (let y = 0; y < size; y++) {
    const ny = y / size;
    for (let x = 0; x < size; x++) {
      const nx = x / size;
      const d = Math.hypot(nx - sunX, (ny - sunY) * 0.94);
      if (d < sunR * 3.9) {
        const glow = Math.pow(1 - d / (sunR * 3.9), 2.4) * 0.5;
        blendAt(x, y, [255, 156, 104], glow);
      }
      if (d < sunR) {
        const rim = d / sunR;
        const color = mix([255, 232, 198], [255, 178, 126], rim);
        blendAt(x, y, color, 1);
      }
    }
  }

  // Stars in the upper sky, deterministic so every build is identical.
  let seed = 0x1a2b3c4d;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 90; i++) {
    const nx = random();
    const ny = random() * 0.5;
    if (Math.hypot(nx - sunX, ny - sunY) < 0.15) continue;
    const radius = 0.6 + random() * 1.6;
    const alpha = 0.15 + random() * 0.5;
    const cx = nx * size;
    const cy = ny * size;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const dist = Math.hypot(dx, dy);
        if (dist <= radius) blendAt(Math.round(cx + dx), Math.round(cy + dy), [226, 236, 255], alpha * (1 - dist / (radius + 0.5)));
      }
    }
  }

  // Distant ridge, softened by haze.
  const backRidge = [
    [0, 0.78], [0.12, 0.67], [0.24, 0.73], [0.38, 0.62], [0.52, 0.72],
    [0.66, 0.61], [0.8, 0.7], [1, 0.65]
  ];
  function ridgeYAt(points, nx) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (nx >= a[0] && nx <= b[0]) {
        const t = (nx - a[0]) / (b[0] - a[0]);
        return lerp(a[1], b[1], t);
      }
    }
    return points[points.length - 1][1];
  }
  for (let x = 0; x < size; x++) {
    const nx = x / size;
    const ridge = ridgeYAt(backRidge, nx);
    for (let y = Math.floor(ridge * size); y < size; y++) {
      const depth = clamp((y / size - ridge) / 0.3, 0, 1);
      blendAt(x, y, mix([18, 34, 62], [10, 18, 36], depth), 0.92);
    }
  }

  // Marine layer: a bank of soft gaussian blobs just below the summit.
  const blobs = [
    { x: 0.02, y: 0.655, rx: 0.3, ry: 0.055, a: 0.66 },
    { x: 0.26, y: 0.67, rx: 0.27, ry: 0.06, a: 0.78 },
    { x: 0.5, y: 0.685, rx: 0.3, ry: 0.052, a: 0.84 },
    { x: 0.74, y: 0.665, rx: 0.28, ry: 0.06, a: 0.76 },
    { x: 0.97, y: 0.645, rx: 0.26, ry: 0.055, a: 0.64 },
    { x: 0.17, y: 0.715, rx: 0.22, ry: 0.028, a: 0.36 },
    { x: 0.62, y: 0.726, rx: 0.25, ry: 0.026, a: 0.34 }
  ];
  for (let y = 0; y < size; y++) {
    const ny = y / size;
    if (ny < 0.55 || ny > 0.8) continue;
    for (let x = 0; x < size; x++) {
      const nx = x / size;
      let field = 0;
      for (const blob of blobs) {
        const dx = (nx - blob.x) / blob.rx;
        const dy = (ny - blob.y) / blob.ry;
        field += blob.a * Math.exp(-(dx * dx + dy * dy) * 1.7);
      }
      field *= clamp((ny - 0.56) / 0.045, 0, 1);
      if (field > 0.02) {
        const warmth = clamp(1 - Math.abs(nx - sunX) * 2.4, 0, 1) * 0.16;
        const color = mix([200, 218, 248], [255, 228, 208], warmth);
        blendAt(x, y, color, clamp(field, 0, 0.9));
      }
    }
  }

  // Main peak.
  const mainRidge = [
    [0, 0.945], [0.12, 0.855], [0.26, 0.63], [0.38, 0.695],
    [0.46, 0.365], [0.56, 0.655], [0.72, 0.56], [1, 0.91]
  ];
  const peakX = 0.46;
  for (let x = 0; x < size; x++) {
    const nx = x / size;
    const ridge = ridgeYAt(mainRidge, nx);
    const start = Math.floor(ridge * size);
    const lit = clamp((peakX - nx) / 0.4, 0, 1) * 0.5;
    for (let y = start; y < size; y++) {
      const depth = clamp((y / size - ridge) / 0.5, 0, 1);
      const baseColor = mix([8, 15, 31], [5, 10, 21], depth);
      const face = mix(baseColor, [15, 28, 55], lit * (1 - depth * 0.6));
      blendAt(x, y, face, 1);

      // Snow cap: the part of the peak above the snow line, with a soft edge.
      if (y / size < 0.45) {
        const edge = 1 - clamp((Math.abs(nx - peakX) - 0.015) / 0.09, 0, 1);
        const fade = 1 - clamp((y / size - 0.398) / 0.052, 0, 1);
        if (edge > 0 && fade > 0) {
          blendAt(x, y, [218, 231, 252], 0.88 * edge * fade);
        }
      }
    }
    // Rim light along the ridge.
    for (let d = 0; d < 3; d++) {
      const yy = start + d;
      if (yy < size) blendAt(x, yy, [142, 178, 226], 0.38 - d * 0.1);
    }
  }

  // Foreground ridge, almost black.
  const frontRidge = [
    [0, 0.925], [0.14, 0.885], [0.32, 0.925], [0.5, 0.895],
    [0.68, 0.94], [0.86, 0.9], [1, 0.925]
  ];
  for (let x = 0; x < size; x++) {
    const nx = x / size;
    const ridge = ridgeYAt(frontRidge, nx);
    const start = Math.floor(ridge * size);
    for (let y = start; y < size; y++) {
      const depth = clamp((y / size - ridge) / 0.1, 0, 1);
      blendAt(x, y, mix([7, 13, 27], [3, 6, 14], depth), 1);
    }
    for (let d = 0; d < 2; d++) {
      const yy = start + d;
      if (yy < size) blendAt(x, yy, [52, 77, 117], 0.3);
    }
  }

  return px;
}

function downsample(source, sourceSize, targetSize) {
  const out = new Uint8ClampedArray(targetSize * targetSize * 4);
  const factor = sourceSize / targetSize;
  const samples = factor * factor;

  for (let y = 0; y < targetSize; y++) {
    const y0 = Math.floor(y * factor);
    const y1 = Math.min(sourceSize, Math.floor((y + 1) * factor));
    for (let x = 0; x < targetSize; x++) {
      const x0 = Math.floor(x * factor);
      const x1 = Math.min(sourceSize, Math.floor((x + 1) * factor));
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * sourceSize + sx) * 4;
          r += source[i];
          g += source[i + 1];
          b += source[i + 2];
          a += source[i + 3];
          count++;
        }
      }
      const o = (y * targetSize + x) * 4;
      out[o] = r / count;
      out[o + 1] = g / count;
      out[o + 2] = b / count;
      out[o + 3] = a / count;
    }
  }
  return out;
}

const base = renderBase();

const outputs = [
  ["icon-512.png", 512],
  ["icon-192.png", 192],
  ["apple-touch-icon.png", 180],
  ["icon-maskable-512.png", 512]
];

for (const [file, size] of outputs) {
  const pixels = size === BASE ? base : downsample(base, BASE, size);
  fs.writeFileSync(path.join(iconDir, file), encodePng(size, size, pixels));
  console.log(`Wrote public/icons/${file} (${size}x${size})`);
}

// A crisp vector favicon for browser tabs.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#070b18"/>
      <stop offset="1" stop-color="#1b2e55"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#sky)"/>
  <circle cx="32" cy="18" r="5.6" fill="#ffc69c"/>
  <g fill="#d7e3ff" opacity=".82">
    <ellipse cx="18" cy="42" rx="13" ry="4.6"/>
    <ellipse cx="34" cy="44" rx="16" ry="4.2"/>
    <ellipse cx="50" cy="41" rx="12" ry="4.4"/>
  </g>
  <path d="M8 56 25 34l6 7.5L38 24l18 32H8Z" fill="#0a1326"/>
  <path d="m35 28.5 3-4.5 9 14-7-3-5 3.5 2.5-6Z" fill="#dce8ff"/>
</svg>
`;
fs.writeFileSync(path.join(iconDir, "favicon.svg"), favicon);
console.log("Wrote public/icons/favicon.svg");
