// `npm run staging:preflight`: which staging settings are missing or wrong, from the settings alone. No network, no
// connection, no value printed. Exit 0 when the settings look complete, 2 otherwise. It cannot see what is only on the
// database (staging marker, application role) or in Supabase (private bucket); the commands check that themselves.
import { stagingPreflight } from "../src/db/staging-preflight.mts";
import { readStagingEnv } from "./staging-env.mts";

const { settings, ready, connectionMode } = stagingPreflight(readStagingEnv());
for (const s of settings) console.log(`${s.state === "ok" ? "ok     " : s.state === "missing" ? "MISSING" : "INVALID"}  ${s.name}${s.note ? ` — ${s.note}` : ""}`);
if (connectionMode) console.log(`Administrator connection: ${connectionMode} (migrations and backups use it; the transaction pooler is refused there).`);
console.log(ready ? "The settings look complete. Next: npm run db:migrate:staging (docs/operations/staging-setup.md, section 6)." : "NOT READY — nothing was connected to. Fill in the settings above (docs/operations/staging-setup.md, sections 3 to 5).");
process.exitCode = ready ? 0 : 2;
