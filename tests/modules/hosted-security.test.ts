import { describe, expect, it } from "vitest";
import { type DefaultEntry, isPlatformDefault } from "../../src/db/hosted-security.mts";

// What the privilege audit may treat as Supabase's own default privileges (Gate H.56). Everything else must stay a finding.

const supabase: DefaultEntry = { owner: "supabase_admin", ownerSuperuser: true, connectionIsMember: false, scope: "public", kind: "r", privilege: "SELECT" };

describe("isPlatformDefault", () => {
  it("exempts exactly supabase_admin's table and sequence defaults in public", () => {
    for (const privilege of ["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"]) expect(isPlatformDefault({ ...supabase, privilege })).toBe(true);
    for (const privilege of ["SELECT", "UPDATE", "USAGE"]) expect(isPlatformDefault({ ...supabase, kind: "S", privilege })).toBe(true);
  });
  it("never exempts another owner, even a superuser, the migration role or the application role", () => {
    for (const owner of ["postgres", "babysunray_app", "supabase_auth_admin", "supabase_admin2", "Supabase_Admin", "other_superuser"]) expect(isPlatformDefault({ ...supabase, owner })).toBe(false);
  });
  it("never exempts a supabase_admin look-alike that is not a superuser, or one this connection can act as", () => {
    expect(isPlatformDefault({ ...supabase, ownerSuperuser: false })).toBe(false);
    expect(isPlatformDefault({ ...supabase, connectionIsMember: true })).toBe(false);
  });
  it("never exempts another schema, an all-schemas entry, or another object kind", () => {
    for (const scope of ["all schemas", "drizzle", "storage", "babysunray_target", "public2"]) expect(isPlatformDefault({ ...supabase, scope })).toBe(false);
    for (const kind of ["f", "T", "n", ""]) expect(isPlatformDefault({ ...supabase, kind })).toBe(false);
  });
  it("never exempts a privilege Supabase is not known to grant on that kind", () => {
    expect(isPlatformDefault({ ...supabase, kind: "S", privilege: "DELETE" })).toBe(false);
    expect(isPlatformDefault({ ...supabase, kind: "r", privilege: "USAGE" })).toBe(false);
    expect(isPlatformDefault({ ...supabase, privilege: "EXECUTE" })).toBe(false);
  });
});
