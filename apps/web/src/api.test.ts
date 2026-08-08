import { describe, expect, it } from "vitest";

import { contentDispositionFilename } from "./api.js";

/**
 * The filename travels in a header rather than the URL, so it never reaches a
 * proxy access log — a filename can be as revealing as the file it names.
 */
describe("contentDispositionFilename", () => {
  it("carries a Japanese name in the encoded form", () => {
    const header = contentDispositionFilename("2026年度 勤務表.xlsx");

    expect(header).toContain(
      `filename*=UTF-8''${encodeURIComponent("2026年度 勤務表.xlsx")}`,
    );
  });

  /** The plain form is ASCII-only, and is what an old parser reads. */
  it("keeps an ASCII fallback beside it", () => {
    expect(contentDispositionFilename("報告書.pdf")).toContain('filename="___.pdf"');
  });

  it("passes an ASCII name through unchanged", () => {
    expect(contentDispositionFilename("report.pdf")).toContain('filename="report.pdf"');
  });

  /** A quote in the name must not end the quoted string early. */
  it("neutralises a quote", () => {
    expect(contentDispositionFilename('a"b.pdf')).toContain('filename="a_b.pdf"');
  });
});
