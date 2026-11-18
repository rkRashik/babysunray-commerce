// `npm run netlify:env -- --out <new file outside the project> --url https://<site>.netlify.app`: writes the Netlify
// environment variables the application needs, from the STAGING settings file, as a .env file that Netlify can import
// (Site configuration > Environment variables > Add a variable > Import from a .env file). Gate H.58.
//
// What it does: maps the application's pooled connection (never the administrator one) to DATABASE_URL, the staging
// Supabase project and bucket to the photo-store settings, adds the fixed hosted settings and a NEW random
// BETTER_AUTH_SECRET, and checks the result with the application's own configuration check. The Cloudinary variables are
// not included (they are set in Netlify already). It prints only variable names, never a value. The file is created
// exclusively (never replaces one), outside the repository, and holds secrets: import it, then delete it.
// This points the Netlify site at the STAGING database and bucket. A production site needs its own project and its own run.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { hostedConfigProblems } from "../src/config/hosted.ts";
import { outsideRepository } from "../src/db/hosted-report.mts";
import { APP_URL } from "../src/db/staging-preflight.mts";
import { parseStagingUrl } from "../src/db/hosted-target.mts";
import { readStagingEnv, ROOT } from "./staging-env.mts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function main(): void {
  const env = readStagingEnv();
  const out = outsideRepository(arg("--out"), "output file", ROOT);
  const site = arg("--url") ?? "";
  if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site)) throw new Error("Give --url as the site's https origin, for example https://your-site.netlify.app (no path, no trailing slash).");
  // Parsing also enforces: hosted, transaction pooler, application role, TLS mode.
  const app = parseStagingUrl(env, APP_URL, { pooled: true });
  if (!app.user.startsWith("babysunray_app.")) throw new Error("The application connection must use the babysunray_app role.");
  for (const name of ["STAGING_SUPABASE_URL", "STAGING_SUPABASE_SECRET_KEY", "STAGING_STORAGE_BUCKET"]) if (!env[name]) throw new Error(`${name} is not set; run npm run staging:setup.`);

  const values: Record<string, string> = {
    DATABASE_URL: env[APP_URL]!,
    DATABASE_RUNTIME: "serverless",
    DATABASE_POOLER: "transaction",
    DATABASE_SSL: "require",
    BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"),
    BETTER_AUTH_URL: site,
    MEDIA_STORAGE_PROVIDER: "supabase",
    SUPABASE_URL: env.STAGING_SUPABASE_URL!,
    SUPABASE_STORAGE_BUCKET: env.STAGING_STORAGE_BUCKET!,
    SUPABASE_SERVICE_ROLE_KEY: env.STAGING_SUPABASE_SECRET_KEY!,
  };
  for (const [name, value] of Object.entries(values)) if (/[\s"'#]/.test(value)) throw new Error(`${name} cannot be written safely to a .env file.`);
  const problems = hostedConfigProblems(values, ROOT);
  if (problems.length) {
    console.error(`The settings would not pass the application's configuration check: ${problems.map((p) => p.name).join(", ")}. Nothing was written.`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(out, `${Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n")}\n`, { flag: "wx", mode: 0o600 });
  console.log(`Wrote ${Object.keys(values).length} variables (names only): ${Object.keys(values).join(", ")}.`);
  console.log(`File: ${out}`);
  console.log("They pass the application's configuration check. Import the file in Netlify, then DELETE it (it holds secrets). Not included: the administrator database connection (it never goes to Netlify) and the Cloudinary variables.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed.");
  process.exitCode = 1;
}
