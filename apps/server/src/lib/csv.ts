/**
 * Minimal RFC 4180 CSV, no dependency.
 *
 * Written by hand because the requirements are narrow and specific: Japanese
 * text, Excel on Windows, and round-tripping our own export back through our
 * own import. A general library would bring configuration surface we do not
 * need and would still need the BOM decision below made explicitly.
 */

/** Wraps a field only when it needs it. */
function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(headers: string[], rows: (string | null)[][]): string {
  const lines = [
    headers.map(escapeField).join(","),
    ...rows.map((row) => row.map((cell) => escapeField(cell ?? "")).join(",")),
  ];
  // CRLF: Excel is the overwhelmingly likely destination for an export a
  // Japanese small business will open.
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Excel on Windows assumes the system codepage unless a UTF-8 BOM is present,
 * which turns every Japanese name into mojibake. The BOM is the difference
 * between a file that opens correctly by double-clicking and one that requires
 * an import wizard.
 */
export const UTF8_BOM = "﻿";

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * Parses CSV into records keyed by header.
 *
 * Tolerates a leading BOM (our own exports have one), both line endings, and
 * quoted fields containing commas or newlines — all of which appear the moment
 * somebody edits an export in Excel and sends it back.
 */
export function parseCsv(input: string): ParsedCsv {
  const text = input.startsWith(UTF8_BOM) ? input.slice(1) : input;

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r") {
      // Swallow; the \n that follows ends the row.
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else {
      field += char;
    }
  }

  // A final line with no trailing newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const headerRow = rows.shift();
  if (!headerRow) return { headers: [], rows: [] };

  const headers = headerRow.map((h) => h.trim());

  return {
    headers,
    rows: rows
      // Skip blank lines, which trailing newlines in hand-edited files produce.
      .filter((cells) => cells.some((cell) => cell.trim() !== ""))
      .map((cells) => {
        const record: Record<string, string> = {};
        headers.forEach((header, index) => {
          record[header] = (cells[index] ?? "").trim();
        });
        return record;
      }),
  };
}
