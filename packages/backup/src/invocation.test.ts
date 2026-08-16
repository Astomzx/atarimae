import { describe, expect, it } from "vitest";

import { runAs } from "./invocation.js";

/**
 * These look trivial and are not. Every documented backup command in
 * `docs/deployment/docker.md` said `pnpm`, and none of them could run inside
 * the container, because the runtime image has Node and no package manager.
 * The program's own error messages had the same bug — a restore refused in the
 * container told the operator to run `pnpm restore <file> --force`.
 *
 * Nothing in `pnpm check` runs a command inside a container, so this is the
 * closest a unit test gets: it pins the two forms and which one is chosen.
 */

describe("runAs", () => {
  /** No package manager in the environment, which is the container. */
  it("gives a runnable node command when there is no package manager", () => {
    const env = {};

    expect(runAs("backup", env)).toBe("node packages/backup/dist/cli.js backup");
    expect(runAs("verify", env)).toBe("node packages/backup/dist/cli.js verify");
    expect(runAs("restore", env)).toBe("node packages/backup/dist/cli.js restore");
  });

  /** Never `pnpm` when there is nothing to run it with. */
  it("does not mention pnpm in the container form", () => {
    expect(runAs("restore", {})).not.toContain("pnpm");
  });

  it("uses the pnpm script when the package manager ran it", () => {
    expect(runAs("backup", { npm_lifecycle_event: "backup" })).toBe("pnpm backup");
    expect(runAs("restore", { npm_lifecycle_event: "restore" })).toBe("pnpm restore");
  });

  /**
   * The script is echoed verbatim rather than mapped back from the internal
   * command name. `pnpm verify` is not a script in package.json; `pnpm
   * backup:verify` is.
   */
  it("echoes the script name, not the internal command name", () => {
    expect(runAs("verify", { npm_lifecycle_event: "backup:verify" })).toBe(
      "pnpm backup:verify",
    );
  });
});
