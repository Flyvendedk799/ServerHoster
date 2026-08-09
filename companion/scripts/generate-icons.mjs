#!/usr/bin/env node
/**
 * Generate the PWA icons into public/.
 *
 * Written by hand against node:zlib rather than pulled from an image library:
 * the icon is four rectangles and a gradient, the output has to be committed
 * (a manifest that 404s is a PWA that won't install), and a build-time
 * dependency that produces a checked-in file is a dependency you carry forever
 * for one afternoon's use.
 *
 *   node scripts/generate-icons.mjs
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "public");

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** RGBA pixel buffer → PNG bytes. */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  // One filter byte (0 = None) per scanline, as the PNG spec requires.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

/**
 * The mark: three stacked "service" bars on the product's blue→teal gradient.
 * `padding` is the fraction of the canvas kept clear — maskable icons get a
 * bigger safe zone because the platform crops them to its own shape.
 */
function drawIcon(size, { padding, rounded }) {
  const rgba = Buffer.alloc(size * size * 4);
  const from = [37, 99, 235];
  const to = [20, 184, 166];
  const radius = rounded ? size * 0.22 : 0;

  const inset = size * padding;
  const barLeft = inset;
  const barRight = size - inset;
  const barCount = 3;
  const gap = (size - inset * 2) * 0.11;
  const barHeight = (size - inset * 2 - gap * (barCount - 1)) / barCount;

  const insideRounded = (x, y) => {
    if (!rounded) return true;
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      if (!insideRounded(x + 0.5, y + 0.5)) {
        rgba[offset + 3] = 0;
        continue;
      }
      const [r, g, b] = mix(from, to, (x / size) * 0.5 + (y / size) * 0.5);
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = 255;

      for (let i = 0; i < barCount; i += 1) {
        const top = inset + i * (barHeight + gap);
        if (x >= barLeft && x < barRight && y >= top && y < top + barHeight) {
          // Bars are the background colour punched through the gradient, with a
          // status dot on the left of each — the same visual language as the
          // service rows in the app.
          rgba[offset] = 7;
          rgba[offset + 1] = 11;
          rgba[offset + 2] = 20;
          const dotCx = barLeft + barHeight * 0.55;
          const dotCy = top + barHeight / 2;
          const dr = barHeight * 0.18;
          if ((x - dotCx) ** 2 + (y - dotCy) ** 2 <= dr * dr) {
            rgba[offset] = 16;
            rgba[offset + 1] = 185;
            rgba[offset + 2] = 129;
          }
        }
      }
    }
  }
  return encodePng(size, size, rgba);
}

fs.mkdirSync(outDir, { recursive: true });
const targets = [
  ["icon-192.png", 192, { padding: 0.2, rounded: true }],
  ["icon-512.png", 512, { padding: 0.2, rounded: true }],
  // Maskable icons are cropped to the platform's shape, so the art has to sit
  // inside a much smaller safe zone and the canvas has to be edge-to-edge.
  ["icon-maskable-512.png", 512, { padding: 0.3, rounded: false }]
];
for (const [name, size, options] of targets) {
  fs.writeFileSync(path.join(outDir, name), drawIcon(size, options));
  process.stdout.write(`wrote ${name}\n`);
}
