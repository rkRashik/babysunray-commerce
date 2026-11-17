import { realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

// Shared by the commands that touch a hosted database (Gate H.48A): where their reports and backups may be written, and a
// report writer that can never replace a file it did not create. Plain TypeScript (no aliases) so Node runs it from scripts/.

/** An absolute file path in an existing folder OUTSIDE the project (reports and backups never land in the repository). */
export function outsideRepository(file: string | undefined, what: string, projectRoot: string): string {
  if (!file || !path.isAbsolute(file)) throw new Error(`Give the ${what} as an absolute path outside the project.`);
  let dir: string;
  try {
    dir = realpathSync(path.dirname(file));
  } catch {
    throw new Error(`The folder for the ${what} does not exist.`);
  }
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = path.relative(fold(realpathSync(projectRoot)), fold(dir));
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new Error(`The ${what} must be outside the project folder.`);
  return path.join(dir, path.basename(file));
}

/**
 * A function that writes `data` as JSON (owner-only) to `file`. The first write creates the file EXCLUSIVELY, so a file that
 * already exists, however it got there, is never overwritten; later writes replace this run's own file. The data is
 * whatever the caller passes: it must never hold a password, a key or a connection string.
 */
export function reportWriter(file: string): (data: unknown) => void {
  let created = false;
  return (data) => {
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { flag: created ? "w" : "wx", mode: 0o600 });
    created = true;
  };
}
