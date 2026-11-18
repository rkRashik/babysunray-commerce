// Repairs the staging settings file without ever returning or printing a value (Gate H.56). Pure text functions: no
// file, network or database. `npm run staging:setup` (scripts/staging-setup.mts) does the reading, prompting and writing.
// The file is read as raw text on purpose: Node's env parser treats an unencoded "#" in a password as the start of a
// comment, which silently cuts the connection string.

/** The value of NAME in raw env text: everything after the first "=", with no comment stripping. */
export function rawValue(text: string, name: string): string | undefined {
  const m = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=(.*)$`, "m").exec(text);
  if (!m) return undefined;
  let value = m[1].replace(/\r$/, "").trim();
  const quote = value[0];
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
  return value;
}

const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const decodeOrSelf = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The project ref in a pooler user `<role>.<ref>`, or in a direct host `db.<ref>.supabase.co`. */
export function projectRefOf(url: string | undefined): string | null {
  if (!url) return null;
  const repaired = repairConnectionUrl(url);
  if (!repaired) return null;
  try {
    const u = new URL(repaired);
    const user = decodeURIComponent(u.username);
    if (user.includes(".")) return user.slice(user.indexOf(".") + 1);
    return /^db\.([a-z0-9]+)\.supabase\.co$/.exec(u.hostname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export type RepairOptions = {
  /** Set for a Supabase pooler host: the user must be `<role>.<ref>`. */
  projectRef?: string | null;
  /** The administrator connection is a session connection: a pooler host on the transaction port is moved to 5432. */
  sessionConnection?: boolean;
};

/**
 * Rebuilds a PostgreSQL connection URL whose structure was broken by an unencoded password (`#`, `/`, `?`, `@`, `:`,
 * `%`, spaces), drops query parameters (TLS comes from STAGING_DATABASE_SSL) and a missing database defaults to
 * `postgres`. A password that is already valid is kept byte for byte. Returns null when the text is not a PostgreSQL
 * URL with a host, so the caller reports the setting without guessing.
 */
export function repairConnectionUrl(raw: string, options: RepairOptions = {}): string | null {
  const m = /^postgres(?:ql)?:\/\/([\s\S]*)$/i.exec(raw.trim());
  if (!m) return null;
  const rest = m[1];
  const at = rest.lastIndexOf("@");
  if (at < 0) return null;
  const info = rest.slice(0, at);
  const colon = info.indexOf(":");
  const userRaw = colon < 0 ? info : info.slice(0, colon);
  const passRaw = colon < 0 ? "" : info.slice(colon + 1);
  const tail = rest.slice(at + 1).replace(/[?#][\s\S]*$/, "");
  const slash = tail.indexOf("/");
  const hostPort = slash < 0 ? tail : tail.slice(0, slash);
  const database = (slash < 0 ? "" : tail.slice(slash + 1)) || "postgres";
  const hp = /^([A-Za-z0-9.-]+)(?::(\d+))?$/.exec(hostPort);
  if (!hp || !userRaw) return null;
  const host = hp[1];
  let port = hp[2];

  let user = decodeOrSelf(userRaw);
  const pooler = host.toLowerCase().endsWith(".pooler.supabase.com");
  if (pooler && options.projectRef && !user.includes(".")) user = `${user}.${options.projectRef}`;
  if (pooler && options.sessionConnection && port === "6543") port = "5432";

  const validAsIs = /^[A-Za-z0-9\-._~!$&'()*+,;=%]*$/.test(passRaw) && !/%(?![0-9A-Fa-f]{2})/.test(passRaw);
  const password = validAsIs ? passRaw : encode(passRaw);
  return `postgresql://${encode(user)}${colon < 0 ? "" : `:${password}`}@${host}${port ? `:${port}` : ""}/${database}`;
}

/** A key pasted from the Supabase dashboard must be storable unquoted in the settings file. */
export function isStorableKey(value: string): boolean {
  return value.length >= 20 && /^[A-Za-z0-9_.-]+$/.test(value);
}

/** Replaces the line of each name in the file text (keeping every other line, comment and line ending), or appends it. */
export function rewriteEnvText(text: string, updates: Record<string, string>): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let out = text;
  for (const [name, value] of Object.entries(updates)) {
    const line = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[^\\r\\n]*$`, "m");
    if (line.test(out)) out = out.replace(line, () => `${name}=${value}`);
    else out = `${out}${out === "" || out.endsWith("\n") ? "" : eol}${name}=${value}${eol}`;
  }
  return out;
}
