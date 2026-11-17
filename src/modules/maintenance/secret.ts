import { createHash, timingSafeEqual } from "node:crypto";

// The secret that authorises the maintenance endpoint (src/api/maintenance.ts). Pure, so `npm run config:check` can use it.

/** The secret when configured and strong; null when the endpoint is off or the secret is unusable (never partially on). */
export function maintenanceSecret(env: Record<string, string | undefined>): string | null {
  const secret = env.MAINTENANCE_SECRET ?? "";
  if (secret.length < 32 || /change_me/i.test(secret) || /\s/.test(secret)) return null;
  if (secret.length * Math.log2(new Set(secret).size) < 120) return null;
  // One secret per purpose: a leak of the scheduler's must not hand over the sign-in secret.
  if (secret === env.BETTER_AUTH_SECRET) return null;
  return secret;
}

/** Why MAINTENANCE_SECRET cannot be used, or null when unset (off) or usable. Names the variable, never a value. */
export function maintenanceSecretProblem(env: Record<string, string | undefined>): string | null {
  if (!env.MAINTENANCE_SECRET) return null;
  return maintenanceSecret(env) ? null : "MAINTENANCE_SECRET must be at least 32 random characters and different from BETTER_AUTH_SECRET; the endpoint stays off until it is.";
}

const digest = (value: string) => createHash("sha256").update(value).digest();
export function bearerMatches(header: string | null, secret: string): boolean {
  const presented = /^Bearer (\S+)$/.exec(header ?? "")?.[1] ?? "";
  // Both sides hashed to 32 bytes first, so the comparison time never depends on the presented length or content.
  return timingSafeEqual(digest(presented), digest(secret)) && presented.length > 0;
}
