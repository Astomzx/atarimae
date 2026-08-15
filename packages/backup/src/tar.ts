/**
 * Just enough tar to hold a backup, written rather than depended on.
 *
 * The archive has to be something an operator can open with tools they already
 * have when this project is not around — `tar tzf` on any machine, at three in
 * the morning, without npm. That rules out a private format. It does not
 * require a tar library: the subset needed here is a fixed-size header and a
 * checksum, and the alternative is a dependency in the one tool whose whole job
 * is to still work when everything else has gone wrong.
 *
 * ustar only, files only. No long names, no symlinks, no sparse files, no
 * extended headers. Everything this archive contains is a manifest, a SQL dump
 * or an attachment stored under `YYYY/MM/<uuid>`, and none of those come close
 * to the limits. A name that does not fit is refused rather than truncated —
 * a truncated name in an archive is a file that restores to the wrong place
 * and says nothing about it.
 */

const BLOCK = 512;

/** ustar's name field. Nothing this project writes approaches it. */
const MAX_NAME_BYTES = 100;

/** ustar stores the size as 11 octal digits, so this is the format's own ceiling. */
export const MAX_ENTRY_BYTES = 0o77777777777; // 8 GiB - 1

export interface TarEntry {
  name: string;
  data: Uint8Array;
  /** Seconds since the epoch. Defaults to now. */
  mtime?: number;
}

function octal(value: number, width: number): string {
  // width - 1 digits and a NUL, which is what every tar in practice writes.
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function writeAscii(
  block: Uint8Array,
  offset: number,
  text: string,
  width: number,
): void {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > width) {
    throw new Error(`tar field does not fit in ${width} bytes: ${text}`);
  }
  block.set(bytes, offset);
}

function header(name: string, size: number, mtime: number): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  if (nameBytes.length === 0) {
    throw new Error("tar entry name is empty");
  }
  if (nameBytes.length > MAX_NAME_BYTES) {
    throw new Error(
      `tar entry name is ${nameBytes.length} bytes, over the ustar limit of ` +
        `${MAX_NAME_BYTES}: ${name}`,
    );
  }
  if (size > MAX_ENTRY_BYTES) {
    throw new Error(`tar entry is too large for ustar: ${name} (${size} bytes)`);
  }

  const block = new Uint8Array(BLOCK);

  block.set(nameBytes, 0);
  writeAscii(block, 100, octal(0o644, 8), 8); // mode
  writeAscii(block, 108, octal(0, 8), 8); // uid
  writeAscii(block, 116, octal(0, 8), 8); // gid
  writeAscii(block, 124, octal(size, 12), 12);
  writeAscii(block, 136, octal(Math.floor(mtime), 12), 12);
  block[156] = 0x30; // typeflag '0' — an ordinary file
  writeAscii(block, 257, "ustar\0", 6);
  writeAscii(block, 263, "00", 2);

  /*
   * The checksum is computed with its own field read as eight spaces, then
   * written into that field. Six octal digits, a NUL and a space is the
   * historical layout every reader accepts.
   */
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeAscii(block, 148, sum.toString(8).padStart(6, "0") + "\0 ", 8);

  return block;
}

function padding(size: number): number {
  const remainder = size % BLOCK;
  return remainder === 0 ? 0 : BLOCK - remainder;
}

/** Builds a complete ustar archive in memory. */
export function createTar(entries: readonly TarEntry[]): Uint8Array {
  const now = Math.floor(Date.now() / 1000);

  let total = 0;
  for (const entry of entries) {
    total += BLOCK + entry.data.length + padding(entry.data.length);
  }
  // Two zero blocks mark the end of the archive. Readers that do not see them
  // report a truncated file, which is exactly what a half-written backup is.
  total += BLOCK * 2;

  const out = new Uint8Array(total);
  let offset = 0;

  for (const entry of entries) {
    out.set(header(entry.name, entry.data.length, entry.mtime ?? now), offset);
    offset += BLOCK;
    out.set(entry.data, offset);
    offset += entry.data.length + padding(entry.data.length);
  }

  return out;
}

function readString(block: Uint8Array, offset: number, width: number): string {
  const slice = block.subarray(offset, offset + width);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end)).trim();
}

function readOctal(block: Uint8Array, offset: number, width: number): number {
  const text = readString(block, offset, width);
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) {
    throw new Error(`tar header holds a malformed octal field at offset ${offset}`);
  }
  return value;
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

/**
 * Reads an archive back.
 *
 * The checksum is verified on every header, and a mismatch is fatal. This is
 * the cheapest possible detection of a backup that was truncated by a full disk
 * or mangled by being copied in text mode, and finding that out while reading
 * the archive is enormously better than finding it out from a restored system
 * that is subtly wrong.
 */
export function readTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);

    if (isZeroBlock(block)) break;

    const stored = readOctal(block, 148, 8);

    // Recompute exactly as the writer did: the checksum field read as spaces.
    const scratch = new Uint8Array(block);
    scratch.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of scratch) sum += byte;

    if (sum !== stored) {
      const name = readString(block, 0, MAX_NAME_BYTES);
      throw new Error(
        `Archive is corrupt: header checksum mismatch for "${name}" ` +
          `(stored ${stored}, computed ${sum}).`,
      );
    }

    const name = readString(block, 0, MAX_NAME_BYTES);
    const size = readOctal(block, 124, 12);
    const mtime = readOctal(block, 136, 12);
    offset += BLOCK;

    if (offset + size > archive.length) {
      throw new Error(
        `Archive is truncated: "${name}" claims ${size} bytes and the file ends first.`,
      );
    }

    // A directory entry or anything that is not a plain file is skipped rather
    // than guessed at. Nothing this project writes produces one.
    if (block[156] === 0x30 || block[156] === 0x00) {
      entries.push({ name, data: archive.slice(offset, offset + size), mtime });
    }

    offset += size + padding(size);
  }

  return entries;
}
