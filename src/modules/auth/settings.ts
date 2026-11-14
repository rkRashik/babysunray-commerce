// Authentication settings from the environment, validated once at the boundary (ADR-0003). Error messages
// name variables, never values. Each installation sets its own secret and URL; nothing here is
// BabySunray-specific.

export type AuthSettings = { secret: string; baseURL: string };

type Env = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Better Auth reads these itself and would widen the configuration behind this validation: extra trusted
// origins, an unvalidated rotated secret list, or telemetry. They are refused until a gate approves them.
const UNSUPPORTED = ["BETTER_AUTH_TRUSTED_ORIGINS", "BETTER_AUTH_SECRETS", "BETTER_AUTH_TELEMETRY"];

export function readAuthSettings(env: Env): AuthSettings {
  for (const name of UNSUPPORTED) {
    if (env[name] !== undefined && env[name] !== "") throw new Error(`${name} is not supported in this project.`);
  }
  return { secret: validateSecret(env.BETTER_AUTH_SECRET), baseURL: validateBaseURL(env.BETTER_AUTH_URL, env.NODE_ENV) };
}

function validateSecret(secret: string | undefined): string {
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set.");
  if (/change_me/i.test(secret)) throw new Error("BETTER_AUTH_SECRET is still the placeholder.");
  // Same estimate Better Auth uses for its warning (length x log2 of distinct characters), enforced here.
  const bits = secret.length * Math.log2(new Set(secret).size);
  if (secret.length < 32 || bits < 120) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 random characters (for example `openssl rand -base64 32`).");
  }
  return secret;
}

function validateBaseURL(raw: string | undefined, nodeEnv: string | undefined): string {
  if (!raw) throw new Error("BETTER_AUTH_URL is not set.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("BETTER_AUTH_URL is not a valid URL.");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("BETTER_AUTH_URL must be an origin only, such as https://shop.example.");
  }
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname) && nodeEnv !== "production") return url.origin;
  throw new Error("BETTER_AUTH_URL must use https (plain http is allowed only for localhost outside production).");
}
