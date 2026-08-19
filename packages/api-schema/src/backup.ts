import { Type, type Static } from "@sinclair/typebox";

/**
 * Downloading a full backup over HTTP.
 *
 * `backup.md` refused this once, and the reasoning is still the right way to
 * read it: this is one request that carries away every password hash, message
 * and attachment. It exists because an operator who cannot open a terminal was
 * an operator with no backups, and "the feature exists but nobody can use it"
 * is the same as not having one.
 */

export const ExportBackupRequest = Type.Object({
  /**
   * The caller's own password, again, now.
   *
   * A stolen session cookie is the realistic attack against this endpoint, and
   * this is what makes the cookie alone insufficient.
   */
  password: Type.String({ minLength: 1, maxLength: 512 }),
});
export type ExportBackupRequest = Static<typeof ExportBackupRequest>;

export const BackupErrorCode = {
  /** No pg_dump on this server, so no archive can be produced. */
  TOOLING_MISSING: "BACKUP_TOOLING_MISSING",
  DUMP_FAILED: "BACKUP_DUMP_FAILED",
  /** Attachment rows have no file; an archive would preserve the breakage. */
  INCONSISTENT: "BACKUP_INCONSISTENT",
} as const;
