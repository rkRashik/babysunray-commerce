import { describe, expect, it } from "vitest";
import { parseStagingUrl } from "../../src/db/hosted-target.mts";
import { isStorableKey, projectRefOf, rawValue, repairConnectionUrl, rewriteEnvText } from "../../src/db/staging-setup.mts";

// The staging settings repair (Gate H.56). Every value here is fictional.

const REF = "abcdefghijklmnop";
const PASSWORD = "pa#ss/w@rd?x%1 y:z";
const env = (url: string) => ({ STAGING_DATABASE_SSL: "require", X: url });
const parsed = (url: string) => parseStagingUrl(env(url), "X", { pooled: false });

describe("repairConnectionUrl", () => {
  it("rebuilds a URL whose password has unencoded reserved characters, and the password survives the round trip", () => {
    const raw = `postgresql://postgres.${REF}:${PASSWORD}@aws-0-xx.pooler.supabase.com:5432/postgres`;
    expect(() => parsed(raw)).toThrow(); // the defect: the "#" starts a fragment, so the database is empty
    const fixed = repairConnectionUrl(raw)!;
    expect(fixed).toContain("%23");
    expect(fixed.slice(fixed.indexOf("@"))).toBe("@aws-0-xx.pooler.supabase.com:5432/postgres");
    const conn = parsed(fixed);
    expect(conn).toMatchObject({ host: "aws-0-xx.pooler.supabase.com", port: 5432, database: "postgres", user: `postgres.${REF}`, password: PASSWORD });
  });
  it("keeps a password that is already valid byte for byte, so repairing twice changes nothing", () => {
    const ok = `postgresql://postgres.${REF}:Ab%23c-d_e@aws-0-xx.pooler.supabase.com:5432/postgres`;
    expect(repairConnectionUrl(ok)).toBe(ok);
    const once = repairConnectionUrl(`postgres://u:a#b@h.example.com/db`)!;
    expect(repairConnectionUrl(once)).toBe(once);
  });
  it("drops query parameters, defaults the database and completes a pooler user and port for the administrator session connection", () => {
    const raw = `postgresql://postgres:secret@aws-0-xx.pooler.supabase.com:6543?sslmode=require`;
    expect(repairConnectionUrl(raw, { projectRef: REF, sessionConnection: true })).toBe(`postgresql://postgres.${REF}:secret@aws-0-xx.pooler.supabase.com:5432/postgres`);
    // without the options nothing about the user or port is guessed
    expect(repairConnectionUrl(raw)).toBe("postgresql://postgres:secret@aws-0-xx.pooler.supabase.com:6543/postgres");
  });
  it("returns null for text that is not a PostgreSQL URL with a user and host", () => {
    for (const bad of ["", "https://x.example.com", "postgresql://host/db", "postgresql://:pw@host/db", "postgresql://u:pw@/db"]) expect(repairConnectionUrl(bad)).toBeNull();
  });
});

describe("projectRefOf", () => {
  it("reads the ref from a pooler user or a direct host, even when the password is broken", () => {
    expect(projectRefOf(`postgresql://babysunray_app.${REF}:a#b@h.pooler.supabase.com:6543/postgres`)).toBe(REF);
    expect(projectRefOf(`postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`)).toBe(REF);
    expect(projectRefOf(undefined)).toBeNull();
  });
});

describe("rawValue and rewriteEnvText", () => {
  it("reads a value with a hash and quotes as written, and rewrites only the named lines, keeping comments and line endings", () => {
    const text = `# note\r\nA=1\r\nSTAGING_X="p#q"\r\nB=2\r\n`;
    expect(rawValue(text, "STAGING_X")).toBe("p#q");
    expect(rawValue(text, "NOPE")).toBeUndefined();
    const out = rewriteEnvText(text, { STAGING_X: "new", STAGING_Y: "added" });
    expect(out).toBe(`# note\r\nA=1\r\nSTAGING_X=new\r\nB=2\r\nSTAGING_Y=added\r\n`);
  });
  it("appends to a file without a final newline and to an empty file", () => {
    expect(rewriteEnvText("A=1", { B: "2" })).toBe("A=1\nB=2\n");
    expect(rewriteEnvText("", { B: "2" })).toBe("B=2\n");
  });
});

describe("isStorableKey", () => {
  it("accepts key-shaped text and refuses blanks, spaces, hashes and quotes", () => {
    expect(isStorableKey("sb_secret_" + "a".repeat(30))).toBe(true);
    for (const bad of ["", "short", "has space " + "a".repeat(30), "a".repeat(30) + "#c", "'" + "a".repeat(30)]) expect(isStorableKey(bad)).toBe(false);
  });
});
