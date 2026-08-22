/**
 * What may be uploaded, and what it is actually made of.
 *
 * Four rules, each closing a specific hole:
 *
 *   1. The extension must be on an allow-list. A deny-list is a promise to
 *      have thought of every dangerous extension, which nobody has.
 *   2. The bytes must match what the extension claims. `Content-Type` is set
 *      by the uploader and means nothing; a renamed executable must not become
 *      a spreadsheet by being called one.
 *   3. The stored name is generated here and never derived from the uploaded
 *      one, so no filename can influence where the file lands.
 *   4. Permission is checked again on download, in the route — a link is not a
 *      capability.
 *
 * SVG is deliberately absent. It is XML, it can carry script, and browsers
 * execute that script when it is served inline from your own origin. There is
 * no way to accept SVG and also serve it as an image safely, so it is not
 * accepted.
 */

/** The database constrains this too: byte_size > 0 AND <= 26214400. */
export const MAX_ATTACHMENT_BYTES = 26_214_400; // 25 MiB

export interface FileKind {
  /** Canonical type, stored and used to serve the file. Never the uploader's. */
  contentType: string;
  /**
   * Shown inline in the conversation rather than downloaded. Only formats whose
   * bytes are verified here and which cannot carry script.
   */
  inline?: boolean;
  /** Byte signatures, any of which identifies the format. */
  signatures?: readonly (readonly number[])[];
  /** Formats with no signature at all, validated as text instead. */
  text?: true;
  /** ISO Base Media brands used by HEIF/HEIC, found in the ftyp box. */
  isoBrands?: readonly string[];
}

const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  // An empty archive, and one written by a streaming producer.
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
] as const;

/**
 * The Office formats are ZIP containers, and telling xlsx from docx means
 * reading the central directory. This checks that the file is genuinely a ZIP
 * container and takes the specific type from the extension.
 *
 * That is the honest limit of it: a .docx renamed to .xlsx passes. What does
 * not pass is anything that is not a ZIP at all, which is the case that
 * matters — the file that is really a program.
 */
export const ALLOWED_TYPES: Readonly<Record<string, FileKind>> = {
  pdf: { contentType: "application/pdf", signatures: [[0x25, 0x50, 0x44, 0x46, 0x2d]] },

  jpg: { contentType: "image/jpeg", inline: true, signatures: [[0xff, 0xd8, 0xff]] },
  jpeg: { contentType: "image/jpeg", inline: true, signatures: [[0xff, 0xd8, 0xff]] },
  png: {
    contentType: "image/png",
    inline: true,
    signatures: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  },
  gif: {
    contentType: "image/gif",
    inline: true,
    signatures: [
      [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
      [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    ],
  },
  webp: {
    contentType: "image/webp",
    inline: true,
    // RIFF....WEBP — the four size bytes in between are skipped by the check.
    signatures: [[0x52, 0x49, 0x46, 0x46]],
  },
  // Safari and iOS commonly hand the original camera file to a file input.
  // Browsers do not consistently render it, so it is downloadable rather than
  // inline; accepting and verifying it still lets a phone send the photo.
  heic: {
    contentType: "image/heic",
    isoBrands: ["heic", "heix", "hevc", "hevx"],
  },
  heif: {
    contentType: "image/heif",
    isoBrands: ["mif1", "msf1", "heic", "heix", "hevc", "hevx"],
  },

  xlsx: {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    signatures: ZIP_SIGNATURES,
  },
  docx: {
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    signatures: ZIP_SIGNATURES,
  },
  pptx: {
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    signatures: ZIP_SIGNATURES,
  },
  zip: { contentType: "application/zip", signatures: ZIP_SIGNATURES },

  csv: { contentType: "text/csv", text: true },
  txt: { contentType: "text/plain", text: true },
};

export type UploadRejection =
  "EMPTY" | "TOO_LARGE" | "EXTENSION_NOT_ALLOWED" | "CONTENT_MISMATCH" | "NAME_INVALID";

export interface UploadAccepted {
  ok: true;
  contentType: string;
  inline: boolean;
  extension: string;
}

export interface UploadRejected {
  ok: false;
  reason: UploadRejection;
  /** The extensions that would have been accepted, for the error message. */
  allowed?: string[];
}

export function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return fileName.slice(dot + 1).toLowerCase();
}

/**
 * A name is only ever shown to people, never used as a path — but a name
 * carrying a separator or a NUL is a name written to trick something
 * downstream, and there is no honest reason to accept one.
 */
export function isUsableFileName(fileName: string): boolean {
  if (fileName.trim() === "") return false;
  if (fileName.length > 255) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f/\\]/.test(fileName)) return false;
  if (fileName === "." || fileName === "..") return false;
  return true;
}

function startsWithSignature(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function hasIsoBrand(bytes: Uint8Array, allowed: readonly string[]): boolean {
  if (bytes.length < 12) return false;
  if (new TextDecoder("ascii").decode(bytes.subarray(4, 8)) !== "ftyp") return false;

  // Major brand at byte 8, then compatible brands after the minor version.
  const candidates = [8];
  for (let offset = 16; offset + 4 <= Math.min(bytes.length, 128); offset += 4) {
    candidates.push(offset);
  }
  const decoder = new TextDecoder("ascii");
  return candidates.some((offset) =>
    allowed.includes(decoder.decode(bytes.subarray(offset, offset + 4))),
  );
}

/**
 * Text has no signature, so "is this really text" is answered by decoding it:
 * valid UTF-8, and no NUL bytes. A binary file renamed to .txt fails on one or
 * the other in every case that matters.
 *
 * Only the first 8 KiB is decoded — enough to catch a binary, and it keeps a
 * 25 MiB "text file" from being decoded twice.
 */
const TEXT_SAMPLE_BYTES = 8_192;

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, TEXT_SAMPLE_BYTES);
  if (sample.includes(0)) return false;

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    // A multi-byte character split by the sample boundary is not a failure.
    // Retrying without the last few bytes distinguishes that from real binary.
    if (sample.length < TEXT_SAMPLE_BYTES) return false;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, -4));
      return true;
    } catch {
      return false;
    }
  }
}

export function validateUpload(
  fileName: string,
  bytes: Uint8Array,
): UploadAccepted | UploadRejected {
  if (!isUsableFileName(fileName)) return { ok: false, reason: "NAME_INVALID" };
  if (bytes.length === 0) return { ok: false, reason: "EMPTY" };
  if (bytes.length > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "TOO_LARGE" };

  const extension = extensionOf(fileName);
  const kind = extension ? ALLOWED_TYPES[extension] : undefined;
  if (!extension || !kind) {
    return {
      ok: false,
      reason: "EXTENSION_NOT_ALLOWED",
      allowed: Object.keys(ALLOWED_TYPES),
    };
  }

  const matches = kind.text
    ? looksLikeText(bytes)
    : kind.isoBrands
      ? hasIsoBrand(bytes, kind.isoBrands)
      : (kind.signatures ?? []).some((signature) =>
          startsWithSignature(bytes, signature),
        );

  if (!matches) return { ok: false, reason: "CONTENT_MISMATCH" };

  return {
    ok: true,
    contentType: kind.contentType,
    inline: kind.inline ?? false,
    extension,
  };
}

/**
 * Where the file is stored, decided here and never by the uploader.
 *
 * Sharded by upload date so one directory does not accumulate every file an
 * organisation has ever sent, and carrying no extension at all: a stored name
 * that ends in `.html` is one webserver misconfiguration away from being
 * served as a page from your own origin.
 */
export function storageKeyFor(id: string, now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}/${month}/${id}`;
}

/**
 * The filename, out of and back into a `Content-Disposition` header.
 *
 * Uploads carry the name here rather than in the URL: a query string reaches
 * the access log of every proxy on the way, and "解雇通知_田中.pdf" is not a
 * thing to write into a log file. RFC 5987 is also the only part of HTTP that
 * gets a Japanese filename through intact.
 */
export function encodeFileName(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function parseFileName(header: string | undefined): string | null {
  if (!header) return null;

  // The encoded form wins when both are present: it is the one that survived
  // being a Japanese filename.
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      const decoded = decodeURIComponent(extended[1].trim());
      if (decoded !== "") return decoded;
    } catch {
      // Malformed percent-encoding: fall through to the plain form.
    }
  }

  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(header);
  if (quoted?.[1]) return quoted[1];

  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bare?.[1]) return bare[1].trim();

  return null;
}
