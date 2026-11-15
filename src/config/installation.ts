// The business identity of this installation (requirements B-12, RU-1), from the environment: one installation =
// one business, its own database, secrets, photo folder and these settings. Only public, display-level identity is
// configurable here; order rules, delivery zones, COD and verification stay in code and in the founder-approved
// policy (an installation decision, never a setting a user can change). Defaults are neutral, so a fresh copy shows
// no other business's name, words or contact details. Plain functions, no secrets; read on the server.

export type InstallationIdentity = {
  storeName: string;
  /** A short public description in each language, or null (nothing shown). */
  storeLine: { en: string | null; bn: string | null };
  /** Shown only when configured. */
  contact: { phone: string | null; email: string | null };
  /** Storefront preview colours (prototype tokens), each checked for readable contrast. */
  theme: { ink: string; accent: string; paper: string };
};

export const DEFAULT_THEME = { ink: "#332923", accent: "#c28b56", paper: "#f9f6f1" };
// The fixed secondary tokens the preview also draws with (src/app/globals.css); the configured colours must keep
// them readable.
const SECONDARY = { umber: "#6b5b4f", tan: "#7a4e24", sand: "#e8d5bf" };
export const DEFAULT_STORE_NAME = "Storefront";

type Env = Record<string, string | undefined>;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const HEX = /^#[0-9a-fA-F]{6}$/;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function text(env: Env, name: string, max: number, problems: string[]): string | null {
  const raw = env[name]?.normalize("NFC").trim();
  if (!raw) return null;
  if (raw.length > max || CONTROL.test(raw)) {
    problems.push(`${name} must be at most ${max} characters without line breaks or control characters.`);
    return null;
  }
  return raw;
}

/** The identity and every problem with the settings (names and rules only, never values). A bad value falls back to the default. */
export function readInstallationIdentity(env: Env): { identity: InstallationIdentity; problems: string[] } {
  const problems: string[] = [];
  const storeName = text(env, "STORE_NAME", 60, problems) ?? DEFAULT_STORE_NAME;
  const storeLine = { en: text(env, "STORE_LINE_EN", 200, problems), bn: text(env, "STORE_LINE_BN", 200, problems) };
  let phone = text(env, "STORE_CONTACT_PHONE", 30, problems);
  if (phone && !/^\+?[0-9][0-9 -]{5,20}$/.test(phone)) {
    problems.push("STORE_CONTACT_PHONE must be a phone number (digits, spaces, hyphens, an optional leading +).");
    phone = null;
  }
  let email = text(env, "STORE_CONTACT_EMAIL", 120, problems);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    problems.push("STORE_CONTACT_EMAIL must be an email address.");
    email = null;
  }
  const theme = { ...DEFAULT_THEME };
  const picked = { ink: env.STORE_THEME_INK?.trim(), accent: env.STORE_THEME_ACCENT?.trim(), paper: env.STORE_THEME_PAPER?.trim() };
  if (picked.ink || picked.accent || picked.paper) {
    const candidate = { ink: picked.ink || theme.ink, accent: picked.accent || theme.accent, paper: picked.paper || theme.paper };
    const bad = Object.entries(candidate).filter(([, v]) => !HEX.test(v));
    if (bad.length) problems.push(`${bad.map(([k]) => `STORE_THEME_${k.toUpperCase()}`).join(", ")} must be a colour like #332923.`);
    else {
      const checks: [string, number, number][] = [
        ["ink on paper", contrast(candidate.ink, candidate.paper), 7],
        ["ink on accent", contrast(candidate.ink, candidate.accent), 4.5],
        ["secondary text on paper", Math.min(contrast(SECONDARY.umber, candidate.paper), contrast(SECONDARY.tan, candidate.paper)), 4.5],
        ["light text on ink", Math.min(contrast(SECONDARY.sand, candidate.ink), contrast(candidate.paper, candidate.ink)), 4.5],
      ];
      const failed = checks.filter(([, ratio, min]) => ratio < min);
      if (failed.length) problems.push(`The STORE_THEME_* colours are not readable enough (${failed.map(([what, ratio, min]) => `${what} ${ratio.toFixed(1)}:1, needs ${min}:1`).join("; ")}). The default colours are used.`);
      else Object.assign(theme, { ink: candidate.ink.toLowerCase(), accent: candidate.accent.toLowerCase(), paper: candidate.paper.toLowerCase() });
    }
  }
  return { identity: { storeName, storeLine, contact: { phone, email }, theme }, problems };
}

/** This process's identity (read on every call; cheap). */
export const installationIdentity = () => readInstallationIdentity(process.env).identity;
