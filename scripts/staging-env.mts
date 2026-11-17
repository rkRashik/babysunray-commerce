// The staging settings file, read the same way by every staging command: the file named by STAGING_ENV_FILE, else
// `.env.staging.local` in the project folder (git-ignored). The shell's own variables win over the file. A missing
// file is no settings; an unreadable one is an error. Values are never printed. Gate H.46B.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export const ROOT = path.resolve(import.meta.dirname, "..");

export function readStagingEnv(): Record<string, string | undefined> {
  const name = process.env.STAGING_ENV_FILE ?? path.join(ROOT, ".env.staging.local");
  let file: Record<string, string | undefined> = {};
  try {
    file = parseEnv(readFileSync(name, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The staging settings file could not be read.");
  }
  return { ...file, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) };
}
