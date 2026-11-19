// The staging settings file, read the same way by every staging command: the file named by STAGING_ENV_FILE, else
// `.env.staging.local` in the project folder (git-ignored). The shell's own variables win over the file. A missing
// file is no settings; an unreadable one is an error. Values are never printed. Gate H.46B.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export const ROOT = path.resolve(import.meta.dirname, "..");

export function readStagingEnv(): Record<string, string | undefined> {
  return readHostedEnv("staging");
}

/** The settings file of a hosted target: `.env.staging.local` or `.env.production.local` (or STAGING_ENV_FILE / PRODUCTION_ENV_FILE). */
export function readHostedEnv(kind: "staging" | "production"): Record<string, string | undefined> {
  const name = (kind === "staging" ? process.env.STAGING_ENV_FILE : process.env.PRODUCTION_ENV_FILE) ?? path.join(ROOT, `.env.${kind}.local`);
  let file: Record<string, string | undefined> = {};
  try {
    file = parseEnv(readFileSync(name, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`The ${kind} settings file could not be read.`);
  }
  return { ...file, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) };
}
