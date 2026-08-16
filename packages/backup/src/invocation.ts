/**
 * "Run this again, like so" — in words that work where the operator is standing.
 *
 * From a checkout that is `pnpm restore`. Inside the container it is not: the
 * runtime image has Node and no package manager, so a message telling somebody
 * to run `pnpm` there is telling them to run something that does not exist.
 *
 * That mistake had already been made once, in `docs/deployment/docker.md`,
 * where every documented backup command said `pnpm` and none of them could run
 * — see `docs/engineering/docker-first-build.md`. A program whose own error
 * messages repeat the error its documentation just made is a program that
 * teaches the wrong thing twice.
 *
 * Its own file rather than a function inside `cli.ts`, because `cli.ts` runs
 * `main()` on import and so cannot be reached by a test.
 */

export type Command = "backup" | "verify" | "restore";

/**
 * Set by the package manager to the name of the script being run — `backup`,
 * `backup:verify`, `restore` — and absent when the CLI is invoked directly.
 *
 * The script name is used verbatim rather than mapped back, so `pnpm
 * backup:verify` is echoed as `backup:verify` and not as the internal command
 * name `verify`. Telling somebody to run a script that is not in package.json
 * is the same failure in a smaller size.
 */
export function runAs(command: Command, env: NodeJS.ProcessEnv = process.env): string {
  const script = env["npm_lifecycle_event"];
  if (script) return `pnpm ${script}`;

  // Matches how migrations are documented: `node scripts/db.mjs up`.
  return `node packages/backup/dist/cli.js ${command}`;
}
