/**
 * Generates the desktop icons from the same mark the web app uses.
 *
 * Tauri needs PNG and ICO; the web app has an SVG. Rather than add an image
 * library to convert between them, the shape is drawn here directly — it is a
 * rounded square and a three-point check, which is about forty lines of
 * arithmetic — and encoded with the zlib that ships with Node.
 *
 * The point is that there is one definition of the mark. Change `draw` and
 * `apps/web/public/icon.svg` together, and run:
 *
 *     node apps/desktop/scripts/make-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

/** Matches --accent in the web app's stylesheet. */
const BRAND = [0x1f, 0x5f, 0x8b];
const WHITE = [0xff, 0xff, 0xff];

/** The viewBox the SVG is drawn in, so the two cannot drift. */
const VIEW = 512;
const RADIUS = 112;
const CHECK = [
  [148, 264],
  [220, 336],
  [364, 176],
];
const STROKE = 48;

/** Distance from a point to a line segment. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Inside the rounded square? Coordinates are in the 512 viewBox. */
function insideRoundedSquare(x, y) {
  const near = (v) => Math.min(v, VIEW - v);
  const dx = near(x);
  const dy = near(y);
  if (dx >= RADIUS || dy >= RADIUS) return dx >= 0 && dy >= 0;
  return Math.hypot(RADIUS - dx, RADIUS - dy) <= RADIUS;
}

function onCheck(x, y) {
  const half = STROKE / 2;
  for (let i = 0; i < CHECK.length - 1; i += 1) {
    const [ax, ay] = CHECK[i];
    const [bx, by] = CHECK[i + 1];
    // Round caps and joins fall out of a plain distance test.
    if (distanceToSegment(x, y, ax, ay, bx, by) <= half) return true;
  }
  return false;
}

/**
 * Renders at `size`, supersampled 4x4.
 *
 * `maskable` bleeds the background to the edges and shrinks the mark, because
 * a launcher crops an installed icon to its own shape and only the middle 80%
 * survives.
 */
function draw(size, { maskable = false } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = 4;
  const scale = VIEW / size;
  const inset = maskable ? 0.82 : 1;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let background = 0;
      let mark = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const vx = (x + (sx + 0.5) / samples) * scale;
          const vy = (y + (sy + 0.5) / samples) * scale;

          if (maskable ? true : insideRoundedSquare(vx, vy)) background += 1;

          // Scale the mark about the centre for the maskable variant.
          const mx = (vx - VIEW / 2) / inset + VIEW / 2;
          const my = (vy - VIEW / 2) / inset + VIEW / 2;
          if (onCheck(mx, my)) mark += 1;
        }
      }

      const total = samples * samples;
      const alpha = background / total;
      const white = mark / total;

      const offset = (y * size + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        pixels[offset + c] = Math.round(BRAND[c] * (1 - white) + WHITE[c] * white);
      }
      pixels[offset + 3] = Math.round(255 * Math.max(alpha, white));
    }
  }

  return pixels;
}

// --------------------------------------------------------------------- PNG --

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  // 10..12 are compression, filter and interlace: all zero, all the only
  // values PNG defines.

  // Each scanline is prefixed with its filter type. 0 is "none" — the images
  // are tiny and zlib does the work.
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------------- ICO --

/**
 * ICO has embedded PNGs since Vista, so the entries are the same bytes as the
 * files beside them rather than a second encoder for BMP.
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];

  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    // 256 is written as 0 — the field is one byte.
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette size
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

// -------------------------------------------------------------------- write --

mkdirSync(OUT, { recursive: true });

const PNG_SIZES = [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
];

for (const [name, size] of PNG_SIZES) {
  writeFileSync(join(OUT, name), encodePng(size, draw(size)));
  console.log(`  ${name}`);
}

// Windows picks the size it wants out of the one file.
const icoSizes = [16, 32, 48, 64, 128, 256];
writeFileSync(
  join(OUT, "icon.ico"),
  encodeIco(icoSizes.map((size) => ({ size, png: encodePng(size, draw(size)) }))),
);
console.log("  icon.ico");

// Not used by Tauri, but keeps the Android/maskable shape in one place.
writeFileSync(
  join(OUT, "icon-maskable.png"),
  encodePng(512, draw(512, { maskable: true })),
);
console.log("  icon-maskable.png");
