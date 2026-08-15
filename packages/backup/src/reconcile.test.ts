import { describe, expect, it } from "vitest";

import { describeReconcile, reconcile } from "./reconcile.js";

describe("reconcile", () => {
  it("is satisfied when every row has its file", () => {
    const result = reconcile({
      databaseKeys: ["2026/08/a", "2026/08/b"],
      fileKeys: ["2026/08/a", "2026/08/b"],
    });

    expect(result.ok).toBe(true);
    expect(result.matched).toBe(2);
    expect(result.missing).toEqual([]);
    expect(result.orphaned).toEqual([]);
  });

  /**
   * The failure this whole tool exists to prevent: a backup that restores to a
   * system which looks healthy and breaks the first time somebody clicks a
   * paperclip.
   */
  it("fails when a row has no file", () => {
    const result = reconcile({
      databaseKeys: ["2026/08/a", "2026/08/b"],
      fileKeys: ["2026/08/a"],
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["2026/08/b"]);
  });

  /**
   * The harmless direction, and the one the copy order deliberately produces:
   * a file copied while its row still existed, and a dump taken after the sweep
   * removed the row.
   */
  it("tolerates a file no row refers to, and still says so", () => {
    const result = reconcile({
      databaseKeys: ["2026/08/a"],
      fileKeys: ["2026/08/a", "2026/08/swept"],
    });

    expect(result.ok).toBe(true);
    expect(result.orphaned).toEqual(["2026/08/swept"]);
  });

  /**
   * An upload writes the row before it knows the storage key and fills it in
   * within the same transaction. A row caught in between is not a missing file.
   */
  it("ignores a row whose storage key has not been written yet", () => {
    const result = reconcile({
      databaseKeys: ["", "2026/08/a"],
      fileKeys: ["2026/08/a"],
    });

    expect(result.ok).toBe(true);
    expect(result.matched).toBe(1);
    expect(result.missing).toEqual([]);
  });

  it("reports the same inconsistency the same way twice", () => {
    const forwards = reconcile({
      databaseKeys: ["2026/08/c", "2026/08/a", "2026/08/b"],
      fileKeys: [],
    });
    const backwards = reconcile({
      databaseKeys: ["2026/08/b", "2026/08/c", "2026/08/a"],
      fileKeys: [],
    });

    expect(forwards.missing).toEqual(backwards.missing);
    expect(forwards.missing).toEqual(["2026/08/a", "2026/08/b", "2026/08/c"]);
  });

  it("counts a duplicated row once", () => {
    const result = reconcile({
      databaseKeys: ["2026/08/a", "2026/08/a"],
      fileKeys: ["2026/08/a"],
    });

    expect(result.matched).toBe(1);
    expect(result.ok).toBe(true);
  });

  it("is satisfied by a system that has no attachments at all", () => {
    const result = reconcile({ databaseKeys: [], fileKeys: [] });
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(0);
  });
});

describe("describeReconcile", () => {
  /**
   * Silent success is the enemy: a run that checked nothing must not look like
   * a run that found nothing wrong.
   */
  it("spells out a zero rather than omitting the line", () => {
    const summary = describeReconcile(reconcile({ databaseKeys: [], fileKeys: [] }));

    expect(summary).toContain("attachments matched:  0");
    expect(summary).toContain("rows with no file:    0");
  });

  it("names the rows whose file is absent", () => {
    const summary = describeReconcile(
      reconcile({ databaseKeys: ["2026/08/gone"], fileKeys: [] }),
    );

    expect(summary).toContain("2026/08/gone");
  });

  it("truncates a very long list rather than printing thousands of lines", () => {
    const keys = Array.from({ length: 25 }, (_, index) => `2026/08/${index}`);
    const summary = describeReconcile(reconcile({ databaseKeys: keys, fileKeys: [] }));

    expect(summary).toContain("and 5 more");
  });
});
