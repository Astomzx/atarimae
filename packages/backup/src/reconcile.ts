/**
 * Does the database in this archive agree with the files in this archive?
 *
 * This is the whole point of the tool. An attachment is two things — a row in
 * `message_attachments` and a file under `ATTACHMENT_ROOT` — and a backup that
 * captures one without the other restores to a system that looks entirely
 * healthy and fails the first time somebody clicks a paperclip, with no error
 * anywhere until they do.
 *
 * The two directions are not symmetrical, and the asymmetry decides the order
 * everything else happens in:
 *
 *   a row with no file   a download that is broken forever
 *   a file with no row   a wasted block on disk
 *
 * So files are copied *before* the database is dumped. The sweep deletes the
 * row first and the file second, so a sweep running during a backup can only
 * ever produce the harmless direction: the file was copied while the row still
 * existed, and the dump taken afterwards no longer has the row. Dumping first
 * would produce the other one.
 *
 * That is the same trade, in the same direction, as the upload path — see
 * docs/architecture/attachments.md. Given the choice, waste the space.
 */

export interface ReconcileInput {
  /** `storage_key` of every attachment row, as the database has them. */
  databaseKeys: Iterable<string>;
  /** Keys actually present as files, whether in an archive or on disk. */
  fileKeys: Iterable<string>;
}

export interface ReconcileResult {
  /** Rows whose file is absent. Any of these makes a backup unusable. */
  missing: string[];
  /** Files no row refers to. Harmless, and reported so it is never a surprise. */
  orphaned: string[];
  /** Keys present on both sides. */
  matched: number;
  ok: boolean;
}

/**
 * An upload writes the row before it knows the storage key, and fills the key
 * in immediately afterwards in the same transaction. A row caught between the
 * two has no file yet and is not evidence of anything missing.
 */
const NOT_YET_STORED = "";

export function reconcile({ databaseKeys, fileKeys }: ReconcileInput): ReconcileResult {
  const files = new Set(fileKeys);
  const rows = new Set<string>();

  for (const key of databaseKeys) {
    if (key === NOT_YET_STORED) continue;
    rows.add(key);
  }

  const missing: string[] = [];
  let matched = 0;

  for (const key of rows) {
    if (files.has(key)) matched += 1;
    else missing.push(key);
  }

  const orphaned: string[] = [];
  for (const key of files) {
    if (!rows.has(key)) orphaned.push(key);
  }

  // Sorted so the same inconsistency reads the same way twice, which matters
  // when somebody is comparing two runs to work out what changed.
  missing.sort();
  orphaned.sort();

  return { missing, orphaned, matched, ok: missing.length === 0 };
}

/**
 * The sentence an operator reads.
 *
 * A count of zero is spelled out rather than omitted. "0 attachments" is a
 * fact; a missing line is ambiguous between nothing to report and nothing
 * checked, and this product does not do ambiguous success.
 */
export function describeReconcile(result: ReconcileResult): string {
  const lines = [
    `  attachments matched:  ${result.matched}`,
    `  files with no row:    ${result.orphaned.length}`,
    `  rows with no file:    ${result.missing.length}`,
  ];

  if (result.missing.length > 0) {
    lines.push("", "  Rows whose file is absent:");
    for (const key of result.missing.slice(0, 20)) lines.push(`    ${key}`);
    if (result.missing.length > 20) {
      lines.push(`    ... and ${result.missing.length - 20} more`);
    }
  }

  return lines.join("\n");
}
