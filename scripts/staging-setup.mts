// `npm run staging:setup`: repairs and completes the staging settings file so the founder does not edit URLs by hand
// (Gate H.56). It reads the file as raw text at run time, re-encodes a connection URL broken by an unencoded password
// (`#` becomes %23 and so on), derives the project URL from the project ref already in the connection users, and asks
// for the two Supabase keys with a hidden prompt. It prints only setting names and fixed messages, never a value, makes
// no network connection and never touches the database. Keys are never taken from arguments or the environment.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_URL, MIGRATION_URL, stagingPreflight } from "../src/db/staging-preflight.mts";
import { isStorableKey, projectRefOf, rawValue, repairConnectionUrl, rewriteEnvText } from "../src/db/staging-setup.mts";
import { askHidden } from "./prompt.mts";
import { ROOT, readStagingEnv } from "./staging-env.mts";

const file = process.env.STAGING_ENV_FILE ?? path.join(ROOT, ".env.staging.local");
let text = "";
try {
  text = readFileSync(file, "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The staging settings file could not be read.");
}

const updates: Record<string, string> = {};
const fixed: string[] = [];

// 1. Connection URLs: the application one first, because its user carries the project ref.
const appRaw = rawValue(text, APP_URL);
const migrationRaw = rawValue(text, MIGRATION_URL);
const ref = projectRefOf(appRaw) ?? projectRefOf(migrationRaw);
for (const [name, raw, session] of [[APP_URL, appRaw, false], [MIGRATION_URL, migrationRaw, true]] as const) {
  if (!raw) continue;
  const repaired = repairConnectionUrl(raw, { projectRef: ref, sessionConnection: session });
  if (repaired && repaired !== raw) {
    updates[name] = repaired;
    fixed.push(`${name}: connection string rebuilt`);
  } else if (!repaired) console.log(`INVALID  ${name} — not recognisable as postgresql://user:password@host:port/database; nothing was changed for it.`);
}

// 2. The project URL is not secret and follows from the project ref.
if (!rawValue(text, "STAGING_SUPABASE_URL") && ref) {
  updates.STAGING_SUPABASE_URL = `https://${ref}.supabase.co`;
  fixed.push("STAGING_SUPABASE_URL: derived from the project ref");
}

// 3. The two keys cannot be obtained automatically: ask in the terminal, hidden, validated by the preflight itself.
const merged = () => ({ ...readStagingEnv(), ...updates });
const keyState = (name: string) => stagingPreflight(merged()).settings.find((s) => s.name === name)?.state;
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const waiting: string[] = [];
for (const [name, label] of [["STAGING_SUPABASE_PUBLISHABLE_KEY", "publishable key (sb_publishable_...)"], ["STAGING_SUPABASE_SECRET_KEY", "secret key (sb_secret_...)"]] as const) {
  if (keyState(name) === "ok") continue;
  if (!interactive) {
    waiting.push(name);
    continue;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const typed = (await askHidden(`Paste the Supabase ${label}, then Enter (not shown): `)).trim();
    if (typed && isStorableKey(typed)) {
      updates[name] = typed;
      if (keyState(name) === "ok") {
        fixed.push(`${name}: entered`);
        break;
      }
      delete updates[name];
    }
    console.log("That is not the expected kind of key (the publishable and the secret key are different; neither may be blank or contain spaces).");
    if (attempt === 3) waiting.push(name);
  }
}

if (Object.keys(updates).length > 0) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, rewriteEnvText(text, updates), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}
for (const line of fixed) console.log(`updated  ${line}`);
if (fixed.length === 0) console.log("Nothing needed repairing.");

const { settings, ready } = stagingPreflight(readStagingEnv());
for (const s of settings) console.log(`${s.state === "ok" ? "ok     " : s.state === "missing" ? "MISSING" : "INVALID"}  ${s.name}${s.note ? ` — ${s.note}` : ""}`);
if (waiting.length > 0) console.log(`Still needed from the terminal: ${waiting.join(", ")}. Run npm run staging:setup in your own terminal (VS Code: Terminal > New Terminal); it asks with a hidden prompt.`);
console.log(ready ? "The settings look complete (nothing was connected to)." : "NOT READY yet (nothing was connected to).");
process.exitCode = ready ? 0 : 2;
